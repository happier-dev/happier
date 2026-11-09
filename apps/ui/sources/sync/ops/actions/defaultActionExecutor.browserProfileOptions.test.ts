import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook, standardCleanup } from '@/dev/testkit';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.doUnmock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch');
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');

afterEach(async () => {
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    await standardCleanup();
});
afterAll(async () => { await network.dispose(); });

it('resolves install form draft Machine profiles without a mounted target or Browser automation', async () => {
    await homes.reset();
    network.resetRequests();
    const serverUrl = 'https://browser-profile-options.test';
    const serverIdentityId = 'srv_browser-profile-options';
    const serverId = await homes.addHome({ name: 'Profile Home', serverUrl, serverIdentityId, accountId: 'profile-owner', currentAccount: true });
    await network.addHome(serverUrl, 'profile-owner', { serverIdentityId });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
        featureToggles: { 'browser.automation': true },
    } }, version: 1 } });
    homes.answer(serverId, '/v1/actions/browser.extensions.list', { select: body => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
        expect(request.target).toEqual({ kind: 'machine', machineId: 'draft-machine' });
        expect(request.input).toEqual({ machineId: 'draft-machine' });
        return { body: { v: 1, actionId: 'browser.extensions.list', requestId: request.requestId,
            execution: { ok: true, result: { status: 'ready', entries: [], profiles: [{ profileId: 'work', displayName: 'Work' }] } } } };
    } });
    network.setHttpResponder(async (input, init) => new URL(String(input)).pathname.startsWith('/v1/machines/')
        ? null : homes.request(input, init));
    const prime = (enabled: boolean) => primeServerFeaturesSnapshot({ serverId, snapshot: {
        status: 'ready', features: FeaturesResponseSchema.parse({ features: { browser: {
            enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, automation: { enabled },
        } } }),
    } });
    prime(true);
    const disposeLoader = await installRealActionExecutorModuleLoader();
    const { useInputFieldOptions } = await import('@/components/sessions/actions/useInputFieldOptions');
    const { captureLazyActionAccountContext } = await import('./actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    const field = { path: 'profileId', optionsSourceId: 'browser.profiles.available' };
    const request = { actionId: 'browser.extensions.install', fieldPath: field.path, draftInput: { machineId: 'draft-machine' } };
    const context = { surface: 'ui' as const, serverId };
    // The generic install form has no mounted Machine: selection lives in its draft.
    const direct = await createDefaultActionExecutor().execute('action.options.resolve', request, context);
    expect(direct, JSON.stringify(direct)).toMatchObject({ ok: true, result: { options: [{ value: 'work', label: 'Work' }] } });
    const mounted = await renderHook(() => useInputFieldOptions({ serverId, accountLifetime: account.accountLifetime,
        enabled: true, requests: [{ field, actionId: request.actionId, draftInput: request.draftInput }] }));
    try {
        await waitForHomeGovernance(() => expect(mounted.getCurrent().state(field)).toMatchObject({
            status: 'ready', options: [{ value: 'work', label: 'Work' }],
        }));
        expect(homes.requestsFor('/v1/actions/browser.extensions.list')).toHaveLength(2);
        prime(false);
        // Saved extension/profile inventory has no Browser automation feature requirement.
        expect(await createDefaultActionExecutor().execute('action.options.resolve', request, context)).toMatchObject({
            ok: true, result: { options: [{ value: 'work', label: 'Work' }] },
        });
        expect(homes.requestsFor('/v1/actions/browser.extensions.list')).toHaveLength(3);
    } finally {
        await mounted.unmount();
        account.dispose();
        disposeLoader();
    }
});
