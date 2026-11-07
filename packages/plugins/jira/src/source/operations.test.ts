import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate as activateAccount } from '../accountRuntime.js';
import { describe, expect, it, vi } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
    TriageGetResultV1Schema, TriageListInstancesResultV1Schema, TriageScanResultV1Schema,
    TriageListScopeUnitsResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { getJiraEntry, listJiraInstances, scanJiraSource } from './operations.js';
import { readJiraDetail, JiraDetailResultSchema } from './detail.js';
import { JIRA_PLUGIN, PLUGIN_MANIFEST } from '../manifest.js';
import { assertTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
// Composed integration test only: the real aggregate consumes the independently authored plugin.
import { runTriageScanPass } from '../../../triage/src/projection/scanPass.js';
import { createJiraIssue, editJiraIssue, transitionJiraIssue, commentJiraIssue } from './writes.js';
import { TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { readJiraConfiguration } from './model.js';
import { JIRA_ACTIONS } from '../contracts.js';

const origin = 'https://work.atlassian.net';
const account = { service: { pluginId: 'happier.jira', localId: 'jira-account' }, accountId: 'account-1' };
const source = { pluginId: 'happier.jira', localId: 'jira-issues' };
const ref = { kindId: 'issue', collisionScope: `jira:${origin}`, entryId: '10001' };
const instance = {
    ...createTriageSourceV1Fixture().configuredInstance,
    instance: { source, sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
    binding: { purpose: 'jira-account', account },
    localInstanceKey: `${origin}#10000`,
    configuration: { v: 1 as const, token: JSON.stringify({ v: 1, projectId: '10000', involvement: 'mine' }) },
};

// Jira REST v3 provider DTOs, not copies of Happier's internal projections.
// https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-post
// https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get
export const issue = {
    id: '10001', key: 'ABC-123', self: `${origin}/rest/api/3/issue/10001`,
    fields: {
        summary: 'Repair the queue\nwithout losing work',
        project: { id: '10000', key: 'ABC', name: 'Platform' },
        status: { id: '3', name: 'In progress', statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' } },
        issuetype: { id: '10002', name: 'Task', subtask: false }, priority: { id: '2', name: 'High' },
        creator: { accountId: 'person-1', displayName: 'Amina' },
        assignee: { accountId: 'person-1', displayName: 'Amina' },
        watches: { isWatching: true, watchCount: 2 }, labels: ['reliability'],
        created: '2026-10-01T12:00:00.000+0000', updated: '2026-10-18T12:00:00.000+0000',
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep queued work.' }] }] },
        parent: { id: '10002', key: 'ABC-120', fields: { summary: 'Queue program' } },
        subtasks: [{ id: '10003', key: 'ABC-124', fields: { summary: 'Exercise recovery' } }],
        issuelinks: [{ id: '11000', type: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { id: '10004', key: 'ABC-119', fields: { summary: 'Fix custody' } } }],
        customfield_10020: [{ id: 7, name: 'October sprint', state: 'active' }],
    },
    schema: { customfield_10020: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint', customId: 10020 } },
};

export function host(respond: (url: URL, body: unknown) => { status?: number; body: unknown; headers?: Record<string, string> }) {
    const request = vi.fn(async (input: { url: string; method: string; body?: Uint8Array }, options: { signal: AbortSignal }) => {
        options.signal.throwIfAborted();
        const response = respond(new URL(input.url), input.body === undefined ? undefined : JSON.parse(new TextDecoder().decode(input.body)));
        return { status: response.status ?? 200, finalUrl: input.url, headers: response.headers ?? {}, body: new TextEncoder().encode(JSON.stringify(response.body)) };
    });
    const materializeListedAccount = vi.fn(async () => ({ kind: 'httpHeaders', headers: { authorization: 'Basic fixture-only' } }));
    const listAccounts = vi.fn(async () => ({ status: 'complete', accounts: [{ account, state: 'connected', displayName: 'Work Jira', connectedAccountOrigins: [origin] }] }));
    // Genuine host service boundaries: Connected Accounts + HTTP; all Jira and Triage logic stays real.
    const context = { signal: new AbortController().signal, services: {
        connectedAccounts: {
            listAccounts,
            materializeListedAccount,
        }, http: { request },
    } } as unknown as PluginInvocationContext;
    return { context, request, materializeListedAccount, listAccounts };
}

describe('Jira source through provider HTTP', () => {
    it.each([
        ['connected_service_credential_reconnect_required', 'authentication'],
        ['plugin_connected_account_settings_unavailable', 'transient'],
    ] as const)('preserves typed host refusal %s and request ID without HTTP', async (code, classification) => {
        const h = host(() => ({ body: {} }));
        h.materializeListedAccount.mockRejectedValue(Object.assign(new Error('private credential'), {
            code, retryable: false, details: { requestId: 'jira-host-refusal' },
        }));
        expect(await scanJiraSource({ v: 1, instance, page: { kind: 'initial', limit: 20 } }, h.context))
            .toMatchObject({ kind: 'failed', failure: { class: classification, code, detail: 'Happier Request ID: jira-host-refusal' } });
        expect(h.request).not.toHaveBeenCalled();
    });

    it('executes the Account scan through registration and HTTP without a Machine', async () => {
        const h = host((url) => ({ body: url.pathname.endsWith('/myself') ? { accountId: 'person-1' } : { isLast: true, issues: [issue] } }));
        const kit = await createPluginTestkit({ manifest: JIRA_PLUGIN.manifest,
            module: { activate: JIRA_PLUGIN.activate, activateAccount }, services: h.context.services });
        try {
            expect(await kit.invokeAction(JIRA_ACTIONS.scan, { v: 1, instance: instance, page: { kind: 'initial', limit: 3 } }))
                .toMatchObject({ kind: 'complete', observations: [{ kind: 'present', snapshot: { title: 'Repair the queue without losing work' } }] });
            expect(h.request).toHaveBeenCalledTimes(2);
        } finally { await kit.dispose(); }
    });
    it('bounds completed task reads through native JQL while retaining project, involvement and provider paging', async () => {
        const sinceMs = Date.parse('2026-10-19T00:00:00Z');
        const completed = { kindIds: ['issue'], sinceMs };
        const h = host((url, body) => {
            if (url.pathname === '/rest/api/3/myself') return { body: { accountId: 'person-1' } };
            expect(body).toMatchObject({ jql: `project IN (10000) AND (assignee = currentUser() OR creator = currentUser() OR watcher = currentUser()) AND (statusCategory != Done OR resolved >= ${sinceMs}) ORDER BY updated DESC, id DESC` });
            const continued = typeof body === 'object' && body !== null && 'nextPageToken' in body;
            return { body: { isLast: continued, ...(continued ? {} : { nextPageToken: 'next' }), issues: [{ ...issue, fields: { ...issue.fields,
                resolutiondate: '2026-10-20T10:30:00Z', status: { name: 'Done', statusCategory: { key: 'done' } } } }] } };
        });
        const first = await scanJiraSource({ v: 1, instance, completed, page: { kind: 'initial', limit: 20 } }, h.context);
        expect(first).toMatchObject({ kind: 'page', observations: [{ snapshot: { completedAtMs: Date.parse('2026-10-20T10:30:00Z') } }] });
        if (first.kind !== 'page') throw new Error('Expected provider continuation');
        expect(await scanJiraSource({ v: 1, instance, completed, page: { kind: 'continuation', continuation: first.continuation } }, h.context))
            .toMatchObject({ kind: 'complete' });
        expect(await scanJiraSource({ v: 1, instance, completed: { ...completed, sinceMs: sinceMs + 1 },
            page: { kind: 'continuation', continuation: first.continuation } }, h.context)).toMatchObject({ kind: 'failed' });
    });
    it('projects due and resolved dates from provider fields into the shared scan snapshot', async () => {
        const h = host((url, body) => {
            if (url.pathname === '/rest/api/3/myself') return { body: { accountId: 'person-1' } };
            expect(body).toMatchObject({ fields: expect.arrayContaining(['duedate', 'resolutiondate']) });
            return { body: { isLast: true, issues: [{ ...issue, fields: { ...issue.fields, duedate: '2026-10-25',
                resolutiondate: '2026-10-20T10:30:00Z', status: { name: 'Done', statusCategory: { key: 'done' } } } }] } };
        });
        expect(TriageScanResultV1Schema.parse(await scanJiraSource({ v: 1, instance, page: { kind: 'initial', limit: 20 } }, h.context)))
            .toMatchObject({ kind: 'complete', observations: [{ snapshot: {
                dueDate: '2026-10-25', completedAtMs: Date.parse('2026-10-20T10:30:00Z'),
            } }] });
    });
    it('reads historical project configuration as a selected scope without losing create defaults', () => {
        expect(readJiraConfiguration(JSON.stringify({ v: 1, projectId: '10000', involvement: 'mine', issueTypeId: '10002' })))
            .toEqual({ v: 2, scope: { kind: 'selected', unitIds: ['10000'] }, involvement: 'mine', projectId: '10000', issueTypeId: '10002' });
    });

    it.each(['selected', 'all'] as const)('scans the %s project scope through one site and checks returned project membership', async (kind) => {
        const configured = { ...instance, localInstanceKey: origin, configuration: { v: 1 as const,
            token: JSON.stringify({ v: 2, scope: kind === 'all' ? { kind } : { kind, unitIds: ['10000', '10002'] }, involvement: 'mine' }) } };
        const h = host((url, body) => {
            if (url.pathname === '/rest/api/3/myself') return { body: { accountId: 'person-1' } };
            expect(body).toMatchObject({ jql: kind === 'selected'
                ? 'project IN (10000,10002) AND (assignee = currentUser() OR creator = currentUser() OR watcher = currentUser()) ORDER BY updated DESC, id DESC'
                : '(assignee = currentUser() OR creator = currentUser() OR watcher = currentUser()) ORDER BY updated DESC, id DESC' });
            return { body: { isLast: true, issues: [issue,
                { ...issue, id: '10005', fields: { ...issue.fields, project: { id: '10002', name: 'Mobile' } } },
                { ...issue, id: '10006', fields: { ...issue.fields, project: { id: '10003', name: 'Other' } } }] } };
        });
        const result = TriageScanResultV1Schema.parse(await scanJiraSource({ v: 1, instance: configured, page: { kind: 'initial', limit: 3 } }, h.context));
        expect(result).toMatchObject({ kind: 'complete', observations: kind === 'selected'
            ? [{ localRef: { entryId: '10001' }, snapshot: { scopeUnitId: '10000' } },
                { localRef: { entryId: '10005' }, snapshot: { scopeUnitId: '10002' } }]
            : [{ localRef: { entryId: '10001' }, snapshot: { scopeUnitId: '10000' } },
                { localRef: { entryId: '10005' }, snapshot: { scopeUnitId: '10002' } },
                { localRef: { entryId: '10006' }, snapshot: { scopeUnitId: '10003' } }] });
        expect(result.kind === 'complete' && result.evidence).toMatchObject(kind === 'selected'
            ? { kind: 'partial', omittedItemCount: 1 } : { kind: 'walkFinished' });
    });

    it('refuses nonnumeric selected project ids before provider access', async () => {
        const h = host(() => ({ body: {} }));
        const configured = { ...instance, localInstanceKey: origin, configuration: { v: 1 as const,
            token: JSON.stringify({ v: 2, scope: { kind: 'selected', unitIds: ['10000) OR project is not EMPTY'] }, involvement: 'all' }) } };
        expect(await scanJiraSource({ v: 1, instance: configured, page: { kind: 'initial', limit: 1 } }, h.context))
            .toMatchObject({ kind: 'failed', failure: { code: 'jira/configurationInvalid' } });
        expect(h.request).not.toHaveBeenCalled();
    });

    it('enforces project selection on exact reads before allowing a site-routed write', async () => {
        let edited = false;
        const configured = { ...instance, localInstanceKey: origin, configuration: { v: 1 as const,
            token: JSON.stringify({ v: 2, scope: { kind: 'selected', unitIds: ['10002'] }, involvement: 'all' }) } };
        const h = host((url, body) => {
            if (body) { edited = true; return { status: 204, body: null }; }
            return { body: url.pathname.endsWith('/editmeta') ? { fields: { summary: { operations: ['set'] } } }
                : { ...issue, fields: { ...issue.fields, summary: edited ? 'Changed' : issue.fields.summary } } };
        });
        expect(await getJiraEntry({ v: 1, instance: configured, localRef: ref }, h.context))
            .toMatchObject({ kind: 'unresolved', failure: { code: 'jira/entryMoved' } });
        expect(await editJiraIssue({ v: 1, instance: configured, localRef: ref, fields: { title: 'Changed' } }, h.context))
            .toMatchObject({ kind: 'failed', failure: { code: 'jira/entryMoved' } });
        expect(edited).toBe(false);
    });

    it('lists searched project choices through the activated safe scope Action and projects configured choices without provider access', async () => {
        type Handler = (input: unknown, context: PluginInvocationContext) => Promise<unknown>;
        const handlers = new Map<string, Handler>();
        activateAccount({ actions: { register: (id: string, handler: Handler) => handlers.set(id, handler) },
            connectedAccounts: { register: () => {} },
        } as unknown as PluginApi);
        const contribution = PLUGIN_MANIFEST.contributes.targetedPluginContributions[0];
        const read = handlers.get(contribution?.operations.listScopeUnits ?? '');
        expect(read).toBeDefined();
        if (read === undefined) throw new Error('Jira scope Action was not activated');
        const draft = { v: 1, binding: instance.binding, localInstanceKey: origin, keyStability: 'locatorDerived',
            configuration: { v: 1, token: JSON.stringify({ v: 2, scope: { kind: 'selected', unitIds: ['10000'] }, involvement: 'mine',
                scopeUnits: [{ id: '10000', label: 'Platform', secondaryText: 'ABC', collisionScope: 'invented-project-identity' }] }) },
            locator: { v: 1, displayLabel: 'Work Jira' } };
        const h = host((url) => {
            expect(url.pathname).toBe('/rest/api/3/project/search');
            expect(url.searchParams.get('query')).toBe('Platform');
            expect(url.searchParams.get('maxResults')).toBeNull();
            const second = url.searchParams.get('startAt') === '1';
            return { body: { startAt: second ? 1 : 0, maxResults: 1, isLast: second,
                values: [{ id: second ? '10002' : '10000', name: second ? 'Platform mobile' : 'Platform', key: second ? 'MOB' : 'ABC' }] } };
        });
        const first = TriageListScopeUnitsResultV1Schema.parse(await read({ v: 1, draft, query: 'Platform' }, h.context));
        expect(first).toMatchObject({ kind: 'page', status: 'partial', units: [{ id: '10000', label: 'Platform', secondaryText: 'ABC' }] });
        if (first.kind !== 'page' || first.status !== 'partial' || !first.nextCursor) throw new Error('Project continuation missing');
        expect(TriageListScopeUnitsResultV1Schema.parse(await read({ v: 1, draft, query: 'Platform', cursor: first.nextCursor }, h.context)))
            .toMatchObject({ kind: 'page', status: 'complete', units: [{ id: '10002', label: 'Platform mobile' }] });
        h.request.mockClear(); h.materializeListedAccount.mockClear(); h.listAccounts.mockClear();
        expect(await read({ v: 1, draft, query: 'Other', cursor: first.nextCursor }, h.context))
            .toMatchObject({ kind: 'failed', failure: { code: 'jira/projectCursorInvalid' } });
        expect(h.request).not.toHaveBeenCalled();
        h.listAccounts.mockClear();
        expect(await read({ v: 1, draft, mode: 'configured' }, h.context))
            .toEqual({ kind: 'page', status: 'complete', selection: { kind: 'selected', unitIds: ['10000'] },
                units: [{ id: '10000', label: 'Platform', secondaryText: 'ABC' }] });
        expect(h.request).not.toHaveBeenCalled();
        expect(h.materializeListedAccount).not.toHaveBeenCalled();
        expect(h.listAccounts).not.toHaveBeenCalled();
    });
    it('loads complete editable values and never invents a value for an omitted provider field', async () => {
        const h = host((url) => ({ body: url.pathname.endsWith('/transitions') ? { transitions: [] }
            : url.pathname.endsWith('/editmeta') ? { fields: {} }
                : url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' } : issue }));
        const result = TriageGetResultV1Schema.parse(await getJiraEntry({ v: 1, instance, localRef: ref }, h.context));
        expect(result).toMatchObject({ kind: 'present', taskFields: { title: issue.fields.summary, body: 'Keep queued work.\n',
            labelIds: ['reliability'], assigneeIds: ['person-1'], priority: '2', parent: { entryId: '10002' } } });
        expect(result).not.toHaveProperty('taskFields.dueDate');
        const unavailableBody = host((url) => ({ body: url.pathname.endsWith('/transitions') ? { transitions: [] }
            : url.pathname.endsWith('/editmeta') ? { fields: {} }
                : url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' }
                    : { ...issue, fields: { ...issue.fields, description: { inaccessible: true } } } }));
        const unavailable = await getJiraEntry({ v: 1, instance, localRef: ref }, unavailableBody.context);
        expect(unavailable).toMatchObject({ kind: 'present', taskFields: { title: issue.fields.summary } });
        expect(unavailable).not.toHaveProperty('taskFields.body');
    });
    it('discovers one source boundary for the exact configured Jira site', async () => {
        const h = host((url) => ({ body: url.pathname === '/rest/api/3/project/search'
            ? { isLast: Number(url.searchParams.get('startAt')) > 0, startAt: Number(url.searchParams.get('startAt')), maxResults: 1, total: 2,
                values: [{ id: Number(url.searchParams.get('startAt')) > 0 ? '10002' : '10000', key: 'ABC', name: 'Platform' }] }
            : { accountId: 'person-1', displayName: 'Amina' } }));
        const result = TriageListInstancesResultV1Schema.parse(await listJiraInstances({ v: 1 }, h.context));
        expect(result).toMatchObject({ kind: 'complete', candidates: [
            { localInstanceKey: origin, binding: { account } },
        ] });
        if (result.kind !== 'complete') throw new Error('Expected site discovery');
        expect(result.candidates).toHaveLength(1);
        expect(h.request).not.toHaveBeenCalled();
        const draft = result.candidates[0];
        if (draft === undefined) throw new Error('Expected the site candidate');
        expect(readJiraConfiguration(draft.configuration.token)).toEqual({ v: 2, scope: { kind: 'all' }, involvement: 'mine' });
        const provider = host((url) => ({ body: url.pathname === '/rest/api/3/myself'
            ? { accountId: 'person-1' } : { isLast: true, issues: [issue] } }));
        const configured = { ...instance, binding: draft.binding, localInstanceKey: draft.localInstanceKey, configuration: draft.configuration };
        expect(await scanJiraSource({ v: 1, instance: configured, page: { kind: 'initial', limit: 1 } }, provider.context))
            .toMatchObject({ kind: 'complete', observations: [{ localRef: ref }] });
    });

    it('pages enhanced JQL search and preserves Jira identity, native state and involvement', async () => {
        const h = host((url, body) => {
            if (url.pathname === '/rest/api/3/myself') return { body: { accountId: 'person-1' } };
            const request = body as { fields: string[]; nextPageToken?: string };
            // Jira returns the requested field projection, not every fixture field.
            return { body: { issues: [{ ...issue, fields: Object.fromEntries(Object.entries(issue.fields)
                .filter(([key]) => request.fields.includes(key))) }], isLast: Boolean(request.nextPageToken),
                ...(request.nextPageToken ? {} : { nextPageToken: 'next-provider-page' }) } };
        });
        const first = TriageScanResultV1Schema.parse(await scanJiraSource({ v: 1, instance, page: { kind: 'initial', limit: 10 } }, h.context));
        expect(first).toMatchObject({ kind: 'page', observations: [{ kind: 'present', localRef: ref,
            snapshot: { title: 'Repair the queue without losing work', designation: 'ABC-123', state: { presentation: 'active', nativeLabel: 'In progress', stage: 'started' },
                relations: { parent: { ...ref, source, entryId: '10002' },
                    children: { total: 1, complete: true, entries: [{ ...ref, source, entryId: '10003' }] },
                    blockedBy: [{ ...ref, source, entryId: '10004' }] } },
            viewer: { involvement: ['author', 'assignee', 'subscribed'] },
        }] });
        if (first.kind !== 'page') throw new Error('expected the provider continuation');
        const second = TriageScanResultV1Schema.parse(await scanJiraSource({ v: 1, instance, page: { kind: 'continuation', continuation: first.continuation } }, h.context));
        expect(second.kind).toBe('complete');
        const calls = h.request.mock.calls.filter(([r]) => r.url.includes('/search/jql'));
        expect(calls).toHaveLength(2);
        const sent = JSON.parse(new TextDecoder().decode(calls[1]?.[0].body));
        expect(sent).toMatchObject({ maxResults: 10, nextPageToken: 'next-provider-page' });
        expect(sent.jql).toContain('watcher = currentUser()');
        expect(JSON.stringify(first)).not.toContain('Basic fixture-only');
    });

    it('returns provider retry evidence and does not treat a permission-masked 404 as absence', async () => {
        const h = host((url) => url.pathname === '/rest/api/3/myself' ? { body: { accountId: 'person-1' } }
            : { status: 429, body: { errorMessages: ['rate limited'] }, headers: { 'Retry-After': '60', 'X-RateLimit-Reset': '2099-01-01T00:00:00Z' } });
        const result = await scanJiraSource({ v: 1, instance, page: { kind: 'initial', limit: 10 } }, h.context);
        expect(result).toMatchObject({ kind: 'failed', failure: { class: 'rateLimit', retryNotBeforeMs: Date.parse('2099-01-01T00:00:00Z') } });
        const hidden = host(() => ({ status: 404, body: { errorMessages: ['Issue does not exist or you do not have permission to see it.'] } }));
        const get = TriageGetResultV1Schema.parse(await getJiraEntry({ v: 1, instance, localRef: ref }, hidden.context));
        expect(get).toMatchObject({ kind: 'unresolved', failure: { class: 'permission' } });
    });

    it('keeps malformed-provider rows visible as incomplete coverage while accepting valid siblings', async () => {
        const h = host((url) => ({ body: url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' }
            : { issues: [{ key: 'MALFORMED-1', fields: {} }, issue], isLast: true } }));
        const result = TriageScanResultV1Schema.parse(await scanJiraSource({ v: 1, instance, page: { kind: 'initial', limit: 10 } }, h.context));
        expect(result).toMatchObject({ kind: 'complete', observations: [{ localRef: ref }],
            evidence: { kind: 'partial', omittedItemCount: 1 } });
    });

    it('refuses a cross-site reference before materializing credentials', async () => {
        const h = host(() => ({ body: issue }));
        const result = await getJiraEntry({ v: 1, instance, localRef: { ...ref, collisionScope: 'jira:https://other.atlassian.net' } }, h.context);
        expect(result).toMatchObject({ kind: 'unresolved', failure: { class: 'unsupportedContract' } });
        expect(h.materializeListedAccount).not.toHaveBeenCalled();
        expect(h.request).not.toHaveBeenCalled();
    });

    it('projects ADF and native detail facts without guessing the Sprint custom-field id', async () => {
        const h = host((url) => ({ body: url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' } : issue }));
        const result = JiraDetailResultSchema.parse(await readJiraDetail({ v: 1, instance, localRef: ref }, h.context));
        expect(result).toMatchObject({ kind: 'detail', body: 'Keep queued work.\n', fields: expect.arrayContaining([
            { label: 'Issue type', value: 'Task' }, { label: 'Priority', value: 'High' },
            { label: 'Sprint', value: 'October sprint' }, { label: 'Labels', value: 'reliability' },
            { label: 'Parent', value: 'ABC-120 · Queue program' },
            { label: 'Subtasks', value: 'ABC-124 · Exercise recovery' },
            { label: 'Is blocked by', value: 'ABC-119 · Fix custody' },
        ]) });
    });

    it('reaches Jira HTTP through the declared activated Action and the real Triage aggregate', async () => {
        assertTriageSourceContributionV1(PLUGIN_MANIFEST);
        type Handler = (input: unknown, context: PluginInvocationContext) => Promise<unknown>;
        const handlers = new Map<string, Handler>();
        // Genuine host registration boundary; SDK activation and source handlers remain real.
        activateAccount({ actions: { register: (id: string, handler: Handler) => handlers.set(id, handler) },
            connectedAccounts: { register: () => {} },
        } as unknown as PluginApi);
        const contribution = PLUGIN_MANIFEST.contributes.targetedPluginContributions[0];
        if (!contribution) throw new Error('Jira source contribution is missing');
        const scan = handlers.get(contribution.operations.scan ?? '');
        if (!scan) throw new Error('The declared Jira scan was not activated');
        const h = host((url, body) => ({ body: url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' }
            : { issues: [{ ...issue, id: (body as { nextPageToken?: string }).nextPageToken ? '10005' : '10001' }],
                isLast: Boolean((body as { nextPageToken?: string }).nextPageToken),
                ...((body as { nextPageToken?: string }).nextPageToken ? {} : { nextPageToken: 'provider-page-2' }) } }));
        const result = await runTriageScanPass({ lanes: [{ source, sourceInstanceId: instance.instance.sourceInstanceId,
            configured: instance, declaredKindIds: ['issue'],
            scan: async (input) => TriageScanResultV1Schema.parse(await scan(input, h.context)),
        }], pageLimit: 1, observationBudget: 2, nowMs: () => 1000 });
        expect(result.observations.map((row) => row.entryRef.entryId)).toEqual(['10001', '10005']);
        expect(result.lanes[0]).toMatchObject({ exhausted: true });
    });

    it('creates once using configured issue type and provider required-field metadata, then verifies the returned issue', async () => {
        const configured = { ...instance, configuration: { v: 1 as const, token: JSON.stringify({ v: 1, projectId: '10000', involvement: 'mine', issueTypeId: '10002' }) } };
        const h = host((url, body) => {
            if (url.pathname.includes('/createmeta/')) return { body: { fields: [
                { fieldId: 'summary', required: true, operations: ['set'] },
                { fieldId: 'project', required: true, operations: ['set'] },
                { fieldId: 'issuetype', required: true, operations: ['set'] },
            ], startAt: 0, maxResults: 50, total: 3 } };
            if (url.pathname === '/rest/api/3/issue') {
                expect(body).toMatchObject({ fields: { summary: 'Repair custody', project: { id: '10000' }, issuetype: { id: '10002' } } });
                return { status: 201, body: { id: issue.id, key: issue.key } };
            }
            return { body: url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' }
                : { ...issue, fields: { ...issue.fields, summary: 'Repair custody' } } };
        });
        expect(await createJiraIssue({ v: 1, instance: configured, kindId: 'issue', initialStatusId: 'native-state',
            fields: { title: 'Repair custody' } }, h.context)).toEqual({ kind: 'refused', reason: 'jira/unsupportedField' });
        expect(h.request).not.toHaveBeenCalled();
        const result = TriageTaskWriteResultV1Schema.parse(await createJiraIssue({ v: 1, instance: configured, kindId: 'issue', fields: { title: 'Repair custody' } }, h.context));
        expect(result).toMatchObject({ kind: 'applied', observation: { localRef: ref, snapshot: { title: 'Repair custody' } } });
        expect(h.request.mock.calls.filter(([r]) => new URL(r.url).pathname === '/rest/api/3/issue')).toHaveLength(1);
    });

    it('refuses unsupported required fields before creation', async () => {
        const configured = { ...instance, configuration: { v: 1 as const, token: JSON.stringify({ v: 1, projectId: '10000', involvement: 'mine', issueTypeId: '10002' }) } };
        const h = host(() => ({ body: { fields: [{ fieldId: 'summary', required: true, operations: ['set'] },
            { fieldId: 'customfield_12000', required: true, hasDefaultValue: false, operations: ['set'] }], startAt: 0, maxResults: 50, total: 2 } }));
        expect(await createJiraIssue({ v: 1, instance: configured, kindId: 'issue', fields: { title: 'Repair custody' } }, h.context)).toEqual({ kind: 'refused', reason: 'jira/requiredFieldUnsupported' });
        expect(h.request.mock.calls.every(([r]) => !r.body)).toBe(true);
    });

    it('edits only offered fields and verifies the exact title and ADF body after the provider write', async () => {
        let edited = false;
        const h = host((url, body) => {
            if (url.pathname.endsWith('/editmeta')) return { body: { fields: { summary: { operations: ['set'] }, description: { operations: ['set'] } } } };
            if (body) { edited = true; return { status: 204, body: null }; }
            return { body: url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' }
                : { ...issue, fields: { ...issue.fields, ...(edited ? { summary: 'New title', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New body' }] }] } } : {}) } } };
        });
        const kit = await createPluginTestkit({ manifest: JIRA_PLUGIN.manifest,
            module: { activate: JIRA_PLUGIN.activate, activateAccount }, services: h.context.services });
        try {
            expect(await kit.invokeAction(JIRA_ACTIONS.edit, { v: 1, instance, localRef: ref, fields: { title: 'New title', body: 'New body' } }))
                .toMatchObject({ kind: 'applied', observation: { snapshot: { title: 'New title' } } });
            expect(h.request.mock.calls.filter(([r]) => r.body)).toHaveLength(1);
            h.request.mockClear();
            h.materializeListedAccount.mockRejectedValue(new Error('selected account unavailable'));
            expect(await kit.invokeAction(JIRA_ACTIONS.edit, { v: 1, instance, localRef: ref, fields: { title: 'Another title' } }))
                .toMatchObject({ kind: 'failed', failure: { class: 'authentication' } });
            expect(h.request).not.toHaveBeenCalled();
        } finally { await kit.dispose(); }
    });

    it('keeps an Account Jira edit cancelled after dispatch uncertain without replay', async () => {
        const controller = new AbortController();
        const h = host((url, body) => {
            if (url.pathname.endsWith('/editmeta')) return { body: { fields: { summary: { operations: ['set'] } } } };
            if (body) { controller.abort(); throw new Error('cancelled after send'); }
            return { body: url.pathname.endsWith('/myself') ? { accountId: 'person-1' } : issue };
        });
        const kit = await createPluginTestkit({ manifest: JIRA_PLUGIN.manifest,
            module: { activate: JIRA_PLUGIN.activate, activateAccount }, services: h.context.services });
        try {
            const handler = kit.registration('actions', JIRA_ACTIONS.edit);
            if (!handler) throw new Error('Missing Account edit Action');
            // Observe source settlement before the Action RPC discards an aborted reply.
            expect(await handler({ v: 1, instance, localRef: ref, fields: { title: 'New title' } }, { ...h.context, signal: controller.signal }))
                .toMatchObject({ kind: 'uncertain' });
            expect(h.request.mock.calls.filter(([r]) => r.body)).toHaveLength(1);
        } finally { await kit.dispose(); }
    });

    it('uses an offered native transition id and does not replay an uncertain write', async () => {
        const h = host((url, body) => {
            if (url.pathname.endsWith('/transitions')) return body ? { status: 503, body: {} }
                : { body: { transitions: [{ id: '31', name: 'Done', to: { id: '5', name: 'Done', statusCategory: { key: 'done' } }, fields: {} }] } };
            return { body: url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' } : issue };
        });
        expect(await transitionJiraIssue({ v: 1, instance, localRef: ref, transitionId: '31' }, h.context)).toMatchObject({ kind: 'uncertain' });
        expect(h.request.mock.calls.filter(([r]) => r.body)).toHaveLength(1);
        const refused = host((url) => ({ body: url.pathname.endsWith('/transitions') ? { transitions: [] } : issue }));
        expect(await transitionJiraIssue({ v: 1, instance, localRef: ref, transitionId: '99' }, refused.context)).toMatchObject({ kind: 'refused', reason: 'jira/transitionUnavailable' });
    });

    it.each(['\n', '\r\n'])('publishes a multiline comment once as ADF and confirms the exact stored body (%j)', async (newline) => {
        const adf = { type: 'doc', version: 1, content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Checked recovery.' }] },
            { type: 'paragraph', content: [] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Queued work survived.' }] },
        ] };
        let storedBody: unknown;
        const h = host((url, body) => {
            if (url.pathname.includes('/comment')) {
                if (body) {
                    expect(body).toEqual({ body: adf });
                    storedBody = (body as { body: unknown }).body;
                }
                return { status: body ? 201 : 200, body: { id: '12000', body: storedBody } };
            }
            return { body: url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' } : issue };
        });
        expect(await commentJiraIssue({ entry: { v: 1, instance, localRef: ref }, body: ['Checked recovery.', '', 'Queued work survived.'].join(newline) }, h.context)).toMatchObject({ kind: 'applied' });
        expect(storedBody).toEqual(adf);
        expect(h.request.mock.calls.filter(([r]) => r.body)).toHaveLength(1);
        expect(h.request.mock.calls.filter(([r]) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/comment'))).toHaveLength(1);
    });

    it('keeps a genuinely different confirmed comment uncertain without a second POST', async () => {
        const h = host((url, body) => {
            if (url.pathname.includes('/comment')) return { status: body ? 201 : 200, body: { id: '12000', body: {
                type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Changed by another editor.' }] }],
            } } };
            return { body: url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' } : issue };
        });
        expect(await commentJiraIssue({ entry: { v: 1, instance, localRef: ref }, body: 'Checked\r\nrecovery.' }, h.context)).toMatchObject({ kind: 'uncertain' });
        expect(h.request.mock.calls.filter(([r]) => r.body)).toHaveLength(1);
        expect(h.request.mock.calls.filter(([r]) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/comment'))).toHaveLength(1);
    });

    // REST v3 Get issue returns a field projection, not evidence of an empty
    // value for an omitted key. Explicit null and [] are JSON field values.
    // https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get
    it.each([
        { nativeKey: 'description', fields: { body: '' }, empty: null },
        { nativeKey: 'labels', fields: { labelIds: [] }, empty: [] },
        { nativeKey: 'assignee', fields: { assigneeIds: [] }, empty: null },
        { nativeKey: 'priority', fields: { priority: null }, empty: null },
        { nativeKey: 'duedate', fields: { dueDate: null }, empty: null },
        { nativeKey: 'parent', fields: { parent: null }, empty: null },
    ])('requires $nativeKey evidence before treating a clear as applied', async ({ nativeKey, fields, empty }) => {
        for (const evidence of ['missing', 'missing-after-write', 'already-empty', 'cleared'] as const) {
            let writes = 0;
            const h = host((url, body) => {
                if (url.pathname.endsWith('/editmeta')) return { body: { fields: { [nativeKey]: { operations: ['set'] } } } };
                if (body) { writes += 1; return { status: 204, body: null }; }
                if (url.pathname === '/rest/api/3/myself') return { body: { accountId: 'person-1' } };
                expect(url.searchParams.get('fields')).toBe('*all');
                const native: Record<string, unknown> = { ...issue.fields };
                delete native[nativeKey];
                if (evidence === 'missing-after-write' && writes === 0) native[nativeKey] = nativeKey === 'duedate' ? '2026-10-20' : issue.fields[nativeKey as keyof typeof issue.fields];
                if (evidence === 'already-empty' || (evidence === 'cleared' && writes > 0)) native[nativeKey] = empty;
                return { body: { ...issue, fields: native } };
            });
            const result = TriageTaskWriteResultV1Schema.parse(await editJiraIssue({ v: 1, instance, localRef: ref, fields }, h.context));
            expect(result.kind, evidence).toBe(evidence === 'missing' || evidence === 'missing-after-write' ? 'uncertain' : 'applied');
            expect(writes, evidence).toBe(evidence === 'already-empty' ? 0 : 1);
        }
    });

    it('exposes native transitions with required inputs and offered edit fields on an exact read', async () => {
        const h = host((url) => ({ body: url.pathname.endsWith('/transitions') ? { transitions: [
            { id: '31', name: 'Complete', to: { id: '5', name: 'Done', statusCategory: { key: 'done' } }, fields: {} },
            { id: '41', name: 'Require approval', to: { id: '6' }, fields: { resolution: { name: 'Resolution', required: true,
                hasDefaultValue: false, operations: ['set'], schema: { type: 'resolution' }, allowedValues: [{ id: '1', name: 'Fixed' }] } } },
            { id: '51', name: 'Native application step', to: { id: '7' }, fields: { customfield_13000: { name: 'Application data',
                required: true, operations: ['set'], schema: { type: 'json' } } } },
        ] } : url.pathname.endsWith('/editmeta') ? { fields: { summary: { operations: ['set'] }, priority: { operations: ['set'] } } }
            : url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' } : issue }));
        const read = TriageGetResultV1Schema.parse(await getJiraEntry({ v: 1, instance, localRef: ref }, h.context));
        expect(read).toMatchObject({ kind: 'present', snapshot: {
            taskCapabilities: { editFields: ['title', 'priority'], transitions: [
                { id: '31', label: 'Complete', state: { presentation: 'resolved', completionReason: 'completed' } },
                { id: '41', label: 'Require approval', requiredFields: [{ id: 'resolution', label: 'Resolution', kind: 'choice', options: [{ id: '1', label: 'Fixed' }] }] },
                { id: '51', label: 'Native application step', requiredFields: [{ id: 'customfield_13000', label: 'Application data', kind: 'unsupported' }] },
            ] },
        } });
        expect(read).not.toHaveProperty('snapshot.taskCapabilities.completingTransitionId');
    });

    it.each(['applied', 'missing', 'invalid', 'duplicate', 'unoffered', 'provider-refusal', 'lost-response', 'unconfirmed-fields'] as const)(
        'collects required native transition inputs, validates fresh metadata and writes at most once: %s', async (scenario) => {
        let writes = 0;
        const fields = { resolution: { name: 'Resolution', required: true, hasDefaultValue: false, operations: ['set'],
            schema: { type: 'resolution' }, allowedValues: [{ id: '1', name: 'Fixed' }] },
            customfield_12000: { name: 'Reason', required: true, operations: ['set'], schema: { type: 'string' } } };
        const h = host((url, body) => {
            if (url.pathname.endsWith('/transitions')) {
                if (!body) return { body: { transitions: [{ id: '31', name: 'Done', to: { id: '5', name: 'Done', statusCategory: { key: 'done' } }, fields }] } };
                writes += 1;
                expect(body).toEqual({ transition: { id: '31' }, fields: { resolution: { id: '1' }, customfield_12000: 'Verified' } });
                return { status: scenario === 'provider-refusal' ? 400 : scenario === 'lost-response' ? 503 : 204, body: null };
            }
            return { body: url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' } : {
                ...issue, fields: { ...issue.fields, ...(writes > 0 && (scenario === 'applied' || scenario === 'unconfirmed-fields')
                    ? { status: { id: '5', name: 'Done', statusCategory: { key: 'done' } },
                        ...(scenario === 'applied' ? { resolution: { id: '1' }, customfield_12000: 'Verified' } : {}) } : {}) },
            } };
        });
        const fieldValues = [{ fieldId: 'resolution', value: scenario === 'invalid' ? 'obsolete' : '1' },
            { fieldId: 'customfield_12000', value: 'Verified' }];
        if (scenario === 'missing') fieldValues.pop();
        if (scenario === 'duplicate') fieldValues.push(fieldValues[0]!);
        if (scenario === 'unoffered') fieldValues.push({ fieldId: 'description', value: 'Not on this transition screen' });
        const result = TriageTaskWriteResultV1Schema.parse(await transitionJiraIssue({ v: 1, instance, localRef: ref, transitionId: '31', fieldValues }, h.context));
        expect(result.kind).toBe(scenario === 'applied' ? 'applied' : scenario === 'provider-refusal' ? 'failed'
            : scenario === 'lost-response' || scenario === 'unconfirmed-fields' ? 'uncertain' : 'refused');
        if (scenario === 'provider-refusal') expect(result).toMatchObject({ failure: { code: 'jira/http400' } });
        expect(writes).toBe(['applied', 'provider-refusal', 'lost-response', 'unconfirmed-fields'].includes(scenario) ? 1 : 0);
    });

    it.each([false, true])('uses the declared native transition Action and verifies typed number, option-list and ADF inputs (changed options: %s)', async (changedOptions) => {
        type Handler = (input: unknown, context: PluginInvocationContext) => Promise<unknown>;
        const handlers = new Map<string, Handler>();
        activateAccount({ actions: { register: (id: string, handler: Handler) => handlers.set(id, handler) },
            connectedAccounts: { register: () => {} },
        } as unknown as PluginApi);
        const contribution = PLUGIN_MANIFEST.contributes.targetedPluginContributions[0];
        const transition = handlers.get(contribution?.operations.transition ?? '');
        if (transition === undefined) throw new Error('Declared native transition Action was not activated');
        let stored: Record<string, unknown> = {};
        const h = host((url, body) => {
            if (url.pathname.endsWith('/transitions')) {
                if (!body) return { body: { transitions: [{ id: '31', name: 'Done', to: { id: '5' }, fields: {
                    description: { name: 'Reason', required: true, operations: ['set'], schema: { type: 'string' } },
                    customfield_12000: { name: 'Effort', required: true, operations: ['set'], schema: { type: 'number' } },
                    fixVersions: { name: 'Fix versions', required: true, operations: ['set'], schema: { type: 'array', items: 'version' },
                        allowedValues: [{ id: '11', name: '1.1' }, { id: '12', name: '1.2' }] },
                } }] } };
                expect(body).toMatchObject({ transition: { id: '31' }, fields: { customfield_12000: 3, fixVersions: [{ id: '11' }, { id: '12' }],
                    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Verified' }] }] } } });
                stored = { ...(body as { fields: Record<string, unknown> }).fields,
                    ...(changedOptions ? { fixVersions: [{ id: '11' }, { id: '11' }] } : {}) };
                return { status: 204, body: null };
            }
            return { body: url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' } : {
                ...issue, fields: { ...issue.fields, ...stored,
                    ...(Object.keys(stored).length === 0 ? {} : { status: { id: '5', name: 'Done', statusCategory: { key: 'done' } } }) },
            } };
        });
        expect(await transition({ v: 1, instance, localRef: ref, transitionId: '31', fieldValues: [
            { fieldId: 'description', value: 'Verified' }, { fieldId: 'customfield_12000', value: 3 }, { fieldId: 'fixVersions', value: ['11', '12'] },
        ] }, h.context)).toMatchObject({ kind: changedOptions ? 'uncertain' : 'applied' });
        expect(h.request.mock.calls.filter(([request]) => request.method === 'POST')).toHaveLength(1);
    });

    it('accepts the canonical string priority id and confirms the native transition outcome', async () => {
        let changed = false;
        const h = host((url, body) => {
            if (url.pathname.endsWith('/editmeta')) return { body: { fields: { priority: { operations: ['set'], allowedValues: [{ id: '2' }] } } } };
            if (url.pathname.endsWith('/transitions')) return body ? (changed = true, { status: 204, body: null })
                : { body: { transitions: [{ id: '31', to: { id: '5', name: 'Done', statusCategory: { key: 'done' } }, fields: {} }] } };
            return { body: url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' }
                : { ...issue, fields: { ...issue.fields, ...(changed ? { status: { id: '5', name: 'Done', statusCategory: { key: 'done' } } } : {}) } } };
        });
        expect(await editJiraIssue({ v: 1, instance, localRef: ref, fields: { priority: '2' } }, h.context)).toMatchObject({ kind: 'applied' });
        expect(await transitionJiraIssue({ v: 1, instance, localRef: ref, transitionId: '31' }, h.context)).toMatchObject({ kind: 'applied', observation: { snapshot: { state: { presentation: 'resolved' } } } });
    });

    it('keeps an ambiguous comment outcome uncertain without replay or a guessed comment match', async () => {
        const h = host((url, body) => ({ status: body ? 503 : 200, body: url.pathname === '/rest/api/3/myself' ? { accountId: 'person-1' } : issue }));
        expect(await commentJiraIssue({ entry: { v: 1, instance, localRef: ref }, body: 'Checked recovery.' }, h.context)).toMatchObject({ kind: 'uncertain' });
        expect(h.request.mock.calls.filter(([r]) => r.body)).toHaveLength(1);
    });

    it('offers every native issue type through its activated exact-account configuration Action', async () => {
        type Handler = (input: unknown, context: PluginInvocationContext) => Promise<unknown>;
        const handlers = new Map<string, Handler>();
        activateAccount({ actions: { register: (id: string, handler: Handler) => handlers.set(id, handler) },
            connectedAccounts: { register: () => {} },
        } as unknown as PluginApi);
        const h = host((url) => ({ body: { startAt: Number(url.searchParams.get('startAt')), maxResults: 1, total: 2,
            issueTypes: [{ id: Number(url.searchParams.get('startAt')) === 0 ? '10002' : '10003', name: 'Task' }] } }));
        const read = handlers.get('issues/list-types');
        expect(read).toBeDefined();
        expect(await read?.({ binding: instance.binding, localInstanceKey: instance.localInstanceKey, configuration: instance.configuration }, h.context))
            .toEqual({ kind: 'complete', issueTypes: [{ id: '10002', name: 'Task' }, { id: '10003', name: 'Task' }] });
    });
});
