import type { JiraSourceContext } from '../api.js';
import {
    defineProtocolObject, defineProtocolString,
    type ProtocolComposableSchema, type ProtocolSchemaInput, type ProtocolSchemaOutput,
} from '@happier-dev/plugin-sdk/protocol';
import {
    TriageSourceConnectedAccountInputsV1, TriageTaskCreateInputV1Schema, TriageTaskEditInputV1Schema,
    TriageTaskTransitionInputV1Schema, type TriageTaskWriteResultV1, type TriageTaskFieldsV1,
    type TriageTaskTransitionFieldValuesV1,
} from '@happier-dev/triage-protocol/v1';
import { settleAtMostOnceProviderWrite } from '@happier-dev/triage-sources/runtime';
import { JiraFailure, invalidJira, jiraFailure, numericId, object, string, type JiraClient } from '../api.js';
import { JIRA_PLUGIN_ID, JIRA_SOURCE_ID } from '../contracts.js';
import { jiraAdfText, projectJiraIssue, type JiraConfiguration, type JiraIssue } from './model.js';
import { openJiraInstance, readExactJiraIssue, jiraViewer } from './operations.js';
import { JIRA_FIELD_IDS, readJiraCreateDirectory, readJiraTransitions, jiraTransitionRequiredFields,
    jiraTransitionFieldDescriptor, jiraTransitionOptionId, missingJiraValue } from './metadata.js';

export const JiraCommentInputSchema: ProtocolComposableSchema<
    Readonly<{ entry: ProtocolSchemaInput<typeof TriageSourceConnectedAccountInputsV1.get>; body: string }>,
    Readonly<{ entry: ProtocolSchemaOutput<typeof TriageSourceConnectedAccountInputsV1.get>; body: string }>
> = defineProtocolObject({
    entry: TriageSourceConnectedAccountInputsV1.get,
    body: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });

class JiraRefusal extends Error {}
function refusal(reason: string): never { throw new JiraRefusal(reason); }
function failed(error: unknown): TriageTaskWriteResultV1 {
    return error instanceof JiraRefusal ? { kind: 'refused', reason: error.message } : { kind: 'failed', failure: jiraFailure(error) };
}

function normalizeJiraBody(body: string): string {
    return body.replace(/\r\n/gu, '\n');
}

export function jiraAdfBody(body: string) {
    return { type: 'doc', version: 1, content: normalizeJiraBody(body).split('\n').map((text) => ({ type: 'paragraph',
        content: text.length === 0 ? [] : [{ type: 'text', text }] })) };
}

function nativeFields(fields: TriageTaskFieldsV1, origin: string): Record<string, unknown> {
    if (Object.keys(fields).some((key) => !Object.hasOwn(JIRA_FIELD_IDS, key))) refusal('jira/fieldUnsupported');
    if (fields.assigneeIds !== undefined && fields.assigneeIds.length > 1) refusal('jira/singleAssigneeRequired');
    if (fields.priority !== undefined && fields.priority !== null && !numericId(String(fields.priority))) refusal('jira/priorityIdInvalid');
    if (fields.parent !== undefined && fields.parent !== null && (fields.parent.source.pluginId !== JIRA_PLUGIN_ID
        || fields.parent.source.localId !== JIRA_SOURCE_ID || fields.parent.kindId !== 'issue'
        || fields.parent.collisionScope !== `jira:${origin}` || !numericId(fields.parent.entryId))) refusal('jira/parentSourceMismatch');
    return {
        ...(fields.title === undefined ? {} : { summary: fields.title }),
        ...(fields.body === undefined ? {} : { description: jiraAdfBody(fields.body) }),
        ...(fields.assigneeIds === undefined ? {} : { assignee: fields.assigneeIds.length === 0 ? null : { accountId: fields.assigneeIds[0] } }),
        ...(fields.labelIds === undefined ? {} : { labels: fields.labelIds }),
        ...(fields.priority === undefined ? {} : { priority: fields.priority === null ? null : { id: String(fields.priority) } }),
        ...(fields.dueDate === undefined ? {} : { duedate: fields.dueDate }),
        ...(fields.parent === undefined ? {} : { parent: fields.parent === null ? null : { id: fields.parent.entryId } }),
    };
}

function validateMetadata(fields: Record<string, unknown>, metadata: Record<string, unknown>, creating: boolean): void {
    for (const key of Object.keys(fields)) {
        if (creating && (key === 'project' || key === 'issuetype')) continue;
        const field = object(metadata[key]);
        if (!Array.isArray(field.operations) || !field.operations.includes('set')) refusal('jira/fieldUnavailable');
        const requestedId = object(fields[key]).id;
        if (requestedId !== undefined && Array.isArray(field.allowedValues)
            && !field.allowedValues.some((value) => object(value).id === requestedId)) refusal('jira/fieldValueUnavailable');
    }
    if (creating && Object.entries(metadata).some(([key, raw]) => {
        const field = object(raw); return field.required === true && field.hasDefaultValue !== true && missingJiraValue(fields[key]);
    })) refusal('jira/requiredFieldUnsupported');
}

function matches(issue: JiraIssue, fields: TriageTaskFieldsV1): boolean {
    const native = issue.fields;
    // Get issue's fields projection does not guarantee each requested key.
    // Omission is unavailable evidence; null/[] explicitly represent a clear.
    // https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get
    if (Object.entries(JIRA_FIELD_IDS).some(([field, key]) => Object.hasOwn(fields, field) && !Object.hasOwn(native, key))) return false;
    const sorted = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(String))].sort().join('\u0000') : '';
    return (fields.title === undefined || native.summary === fields.title)
        && (fields.body === undefined || normalizeJiraBody(jiraAdfText(native.description)).trimEnd() === normalizeJiraBody(fields.body).trimEnd())
        && (fields.labelIds === undefined || (Array.isArray(native.labels) && sorted(native.labels) === sorted(fields.labelIds)))
        && (fields.assigneeIds === undefined || (native.assignee === null ? null : object(native.assignee).accountId) === (fields.assigneeIds[0] ?? null))
        && (fields.priority === undefined || (native.priority === null ? null : object(native.priority).id) === (fields.priority === null ? null : String(fields.priority)))
        && (fields.dueDate === undefined || native.duedate === fields.dueDate)
        && (fields.parent === undefined || (native.parent === null ? null : object(native.parent).id) === (fields.parent?.entryId ?? null));
}

type Dispatch = { ok: true; value: unknown } | { ok: false; error: unknown };
async function dispatch(request: () => Promise<unknown>): Promise<Dispatch> {
    try { return { ok: true, value: await request() }; } catch (error) { return { ok: false, error }; }
}
function mayHaveChanged(result: Dispatch): boolean {
    if (result.ok) return true;
    return result.error instanceof JiraFailure && result.error.dispatched
        && (result.error.status === undefined || result.error.status >= 500 || result.error.status < 300);
}
async function confirmedObservation(client: JiraClient, configuration: JiraConfiguration, id: string) {
    const issue = await readExactJiraIssue(client, configuration, id);
    return { issue, observation: projectJiraIssue(issue, client.origin, await jiraViewer(client)) };
}
function settledResult(result: Awaited<ReturnType<typeof settleAtMostOnceProviderWrite<Dispatch, Extract<TriageTaskWriteResultV1, { kind: 'applied' }>['observation'], ReturnType<typeof jiraFailure>>>>): TriageTaskWriteResultV1 {
    if (result.kind === 'settled') return result.result.ok ? { kind: 'uncertain' } : failed(result.result.error);
    if (result.kind === 'unchanged') return { kind: 'uncertain', observation: result.observation };
    return result;
}

export async function createJiraIssue(raw: unknown, context: JiraSourceContext): Promise<TriageTaskWriteResultV1> {
    const input = TriageTaskCreateInputV1Schema.parse(raw);
    if (input.initialStatusId !== undefined) return { kind: 'refused', reason: 'jira/unsupportedField' };
    try {
        if (input.kindId !== 'issue') refusal('jira/kindUnsupported');
        const { client, configuration } = await openJiraInstance(input.instance, context);
        if (!configuration.projectId) refusal('jira/createProjectRequired');
        if (!configuration.issueTypeId) refusal('jira/issueTypeRequired');
        const fields = { ...nativeFields(input.fields, client.origin), project: { id: configuration.projectId }, issuetype: { id: configuration.issueTypeId } };
        const metadata = await readJiraCreateDirectory(client, `/rest/api/3/issue/createmeta/${configuration.projectId}/issuetypes/${configuration.issueTypeId}`, 'fields');
        validateMetadata(fields, Object.fromEntries(metadata.map((field) => [String(field.fieldId ?? field.key), field])), true);
        let sent: Dispatch;
        return settledResult(await settleAtMostOnceProviderWrite({
            dispatch: async () => sent = await dispatch(() => client.request('/rest/api/3/issue', 'POST', { fields })), mayHaveChanged,
            confirm: async () => {
                if (!sent.ok || !numericId(object(sent.value).id)) return { kind: 'uncertain' as const, ...(!sent.ok ? { failure: jiraFailure(sent.error) } : {}) };
                try {
                    const { issue, observation } = await confirmedObservation(client, configuration, String(object(sent.value).id));
                    return { kind: matches(issue, input.fields) ? 'applied' as const : 'uncertain' as const, observation };
                } catch (error) { return { kind: 'uncertain' as const, failure: jiraFailure(error) }; }
            },
        }));
    } catch (error) { return failed(error); }
}

export async function editJiraIssue(raw: unknown, context: JiraSourceContext): Promise<TriageTaskWriteResultV1> {
    const input = TriageTaskEditInputV1Schema.parse(raw);
    try {
        const { client, configuration } = await openJiraInstance(input.instance, context, input.localRef);
        const fields = nativeFields(input.fields, client.origin);
        if (Object.keys(fields).length === 0) refusal('jira/noChanges');
        const before = await readExactJiraIssue(client, configuration, input.localRef.entryId);
        const metadata = object(await client.request(`/rest/api/3/issue/${input.localRef.entryId}/editmeta`));
        validateMetadata(fields, object(metadata.fields), false);
        if (matches(before, input.fields)) return { kind: 'applied', observation: projectJiraIssue(before, client.origin, await jiraViewer(client)) };
        return settledResult(await settleAtMostOnceProviderWrite({
            dispatch: () => dispatch(() => client.request(`/rest/api/3/issue/${input.localRef.entryId}`, 'PUT', { fields })), mayHaveChanged,
            confirm: async () => {
                try {
                    const { issue, observation } = await confirmedObservation(client, configuration, input.localRef.entryId);
                    return { kind: matches(issue, input.fields) ? 'applied' as const : 'uncertain' as const, observation };
                } catch (error) { return { kind: 'uncertain' as const, failure: jiraFailure(error) }; }
            },
        }));
    } catch (error) { return failed(error); }
}

function transitionNativeFields(transition: Record<string, unknown>, issue: JiraIssue, values: TriageTaskTransitionFieldValuesV1): Record<string, unknown> {
    const metadata = object(transition.fields);
    const fields: Record<string, unknown> = {};
    for (const { fieldId, value } of values) {
        if (Object.hasOwn(fields, fieldId)) refusal('jira/fieldValueInvalid');
        if (!Object.hasOwn(metadata, fieldId)) refusal('jira/fieldUnavailable');
        const field = jiraTransitionFieldDescriptor(fieldId, metadata[fieldId]);
        if (field.kind === 'unsupported') refusal('jira/requiredFieldUnsupported');
        if (missingJiraValue(value) || (typeof value === 'string' && value.trim().length === 0)) refusal('jira/fieldValueInvalid');
        const schema = object(object(metadata[fieldId]).schema);
        if (field.kind === 'text') {
            if (typeof value !== 'string') refusal('jira/fieldValueInvalid');
            const adf = fieldId === 'description' || fieldId === 'environment'
                || schema.custom === 'com.atlassian.jira.plugin.system.customfieldtypes:textarea';
            fields[fieldId] = adf ? jiraAdfBody(value) : value;
        } else if (field.kind === 'number') {
            if (typeof value !== 'number' || !Number.isFinite(value)) refusal('jira/fieldValueInvalid');
            fields[fieldId] = value;
        } else {
            const ids = field.kind === 'choices' ? value : [value];
            if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'
                || !field.options.some(option => option.id === id)) || new Set(ids).size !== ids.length) refusal('jira/fieldValueUnavailable');
            const nativeType = schema.type === 'array' ? schema.items : schema.type;
            const selected = ids.map(id => nativeType === 'string' ? id : nativeType === 'user' ? { accountId: id } : { id });
            fields[fieldId] = field.kind === 'choices' ? selected : selected[0];
        }
    }
    if (jiraTransitionRequiredFields(transition, issue).some(field => missingJiraValue(fields[field.id]))) refusal('jira/transitionRequiresFields');
    return fields;
}

function transitionFieldsMatch(issue: JiraIssue, transition: Record<string, unknown>, values: TriageTaskTransitionFieldValuesV1): boolean {
    const metadata = object(transition.fields);
    return values.every(({ fieldId, value }) => {
        if (!Object.hasOwn(issue.fields, fieldId)) return false;
        const stored = issue.fields[fieldId];
        const field = jiraTransitionFieldDescriptor(fieldId, metadata[fieldId]);
        if (field.kind === 'text') {
            const text = typeof stored === 'string' ? stored : jiraAdfText(stored);
            return typeof value === 'string' && normalizeJiraBody(text).trimEnd() === normalizeJiraBody(value).trimEnd();
        }
        if (field.kind === 'number') return stored === value;
        if (field.kind === 'choice') return jiraTransitionOptionId(stored) === value;
        if (field.kind === 'choices') {
            if (!Array.isArray(stored) || !Array.isArray(value)) return false;
            const actual = stored.map(jiraTransitionOptionId);
            return actual.length === value.length && value.every(id => actual.includes(id));
        }
        return false;
    });
}

export async function transitionJiraIssue(raw: unknown, context: JiraSourceContext): Promise<TriageTaskWriteResultV1> {
    const input = TriageTaskTransitionInputV1Schema.parse(raw);
    try {
        const { client, configuration } = await openJiraInstance(input.instance, context, input.localRef);
        const before = await readExactJiraIssue(client, configuration, input.localRef.entryId);
        const transitions = await readJiraTransitions(client, input.localRef.entryId);
        const transition = object(transitions.find((value) => value.id === input.transitionId));
        if (!string(transition.id)) refusal('jira/transitionUnavailable');
        const targetId = string(object(transition.to).id);
        if (!targetId) throw invalidJira('jira/transitionStatusInvalid');
        const values = input.fieldValues ?? [];
        const fields = transitionNativeFields(transition, before, values);
        let sent: Dispatch;
        return settledResult(await settleAtMostOnceProviderWrite({
            dispatch: async () => sent = await dispatch(() => client.request(`/rest/api/3/issue/${input.localRef.entryId}/transitions`, 'POST', {
                transition: { id: input.transitionId }, ...(values.length === 0 ? {} : { fields }),
            })), mayHaveChanged,
            confirm: async () => {
                try {
                    const { issue, observation } = await confirmedObservation(client, configuration, input.localRef.entryId);
                    return { kind: object(issue.fields.status).id === targetId
                        && transitionFieldsMatch(issue, transition, values)
                        && (sent.ok || object(before.fields.status).id !== targetId) ? 'applied' as const : 'uncertain' as const, observation };
                } catch (error) { return { kind: 'uncertain' as const, failure: jiraFailure(error) }; }
            },
        }));
    } catch (error) { return failed(error); }
}

export async function commentJiraIssue(raw: unknown, context: JiraSourceContext): Promise<TriageTaskWriteResultV1> {
    const input = JiraCommentInputSchema.parse(raw);
    try {
        const { client, configuration } = await openJiraInstance(input.entry.instance, context, input.entry.localRef);
        const id = input.entry.localRef.entryId;
        await readExactJiraIssue(client, configuration, id);
        let sent: Dispatch;
        return settledResult(await settleAtMostOnceProviderWrite({
            dispatch: async () => sent = await dispatch(() => client.request(`/rest/api/3/issue/${id}/comment`, 'POST', { body: jiraAdfBody(input.body) })), mayHaveChanged,
            confirm: async () => {
                const commentId = sent.ok ? string(object(sent.value).id) : undefined;
                if (!commentId) return { kind: 'uncertain' as const, ...(!sent.ok ? { failure: jiraFailure(sent.error) } : {}) };
                try {
                    const comment = object(await client.request(`/rest/api/3/issue/${id}/comment/${encodeURIComponent(commentId)}`));
                    const { observation } = await confirmedObservation(client, configuration, id);
                    return { kind: comment.id === commentId && Object.hasOwn(comment, 'body')
                        && normalizeJiraBody(jiraAdfText(comment.body)).trimEnd() === normalizeJiraBody(input.body).trimEnd() ? 'applied' as const : 'uncertain' as const, observation };
                } catch (error) { return { kind: 'uncertain' as const, failure: jiraFailure(error) }; }
            },
        }));
    } catch (error) { return failed(error); }
}
