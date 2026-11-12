import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionInputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginAccountStorageMutationRequestV1Schema, PluginAccountStorageMutationResponseV1Schema,
    PluginAccountStorageReadResponseV1Schema } from '@happier-dev/protocol/plugins/data/accountKvV1';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';

afterEach(() => vi.restoreAllMocks());

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
        expect(await invoke()).toMatchObject({ ok: true });
        expect(writes).toBe(1);
        callerReads = 0;
        failCallerRead = true;
        const result = await invoke();
        expect(refusedCallerRead).toBe(true);
        expect(result).toMatchObject({ ok: false, errorCode: 'plugin_account_execution_unavailable',
            details: { details: { requestId: 'account-availability-query-2' } },
            failureCause: { phase: 'plugin.account_execution.revalidate', errorClass: 'AxiosError',
                errorCode: 'ERR_BAD_RESPONSE', httpStatus: 503 } });
        expect(writes).toBe(1);
        expect(await invoke()).toMatchObject({ ok: true });
        expect(writes).toBe(2);
        callerReads = 0;
        retireCallerRead = true;
        expect(await invoke()).toMatchObject({ ok: false, errorCode: 'plugin_action_generation_retired',
            error: expect.any(String), details: { details: { requestId: 'account-availability-query-4' } } });
        expect(writes).toBe(2);
    } finally { restore(); await app.close(); }
});
