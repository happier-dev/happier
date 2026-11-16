import * as React from 'react';
import type { MachineIsolationPolicyV1 } from '@happier-dev/protocol/machines/machineIsolationV1';
import { MachineIsolationMutationResultV1Schema, type MachineIsolationGetResultV1 } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { proposeMachineIsolationOutcome, readSyncedMachineIsolationPolicy } from '@/sync/domains/machines/machineIsolationPolicy';
import type { Machine } from '@/sync/domains/state/storageTypes';

/** Reuses the authoring owner's opened snapshot; no Action, metadata read or authorization. */
export function useMachineIsolationProposedOutcome(snapshot: MachineIsolationGetResultV1,
    workKind: keyof MachineIsolationPolicyV1['workKinds'], override?: 'directly') {
    return React.useMemo(() => proposeMachineIsolationOutcome(snapshot, workKind, override), [snapshot, workKind, override]);
}

/** Security's data owner: synced policy reads and the existing metadata CAS Action. No acquisition. */
export function useMachineIsolationPolicy(input: Readonly<{ serverId: string; machine: Machine | null }>) {
    const snapshot = React.useMemo(() => readSyncedMachineIsolationPolicy(input.machine), [input.machine]);
    const execution = useMountedActionExecution(input.serverId);
    const targetKey = JSON.stringify([execution.binding?.scope, input.machine?.id]);
    const [pending, setPending] = React.useState<Readonly<{
        targetKey: string; policy: MachineIsolationPolicyV1; metadataVersion: number | null;
    }> | null>(null);
    const currentPending = pending?.targetKey === targetKey ? pending : null;
    const syncedVersion = snapshot.status === 'ready' ? snapshot.metadataVersion : null;
    React.useEffect(() => {
        if (currentPending?.metadataVersion != null && syncedVersion != null
            && syncedVersion >= currentPending.metadataVersion) setPending(null);
    }, [currentPending, syncedVersion]);

    const savePolicy = React.useCallback(async (policy: MachineIsolationPolicyV1) => {
        if (snapshot.status !== 'ready' || !input.machine) return null;
        const expected = currentPending?.metadataVersion != null
            ? { policy: currentPending.policy, metadataVersion: currentPending.metadataVersion } : snapshot;
        setPending({ targetKey, policy, metadataVersion: null });
        const result = await execution.execute('machines.isolation.set', {
            serverId: input.serverId, machineId: input.machine.id,
            expectedMetadataVersion: expected.metadataVersion, expectedPolicy: expected.policy, policy,
        }).catch(error => {
            setPending(previous => previous?.targetKey === targetKey ? null : previous);
            throw error;
        });
        const parsed = result.ok ? MachineIsolationMutationResultV1Schema.safeParse(result.result) : null;
        if (parsed?.success && (parsed.data.status === 'applied' || parsed.data.status === 'satisfied' || parsed.data.status === 'unchanged')) {
            const settled = { targetKey, policy: parsed.data.policy, metadataVersion: parsed.data.metadataVersion };
            setPending(previous => previous?.targetKey === targetKey ? settled : previous);
        } else setPending(previous => previous?.targetKey === targetKey ? null : previous);
        return result;
    }, [snapshot, input.machine, input.serverId, currentPending, targetKey, execution.execute]);

    return { snapshot, policy: snapshot.status === 'ready' ? currentPending?.policy ?? snapshot.policy : null,
        saving: currentPending !== null && currentPending.metadataVersion === null, savePolicy };
}
