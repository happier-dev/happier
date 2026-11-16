import * as React from 'react';
import type { MachineIsolationPolicyV1 } from '@happier-dev/protocol/machines/machineIsolationV1';

import { useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import { useMachineIsolationPolicy } from '@/hooks/machine/useMachineIsolationPolicy';
import { isOpenedManagedMachinePresetV1, type OpenedManagedMachinePresetV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import { describeMachineIsolationPolicy } from './machineIsolationSummary';

const NO_SERVERS: readonly string[] = Object.freeze([]);

/**
 * The opened presets a policy names, keyed by configured sandbox id. Presets are read only while the policy names one,
 * through the Account's existing preset resource; an unopened or missing preset stays absent.
 */
export function useMachineIsolationPresets(serverId: string, policy: MachineIsolationPolicyV1 | null) {
    const configured = policy ? Object.entries(policy.configuredSandboxes) : [];
    const demanded = configured.length > 0;
    const serverIds = React.useMemo(() => (demanded ? [serverId] : NO_SERVERS), [demanded, serverId]);
    const presets = useMachinePresets(serverIds);
    const list = presets.presetsByServerId[serverId];
    const state = presets.statesByServerId[serverId];
    const byEntry = React.useMemo(() => {
        const opened = new Map<string, OpenedManagedMachinePresetV1>();
        for (const preset of list ?? []) if (isOpenedManagedMachinePresetV1(preset)) opened.set(preset.id, preset);
        const result = new Map<string, OpenedManagedMachinePresetV1>();
        for (const [id, entry] of Object.entries(policy?.configuredSandboxes ?? {})) {
            const preset = opened.get(entry.presetId);
            if (preset) result.set(id, preset);
        }
        return result;
    }, [list, policy?.configuredSandboxes]);
    return { byEntry, settled: !demanded || state?.loading === false, error: state?.error ?? null, refresh: presets.refresh };
}

/** The policy sentences for a Machine, or null while the policy or the presets it names are still unread. */
export function useMachineIsolationSummary(input: Readonly<{ serverId: string; machine: Machine; machineName: string }>) {
    const language = usePreferredLanguage();
    const { policy } = useMachineIsolationPolicy({ serverId: input.serverId, machine: input.machine });
    const presets = useMachineIsolationPresets(input.serverId, policy);
    return React.useMemo(() => policy && presets.settled
        ? describeMachineIsolationPolicy({ policy, machineName: input.machineName, nameOf: id => presets.byEntry.get(id)?.name ?? null })
        : null, [policy, presets.settled, presets.byEntry, input.machineName, language]);
}
