import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD, type ConnectedServicePoolSelectionGetRequestV1,
    type ConnectedServicePoolSelectionGetResponseV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { serveAccountHomes, installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import * as machineRpc from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { readUsageWidgetSelection } from './usageWidgetSelectionRead';

installDisconnectedServerSocketBoundary();
afterEach(() => { vi.restoreAllMocks(); });

const request: ConnectedServicePoolSelectionGetRequestV1 = {
    machineId: 'selector-machine',
    group: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'work' },
    providerLimitId: 'weekly',
};
const preferred = { profileId: 'preferred', priority: 1, createdAtMs: 2, enabled: true, leastLimitedScore: 90 };
const selected = { profileId: 'sticky', priority: 2, createdAtMs: 1, enabled: true, leastLimitedScore: 50 };
const response: ConnectedServicePoolSelectionGetResponseV1 = {
    group: request.group, observedAtMs: 100,
    selection: { selected, reason: 'selected', excluded: [{ profileId: 'cooling', reason: 'cooldown', retryAtMs: 200 }],
        decisionTrace: { activeProfileId: selected.profileId, reason: 'selected', strategy: 'priority',
            selectionBasis: 'active_stickiness', sticky: true, orderedEligibleCandidates: [preferred, selected],
            candidates: [{ profileId: selected.profileId, decision: 'selected', quotaEvidence: { status: 'fresh', remainingPercent: 50 } },
                { profileId: preferred.profileId, decision: 'eligible', quotaEvidence: { status: 'stale_or_missing' } }],
        },
    },
};

async function serveSelectionHome(key: string) {
    const bridge = await loadSyncSingletonForTests();
    const restoreExecutor = await installRealActionExecutorModuleLoader();
    const homes = await serveAccountHomes({ homes: [
        { key, serverUrl: `https://usage-selection-${key}.test`, accountId: `${key}-account` },
    ], route: () => undefined });
    const account = await captureLazyActionAccountContext(homes.homes[key]!.id);
    return { account, dispose: () => { account.dispose(); homes.dispose(); restoreExecutor(); bridge.dispose(); } };
}

describe('Usage widget qualified pool selection read', () => {
    it('reads the exact captured Home and preserves U3 sticky selection independently of preference order', async () => {
        const bridge = await loadSyncSingletonForTests();
        const restoreExecutor = await installRealActionExecutorModuleLoader();
        const homes = await serveAccountHomes({ homes: [
            { key: 'target', serverUrl: 'https://usage-selection-target.test', accountId: 'target-account' },
            { key: 'focused', serverUrl: 'https://usage-selection-focused.test', accountId: 'focused-account' },
        ], route: () => undefined });
        const account = await captureLazyActionAccountContext(homes.homes.target!.id);
        // Substitute only the Machine RPC network transport. Account capture, ordinary
        // Action admission, U3 qualified validation and decision projection stay real.
        vi.spyOn(machineRpc, 'machineRpcWithServerScope').mockImplementation(async <R, A>(input: ServerScopedMachineRpcParams<A>) => {
            expect(input).toMatchObject({ serverId: account.serverId, accountId: 'target-account',
                machineId: request.machineId, method: CONNECTED_SERVICE_POOL_SELECTION_RPC_METHOD, payload: request });
            input.onIssued?.();
            // The transport is generic; the real U3 Action schema validates its reply.
            return response as R;
        });
        try {
            expect(await readUsageWidgetSelection({ lifetime: account.accountLifetime, request })).toEqual({ ok: true, result: response });
        } finally { account.dispose(); homes.dispose(); restoreExecutor(); bridge.dispose(); }
    });

    it('keeps U3 unavailable evidence explicit and refuses a foreign qualified group through its real validator', async () => {
        const fixture = await serveSelectionHome('unavailable');
        let reply: unknown = { status: 'unavailable', code: 'connected_account_daemon_owner_unavailable' };
        vi.spyOn(machineRpc, 'machineRpcWithServerScope').mockImplementation(async <R, A>(input: ServerScopedMachineRpcParams<A>) => {
            input.onIssued?.();
            return reply as R;
        });
        try {
            expect(await readUsageWidgetSelection({ lifetime: fixture.account.accountLifetime, request })).toEqual({ ok: true, result: reply });
            reply = { ...response, group: { ...request.group, groupId: 'foreign' } };
            expect(await readUsageWidgetSelection({ lifetime: fixture.account.accountLifetime, request })).toMatchObject({ ok: false });
        } finally { fixture.dispose(); }
    });

    it.each(['retired', 'cancelled'] as const)('withholds a late response when its captured lifetime is %s', async disposition => {
        const fixture = await serveSelectionHome(disposition);
        const controller = new AbortController();
        let issuedSignal: AbortSignal | undefined;
        vi.spyOn(machineRpc, 'machineRpcWithServerScope').mockImplementation(async <R, A>(input: ServerScopedMachineRpcParams<A>) => {
            input.onIssued?.();
            issuedSignal = input.signal;
            if (disposition === 'retired') {
                // The explicit Home may not own the active runtime. Its real
                // credential mutation producer retires this captured Account.
                expect(await TokenStorage.removeCredentialsForServerUrl(fixture.account.endpointUrl,
                    { serverId: fixture.account.serverId })).toBe(true);
                expect(fixture.account.accountLifetime.isCurrent()).toBe(false);
            } else controller.abort();
            return response as R;
        });
        try {
            expect(await readUsageWidgetSelection({ lifetime: fixture.account.accountLifetime, request, signal: controller.signal }))
                .toMatchObject({ ok: false, errorCode: disposition === 'retired' ? 'action_account_scope_changed' : 'cancelled' });
            expect(issuedSignal?.aborted).toBe(true);
            // A subsequent attempt under the same retired/cancelled capture cannot disclose data.
            expect(await readUsageWidgetSelection({ lifetime: fixture.account.accountLifetime, request, signal: controller.signal }))
                .toMatchObject({ ok: false, errorCode: disposition === 'retired' ? 'action_account_scope_changed' : 'cancelled' });
        } finally { fixture.dispose(); }
    });
});
