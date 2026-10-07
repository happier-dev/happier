import {
    pluginSourceCustodyV1Equal,
    type PluginSourceCustodyV1,
} from '@happier-dev/protocol/plugins/runtime/sourceCustody';

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
    /** The machine list has not been read yet, so nothing can be said about the watcher's machine. */
    | Readonly<{ kind: 'machineChecking' }>
    | Readonly<{ kind: 'machineUnknown' }>
    | Readonly<{ kind: 'machineUnavailable'; status: 'revoked' | 'replaced' }>
    | Readonly<{ kind: 'installationReplaced' }>
    | Readonly<{ kind: 'machineOffline' }>;

export function resolveAutomationWatcherHealth(params: Readonly<{
    watcher: Readonly<{ machineId: string; machineInstallationId: string }>;
    machine: MachineWithReplacement | undefined;
    /** This Home's machine list has been read, so an absent machine has really left. */
    machineListSettled: boolean;
    nowMs?: number;
}>): AutomationWatcherHealthV1 {
    const { machine } = params;
    if (!machine) return Object.freeze({ kind: params.machineListSettled ? 'machineUnknown' : 'machineChecking' });

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
        case 'machineChecking':
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

/**
 * Whether the provider-authored source summaries may be presented as they were
 * reported.
 *
 * A source/catalog summary describes the last report a watcher made, never
 * whether that watcher is still running. When host-derived availability says
 * the watcher cannot observe, its retained `observing`/`current` rows describe
 * a reporter that is not observing, so presenting them verbatim would claim a
 * stopped source is healthy. The impediment is already the truthful reason, so
 * this owner answers only the presentation question and invents no state.
 */
export function canPresentAutomationSourceSummary(
    health: AutomationWatcherHealthV1,
): boolean {
    return health.kind === 'observing';
}

export type AutomationEventObserverRuntimeHealthV1 =
    | Readonly<{ kind: 'current' }>
    | Readonly<{ kind: 'generationReplaced' }>
    | Readonly<{ kind: 'runtimeUnavailable' }>;

/**
 * Joins retained provider status to the daemon's current eligible-Event
 * producer. Source custody is producer-owned and exact; the UI neither derives
 * it from package metadata nor treats an unrelated same-plugin service as the
 * Event observer.
 */
export function resolveAutomationEventObserverRuntimeHealth(params: Readonly<{
    currentSourceCustody: PluginSourceCustodyV1 | null | undefined;
    reporterSourceCustody: PluginSourceCustodyV1 | null | undefined;
}>): AutomationEventObserverRuntimeHealthV1 {
    if (!params.currentSourceCustody) {
        return Object.freeze({ kind: 'runtimeUnavailable' });
    }
    if (
        params.reporterSourceCustody
        && !pluginSourceCustodyV1Equal(params.reporterSourceCustody, params.currentSourceCustody)
    ) {
        return Object.freeze({ kind: 'generationReplaced' });
    }

    return Object.freeze({ kind: 'current' });
}

export function formatAutomationEventObserverRuntimeImpediment(
    health: AutomationEventObserverRuntimeHealthV1,
): string | undefined {
    if (health.kind === 'current') return undefined;
    return t('automations.detail.event.sourceStatusUnavailable');
}
