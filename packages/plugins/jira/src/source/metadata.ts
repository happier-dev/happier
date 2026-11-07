import { projectTriageDisplayTextV1, TriageTaskCapabilitiesV1Schema, type TriageTaskCapabilitiesV1,
    type TriageTaskTransitionRequiredFieldV1 } from '@happier-dev/triage-protocol/v1';
import { invalidJira, object, string, type JiraClient } from '../api.js';
import { jiraState, type JiraIssue } from './model.js';

export const JIRA_FIELD_IDS = { title: 'summary', body: 'description', assigneeIds: 'assignee', labelIds: 'labels',
    priority: 'priority', dueDate: 'duedate', parent: 'parent' } as const;
export const JIRA_TASK_FIELDS = Object.keys(JIRA_FIELD_IDS) as (keyof typeof JIRA_FIELD_IDS)[];
export function missingJiraValue(value: unknown): boolean {
    return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}
export function jiraTransitionOptionId(value: unknown): string | undefined {
    return string(value) ?? string(object(value).id) ?? string(object(value).accountId);
}

/** Jira REST v3 transitions.fields owns both input shape and available choices. */
export function jiraTransitionFieldDescriptor(id: string, raw: unknown): TriageTaskTransitionRequiredFieldV1 {
    const field = object(raw);
    const schema = object(field.schema);
    const address = { id, label: projectTriageDisplayTextV1(string(field.name) ?? id).value };
    const unsupported = { ...address, kind: 'unsupported' as const };
    if (!Array.isArray(field.operations) || !field.operations.includes('set')) return unsupported;
    const nativeType = schema.type === 'array' ? schema.items : schema.type;
    if (Array.isArray(field.allowedValues) && field.allowedValues.length > 0
        && ['string', 'resolution', 'priority', 'option', 'user', 'version', 'component', 'project', 'issuetype'].includes(String(nativeType))) {
        const options = field.allowedValues.flatMap((value) => {
            const optionId = jiraTransitionOptionId(value);
            return optionId === undefined ? [] : [{ id: optionId,
                label: projectTriageDisplayTextV1(string(object(value).name) ?? string(object(value).value)
                    ?? string(object(value).displayName) ?? optionId).value }];
        });
        if (options.length !== field.allowedValues.length || new Set(options.map(option => option.id)).size !== options.length) return unsupported;
        return { ...address, kind: schema.type === 'array' ? 'choices' : 'choice', options };
    }
    if (schema.type === 'string' || schema.type === 'date' || schema.type === 'datetime') return { ...address, kind: 'text' };
    if (schema.type === 'number') return { ...address, kind: 'number' };
    return unsupported;
}

export function jiraTransitionRequiredFields(transition: Record<string, unknown>, issue: JiraIssue): readonly TriageTaskTransitionRequiredFieldV1[] {
    return Object.entries(object(transition.fields)).flatMap(([id, raw]) => {
        const field = object(raw);
        return field.required === true && field.hasDefaultValue !== true && missingJiraValue(issue.fields[id])
            ? [jiraTransitionFieldDescriptor(id, field)] : [];
    });
}
export async function readJiraTransitions(client: JiraClient, id: string): Promise<readonly Record<string, unknown>[]> {
    const result = object(await client.request(`/rest/api/3/issue/${id}/transitions?expand=transitions.fields`));
    if (!Array.isArray(result.transitions)) throw invalidJira('jira/transitionsInvalid');
    return result.transitions.map(object);
}

/** Permissions to edit/transition are independent of permission to read an issue. */
export async function readJiraTaskCapabilities(client: JiraClient, issue: JiraIssue): Promise<TriageTaskCapabilitiesV1> {
    const [edit, transitions] = await Promise.allSettled([
        client.request(`/rest/api/3/issue/${issue.id}/editmeta`), readJiraTransitions(client, issue.id),
    ]);
    const fields = edit.status === 'fulfilled' ? object(object(edit.value).fields) : {};
    const capabilities = TriageTaskCapabilitiesV1Schema.parse({
        editFields: JIRA_TASK_FIELDS.filter((id) => {
            const operations = object(fields[JIRA_FIELD_IDS[id]]).operations;
            return Array.isArray(operations) && operations.includes('set');
        }),
        transitions: transitions.status !== 'fulfilled' ? [] : transitions.value.flatMap((transition) => {
            if (!string(transition.id) || !string(transition.name) || !string(object(transition.to).id)) return [];
            const requiredFields = jiraTransitionRequiredFields(transition, issue);
            const parsed = TriageTaskCapabilitiesV1Schema.safeParse({ transitions: [{ id: transition.id,
                label: projectTriageDisplayTextV1(String(transition.name)).value, state: jiraState(transition.to),
                ...(requiredFields.length === 0 ? {} : { requiredFields }) }] });
            return parsed.success ? parsed.data.transitions ?? [] : [];
        }),
    });
    return capabilities;
}

/** Jira's offset-paged create-metadata resources. No local page ceiling. */
export async function readJiraCreateDirectory(client: JiraClient, path: string, key: 'fields' | 'issueTypes'): Promise<readonly Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let startAt = 0;
    for (;;) {
        const page = object(await client.request(`${path}?startAt=${startAt}`));
        const values = page[key];
        if (!Array.isArray(values) || !Number.isSafeInteger(page.total) || !Number.isSafeInteger(page.startAt)
            || !Number.isSafeInteger(page.maxResults) || Number(page.startAt) !== startAt
            || Number(page.total) < 0) throw invalidJira('jira/createMetadataInvalid');
        rows.push(...values.map(object));
        if (Number(page.startAt) + values.length >= Number(page.total)) return rows;
        const next = Number(page.startAt) + Number(page.maxResults);
        if (next <= startAt || values.length === 0) throw invalidJira('jira/createMetadataPageInvalid');
        startAt = next;
    }
}
