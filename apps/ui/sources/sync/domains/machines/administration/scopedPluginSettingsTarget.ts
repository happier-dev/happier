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
import { isMachineAdministrationExecutionTargetCurrent } from './operationCurrentness';

const DAEMON_PLUGIN_SETTINGS_SCOPE = Object.freeze({ kind: 'daemon' as const });

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
    /** Portable server identity retained even when the selected daemon is offline. */
    selectedServerIdentityId: string | null;
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

export function isAdministrationScopedPluginSettingsTargetCurrent(params: Readonly<{
    target: ScopedPluginSettingsDaemonTarget;
    expectedExecutionTarget: FreshMachineAdministrationExecutionTargetV1 | null;
    resolveCurrentExecutionTarget: () => FreshMachineAdministrationExecutionTargetV1 | null;
}>): boolean {
    if (!params.expectedExecutionTarget) return false;
    const expectedTarget = resolveAdministrationScopedPluginSettingsTarget(params.expectedExecutionTarget);
    if (
        !expectedTarget
        || expectedTarget.serverIdentityId !== params.target.serverIdentityId
        || expectedTarget.machineId !== params.target.machineId
        || expectedTarget.serverId !== params.target.serverId
    ) return false;
    return isMachineAdministrationExecutionTargetCurrent({
        expectedTarget: params.expectedExecutionTarget,
        resolveCurrentTarget: params.resolveCurrentExecutionTarget,
    });
}

export function useScopedPluginSettingsDaemonTargetBinding(
    selectionKey: string,
    options: MachineAdministrationTargetSelectionOptions = {},
): ScopedPluginSettingsDaemonTargetBindingV1 {
    const selection = useMachineAdministrationTargetSelection(selectionKey, options);
    const selectedServerIdentityId = selection.selectedTarget?.serverIdentityId ?? null;
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
        return isMachineAdministrationExecutionTargetCurrent({
            expectedTarget: expected,
            resolveCurrentTarget: () => current,
        }) ? current : null;
    }, [selection]);
    const isTargetCurrent = React.useCallback((candidate: ScopedPluginSettingsDaemonTarget): boolean => {
        return isAdministrationScopedPluginSettingsTargetCurrent({
            target: candidate,
            expectedExecutionTarget: executionTarget,
            resolveCurrentExecutionTarget: selection.resolveExecutionTarget,
        });
    }, [executionTarget, selection.resolveExecutionTarget]);
    return React.useMemo(() => Object.freeze({
        selection,
        selectedServerIdentityId,
        executionTarget,
        target,
        isTargetCurrent,
        resolveCurrentExecutionTarget,
    }), [executionTarget, isTargetCurrent, resolveCurrentExecutionTarget, selectedServerIdentityId, selection, target]);
}
