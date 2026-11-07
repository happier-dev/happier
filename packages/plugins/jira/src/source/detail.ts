import type { JiraSourceContext } from '../api.js';
import { TriageGetInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { jiraFailure, object, string } from '../api.js';
import { jiraAdfText, projectJiraIssue } from './model.js';
import { openJiraInstance, readExactJiraIssue, jiraViewer } from './operations.js';

import type { JiraDetailResult } from './detailContract.js';
export { JiraDetailResultSchema } from './detailContract.js';
export async function readJiraDetail(raw: unknown, context: JiraSourceContext): Promise<JiraDetailResult> {
    const input = TriageGetInputV1Schema.parse(raw);
    try {
        const { client, configuration } = await openJiraInstance(input.instance, context, input.localRef);
        const issue = await readExactJiraIssue(client, configuration, input.localRef.entryId);
        const fields: { label: string; value: string }[] = [];
        const add = (label: string, value: unknown) => { if (typeof value === 'string' && value.length > 0) fields.push({ label, value }); };
        add('Issue type', object(issue.fields.issuetype).name);
        add('Priority', object(issue.fields.priority).name);
        if (Array.isArray(issue.fields.labels)) add('Labels', issue.fields.labels.filter((value) => typeof value === 'string').join(', '));
        for (const [id, schema] of Object.entries(issue.schema)) {
            if (object(schema).custom !== 'com.pyxis.greenhopper.jira:gh-sprint') continue;
            const sprints = issue.fields[id];
            if (Array.isArray(sprints)) add('Sprint', sprints.map((sprint) => string(object(sprint).name)).filter(Boolean).join(', '));
        }
        const designation = (raw: unknown) => {
            const row = object(raw); return [string(row.key), string(object(row.fields).summary)].filter(Boolean).join(' · ');
        };
        add('Parent', designation(issue.fields.parent));
        if (Array.isArray(issue.fields.subtasks)) add('Subtasks', issue.fields.subtasks.map(designation).filter(Boolean).join('\n'));
        if (Array.isArray(issue.fields.issuelinks)) add('Is blocked by', issue.fields.issuelinks
            .filter((raw) => String(object(object(raw).type).inward).toLowerCase() === 'is blocked by')
            .map((raw) => designation(object(raw).inwardIssue)).filter(Boolean).join('\n'));
        return { kind: 'detail', observation: projectJiraIssue(issue, client.origin, await jiraViewer(client)), body: jiraAdfText(issue.fields.description), fields };
    } catch (error) { return { kind: 'failed', failure: jiraFailure(error) }; }
}
