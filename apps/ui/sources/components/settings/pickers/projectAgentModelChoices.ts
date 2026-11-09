import { buildBackendTargetKeyV2, readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ProviderBoundModelRefSchema, type ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type { ProviderModelDescriptorV1 } from '@happier-dev/protocol/models/descriptor';
import { buildScmDiffSummaryModelProfiles } from '@happier-dev/protocol/actions/settings/scmDiffSummaryModels';
import { selectAgentModelProfilesForPurpose, type AgentModelChoicePurpose } from '@happier-dev/protocol/actions/settings/scmDiffSummaryModels';
import { resolveScmDiffSummaryDefaultModelProfile, type ScmDiffSummaryCatalogProfile } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

/** Purpose changes capability admission, never Agent identity. */
export type { AgentModelChoicePurpose } from '@happier-dev/protocol/actions/settings/scmDiffSummaryModels';
export type AgentModelSelection = Readonly<{
    backendTarget: BackendTargetRefV2;
    modelSelection: ProviderBoundModelRef;
    modelSelector: NonNullable<ScmDiffSummaryCatalogProfile['modelSelector']>;
}>;
export type AgentModelChoiceSource = Readonly<{
    entry: ResolvedBackendCatalogEntry;
    models: readonly Pick<ProviderModelDescriptorV1, 'id' | 'name' | 'capabilities' | 'costTier'>[];
    catalogModels: readonly Pick<ProviderModelDescriptorV1, 'id' | 'name' | 'capabilities' | 'costTier'>[];
    agentFormats?: readonly string[] | null;
    runnerCapable: boolean;
    discoverable: boolean;
    /** Retained display models stay visible while their catalog revalidates. */
    selectable?: boolean;
}>;

export function readAgentModelChoiceTarget(entry: ResolvedBackendCatalogEntry): BackendTargetRefV2 | null {
    try { return readBackendTargetRefV2(entry.backendTarget); }
    catch { return entry.compatibilityBackendTargets?.[0] ?? null; }
}

/** Both menus consume this pure projection; display primitives only decorate its rows. */
export function projectAgentModelChoices(params: Readonly<{
    purpose: AgentModelChoicePurpose;
    sources: readonly AgentModelChoiceSource[];
    executableProfiles?: readonly ScmDiffSummaryCatalogProfile[];
    automaticProfiles?: readonly ScmDiffSummaryCatalogProfile[];
    discoveryTargetKeys?: readonly string[];
    /** An Agent that could not start keeps its group: the person is told why instead of finding it gone. */
    probeFailureTargetKeys?: readonly string[];
    selected?: ProviderBoundModelRef | null;
    defaultBackendTarget?: BackendTargetRefV2 | null;
    defaultModelTitle: string;
}>) {
    const selections = new Map<string, AgentModelSelection>();
    const groups = params.sources.flatMap(source => {
        const target = readAgentModelChoiceTarget(source.entry);
        if (!target || params.purpose === 'runner' && !source.runnerCapable) return [];
        const targetKey = source.entry.backendTargetKey;
        const models = [...source.models];
        if (params.purpose === 'runner') {
            if (!models.some(model => model.id === 'default')) models.unshift({ id: 'default', name: params.defaultModelTitle });
            if (params.selected?.agentTargetKey === targetKey && !models.some(model => model.id === params.selected?.modelId))
                models.push({ id: params.selected.modelId, name: params.selected.modelId });
        }
        const profiles = params.purpose === 'walkthrough'
            ? (params.executableProfiles ?? []).filter(profile => profile.modelSelector?.backendTargetKey === targetKey)
            : buildScmDiffSummaryModelProfiles({ backendTarget: source.entry.backendTarget, models, catalogModels: source.catalogModels, agentFormats: source.agentFormats });
        const discoverable = params.purpose === 'walkthrough' ? params.discoveryTargetKeys?.includes(targetKey) === true : source.discoverable;
        if (params.purpose === 'walkthrough' && profiles.length === 0 && !discoverable && params.probeFailureTargetKeys?.includes(targetKey) !== true) return [];
        const offered = selectAgentModelProfilesForPurpose(profiles, params.purpose);
        const selectable = source.selectable !== false;
        for (const profile of selectable ? offered : []) {
            const modelSelector = profile.modelSelector;
            if (!modelSelector?.modelId) continue;
            const modelSelection = ProviderBoundModelRefSchema.parse({ agentTargetKey: targetKey, providerConnectionId: null, modelId: modelSelector.modelId });
            selections.set(profile.catalogId, { backendTarget: target, modelSelection, modelSelector });
        }
        return [{ entry: source.entry, target, targetKey, profiles, offered, selectable,
            hiddenModelCount: profiles.length - offered.length, discoverable,
            customModelIdAllowed: params.purpose === 'runner' }];
    });
    const catalogProfiles = params.purpose === 'walkthrough' ? params.executableProfiles ?? [] : groups.flatMap(group => group.profiles);
    const selectableTargets = new Set(groups.filter(group => group.selectable).map(group => group.targetKey));
    const defaultProfile = params.purpose === 'walkthrough'
        ? resolveScmDiffSummaryDefaultModelProfile((params.automaticProfiles ?? []).filter(profile => selectableTargets.has(profile.modelSelector?.backendTargetKey ?? '')), params.defaultBackendTarget)
        : groups.find(group => group.selectable && group.targetKey === (params.selected?.agentTargetKey
            ?? (params.defaultBackendTarget ? buildBackendTargetKeyV2(params.defaultBackendTarget) : null)))?.offered.find(profile => profile.modelSelector?.modelId === 'default') ?? null;
    return { groups, selections, catalogProfiles, defaultProfile };
}
