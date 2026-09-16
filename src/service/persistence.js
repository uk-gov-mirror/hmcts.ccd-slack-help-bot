const JiraApi = require('jira-client');
const config = require('config')
const {createComment, mapFieldsToDescription} = require("./jiraMessages");

//const systemUser = config.get('secrets.cftptl-intsvc.jira-username')
let systemAccountId;
let systemAccountIdPromise;

const { 
    extractProjectRegex,
    getRequestTypeFromJiraId,
    getJiraProjects,
    getIssueTypeNames,
    getIssueTypeId,
    getJiraProject,
    getJiraStartTransitionId,
    getJiraDoneTransitionId,
    getComponents,
    getFixedVersion,
    getEpicName
} = require('../supportConfig');

const jiraApiUrl = new URL(config.get("jira.api-url"));
if (config.has("secrets.cftptl-intsvc.jira-cloud-id")) {
  jiraApiUrl.pathname = `${jiraApiUrl.pathname.replace(/\/+$/, "")}/${config.get(
    "secrets.cftptl-intsvc.jira-cloud-id",
  )}`;
}

const jira = new JiraApi({
   protocol: jiraApiUrl.protocol.replace(":", ""),
    host: jiraApiUrl.hostname,
    port: jiraApiUrl.port,
    base: jiraApiUrl.pathname.replace(/\/+$/, ""),
    username: config.get('secrets.cftptl-intsvc.jira-username'),
    password: config.get('secrets.cftptl-intsvc.jira-api-token'),
   apiVersion: "2",
   strictSSL: true,
 });

async function getSystemAccountId() {
  if (systemAccountId) return systemAccountId;
  if (!systemAccountIdPromise) {
    systemAccountIdPromise = jira
      .getCurrentUser()
      .then((user) => {
        systemAccountId = user?.accountId;
        return systemAccountId;
      })
      .catch((err) => {
        console.log("Unable to resolve Jira service account ID", err);
        return undefined;
      });
  }
  return systemAccountIdPromise;
}

async function resolveHelpRequest(jiraId) {
    try {
        const requestType = getRequestTypeFromJiraId(jiraId)
        await jira.transitionIssue(jiraId, {
            transition: {
                id: getJiraDoneTransitionId(requestType)
            }
        })
    } catch (err) {
        console.log("Error resolving help request in jira", err)
    }
}

async function startHelpRequest(jiraId) {
    try {
        const requestType = getRequestTypeFromJiraId(jiraId)
        await jira.transitionIssue(jiraId, {
            transition: {
                id: getJiraStartTransitionId(requestType)
            }
        })
    } catch (err) {
        console.log("Error starting help request in jira", err)
    }
}

async function searchForUnassignedOpenIssues() {
    const projects = getJiraProjects().join(', ')
    const issueTypes = getIssueTypeNames().map(name => `"${name}"`).join(', ')
    const jqlQuery = `project in (${projects}) AND type in (${issueTypes}) AND status in ("Draft", "To Do") and assignee is EMPTY ORDER BY created ASC`;
    try {
        return await jira.searchJira(
            jqlQuery,
            {
                // TODO if we moved the slack link out to another field we wouldn't need to request the whole description
                // which would probably be better for performance
                fields: ['created', 'description', 'summary', 'updated']
            }
        )
    } catch (err) {
        console.log("Error searching for issues in jira", err)
        return {
            issues: []
        }
    }
}

async function assignHelpRequest(issueId, email) {
    const user = convertEmail(email)

    try {
        await jira.updateAssignee(issueId, user)
    } catch(err) {
        console.log("Error assigning help request in jira", err)
    }
}

/**
 * Extracts a jira ID
 *
 * expected format: 'View on Jira: <https://hmcts.atlassian.net/jira/browse/SBOX-61|SBOX-61>'
 * @param blocks
 */
function extractJiraIdFromBlocks(blocks) {
    const viewOnJiraText = blocks[4].elements[0].text // TODO make this less fragile

    return extractJiraId(viewOnJiraText)
}

function extractJiraId(text) {
    return extractProjectRegex.exec(text)[1]
}

function convertEmail(email) {
    if (!email) {
        return getSystemAccountId();
    }

    return email.split('@')[0]
}

async function createHelpRequestInJira(requestType, summary, project) {
    return await jira.addNewIssue({
        fields: {
            summary: summary,
            issuetype: {
                id: getIssueTypeId(requestType)
            },
            project: {
                id: project.id
            },
            description: undefined,
            environment: [ { value: "No Environment" } ], // Environment - TODO Make this configurable and select appropriate value based on selection
            customfield_10364: [ { value: "No Environment" } ], // Environment - TODO Make this configurable and select appropriate value based on selection
            parent: {
                      key: getEpicName(requestType)
                    }
        }
    });
}

async function createHelpRequest(requestType, summary) {

    const project = await jira.getProject(getJiraProject(requestType))

    // https://developer.atlassian.com/cloud/jira/platform/rest/v2/api-group-issues/#api-rest-api-2-issue-post
    // note: fields don't match 100%, our Jira version is a bit old (still a supported LTS though)
    let result = await createHelpRequestInJira(requestType, summary, project);
    return result.key
}

async function updateHelpRequestCommonFields(issueId, { userEmail, labels }, requestType) {
    const user = convertEmail(userEmail)
    await jira.updateIssue(issueId, buildFieldsForUpdate(labels, requestType))
    
}

function buildFieldsForUpdate(labels, requestType) {
    return {
        fields: {
            labels: ['created-from-slack', ...labels],
            fixVersions: [ { name: getFixedVersion(requestType) } ],
            components: [ { name: getComponents(requestType) } ]
        }
    }
}

async function updateHelpRequestDescription(issueId, fields) {
    const jiraDescription = mapFieldsToDescription(fields);
    try {
        await jira.updateIssue(issueId, {
            update: {
                description: [{
                    set: jiraDescription
                }]
            }
        })
    } catch(err) {
        console.log("Error updating help request description in jira", err)
    }
}

async function addCommentToHelpRequest(externalSystemId, fields) {
    try {
        await jira.addComment(externalSystemId, createComment(fields))
    } catch (err) {
        console.log("Error creating comment in jira", err)
    }
}

module.exports.resolveHelpRequest = resolveHelpRequest
module.exports.startHelpRequest = startHelpRequest
module.exports.assignHelpRequest = assignHelpRequest
module.exports.createHelpRequest = createHelpRequest
module.exports.updateHelpRequestDescription = updateHelpRequestDescription
module.exports.updateHelpRequestCommonFields = updateHelpRequestCommonFields
module.exports.addCommentToHelpRequest = addCommentToHelpRequest
module.exports.convertEmail = convertEmail
module.exports.extractJiraId = extractJiraId
module.exports.extractJiraIdFromBlocks = extractJiraIdFromBlocks
module.exports.searchForUnassignedOpenIssues = searchForUnassignedOpenIssues
