import {
    MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1, TriageSourceEntryLocalRefV1Schema,
    TriageSourceEntrySnapshotV1Schema, projectTriageDisplayTextV1,
    type TriageRowFactV1, type TriageGetResultV1, TriageTaskFieldsV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { numericId, object, string, invalidJira } from '../api.js';
import { JIRA_PLUGIN_ID, JIRA_SOURCE_ID } from '../contracts.js';
import { parseJiraConfiguration, type JiraConfiguration } from './configurationContract.js';
export type { JiraConfiguration } from './configurationContract.js';

export function readJiraConfiguration(token: string): JiraConfiguration {
    const value = parseJiraConfiguration(token);
    if (value === null) throw invalidJira('jira/configurationInvalid');
    return value;
}
export function jiraLocalRef(origin: string, id: string) {
    return TriageSourceEntryLocalRefV1Schema.parse({ kindId: 'issue', collisionScope: `jira:${origin}`, entryId: id });
}
export type JiraIssue = Readonly<{ id: string; key: string; fields: Record<string, unknown>; schema: Record<string, unknown> }>;
export function readJiraIssue(raw: unknown): JiraIssue | null {
    const row = object(raw);
    const fields = object(row.fields);
    if (!numericId(row.id) || !string(row.key) || !numericId(object(fields.project).id)) return null;
    return { id: row.id, key: String(row.key), fields, schema: object(row.schema) };
}

/** Native status category is the authority; labels never imply a transition. */
export function jiraState(status: unknown) {
    const value = object(status);
    const category = object(value.statusCategory).key;
    const presentation = category === 'done' ? 'resolved' as const
        : category === 'new' || category === 'indeterminate' ? 'active' as const : 'unknown' as const;
    return { presentation,
        ...(category === 'new' ? { stage: 'unstarted' as const } : category === 'indeterminate' ? { stage: 'started' as const }
            : category === 'done' ? { completionReason: 'completed' as const } : {}),
        ...(string(value.name) ? { nativeLabel: projectTriageDisplayTextV1(String(value.name)).value } : {}) };
}

export function jiraRelatedRef(origin: string, id: string) {
    return { source: { pluginId: JIRA_PLUGIN_ID, localId: JIRA_SOURCE_ID }, ...jiraLocalRef(origin, id) };
}
function relations(issue: JiraIssue, origin: string) {
    const parent = object(issue.fields.parent);
    const children = Array.isArray(issue.fields.subtasks) ? issue.fields.subtasks : undefined;
    const validChildren = children?.filter((raw) => numericId(object(raw).id));
    const links = Array.isArray(issue.fields.issuelinks) ? issue.fields.issuelinks : undefined;
    const blockedBy = links?.filter((raw) => String(object(object(raw).type).inward).toLowerCase() === 'is blocked by')
        .map((raw) => object(object(raw).inwardIssue)).filter((row) => numericId(row.id));
    return {
        ...(numericId(parent.id) ? { parent: jiraRelatedRef(origin, parent.id) } : {}),
        ...(children === undefined || validChildren === undefined ? {} : { children: {
            total: children.length, entries: validChildren.map((raw) => jiraRelatedRef(origin, String(object(raw).id))),
            ...(children.length === validChildren.length ? { complete: true as const } : {}),
        } }),
        ...(blockedBy === undefined ? {} : { blockedBy: blockedBy.map((row) => jiraRelatedRef(origin, String(row.id))) }),
    };
}

export function projectJiraIssue(issue: JiraIssue, origin: string, viewerId: string): Extract<TriageGetResultV1, { kind: 'present' }> {
    const fields = issue.fields;
    let truncated = false;
    const display = (raw: unknown, fallback: string, budget?: number) => {
        const projected = projectTriageDisplayTextV1(string(raw) ?? fallback, budget);
        truncated ||= projected.truncated;
        return projected.value || fallback;
    };
    const facts: TriageRowFactV1[] = [];
    for (const [id, label, raw] of [
        ['jira/type', 'Issue type', object(fields.issuetype).name],
        ['jira/priority', 'Priority', object(fields.priority).name],
        ['jira/assignee', 'Assignee', object(fields.assignee).displayName],
    ]) {
        if (typeof raw === 'string' && raw.length > 0) facts.push({ id: String(id), label: String(label), importance: 'secondary',
            value: { kind: id === 'jira/assignee' ? 'actor' : 'text', value: display(raw, 'Unknown', MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1) } });
    }
    const title = display(fields.summary, issue.key);
    const scopeLabel = display(object(fields.project).name, String(object(fields.project).key ?? object(fields.project).id));
    const designation = display(issue.key, issue.id);
    const creator = string(object(fields.creator).displayName);
    const authorLabel = creator === undefined ? undefined : display(creator, issue.id);
    const assignee = string(object(fields.assignee).displayName);
    const createdAtMs = Date.parse(String(fields.created));
    const dueAtMs = Date.parse(String(fields.duedate));
    const completedAtMs = Date.parse(String(fields.resolutiondate));
    const updated = Date.parse(String(fields.updated));
    const involvement: ('author' | 'assignee' | 'subscribed')[] = [];
    if (object(fields.creator).accountId === viewerId) involvement.push('author');
    if (object(fields.assignee).accountId === viewerId) involvement.push('assignee');
    if (object(fields.watches).isWatching === true) involvement.push('subscribed');
    return {
        kind: 'present', localRef: jiraLocalRef(origin, issue.id),
        locator: { v: 1, displayPath: designation, webUrl: `${origin}/browse/${encodeURIComponent(issue.key)}` },
        snapshot: TriageSourceEntrySnapshotV1Schema.parse({ v: 1, title, scopeLabel, scopeUnitId: String(object(fields.project).id), designation,
            ...(fields.assignee === null ? { assigneeLabel: null } : assignee === undefined ? {} : { assigneeLabel: display(assignee, assignee) }),
            ...(authorLabel === undefined ? {} : { authorLabel }), ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
            ...(Number.isFinite(dueAtMs) ? { dueDate: fields.duedate } : {}),
            ...(jiraState(fields.status).presentation === 'resolved' && Number.isFinite(completedAtMs) ? { completedAtMs } : {}),
            state: jiraState(fields.status), relations: relations(issue, origin), facts,
            ...(truncated ? { projectionTruncated: true } : {}),
        }),
        viewer: { involvement }, ...(Number.isFinite(updated) ? { sourceUpdatedAtMs: updated } : {}),
    };
}

/** ADF is projected to literal detail text; HTML and executable marks are never evaluated. */
export function jiraAdfText(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    const node = object(raw);
    if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'mention') return string(object(node.attrs).text) ?? '';
    if (node.type === 'inlineCard') return string(object(node.attrs).url) ?? '';
    const content = Array.isArray(node.content) ? node.content.map(jiraAdfText).join('') : '';
    return ['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem', 'tableRow'].includes(String(node.type)) ? `${content}\n` : content;
}

/** Full values from Get issue, distinct from the normalized row projection. */
export function jiraTaskFields(issue: JiraIssue, origin: string) {
    const fields = issue.fields;
    const description = fields.description;
    const descriptionAvailable = description === null || typeof description === 'string'
        || (object(description).type === 'doc' && Array.isArray(object(description).content));
    return TriageTaskFieldsV1Schema.parse({
        ...(typeof fields.summary === 'string' && fields.summary.length > 0 ? { title: fields.summary } : {}),
        ...(descriptionAvailable ? { body: description === null ? '' : jiraAdfText(description) } : {}),
        ...(Array.isArray(fields.labels) && fields.labels.every(label => typeof label === 'string') ? { labelIds: fields.labels } : {}),
        ...(fields.assignee === null ? { assigneeIds: [] } : typeof object(fields.assignee).accountId === 'string'
            ? { assigneeIds: [object(fields.assignee).accountId] } : {}),
        ...(fields.priority === null ? { priority: null } : typeof object(fields.priority).id === 'string'
            ? { priority: object(fields.priority).id } : {}),
        ...(typeof fields.duedate === 'string' || fields.duedate === null ? { dueDate: fields.duedate } : {}),
        ...(fields.parent === null ? { parent: null } : numericId(object(fields.parent).id)
            ? { parent: jiraRelatedRef(origin, String(object(fields.parent).id)) } : {}),
    });
}
