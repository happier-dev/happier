import * as React from 'react';

import { awaitActionApprovalResult } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerScopedMachine } from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import { resolveManagedMachinePendingPowerIntentV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';
import { canPresentManagedMachineControl, managedReceiptPowerIntents } from './managedCreationPresentation';
import { createManagedProvisionerClient } from './managedProvisionerClient';
import { useManagedMachineInventory } from './useManagedMachineInventory';
import { useManagedProvisionerPresentation } from './useManagedProvisionerPresentation';

/** The stopped Project uses the same power admission and wake verb as Machines. */
export function useManagedWorkspaceStart(scope: WorkspaceScopeBase): Readonly<{
    start(): void;
    pending: boolean;
    reviewApproval: (() => void) | null;
}> | null {
    const { serverId, workspace } = scope;
    const inventory = useManagedMachineInventory(workspace ? [serverId] : [], workspace?.managedId);
    const profileId = resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
    const binding = inventory.bindings.get(profileId);
    const machine = inventory.machinesByServerId[serverId]?.[0];
    const controller = useServerScopedMachine(serverId, workspace?.controller.machineId ?? '');
    const currentController = controller?.installationId === workspace?.controller.installationId ? controller ?? null : null;
    const target = workspace && machine && binding && inventory.entries[profileId]?.status === 'ready'
        && currentController && machine.homeId === workspace.serverId
        && machine.controller?.machineId === workspace.controller.machineId
        && machine.controller.installationId === workspace.controller.installationId
        && machine.creationState === 'active' && machine.archivedAt === undefined
        && binding.isCurrent() && canPresentManagedMachineControl(binding.accountId, machine, currentController)
        ? machine : null;
    const presentation = useManagedProvisionerPresentation({
        serverId, accountScope: target ? binding?.scope : null, purpose: 'mark',
        controller: target?.controller, provider: target?.launch.provider, schemaVersion: target?.launch.schemaVersion,
    });
    const supported = target?.reviewedFacts?.retentionCapabilities.supportedIntents
        ?? presentation.descriptor?.retention.supportedIntents ?? [];
    const intent = target && managedReceiptPowerIntents(target, supported).find(value => value === 'start' || value === 'resume');
    // A wake Home already submitted reads as Starting in every pane until native power reports running, whoever pressed
    // Start: the request settling is not the workspace starting.
    const submittedWake = target ? resolveManagedMachinePendingPowerIntentV1(target) : null;
    const wakeSubmitted = submittedWake === 'start' || submittedWake === 'resume';
    const scopeKey = JSON.stringify([profileId, binding?.accountId, workspace?.serverId, workspace?.managedId,
        workspace?.controller.machineId, workspace?.controller.installationId]);
    const approval = useActionApprovalContinuation({ serverId, scopeKey, onExecuted() {} });
    const inFlight = React.useRef<AbortController | null>(null);
    const [pending, setPending] = React.useState<Readonly<{ scopeKey: string; request: AbortController }> | null>(null);
    const currentTarget = React.useRef<Readonly<{ scopeKey: string; target: typeof target; intent: typeof intent }> | null>(null);
    React.useLayoutEffect(() => {
        currentTarget.current = { scopeKey, target, intent };
        return () => { currentTarget.current = null; };
    }, [scopeKey, target, intent]);
    React.useEffect(() => () => {
        inFlight.current?.abort();
        inFlight.current = null;
    }, [binding, scopeKey]);

    if (!target || !binding || (!intent && !wakeSubmitted)) return null;
    return {
        pending: wakeSubmitted || (pending?.scopeKey === scopeKey && !pending.request.signal.aborted),
        reviewApproval: approval.approvalPending ? approval.openApproval : null,
        start() {
            const current = currentTarget.current;
            if (!intent || inFlight.current || !binding.isCurrent() || current?.scopeKey !== scopeKey
                || current.target !== target || current.intent !== intent) return;
            const request = new AbortController();
            inFlight.current = request;
            const retirement = binding.onRetire(() => request.abort());
            setPending({ scopeKey, request });
            const client = createManagedProvisionerClient(binding.scope, target.homeId);
            const settle = () => ({ settled: true });
            void awaitActionApprovalResult({
                signal: request.signal, succeeded: settle, failed: settle, aborted: settle,
                execute: async callbacks => {
                    const result = await client.execute('machines.managed.power.set', {
                        homeId: target.homeId, managedId: target.id, intent, when: 'now',
                        expectedRevision: target.intentRevision,
                    }, { ...callbacks, onApprovalPending: approval.requestApproval });
                    return result.kind === 'approval_pending' ? { approvalPending: true } : settle();
                },
            }).then(settle, settle).finally(() => {
                retirement.dispose();
                if (inFlight.current === request) inFlight.current = null;
                if (currentTarget.current) setPending(value => value?.request === request ? null : value);
            });
        },
    };
}
