import type { JiraSourceContext } from '../api.js';
import { invalidJira, jiraFailure, numericId, string } from '../api.js';
import { JiraIssueTypesInputSchema, type JiraIssueTypesResult } from './configurationContract.js';
import { readJiraCreateDirectory } from './metadata.js';
import { openJiraInstance } from './operations.js';

export async function listJiraIssueTypes(raw: unknown, context: JiraSourceContext): Promise<JiraIssueTypesResult> {
    const input = JiraIssueTypesInputSchema.parse(raw);
    try {
        const { client, configuration } = await openJiraInstance(input, context);
        if (!configuration.projectId) throw invalidJira('jira/createProjectRequired');
        const types = await readJiraCreateDirectory(client, `/rest/api/3/issue/createmeta/${configuration.projectId}/issuetypes`, 'issueTypes');
        const issueTypes = types.map((row) => {
            if (!numericId(row.id) || !string(row.name)) throw invalidJira('jira/issueTypeInvalid');
            return { id: row.id, name: String(row.name) };
        });
        return { kind: 'complete', issueTypes };
    } catch (error) { return { kind: 'failed', failure: jiraFailure(error) }; }
}
