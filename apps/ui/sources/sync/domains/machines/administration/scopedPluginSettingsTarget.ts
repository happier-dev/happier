import * as React from 'react';

import {
    resolveScopedPluginSettingsTarget,
    type ScopedPluginSettingsDaemonTarget,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';

import {
    useMachineAdministrationTargetSelection,
    type FreshMachineAdministrationExecutionTargetV1,
    type MachineAdministrationTargetSelectionOptions,
    type MachineAdministrationTargetSelectionV1,
} from './useTargetSelection';

const DAEMON_PLUGIN_SETTINGS_SCOPE = Object.freeze({ kind: 'daemon' as const });

/**
 * Two resolutions of the same Account-portable preference are the same
 * administration target only when their portable identity, their device-local
 * routing id AND the daemon generation behind them all match. The generation is
 * part of the identity because a daemon that restarted between the render and
 * the write is a different authority for a Settings record, even though the
 * machine is the same machine.
 */
export function sameMachineAdministrationExecutionTarget(
    left: FreshMachineAdministrationExecutionTargetV1,
    right: FreshMachineAdministrationExecutionTargetV1,
): boolean {
    return left.target.serverIdentityId === right.target.serverIdentityId
        && left.machine.id === right.machine.id
        && left.serverId === right.serverId
        && left.machine.daemonStateVersion === right.machine.daemonStateVersion;
}

/**
 * The one projection from an Administration-selected machine to the exact
 * Settings/Secrets record target. It reuses the canonical
 * `resolveScopedPluginSettingsTarget` owner rather than assembling the daemon
 * shape locally, so an incomplete selection resolves to `null` — an absent
 * target — instead of a partially-formed one.
 */
export function resolveAdministrationScopedPluginSettingsTarget(
    executionTarget: FreshMachineAdministrationExecutionTargetV1 | null,
): ScopedPluginSettingsDaemonTarget | null {
    if (!executionTarget) return null;
    const target = resolveScopedPluginSettingsTarget({
        scope: DAEMON_PLUGIN_SETTINGS_SCOPE,
        serverIdentityId: executionTarget.target.serverIdentityId,
        machineId: executionTarget.machine.id,
        serverId: executionTarget.serverId,
    });
    return target?.kind === 'daemon' ? target : null;
}

/**
 * The administration machine that Settings, Secrets and lifecycle operations
 * actually address.
 *
 * This is deliberately a SEPARATE fact from a plugin's execution origin: a
 * plugin can execute on machine B while its records are administered on the
 * machine A the reader selected here. Both are true at once, so the surfaces
 * that present them must present both rather than collapsing them; this owner
 * only supplies the administration half, plus the one currentness fence every
 * asynchronous write re-checks immediately before it dispatches.
 *
 * It exists because the plugin home/detail model and the deep-linked Settings
 * page screen each grew their own copy of exactly this derivation, and two
 * copies of a currentness decision are two chances to write to a machine the
 * reader is no longer looking at.
 */
export type ScopedPluginSettingsDaemonTargetBindingV1 = Readonly<{
    selection: MachineAdministrationTargetSelectionV1;
    /** The freshly re-resolved administration machine, or `null` when none is usable. */
    executionTarget: FreshMachineAdministrationExecutionTargetV1 | null;
    /** The exact Settings/Secrets record target for that machine. */
    target: ScopedPluginSettingsDaemonTarget | null;
    /** Re-reads the live selection; a rendered target is presentation, never authority. */
    isTargetCurrent: (target: ScopedPluginSettingsDaemonTarget) => boolean;
    /** Re-resolves an expected administration machine, or `null` if it moved. */
    resolveCurrentExecutionTarget: (
        expected: FreshMachineAdministrationExecutionTargetV1 | null,
    ) => FreshMachineAdministrationExecutionTargetV1 | null;
}>;

export function useScopedPluginSettingsDaemonTargetBinding(
    selectionKey: string,
    options: MachineAdministrationTargetSelectionOptions = {},
): ScopedPluginSettingsDaemonTargetBindingV1 {
    const selection = useMachineAdministrationTargetSelection(selectionKey, options);
    const executionTarget = selection.resolveExecutionTarget();
    const target = React.useMemo(
        () => resolveAdministrationScopedPluginSettingsTarget(executionTarget),
        [
            executionTarget?.machine.id,
            executionTarget?.serverId,
            executionTarget?.target.serverIdentityId,
        ],
    );
    const resolveCurrentExecutionTarget = React.useCallback((
        expected: FreshMachineAdministrationExecutionTargetV1 | null,
    ): FreshMachineAdministrationExecutionTargetV1 | null => {
        if (!expected) return null;
        const current = selection.resolveExecutionTarget();
        return current && sameMachineAdministrationExecutionTarget(current, expected)
            ? current
            : null;
    }, [selection]);
    const isTargetCurrent = React.useCallback((candidate: ScopedPluginSettingsDaemonTarget): boolean => {
        const current = resolveCurrentExecutionTarget(executionTarget);
        return current !== null
            && current.target.serverIdentityId === candidate.serverIdentityId
            && current.machine.id === candidate.machineId
            && current.serverId === candidate.serverId;
    }, [executionTarget, resolveCurrentExecutionTarget]);
    return React.useMemo(() => Object.freeze({
        selection,
        executionTarget,
        target,
        isTargetCurrent,
        resolveCurrentExecutionTarget,
    }), [executionTarget, isTargetCurrent, resolveCurrentExecutionTarget, selection, target]);
}
