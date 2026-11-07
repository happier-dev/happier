import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { machineCapabilitiesDetect } from '@/sync/ops/capabilities';
import { sync } from '@/sync/sync';
import { resolveVoiceExecutionMachineSelectionFromState } from '@/voice/settings/executionMachine';

/** A user Retry refreshes Home facts, then reaches its admitted selected Machine. */
export async function recoverVoiceExecutionMachine(): Promise<void> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent()) return;
    const selection = resolveVoiceExecutionMachineSelectionFromState(storage.getState());
    await sync.refreshMachines({ serverId: lifetime.scope.serverId });
    if (selection.kind === 'none' || !lifetime.isCurrent()) return;
    await machineCapabilitiesDetect(selection.machineId, { requests: [], bypassCache: true }, lifetime.scope);
}
