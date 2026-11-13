import { expect, it } from 'vitest';

import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import type { TrackedSession } from '../types';
import { createSpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

it.each(['before', 'during', 'live'] as const)('keeps deferred Connected Account registration under %s startup custody', async (exitPhase) => {
    const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' } as const;
    const purpose = { consumer: { pluginId: 'happier.agent.claude', localId: 'claude' }, purpose: 'model_upstream' } as const;
    const binding = { purpose, target: { kind: 'account' as const, account: { service, accountId: 'subscription' } } };
    const owner = createConnectedAccountPurposeBindingOwner({
        // The persistent catalog is a boundary; Session activation, resolution,
        // retirement and runtime target registration use their real owners.
        store: { read: async () => ({ v: 1, bindings: [] }), update: async (mutate) => mutate({ v: 1, bindings: [] }),
            subscribe: () => ({ dispose() {} }) },
        selectTarget: async () => binding.target,
        resolveTarget: async () => ({ displayName: 'Subscription', account: binding.target.account }),
        materializeAccount: async () => ({ kind: 'environment', env: { TOKEN: 'fixture' } }),
        projectTargetAccounts: async () => { throw new Error('Unexpected inventory read'); },
        assertTargetAccountMaterializable: async () => { throw new Error('Unexpected listed-account materialization'); },
    });
    const registry = new ConnectedServiceRuntimeRegistry();
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(1235), pid: 1235, startedBy: 'daemon', reportMarkerCustody: {
        pending: Promise.resolve(), retiring: exitPhase === 'before',
    } };
    const cleanupByKey = new Map<SessionTrackingKey, () => void | Promise<void>>();
    const activation: { lease: ReturnType<typeof owner.activateSessionPurposeBindings> | null } = { lease: null };
    const callbacks = createSpawnLifecycleCallbacks({
        connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {
            'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'subscription' },
        } },
        catalogAgentId: 'claude', materializationKey: 'csm_deferred', hasConnectedServiceAuth: () => true,
        activateConnectedAccountSessionBindingOnCanonicalSession: async (sessionId) => {
            activation.lease = owner.activateSessionPurposeBindings({ sessionId, purposes: [purpose], bindings: [binding] });
            // The real spawn activation is asynchronous while replacing the
            // temporary launch lease with this canonical Session scope.
            await Promise.resolve();
            return null;
        },
        registerConnectedServiceRuntimeTarget: (target) => { registry.registerTarget(target); },
        getSpawnResourceCleanupOnExit: () => async () => { await activation.lease?.dispose(); },
        onSpawnResourceCleanupArmed: () => {}, spawnResourceCleanupByKey: cleanupByKey,
        getSessionAttachCleanup: () => null, setSessionAttachCleanup: () => {}, sessionAttachCleanupByKey: new Map(),
        persistAcceptedSpawnMarker: async () => {},
    });
    await callbacks.persistAcceptedSpawnMarker(tracked);
    const readiness = tracked.activateConnectedAccountSessionBindingOnCanonicalSession!('session-deferred');
    if (exitPhase === 'during') {
        tracked.reportMarkerCustody!.retiring = true;
        await activation.lease?.dispose();
    }
    try {
        const result = await readiness;
        if (exitPhase === 'live') {
            expect(result).toBeNull();
            expect(activation.lease?.resolvePurposeBinding(purpose)).toEqual(binding);
            expect(registry.getBySessionId('session-deferred')?.pid).toBe(tracked.pid);
            expect(cleanupByKey.has(tracked.trackingKey)).toBe(true);
        } else {
            expect(result).toMatchObject({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK' });
            expect(activation.lease?.resolvePurposeBinding(purpose) ?? null).toBeNull();
            expect(registry.listTargets()).toEqual([]);
            expect(cleanupByKey.has(tracked.trackingKey)).toBe(false);
        }
    } finally { await activation.lease?.dispose(); }
});
