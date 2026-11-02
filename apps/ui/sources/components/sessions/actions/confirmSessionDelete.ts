import { Modal } from '@/modal';
import { t } from '@/text';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionListRenderableOwnerMetadataView } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { resolveExactServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachines';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { resolveSessionDeleteWarning } from './sessionActionPresentation';
import type { SessionActionTarget } from './sessionActionTypes';

type SessionDeleteWarningOptions = Readonly<{
    metadata?: unknown;
    machineOnline?: boolean | null;
    machineLabel?: string | null;
}>;

async function readTargetWarningOptions(target: SessionActionTarget): Promise<SessionDeleteWarningOptions> {
    const metadata = 'agentState' in target.session
        ? readSessionOwnerMetadataView(target.session)
        : readSessionListRenderableOwnerMetadataView(target.session);
    const machineId = resolveSessionMachineId(metadata);
    if (!target.serverId || !machineId) return { metadata, machineLabel: metadata?.host };
    // This is a click-time read of incumbent identity and presence, never a new
    // Machine request or a subscription for every closed row menu.
    const binding = await resolveServerCredentialAccountScope(target.serverId);
    const state = getStorage().getState();
    const heldMachine = state.machines[machineId];
    const machine = resolveExactServerScopedMachine({
        machineId, serverId: target.serverId, activeServerId: getActiveServerSnapshot().serverId,
        activeMachines: heldMachine ? [heldMachine] : [],
        machineListByServerId: state.machineListByServerId,
        machineListStatusByServerId: state.machineListStatusByServerId,
    });
    const reachability = machine
        ? resolveMachineReachability(binding.kind === 'bound' ? binding.scope : null, machine)
        : 'unknown';
    return {
        metadata,
        machineOnline: reachability === 'unknown' ? null : reachability === 'reachable',
        machineLabel: machine ? getMachineDisplayName(machine) : metadata?.host,
    };
}

/** One irreversible-delete confirmation for every single-Session surface. */
export async function confirmSessionDelete(
    options: SessionDeleteWarningOptions & Readonly<{ target?: SessionActionTarget }> = {},
): Promise<boolean> {
    const warning = options.target ? { ...await readTargetWarningOptions(options.target), ...options } : options;
    const stopAndDelete = options.target?.canStopAndDelete === true;
    const confirmText = t(stopAndDelete ? 'sessionInfo.stopAndDeleteSession' : 'sessionInfo.deleteSession');
    return await Modal.confirm(
        t('sessionInfo.deleteSession'),
        resolveSessionDeleteWarning({
            metadata: warning.metadata,
            machineOnline: warning.machineOnline ?? null,
            defaultWarning: t(stopAndDelete ? 'sessionInfo.stopAndDeleteSessionWarning' : 'sessionInfo.deleteSessionWarning'),
            offlineManagedWarning: t('sessionDirectoryRecovery.offlineDelete', {
                machine: warning.machineLabel ?? t('status.unknown'),
            }),
        }),
        { cancelText: t('common.cancel'), confirmText, destructive: true },
    );
}
