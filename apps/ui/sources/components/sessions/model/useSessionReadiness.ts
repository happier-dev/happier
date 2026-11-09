import * as React from 'react';
import type { SessionReadinessV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import { SessionStatusActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, serverAccountScopedResourceKey, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiSessionStatusGet } from '@/sync/ops/actions/sessionStatusAction';
import { readSessionReadinessRepair } from './sessionReadinessViewModel';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import type { QualifiedConnectedAccountPurposeTeamResourceSelectionV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { subscribeUiSessionReadinessInputs } from '@/sync/ops/actions/sessionReadinessInputs';
import { machineAgentInventoryStore } from '@/agents/machineAgents/machineAgentInventoryStore';
import { subscribeMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';

/** Opened Bot/People/picker detail only: the status owner assembles all facts, with explicit retry. */
export function useSessionReadiness(input: Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    sessionId: string;
    enabled: boolean;
    operation?: SessionReadinessV1['operation'];
    credentialPurpose?: QualifiedConnectedAccountPurposeV1;
    credentialTeamSelection?: QualifiedConnectedAccountPurposeTeamResourceSelectionV1;
}>) {
    const { accountLifetime, sessionId } = input;
    const operation = input.operation ?? 'conversation';
    const credentialPurposeKey = JSON.stringify(input.credentialPurpose ?? null);
    const credentialPurpose = React.useMemo(() => input.credentialPurpose, [credentialPurposeKey]);
    const credentialTeamSelectionKey = JSON.stringify(input.credentialTeamSelection ?? null);
    const credentialTeamSelection = React.useMemo(() => input.credentialTeamSelection, [credentialTeamSelectionKey]);
    const key = JSON.stringify([serverAccountScopeKeySuffix(accountLifetime.scope), sessionId, operation, credentialPurposeKey, credentialTeamSelectionKey]);
    const [state, setState] = React.useState<Readonly<{
        key: string; readiness: SessionReadinessV1 | null; loading: boolean; unavailableReason: string | null;
    }>>({ key, readiness: null, loading: false, unavailableReason: null });
    // Only changed readiness inputs can owe another acquisition. Retry supersedes
    // pending work, retaining cancellation through the HTTP body and inventory wait.
    const request = React.useRef<{ controller: AbortController; key: string; dirty: boolean; force: boolean; acquireInventory: boolean } | null>(null);
    const selectedMachine = React.useRef<string | null>(null);
    const subscribe = React.useCallback((notify: () => void) => {
        if (!input.enabled) return () => {};
        const retirement = accountLifetime.onRetire(notify);
        return () => retirement.dispose();
    }, [accountLifetime, input.enabled]);
    const readCurrent = React.useCallback(() => input.enabled && accountLifetime.isCurrent(), [accountLifetime, input.enabled]);
    const enabled = React.useSyncExternalStore(subscribe, readCurrent, readCurrent) && Boolean(sessionId.trim());
    const read = React.useCallback(async (force: boolean, acquireInventory = true) => {
        if (!enabled || !accountLifetime.isCurrent()) return;
        const running = request.current;
        if (!force && running && running.key === key && !running.controller.signal.aborted) {
            running.dirty = true;
            running.acquireInventory ||= acquireInventory;
            return;
        }
        running?.controller.abort();
        const flight = { controller: new AbortController(), key, dirty: true, force, acquireInventory };
        request.current = flight;
        const { controller } = flight;
        const current = () => !controller.signal.aborted && accountLifetime.isCurrent();
        try {
            while (flight.dirty && current()) {
                const refreshReadiness = flight.force;
                const readAdmittedInventory = !flight.acquireInventory;
                flight.dirty = false;
                flight.force = false;
                flight.acquireInventory = false;
                setState(previous => ({ key, readiness: previous.key === key ? previous.readiness : null,
                    loading: true, unavailableReason: null }));
                let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
                try {
                    account = await captureLazyActionAccountContext(accountLifetime.scope.serverId, controller.signal);
                    if (!current()) return;
                    if (!areServerAccountScopesEqual(account.accountLifetime.scope, accountLifetime.scope)) {
                        throw new Error('action_account_scope_changed');
                    }
                    const result = SessionStatusActionResultV1Schema.parse(await createUiSessionStatusGet(account, { refreshReadiness, readAdmittedInventory })({
                        sessionId, serverId: accountLifetime.scope.serverId, readiness: true, operation,
                        ...(credentialPurpose ? { credentialPurpose } : {}), signal: controller.signal,
                        ...(credentialTeamSelection ? { credentialTeamSelection } : {}),
                    }));
                    if (!current()) return;
                    const requested = result.ok !== false && result.readiness?.operation === operation;
                    const machine = requested ? result.readiness?.machine : null;
                    selectedMachine.current = machine && 'machineId' in machine ? machine.machineId : null;
                    setState({ key, readiness: requested ? result.readiness ?? null : null, loading: false,
                        unavailableReason: result.ok === false ? result.code : requested ? null : 'unsupported' });
                } catch {
                    if (current()) setState({ key, readiness: null, loading: false, unavailableReason: 'unavailable' });
                } finally {
                    account?.dispose();
                }
            }
        } finally {
            if (request.current === flight) request.current = null;
        }
    }, [accountLifetime, enabled, key, sessionId, operation, credentialPurpose, credentialTeamSelection]);
    React.useEffect(() => {
        if (!enabled) return;
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, accountLifetime.scope.serverId)) return;
            const changes = event.sessionReadinessChanges;
            if (changes !== undefined && changes !== 'all' && !changes.sessionIds.includes(sessionId)
                && !changes.machineIds.some(id => selectedMachine.current === null || id === selectedMachine.current)) return;
            void read(false);
        }, { serverIds: [accountLifetime.scope.serverId], reconnect: 'refresh' });
        const unsubscribeInputs = subscribeUiSessionReadinessInputs(accountLifetime.scope, sessionId, () => { void read(false); });
        void read(false);
        return () => { unsubscribe(); unsubscribeInputs(); selectedMachine.current = null; request.current?.controller.abort(); };
    }, [accountLifetime.scope.serverId, enabled, read, sessionId]);
    const refresh = React.useCallback(() => read(true), [read]);
    const readiness = enabled && state.key === key ? state.readiness : null;
    const machineId = readiness?.machine && 'machineId' in readiness.machine ? readiness.machine.machineId : undefined;
    const agentId = readiness?.agent?.agentId;
    const definitionId = readiness?.agent?.definitionId;
    React.useEffect(() => {
        if (!enabled || !machineId) return;
        const unsubscribeProjection = subscribeMachineContributionRegistryProjectionInvalidation({
            serverId: accountLifetime.scope.serverId, machineId,
        }, () => { void read(false); });
        const inventoryKey = serverAccountScopedResourceKey(accountLifetime.scope, 'machine-agents', machineId);
        const unsubscribeInventory = agentId ? machineAgentInventoryStore.subscribeAgent(
            inventoryKey, agentId, () => { void read(false, false); }, definitionId,
        ) : machineAgentInventoryStore.subscribe(inventoryKey, () => { void read(false, false); });
        return () => { unsubscribeProjection(); unsubscribeInventory(); };
    }, [accountLifetime.scope, agentId, definitionId, enabled, machineId, read]);
    return React.useMemo(() => ({ readiness, repair: readiness ? readSessionReadinessRepair(readiness) : null,
        loading: enabled && state.key === key && state.loading,
        unavailableReason: enabled && state.key === key ? state.unavailableReason : null, refresh,
    }), [enabled, key, readiness, refresh, state]);
}
