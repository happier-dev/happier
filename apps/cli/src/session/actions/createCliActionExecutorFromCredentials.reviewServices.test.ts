import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createCliActionExecutor } from './createCliActionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN_MANIFEST as TRIAGE_MANIFEST, TRIAGE_PLUGIN } from '@happier-dev/plugins-triage/manifest';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../../../../../packages/plugins/triage/src/internalTasks/configuration';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { resolveSessionRoleRpcOrigin } from './sessionRoleRpcOrigin';
import { ReviewCommentV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { sealReviewCommentSensitiveEnvelopeV1, splitReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/content';
import { REVIEW_COMMENT_PRINCIPAL_HEADER_V1, ReviewCommentPrincipalHeaderV1Schema } from '@happier-dev/protocol/reviews/comments/actions';
import { buildWorkflowActionContext } from '@/daemon/workflows/workflowActionContext';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('lets an own-requester detached Workflow verifier read and dismiss a durable finding while refusing a guest', () =>
  withConfiguredDaemonTestHome({ prefix: 'detached-verifier-custody-', machineId: 'machine' }, async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const executor = createCliActionExecutor({ token, credentials: { token, encryption: null },
        sessionId: '', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.example.test',
        pluginActionExecutionOwner: 'current_process', actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({
            v: 1, approvalWaivedSurfaces: { 'reviews.comments.transition': ['agent'] },
        }) } });
    const runId = '8efb5a70-5620-4ba4-982c-165e54f52dc1';
    const requestId = `${runId}/b6ce47df-7e70-4d23-9b66-7c6af1c1e810/0`;
    const verifier = (accountId: string) => {
        const callerInputAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-verified-review', binding: {
            accountId, custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
            serverIdentityId: 'srv_home', machineId: 'machine', installationId: 'installation', actionId: 'review.start',
            requestId, workflowActionOrigin: { runId, requestId }, target: { kind: 'machine', machineId: 'machine' },
            accountEncryptionMode: 'plain', admittedMachineRole: 'manage', requestEnvelopeDigest: 'a'.repeat(43),
        } });
        return { ...buildWorkflowActionContext({ runId, authorization: { principal: { kind: 'host' },
            admittedPermissionCeiling: 'read-only' } }, { accountId, serverId: 'home', machineId: 'machine', installationId: 'installation' }),
            callerInputAuthorization };
    };
    let finding = ReviewCommentV1Schema.parse({ v: 1, id: 'finding', accountId: 'owner', projectId: 'project',
        anchor: { kind: 'file', filePath: 'example.ts' }, snapshot: { kind: 'none', capturedAt: 1 }, body: 'Verify this finding.',
        bodyVersion: 1, edits: [], author: { kind: 'workflow', runId }, state: 'proposed', flags: {}, dispositions: {},
        threadId: 'finding', transitions: [], createdAt: 1, updatedAt: 1, serverRevision: 1 });
    const expectWorkflowPrincipal = (header: unknown, method: 'GET' | 'POST', path: string) => {
        expect(typeof header).toBe('string');
        const principal = ReviewCommentPrincipalHeaderV1Schema.parse(JSON.parse(Buffer.from(String(header), 'base64url').toString()));
        expect(principal).toMatchObject({ actor: { kind: 'workflow', runId }, proof: { machineId: 'machine', method, path } });
    };
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        expect(url).toBe('https://home.example.test/v1/reviews/comments');
        const principal = config?.headers?.[REVIEW_COMMENT_PRINCIPAL_HEADER_V1];
        if (principal) expectWorkflowPrincipal(principal, 'GET', '/v1/reviews/comments');
        const { structural, sensitive } = splitReviewCommentV1(finding);
        return { status: 200, data: { items: [{ v: 1, structural,
            sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ structural, sensitive, mode: 'plain' }) }], cursor: null } };
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
        expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
        expect(url).toBe('https://home.example.test/v1/reviews/comments/finding/transition');
        expectWorkflowPrincipal(config?.headers?.[REVIEW_COMMENT_PRINCIPAL_HEADER_V1], 'POST', '/v1/reviews/comments/finding/transition');
        expect(body).toMatchObject({ projectId: finding.projectId, expectedState: finding.state,
            expectedServerRevision: finding.serverRevision, toState: 'dismissed', clientMutationId: 'verify-finding' });
        finding = { ...finding, state: 'dismissed', serverRevision: 2 };
        return { status: 200, data: { comment: finding } };
    });
    const scope = { projectId: 'project' };
    const installedControl = { surface: 'cli' as const, authority: 'present_user' as const };
    await expect(executor.execute('reviews.comments.list', scope, installedControl))
        .resolves.toMatchObject({ ok: true, result: { items: [{ id: 'finding', state: 'proposed' }] } });
    const guest = verifier('guest');
    get.mockClear();
    const verdict = { ...scope, commentId: 'finding', expectedState: 'proposed', expectedServerRevision: 1,
        toState: 'dismissed', reason: 'The finding does not apply to the captured change.', clientMutationId: 'verify-finding' };
    for (const [actionId, input] of [['reviews.comments.list', scope], ['reviews.comments.transition', verdict]] as const) {
        await expect(executor.execute(actionId, input, guest)).resolves.toMatchObject({ ok: false, errorCode: 'review_comment_account_custody_denied' });
    }
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    const own = verifier('owner');
    const before = await executor.execute('reviews.comments.list', scope, own);
    expect(before, JSON.stringify(before)).toMatchObject({ ok: true, result: { items: [{ id: 'finding', state: 'proposed' }] } });
    const after = await executor.execute('reviews.comments.transition', verdict, own);
    expect(after, JSON.stringify(after)).toMatchObject({ ok: true, result: { comment: { id: 'finding', state: 'dismissed', serverRevision: 2 } } });
    await expect(executor.execute('reviews.comments.list', { ...scope, includeHistory: true }, installedControl))
        .resolves.toMatchObject({ ok: true, result: { items: [{ id: 'finding', state: 'dismissed', serverRevision: 2 }] } });
  }));

it.each([
    { name: 'original own Account', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, allowed: true },
    { name: 'foreign Account on the shared Machine', accountId: 'guest', authentication: { kind: 'account', tokenEpoch: 1 }, allowed: false },
    { name: 'restricted API token', accountId: 'owner', authentication: null, allowed: false },
    { name: 'Session-origin Account', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, sessionOrigin: true, allowed: false },
    { name: 'own Account with Session-scoped transport', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, sessionTransport: true, allowed: false },
] as const)('keeps the actual Triage selected-finding read bound to $name', async scenario => {
    const { accountId, authentication, allowed } = scenario;
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const executor = createCliActionExecutor({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain',
        ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.example.test', serverIdentityId: 'srv_home', pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const sessionActionOrigin = 'sessionOrigin' in scenario ? resolveSessionRoleRpcOrigin({
        actionCaller: { kind: 'session', sessionId: 'owner-session', starterDepth: 0, turnDepth: 0 },
        sessionInputSource: { sourceSessionId: 'owner-session', sourceTurnId: 'turn', sourceInputId: 'input' },
        actionRequestId: 'task-press', callerPermissionMode: 'default', workspaceWrites: 'deny',
    }) : undefined;
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-verified-root', binding: {
        accountId, custodianAccountId: 'owner',
        ...(authentication ? { authentication } : { principalId: accountId, credentialId: '00000000-0000-4000-8000-000000000001',
            grant: ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: ['reviews.comments.list'] }, targets: { sessions: [], machines: ['machine'] },
                approve: false, origins: [], models: null, permissionModes: null, create: null }) }),
        ...(sessionActionOrigin ? { sessionActionOrigin, sessionActionSource: { machineId: 'machine', installationId: 'installation' } } : {}),
        serverIdentityId: 'srv_home', machineId: 'machine',
        installationId: 'installation', actionId: 'action.invoke', requestId: 'task-press', target,
        accountEncryptionMode: 'plain', admittedMachineRole: 'manage', requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const controller = new AbortController();
    const caller = createPluginActionCallerMaterializationFixture(TRIAGE_MANIFEST.id, { machineId: 'machine' });
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        runtimeAccountId: 'owner', serverId: 'home', serverIdentityId: 'srv_home', externalActionTarget: target,
        externalActionExecutionAuthorization: authorization, ...(sessionActionOrigin ? { sessionActionOrigin } : {}),
        ...('sessionTransport' in scenario ? { rpcSessionAuthorization: { kind: 'session.write' as const, sessionId: 'owner-session' } } : {}) };
    const actions = createPluginInvocationActionsService({ seed: {
        plugin: { id: TRIAGE_MANIFEST.id, version: TRIAGE_MANIFEST.version }, occurrenceId: 'triage-task-press',
        contribution: { id: 'tasks/create-v1', qualifiedId: `${TRIAGE_MANIFEST.id}/actions/tasks/create-v1` },
        sourceCustody: createManagedPluginSourceCustody('triage-task-generation'),
        surface: 'ui', signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
        resolveCurrentPluginMaterializationRef: caller.resolveCurrentPluginMaterializationRef,
        approvalContext: context,
    }, actionExecutor: executor, invokeContributedAction: async () => { throw new Error('No task effect should precede the Review read'); } });
    const plugin = await createPluginTestkit({ manifest: TRIAGE_MANIFEST, module: { ...TRIAGE_PLUGIN, activateAccount(api) {
        // The SDK's self-contribution fixture is replaced by the real host Action service, as in the Task owner tests.
        TRIAGE_PLUGIN.activateAccount({ ...api, actions: { register(id, handler, options) {
            api.actions.register(id, (input, context) => handler(input,
                { ...context, services: { ...context.services, actions } }), options);
        } } });
    } } });
    // Home HTTP is the boundary. A missing Review gives an observable control after credential admission, before task writes.
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: { error: 'not_found' } });
    const configured = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured;
    try {
        await expect(plugin.invokeAction('tasks/create-v1', { v: 1, source: configured.instance.source,
            sourceInstanceId: configured.instance.sourceInstanceId, kindId: 'task', fields: { title: 'Selected finding' },
            originReview: { reviewId: 'missing-review', findingIds: ['finding'] } }, { surface: 'ui' }))
            .rejects.toMatchObject({ code: allowed ? 'review_comment_encryption_material_unavailable' : 'review_comment_account_custody_denied' });
        if (allowed) expect(get).toHaveBeenCalled();
        else expect(get).not.toHaveBeenCalled();
        const services = await executor.resolveReviewServices!(context);
        if (allowed) expect(services.comments).toBeTypeOf('function');
        else expect(services).toEqual({});
    } finally { controller.abort(); await plugin.dispose(); }
});

it.each([
    { name: 'owner', accountId: 'owner', actorAccountId: 'owner', allowed: true },
    { name: 'Manage guest', accountId: 'guest', actorAccountId: 'guest', allowed: false },
    { name: 'guest with owner attribution', accountId: 'owner', actorAccountId: 'guest', allowed: false },
    { name: 'foreign runtime Account', accountId: 'guest', allowed: false },
])('admits $name before handing installed Account Review services to a Workflow', async ({ accountId, actorAccountId, allowed }) => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const executor = createCliActionExecutor({ token, credentials: { token, encryption: null },
        sessionId: '', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.example.test',
        pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
    let current = true;
    const verifyMachineAdmissionCurrent = vi.fn(async () => current);
    const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation', runtimeAccountId: accountId,
        ...(actorAccountId ? { machineAdmission: { actorAccountId, custodianAccountId: 'owner', machineId: 'machine',
            installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent } : {}) };
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: { error: 'not_found' } });
    const direct = await executor.execute('reviews.comments.list', { reviewId: 'missing-review' }, context);
    if (allowed) {
        expect(direct, JSON.stringify(direct)).toMatchObject({ ok: false, error: 'review_comment_encryption_material_unavailable' });
        expect(get).toHaveBeenCalled();
    } else {
        expect(direct, JSON.stringify(direct)).toMatchObject({ ok: false, errorCode: 'review_comment_account_custody_denied' });
        expect(get).not.toHaveBeenCalled();
    }
    if (!allowed) {
        await expect(executor.prepare!('reviews.comments.list', { reviewId: 'missing-review' }, context))
            .resolves.toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'review_comment_account_custody_denied' } });
        expect(get).not.toHaveBeenCalled();
    }
    verifyMachineAdmissionCurrent.mockClear();
    const services = await executor.resolveReviewServices!(context);
    if (!allowed) {
        expect(services).toEqual({});
        return;
    }
    expect(services.records).toBeDefined();
    expect(services.comments).toBeTypeOf('function');
    // The port has been admitted. Later finite work consumes it without a new
    // Machine admission check after withdrawal.
    current = false;
    await expect(services.records!.read('missing-review')).resolves.toBeNull();
    await expect(services.comments!({ actionId: 'reviews.comments.list', input: { reviewId: 'missing-review' } }))
        .rejects.toThrow('review_comment_encryption_material_unavailable');
    expect(verifyMachineAdmissionCurrent).toHaveBeenCalledTimes(1);
});

it.each([
    { name: 'owner', actorAccountId: 'owner', runtimeAccountId: 'owner', allowed: true },
    { name: 'Manage guest', actorAccountId: 'guest', runtimeAccountId: 'guest', allowed: false },
    { name: 'guest with owner attribution', actorAccountId: 'guest', runtimeAccountId: 'owner', allowed: false },
    { name: 'guest signing as their own Account', actorAccountId: 'guest', runtimeAccountId: 'guest', allowed: 'requester' },
] as const)('keeps installed Account Review record writes from a $name Machine caller', async ({ actorAccountId, runtimeAccountId, allowed }) => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const executor = createCliActionExecutor({ token, credentials: { token, encryption: null },
        sessionId: '', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.example.test',
        pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
    const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', runtimeAccountId,
        machineAdmission: { actorAccountId, custodianAccountId: 'owner', machineId: 'machine',
            installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true,
        ...(allowed === 'requester' ? { externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
            token: 'home-verified-root', binding: { accountId: 'guest', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
                serverIdentityId: 'srv_home', machineId: 'machine', installationId: 'installation', actionId: 'review.new_round',
                requestId: 'guest-round', target: { kind: 'machine', machineId: 'machine' }, accountEncryptionMode: 'plain',
                admittedMachineRole: 'manage', requestEnvelopeDigest: 'a'.repeat(43) } }) } : {}) };
    // Home HTTP is the boundary: an owner-credential Review read is the first record effect of a new round.
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: { error: 'not_found' } });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 404, data: { error: 'not_found' } });
    const result = await executor.execute('review.new_round', { reviewId: 'owner-review' }, context);
    const homeCalls = [...get.mock.calls, ...post.mock.calls];
    if (allowed === 'requester') {
        // The requester's own signed authority is Home's to decide; only installed credentials are withheld.
        expect(result).not.toMatchObject({ errorCode: 'review_comment_account_custody_denied' });
        expect(homeCalls.flatMap(call => JSON.stringify(call.at(-1) ?? null).includes(token) ? [call[0]] : [])).toEqual([]);
    } else if (allowed) expect(homeCalls.length, JSON.stringify(result)).toBeGreaterThan(0);
    else {
        expect(homeCalls.map(call => [call[0], (call.at(-1) as { headers?: unknown } | undefined)?.headers])).toEqual([]);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'review_comment_account_custody_denied' });
    }
});

it.each([
    { name: 'Session share editor', context: { rpcSessionAuthorization: { kind: 'session.write' as const, sessionId: 'owner-session' } }, allowed: false },
    { name: 'Manage guest', context: { runtimeAccountId: 'guest', machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'owner',
        machineId: 'machine', installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const },
        verifyMachineAdmissionCurrent: async () => true }, allowed: false },
    { name: 'owner', context: { runtimeAccountId: 'owner' }, allowed: true },
    // Home admits the Run action RPC only for the Session owner and stamps that proof.
    { name: 'Session owner over Session RPC', context: { rpcSessionAuthorization: { kind: 'session.write' as const,
        sessionId: 'owner-session', authority: 'sessionOwner' as const } }, allowed: true },
])('admits a $name before a generic Run call spends installed Account Review ports', async ({ context, allowed }) => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const executor = createCliActionExecutor({ token, credentials: { token, encryption: null },
        sessionId: '', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.example.test',
        pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
    const callerContext: ActionExecutorContext = { surface: 'cli', authority: 'present_user', ...context };
    for (const input of [
        // Triage moves the named comment through the hosting Session's Account, whatever Review it belongs to.
        { runId: 'run', actionId: 'review.triage', input: { findings: [{ id: 'finding', commentId: 'owner-comment', status: 'accepted' }] } },
        { runId: 'run', actionId: 'review.new_round', input: {} },
    ]) {
        const prepared = await executor.prepare!('execution.run.action', input, callerContext);
        if (allowed) expect(prepared).not.toMatchObject({ kind: 'settled', result: { errorCode: 'review_comment_account_custody_denied' } });
        else expect(prepared, input.actionId).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'review_comment_account_custody_denied' } });
    }
});

it('keeps host Review services on their captured Home with refreshed Account credentials', async () => {
    const serverApiUrl = 'https://review-home.example.test';
    const serverIdentityId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const credential = (accountId: string, revision: number) => ({
        token: `header.${Buffer.from(JSON.stringify({ sub: accountId, revision,
            provenance: { v: 2, kind: 'terminal', authority: 'account_automation',
                evidence: [{ kind: 'home_method', methodId: 'key_challenge' }] },
        })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const,
    });
    const installed = credential('requester-account', 1);
    let current: ReturnType<typeof credential> | null = credential('requester-account', 1);
    const reads: Array<{ url: string; authorization: unknown }> = [];
    // HTTP is the boundary; credential selection, host context and Review ports remain real.
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(input)).toBe(`${serverApiUrl}/v1/features/authenticated`);
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${current?.token}`);
        return Response.json(FeaturesResponseSchema.parse({ features: {},
            capabilities: { serverIdentity: { serverIdentityId } } }));
    });
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        reads.push({ url: String(url), authorization: config?.headers?.Authorization });
        expect(String(url)).toBe(`${serverApiUrl}/v1/artifacts/missing-review`);
        expect(config?.headers?.Authorization).toBe(`Bearer ${current?.token}`);
        return { status: 404, data: { error: 'not_found' } };
    });
    const executor = createCliActionExecutorFromCredentials({ credentials: installed,
        readCredentials: async () => current, serverId: 'review-home-profile', serverApiUrl,
        pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
    const resolve = executor.resolveReviewServices;
    expect(resolve).toBeTypeOf('function');
    if (!resolve) throw new Error('Review services resolver missing');
    const context = { surface: 'cli' as const, authority: 'account_automation' as const };
    for (const revision of [1, 2]) {
        current = credential('requester-account', revision);
        await runWithServerHttpBaseUrl('https://other-home.example.test', async () => {
            const services = await resolve(context);
            expect(services.records).toBeDefined();
            expect(services.comments).toBeTypeOf('function');
            await expect(services.records!.read('missing-review')).resolves.toBeNull();
            await expect(services.comments!({ actionId: 'reviews.comments.list',
                input: { reviewId: 'missing-review' } }))
                .rejects.toMatchObject({ code: 'review_comment_encryption_material_unavailable' });
            await expect(services.comments!.createBatch!([{ input: {
                reviewId: 'missing-review', anchor: { kind: 'file', filePath: 'review.ts' },
                snapshot: { kind: 'none', capturedAt: 1 }, body: 'Retained finding',
                clientMutationId: `session-finding-${revision}`,
            } }])).resolves.toMatchObject([{ ok: false, errorCode: 'review_comment_encryption_material_unavailable' }]);
        });
    }
    expect(reads).toHaveLength(6);
    current = credential('foreign-account', 1);
    await expect(resolve(context)).resolves.toEqual({});
    expect(reads).toHaveLength(6);
    current = null;
    await expect(resolve(context)).resolves.toEqual({});
    expect(reads).toHaveLength(6);
});
