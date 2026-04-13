import * as React from 'react';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { OptionPickerProbeState } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { Settings } from '@/sync/domains/settings/settings';

import type { NewSessionAgentPickerSelection } from './buildNewSessionAgentPickerDetailContent';
import { buildNewSessionAgentPickerOptionInteractions } from './buildNewSessionAgentPickerOptionInteractions';
import { resolveNewSessionAgentPickerOptionPresentation } from './resolveNewSessionAgentPickerOptionPresentation';

type BuildNewSessionAgentPickerResolvedOptionsParams = Readonly<{
    profileForAgentSelection: AIBackendProfile | null;
    compatibleBackendTargetKeys: ReadonlySet<string>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    isBackendEntrySelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
    getEngineSelectionForTargetKey: (targetKey: string) => NewSessionAgentPickerSelection;
    selectEngineSelection: (entry: ResolvedBackendCatalogEntry, selection: NewSessionAgentPickerSelection) => void;
    selectedMachineId: string | null;
    capabilityServerId: string;
    selectedPath: string | null;
    settings: Settings;
    refreshProbe?: OptionPickerProbeState | null;
}>;

export function buildNewSessionAgentPickerResolvedOptions(
    params: BuildNewSessionAgentPickerResolvedOptionsParams,
): ReadonlyArray<AgentInputChipPickerOption> {
    return params.resolvedBackendEntries.map((entry) => {
        const selectable = params.isBackendEntrySelectable(entry);
        const { subtitle, disabled, muted } = resolveNewSessionAgentPickerOptionPresentation({
            entry,
            profileForAgentSelection: params.profileForAgentSelection,
            compatibleBackendTargetKeys: params.compatibleBackendTargetKeys,
            selectable,
        });

        return {
            id: entry.targetKey,
            label: entry.title,
            icon: (
                <AgentIcon
                    agentId={entry.iconAgentId}
                    size={12}
                    style={{ transform: [{ scale: getAgentPickerIconScale(entry.iconAgentId) }] }}
                />
            ),
            subtitle,
            disabled,
            muted,
            ...buildNewSessionAgentPickerOptionInteractions({
                entry,
                disabled,
                selectedMachineId: params.selectedMachineId,
                capabilityServerId: params.capabilityServerId,
                selectedPath: params.selectedPath,
                settings: params.settings,
                refreshProbe: params.refreshProbe,
                getEngineSelectionForTargetKey: params.getEngineSelectionForTargetKey,
                selectEngineSelection: params.selectEngineSelection,
            }),
        };
    });
}
