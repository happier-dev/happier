import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { createNativeAuthRuntimeRefreshBridge } from './nativeAuthRuntimeRefresh';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from './requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { createBuiltInQualifiedNativeRefreshHarness } from './refresh/ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit';
import { ConnectedServiceRuntimeRegistry } from './runtimeRegistry/registry';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from './connectedServiceChildEnvironment';
import { createSessionConnectedServiceRuntimeAuthRefreshHandler } from './sessionRuntimeAuthRefresh';
import { ConnectedServiceRuntimeAuthRefreshSelectionSchema } from './runtimeAuthRefreshAuthorization';
import type { ConnectedServiceDaemonAuthBridgeRefreshRequest } from './daemonAuthBridgeTypes';

const created: Awaited<ReturnType<typeof createBuiltInQualifiedNativeRefreshHarness>>[] = [];
afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(created.splice(0).map((harness) => harness.dispose()));
});

async function prepare(subject: 'run' | 'session' = 'run', selectionKind: 'profile' | 'group' = 'profile') {
    const harness = await createBuiltInQualifiedNativeRefreshHarness();
    created.push(harness);
    const serviceId = buildQualifiedPluginContributionKey(harness.service);
    const bindings = ConnectedServiceBindingsV2IngressSchema.parse({ v: 2,
        bindingsByServiceId: { [serviceId]: selectionKind === 'profile'
            ? { source: 'connected', selection: 'profile', profileId: harness.account.accountId }
            : { source: 'connected', selection: 'group', groupId: 'pool', profileId: 'backup' } } });
    const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'codex', bindings,
        contributions: harness.registry.contributes });
    const codec = await (await harness.registry.acquireAgentCatalogEntry?.('codex'))?.getConnectedAccountNativeAuthRefreshCodec?.();
    if (!snapshot?.fileMaterializationPurposes || !codec) throw new Error('Current first-party native auth producer unavailable');
    const lease = harness.purposeRuntime.activatePurposeBindings({ subject: subject === 'run'
        ? { kind: 'execution_run', runId: 'run', runnerPid: 4242, agentId: 'codex', isCurrent: () => true }
        : { kind: 'session', sessionId: 'session' },
        purposes: snapshot.purposes, bindings: snapshot.bindings });
    const bridge = createNativeAuthRuntimeRefreshBridge({ serviceId,
        scope: { subjectId: lease.subjectId, codec, bindings: snapshot.bindings,
            fileMaterializationPurposes: snapshot.fileMaterializationPurposes, isCurrent: lease.isCurrent },
        purposeBindingOwner: { materialize: harness.purposeRuntime.owner.materialize,
            resolveCurrentRequestAuthBinding: harness.purposeRuntime.resolveCurrentRequestAuthBinding },
        refreshCoordinator: harness.coordinator,
        signal: new AbortController().signal });
    const request = { ...(subject === 'run' ? { runId: 'run' } : { sessionId: 'session' }),
        refreshAttemptId: 'attempt-1', forceRefresh: true,
        selection: selectionKind === 'profile'
            ? { kind: 'profile' as const, serviceId, profileId: harness.account.accountId }
            : { kind: 'group' as const, serviceId, groupId: 'pool', activeProfileId: 'work', fallbackProfileId: 'backup', generation: 7 },
        expectedCredentialRevision: harness.firstRevision, planType: 'team' } as const;
    const registry = new ConnectedServiceRuntimeRegistry();
    registry.registerTarget({ sessionId: 'session', pid: 4242, agentId: 'codex', materializationKey: 'session',
        connectedServicesBindingsRaw: bindings, connectedServiceSelectionsEnv: {
            [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{ ...request.selection,
                credentialRevision: harness.firstRevision }]),
        } });
    const sessionRefresh = createSessionConnectedServiceRuntimeAuthRefreshHandler({ registry,
        // Same actual qualified producer captured above; no synthetic bridge settlement.
        resolveDaemonAuthBridge: async (requestedService) => requestedService === serviceId ? bridge : null });
    const refresh = subject === 'run' ? bridge.refresh : async (input: ConnectedServiceDaemonAuthBridgeRefreshRequest) => {
        if (!input.refreshAttemptId || !input.expectedCredentialRevision) throw new Error('Fixture requires an exact refresh attempt');
        const result = await sessionRefresh({ sessionId: 'session', refreshAttemptId: input.refreshAttemptId,
            expectedCredentialRevision: input.expectedCredentialRevision,
            selection: ConnectedServiceRuntimeAuthRefreshSelectionSchema.parse(input.selection),
            ...(typeof input.planType === 'string' ? { planType: input.planType } : {}) });
        return result.ok ? result.result : result;
    };
    return { ...harness, lease, bridge, refresh, request };
}

function oauthResponse(accessToken = 'access-new') {
    return new Response(JSON.stringify({ access_token: accessToken, refresh_token: 'refresh-new',
        id_token: 'id-new', expires_in: 3600 }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('same-purpose qualified native runtime auth refresh', () => {
    it.each(['run', 'session'] as const)('refreshes and decodes the exact %s account files without exposing the rotated secret, including same-attempt replay', async (subject) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(oauthResponse()).mockResolvedValueOnce(oauthResponse('access-next')));
        const { refresh, request, secondRevision, thirdRevision } = await prepare(subject);
        const expected = { status: 'refreshed', result: { accessToken: 'access-new',
            chatgptAccountId: 'work', chatgptPlanType: 'team', credentialRevision: secondRevision } };
        await expect(refresh(request)).resolves.toEqual(expected);
        await expect(refresh(request)).resolves.toEqual(expected);
        await expect(refresh({ ...request, refreshAttemptId: 'different-attempt' })).resolves.toMatchObject({ status: 'unavailable' });
        await expect(refresh({ ...request, selection: { kind: 'profile', serviceId: request.selection.serviceId, profileId: 'other' } }))
            .resolves.toMatchObject(subject === 'run' ? { status: 'unavailable' }
                : { ok: false, errorCode: 'connected_service_session_refresh_forbidden' });
        await expect(refresh({ ...request, refreshAttemptId: 'attempt-2', expectedCredentialRevision: secondRevision }))
            .resolves.toEqual({ status: 'refreshed', result: { accessToken: 'access-next',
                chatgptAccountId: 'work', chatgptPlanType: 'team', credentialRevision: thirdRevision } });
    });

    it('does not disclose refreshed material after the captured Run purpose lease retires during OAuth', async () => {
        let started!: () => void;
        const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
        let settle!: (value: Response) => void;
        vi.stubGlobal('fetch', vi.fn(() => { started(); return new Promise<Response>((resolve) => { settle = resolve; }); }));
        const { bridge, request, lease } = await prepare();
        const pending = bridge.refresh(request);
        await fetchStarted;
        lease.dispose();
        settle(oauthResponse());
        await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
    });

    it('does not disclose after a concurrent credential writer wins the expected-revision CAS', async () => {
        let started!: () => void;
        const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
        let settle!: (value: Response) => void;
        vi.stubGlobal('fetch', vi.fn(() => { started(); return new Promise<Response>((resolve) => { settle = resolve; }); }));
        const { bridge, request, readCredential, mutateCredential, account, firstRevision } = await prepare();
        const pending = bridge.refresh(request);
        await fetchStarted;
        const current = await readCredential();
        await mutateCredential({ token: 'happier-token', mutation: { ref: account, authenticationModeId: 'oauth',
            expectedCredentialRevision: firstRevision, expectedConfigurationRevision: null,
            content: current.content, metadata: current.metadata } });
        settle(oauthResponse());
        await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
    });

    it('rejects settlement and replay after the actual group owner switches the active member during refresh', async () => {
        let started!: () => void;
        const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
        let settle!: (value: Response) => void;
        vi.stubGlobal('fetch', vi.fn(() => { started(); return new Promise<Response>((resolve) => { settle = resolve; }); }));
        const { bridge, request, switchGroupAccount } = await prepare('run', 'group');
        const pending = bridge.refresh(request);
        await fetchStarted;
        switchGroupAccount('backup');
        settle(oauthResponse());
        await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
        await expect(bridge.refresh(request)).resolves.toMatchObject({ status: 'unavailable' });
    });
});
