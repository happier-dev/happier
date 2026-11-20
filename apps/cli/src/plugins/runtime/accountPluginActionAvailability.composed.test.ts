import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionInputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginAccountStorageMutationRequestV1Schema, PluginAccountStorageMutationResponseV1Schema,
    PluginAccountStorageReadResponseV1Schema } from '@happier-dev/protocol/plugins/data/accountKvV1';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { executeAccountPluginAction } from '@/session/actions/executeAccountPluginAction';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';

afterEach(() => vi.restoreAllMocks());

it.each(['replacement', 'uninstalled'] as const)(
    'settles a reviewed Account child against current custody after retirement (%s)', async outcome => {
    const app = fastify();
    const endpoint = 'http://account-action-reacquisition.test';
    const accountId = 'account-action-reacquisition';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const authored = await registerAuthoredAccountActionRelease(app, accountId, { includeAccountProvider: true });
    const pluginId = authored.providerPluginId!;
    const action = { pluginId, localId: 'record' };
    const features = registerAccountHomeHttp(app, { accountId, serverId: 'reacquisition-home' });
    let retired = false;
    app.addHook('preHandler', async request => {
        if (request.url !== PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) return;
        const read = PluginAvailabilityIntentReadActionInputV1Schema.parse(request.body);
        if (read.pluginId === pluginId && read.omitDeclarations) retired = true;
    });
    // Switch the Home response at dispatch to a replacement release with the
    // same Action, or to an Account with the plugin removed.
    app.addHook('onSend', async (request, _reply, payload) => {
        if (!retired || typeof payload !== 'string') return payload;
        const replace = (read: { release?: { ref: { pluginId: string }; archiveDigestSha256: string } | null }) => {
            if (read.release?.ref.pluginId === pluginId) read.release.archiveDigestSha256 = `sha256:${'d'.repeat(64)}`;
        };
        if (request.url === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
            if (PluginAvailabilityIntentReadActionInputV1Schema.parse(request.body).pluginId !== pluginId) return payload;
            const read = JSON.parse(payload);
            if (outcome === 'uninstalled') return JSON.stringify({ ...read, intent: null, release: null, uiArtifacts: [] });
            replace(read);
            return JSON.stringify(read);
        }
        if (request.url === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
            if (outcome === 'uninstalled') {
                const page = JSON.parse(payload);
                page.pluginIds = page.pluginIds.filter((id: string) => id !== pluginId);
                page.intentReads = page.intentReads.filter((read: { pluginId: string }) => read.pluginId !== pluginId);
                return JSON.stringify(page);
            }
            const page = JSON.parse(payload);
            for (const { response } of page.intentReads) replace(response);
            return JSON.stringify(page);
        }
        return payload;
    });
    let writes = 0;
    app.get(`/v1/account/plugin-storage/${pluginId}`, async () => ({ status: 'absent' }));
    app.post(`/v1/account/plugin-storage/${pluginId}`, async request => {
        PluginAccountStorageMutationRequestV1Schema.parse(request.body);
        writes++;
        return PluginAccountStorageMutationResponseV1Schema.parse({ status: 'updated', revision: writes });
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
    const host = { token, credentials, serverHttpBaseUrl: endpoint, serverId: 'reacquisition-home',
        sessionId: 'fixture', mode: 'plain' as const, ctx: null };
    const harness = createCliActionExecutorHarness(host);
    try {
        const result = await invokeHostReviewedChildV1({
            parent: { actionId: 'machines.presets.prepare', input: {} },
            context: { surface: 'cli', authority: 'account_automation', runtimeAccountId: accountId },
            child: { action, role: 'preparationBuild', input: { key: 'prepared' } },
            admittedReview: { action, role: 'preparationBuild', surface: 'cli' },
            execute: async (input, context, actionId) =>
                executeAccountPluginAction({ host, deps: harness.deps, actionId, input, context }),
        });
        expect(retired).toBe(true);
        if (outcome === 'replacement') {
            expect(result).toMatchObject({ matched: true, result: { ok: true, result: { value: 'nested-effect' } } });
            expect(writes).toBe(1);
        } else {
            expect(result).toMatchObject({ matched: true, result: { ok: false,
                errorCode: 'plugin_account_execution_unavailable', effectAttempted: false } });
            expect(writes).toBe(0);
        }
    } finally {
        restore();
        await app.close();
    }
});

it('preserves a transient caller custody refusal through nested Account Actions and admits the next fresh query', async () => {
    const app = fastify();
    const endpoint = 'http://account-action-availability.test';
    const accountId = 'account-action-availability';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const };
    const { pluginId, providerPluginId, setPluginEnabled } = await registerAuthoredAccountActionRelease(app, accountId,
        { includeAccountProvider: true });
    if (!providerPluginId) throw new Error('Missing authored Account provider');
    const actionsSettingsV1 = setActionApprovalOverride({ settings: setActionApprovalOverride({
        settings: normalizeActionsSettingsV1(undefined), actionId: formatQualifiedPluginActionId({ pluginId, localId: 'record-source' }),
        surface: 'cli', approvalRequired: false,
    }), actionId: formatQualifiedPluginActionId({ pluginId: providerPluginId, localId: 'record' }),
    surface: 'plugin', approvalRequired: false });
    const features = registerAccountHomeHttp(app, { accountId, serverId: 'srv_action_availability', settings: { actionsSettingsV1 } });
    let failCallerRead = false;
    let retireCallerRead = false;
    let refusedCallerRead = false;
    let callerReads = 0;
    app.addHook('preHandler', async (request, reply) => {
        if (request.url !== PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) return;
        const read = PluginAvailabilityIntentReadActionInputV1Schema.parse(request.body);
        if (read.pluginId !== pluginId) return;
        callerReads++;
        // The mounted selection and parent admission succeed before the
        // nested Action asks for its caller's current custody.
        if (failCallerRead && callerReads === 3) {
            failCallerRead = false;
            refusedCallerRead = true;
            return reply.code(503).send({ error: 'unavailable' });
        }
        if (retireCallerRead && callerReads === 3) {
            retireCallerRead = false;
            setPluginEnabled(pluginId, false);
        }
    });
    let stored: ReturnType<typeof PluginAccountStorageReadResponseV1Schema.parse> = { status: 'absent' };
    let writes = 0;
    app.get(`/v1/account/plugin-storage/${providerPluginId}`, async () => stored);
    app.post(`/v1/account/plugin-storage/${providerPluginId}`, async request => {
        const mutation = PluginAccountStorageMutationRequestV1Schema.parse(request.body);
        writes++;
        stored = PluginAccountStorageReadResponseV1Schema.parse({ status: 'present', revision: writes, content: mutation.content });
        return PluginAccountStorageMutationResponseV1Schema.parse({ status: 'updated', revision: writes });
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'action_availability',
        serverIdentityId: 'srv_action_availability', serverApiUrl: endpoint });
    let query = 0;
    const invoke = () => {
        const actionRequestId = `account-availability-query-${++query}`;
        return executor.execute('action.invoke', { action: { pluginId, localId: 'record-source' },
            input: { key: `recorded-${query}` } }, { surface: 'cli', runtimeAccountId: accountId, actionRequestId,
            serverId: 'action_availability', serverIdentityId: 'srv_action_availability' });
    };
    try {
        const control = await executor.execute('action.invoke', {
            action: { pluginId, localId: 'echo' }, input: { key: 'account-runtime-control' },
        }, { surface: 'cli', runtimeAccountId: accountId,
            serverId: 'action_availability', serverIdentityId: 'srv_action_availability' });
        expect(control, JSON.stringify(control)).toMatchObject({ ok: true, result: { key: 'account-runtime-control' } });
        const initial = await invoke();
        expect(initial, JSON.stringify(initial)).toMatchObject({ ok: true, result: { value: 'nested-effect' } });
        expect(writes).toBe(1);
        callerReads = 0;
        failCallerRead = true;
        const result = await invoke();
        expect(refusedCallerRead).toBe(true);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'plugin_account_execution_unavailable',
            requestId: 'account-availability-query-2',
            failureCause: { phase: 'plugin.account_execution.revalidate', errorClass: 'AxiosError',
                httpStatus: 503 } });
        expect(writes).toBe(1);
        expect(await invoke()).toMatchObject({ ok: true, result: { value: 'nested-effect' } });
        expect(writes).toBe(2);
        callerReads = 0;
        retireCallerRead = true;
        expect(await invoke()).toMatchObject({ ok: false, errorCode: 'plugin_action_generation_retired',
            error: expect.any(String), requestId: 'account-availability-query-4' });
        expect(writes).toBe(2);
    } finally { restore(); await app.close(); }
});
