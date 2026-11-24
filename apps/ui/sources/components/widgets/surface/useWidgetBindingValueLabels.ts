import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { MachineTargetV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { readWidgetInputTargetV1, type WidgetInputBindingsV1 } from '@happier-dev/protocol/widgets';

import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { storage, useSessionDisplayNameProjections, type SessionDisplayNameSource } from '@/sync/domains/state/storage';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import { resolveWorkspaceDisplayPresentation } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { resolveExactServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';

import { describeWidgetBindingPinValue, type WidgetBindingLabelField, type WidgetBindingValueLabel, type WidgetBindingValueLabels } from './widgetBindingValueLabel';

const sessionName = (source: SessionDisplayNameSource | null) => source ? getSessionName(source, source.serverId) : null;

/** Live display words for declared pins; labels never become part of the stored binding. */
export function useWidgetBindingValueLabels(
    bindings: WidgetInputBindingsV1,
    candidate: Pick<WidgetCandidate, 'inputs' | 'sessionInputPath'> | null | undefined,
    groupFields?: readonly WidgetBindingLabelField[],
): WidgetBindingValueLabels {
    const isSessionVisible = useSessionRecordingVisibility();
    const entries = React.useMemo(() => {
        const fields = candidate?.inputs?.fields ?? [];
        const target = readWidgetInputTargetV1(candidate ?? {});
        const paths = fields.map(field => field.path);
        // Installed descriptors may declare their exact Session ABI without field hints.
        if (target.kind === 'session' && !paths.includes(target.path)) paths.unshift(target.path);
        const declarations = groupFields ?? paths.map(slot => ({
            slot, field: fields.find(field => field.path === slot), sessionTarget: target.kind === 'session' && target.path === slot,
        }));
        return declarations.map(({ slot, field, sessionTarget }) => {
            const binding = bindings[slot];
            const value = binding?.kind === 'value' ? binding.value : undefined;
            const session = value !== undefined && (sessionTarget
                || (field?.inputType && 'hostType' in field.inputType && field.inputType.hostType === 'session'))
                ? VoiceTrackedSessionAddressV1Schema.safeParse(value) : null;
            const workspace = value !== undefined && field?.inputType && 'hostType' in field.inputType && field.inputType.hostType === 'workspace'
                ? WorkspaceRefV1Schema.safeParse(value) : null;
            const machine = value !== undefined && field?.inputType && 'hostType' in field.inputType && field.inputType.hostType === 'machine'
                ? MachineTargetV1Schema.safeParse(value) : null;
            return { slot, field, value, sessionTarget, session: session?.success ? session.data : null, workspace: workspace?.success ? workspace.data : null,
                machine: machine?.success ? machine.data : null };
        });
    }, [bindings, candidate, groupFields]);
    const addresses = React.useMemo(() => entries.flatMap(entry => entry.session && isSessionVisible(entry.session) ? [entry.session] : []), [entries, isSessionVisible]);
    // The pinned Sessions are named from encrypted content: they demand it like visible list rows.
    useSessionContentDemand(addresses, { tag: 'widgets.hydrateBoundSessions', hydrate: 'unsettled' });
    const sessionNames = useSessionDisplayNameProjections(addresses, sessionName);
    // Select the displayed words only: unrelated workspace changes do not invalidate these pins.
    const workspaceNames = storage(useShallow(state => entries.map(entry => entry.workspace ? resolveWorkspaceDisplayPresentation({
        scope: entry.workspace, workspaceRefs: readProjectWorkspaceRefs(state), fallbackPathLabel: entry.workspace.rootPath,
        legacyLabel: entry.workspace.label,
    }).displayTitle : null)));
    const machineNames = storage(useShallow(state => entries.map(entry => {
        if (!entry.machine) return null;
        const machine = resolveExactServerScopedMachine({ ...entry.machine,
            activeServerId: getActiveServerSnapshot().serverId, activeMachines: Object.values(state.machines),
            machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId });
        // The Home's list disambiguates near-identical names; the frame says the same name as that list.
        const inventory = state.machineListByServerId?.[entry.machine.serverId ?? getActiveServerSnapshot().serverId ?? ''] ?? undefined;
        return machine ? getMachineDisplayName(machine, inventory) : null;
    })));
    return React.useMemo(() => {
        let sessionIndex = 0;
        const labels: Record<string, WidgetBindingValueLabel> = Object.create(null);
        entries.forEach((entry, index) => {
            const { field, value } = entry;
            let label: WidgetBindingValueLabel;
            if (entry.session) label = isSessionVisible(entry.session) ? sessionNames[sessionIndex++] ?? null : null;
            else if (entry.workspace) label = workspaceNames[index] ?? null;
            else if (entry.machine) label = machineNames[index] ?? null;
            else if (value !== undefined) label = describeWidgetBindingPinValue(field, value, entry.sessionTarget, groupFields !== undefined);
            labels[entry.slot] = Object.hasOwn(labels, entry.slot) && labels[entry.slot] !== label ? null : label;
        });
        return labels;
    }, [entries, sessionNames, workspaceNames, machineNames, isSessionVisible, groupFields]);
}
