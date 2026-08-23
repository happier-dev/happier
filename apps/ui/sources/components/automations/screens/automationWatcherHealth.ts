import { t } from '@/text';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import type { MachineWithReplacement } from '@/sync/domains/machines/identity/machineIdentityTypes';

/**
 * Whether a persisted `checkpointedPull` watcher can still observe events.
 *
 * The watcher stores the machine installation it was bound to, and the server
 * admits a materialization only for a machine row whose `installationId` still
 * equals that value
 * (`resolveCurrentClaimablePluginMachineMaterializationTx`). A revoked,
 * replaced, unknown, or reinstalled machine therefore cannot fire the
 * Automation at all, and an offline one is not firing right now — none of which
 * a bare machine name distinguishes from a healthy watcher.
 *
 * This is presentation of facts the client already holds. It selects nothing,
 * repairs nothing, and never treats a machine that reports no installation
 * identity as mismatched.
 */
export type AutomationWatcherHealthV1 =
    | Readonly<{ kind: 'observing' }>
    | Readonly<{ kind: 'machineUnknown' }>
    | Readonly<{ kind: 'machineUnavailable'; status: 'revoked' | 'replaced' }>
    | Readonly<{ kind: 'installationReplaced' }>
    | Readonly<{ kind: 'machineOffline' }>;

export function resolveAutomationWatcherHealth(params: Readonly<{
    watcher: Readonly<{ machineId: string; machineInstallationId: string }>;
    machine: MachineWithReplacement | undefined;
    nowMs?: number;
}>): AutomationWatcherHealthV1 {
    const { machine } = params;
    if (!machine) return Object.freeze({ kind: 'machineUnknown' });

    const presence = resolveMachinePickerPresence(machine, params.nowMs);
    if (presence.status === 'revoked' || presence.status === 'replaced') {
        return Object.freeze({ kind: 'machineUnavailable', status: presence.status });
    }

    // Only a machine that actually reports an installation identity can be
    // known to have been reinstalled; an absent one is unknown, not mismatched.
    const currentInstallationId = machine.installationId;
    if (
        typeof currentInstallationId === 'string'
        && currentInstallationId.length > 0
        && currentInstallationId !== params.watcher.machineInstallationId
    ) {
        return Object.freeze({ kind: 'installationReplaced' });
    }

    if (presence.status === 'offline') return Object.freeze({ kind: 'machineOffline' });
    return Object.freeze({ kind: 'observing' });
}

/**
 * The user-facing reason a watcher is not observing, or `undefined` when it is.
 */
export function formatAutomationWatcherImpediment(
    health: AutomationWatcherHealthV1,
): string | undefined {
    switch (health.kind) {
        case 'observing':
            return undefined;
        case 'machineUnknown':
            return t('automations.detail.event.watcherMachineUnknown');
        case 'machineUnavailable':
            return health.status === 'revoked'
                ? t('automations.detail.event.watcherMachineRevoked')
                : t('automations.detail.event.watcherMachineReplaced');
        case 'installationReplaced':
            return t('automations.detail.event.watcherInstallationReplaced');
        case 'machineOffline':
            return t('automations.detail.event.watcherMachineOffline');
    }
}
