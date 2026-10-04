import * as React from 'react';
import { getAgentCore, getAgentStaticModels } from '@happier-dev/agents';
import { buildBackendTargetKeyV2, readBackendTargetRefV2, type BackendTargetRefV2, type AcpCatalogSettingsV1, type ScmDiffSummaryModelSelector } from '@happier-dev/protocol';
import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useSetting } from '@/sync/domains/state/storage';
import { decodeScmDiffSummaryModelOverride } from '@/settings/scmDiffSummary/settings';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { t } from '@/text';
import { useViewportClass } from '@/utils/platform/useViewportClass';

export type ScmDiffSummaryModelSelection = Readonly<{ backendTarget: BackendTargetRefV2; modelSelector: ScmDiffSummaryModelSelector }>;

/** The one Summary model picker: settings and START share the runtime catalog and preference codec. */
export function ScmDiffSummaryModelPicker(props: Readonly<{
    value: string;
    onChange: (value: string) => void;
    onSelection?: (selection: ScmDiffSummaryModelSelection) => void;
    onAvailabilityChange?: (available: boolean) => void;
    machineId?: string | null;
    serverId?: string | null;
    defaultBackendTarget?: BackendTargetRefV2 | null;
    testID?: string;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const viewportClass = useViewportClass();
    const [discoveryTargetKey, setDiscoveryTargetKey] = React.useState<string | null>(null);
    const enabledAgentIds = useEnabledAgentIds();
    const acpCatalogSettings = useSetting('acpCatalogSettingsV1') as AcpCatalogSettingsV1 | undefined;
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey') as Record<string, boolean> | undefined;
    const daemon = useDaemonMergedProjectionInputs({ machineId: props.machineId ?? null, serverId: props.serverId ?? null, enabled: open && Boolean(props.machineId) });
    const entries = React.useMemo(() => getResolvedBackendCatalogEntries({ enabledAgentIds,
        acpCatalogSettingsV1: acpCatalogSettings ?? { v: 2, backends: [] }, backendEnabledByTargetKey,
        discoveredBackendIds: daemon.inputs?.discoveredBackendIds,
        mergedProviderProjectionById: daemon.inputs?.mergedProviderProjectionById,
        mergedBackendProjectionById: daemon.inputs?.mergedBackendProjectionById,
    }), [enabledAgentIds, acpCatalogSettings, backendEnabledByTargetKey, daemon.inputs]);
    const targetFor = (entry: ResolvedBackendCatalogEntry): BackendTargetRefV2 | null => {
        try { return readBackendTargetRefV2(entry.backendTarget); }
        catch { return entry.compatibilityBackendTargets?.[0] ?? null; }
    };
    const selected = decodeScmDiffSummaryModelOverride(props.value);
    const selectedEntry = entries.find((entry) => {
        const target = targetFor(entry);
        return target && buildBackendTargetKeyV2(target) === selected?.backendTargetKey;
    });
    const discoveryEntry = entries.find(entry => {
        const target = targetFor(entry);
        return target && buildBackendTargetKeyV2(target) === discoveryTargetKey;
    });
    const probeEntry = discoveryEntry ?? selectedEntry;
    const probeTarget = probeEntry ? targetFor(probeEntry) : props.defaultBackendTarget;
    const probe = useNewSessionPreflightModelsState({
        backendTarget: probeTarget,
        runtimeCarrierAgentId: probeEntry?.agentId,
        selectedMachineId: props.machineId ?? null, capabilityServerId: props.serverId ?? '', enabled: open && Boolean(props.machineId),
    });
    const selections = new Map<string, ScmDiffSummaryModelSelection>();
    const discoveryTargets = new Map<string, string>();
    const items: DropdownMenuItem[] = [];
    for (const entry of entries) {
        const target = targetFor(entry);
        if (!target) continue;
        const dynamic = probeTarget && buildBackendTargetKeyV2(target) === buildBackendTargetKeyV2(probeTarget) && probe.preflightModels ? probe.preflightModels.availableModels : null;
        const staticModels = getAgentStaticModels(entry.agentId, { catalogOnly: true });
        const profiles = buildScmDiffSummaryModelProfiles({ backendTarget: target, models: dynamic ?? staticModels,
                agentFormats: entry.kind === 'builtInAgent' ? getAgentCore(entry.agentId)?.structuredOutput?.formats : null,
        });
        const targetKey = buildBackendTargetKeyV2(target);
        const id = `backend-discovery:${targetKey}`;
        discoveryTargets.set(id, targetKey);
        items.push({ id, title: entry.title, category: entry.title, disabled: !props.machineId,
            subtitle: !props.machineId || (probeEntry === entry && probe.probe.failed) ? t('walkthroughSettings.unavailable')
                : probeEntry === entry && probe.probe.phase !== 'idle' ? t('common.loading') : t('walkthroughSettings.chooseModel') });
        for (const profile of profiles) {
            const support = profile.structuredOutput;
            if (support === 'supported' && profile.modelSelector) selections.set(profile.catalogId, { backendTarget: target, modelSelector: profile.modelSelector });
            items.push({ id: profile.catalogId, title: profile.title, category: entry.title, disabled: support !== 'supported',
                subtitle: support === 'supported' ? undefined : support === 'unsupported' ? t('walkthroughSettings.unsupported') : t('walkthroughSettings.unavailable') });
        }
    }
    const runtimeDefault = props.defaultBackendTarget;
    if (runtimeDefault) {
        const runtimeSelection = [...selections.values()].find(selection => selection.modelSelector.modelId === 'default'
            && buildBackendTargetKeyV2(selection.backendTarget) === buildBackendTargetKeyV2(runtimeDefault));
        if (runtimeSelection) selections.set('', runtimeSelection);
        items.unshift({ id: '', title: t('agentInput.model.useCliSettings'), disabled: !runtimeSelection,
            subtitle: runtimeSelection ? undefined : t('walkthroughSettings.unavailable') });
    }
    const selectedItem = items.find((item) => item.id === props.value);
    const selectionAvailable = selections.has(props.value);
    React.useEffect(() => { props.onAvailabilityChange?.(selectionAvailable); }, [props.onAvailabilityChange, selectionAvailable]);
    return <DropdownMenu open={open} onOpenChange={setOpen} items={items} selectedId={props.value} search
        variant="selectable" matchTriggerWidth connectToTrigger closeOnSelect={false}
        itemTrigger={{ title: t('walkthroughSettings.model'), subtitle: t('walkthroughSettings.modelDescription'),
            detailFormatter: () => selectedItem?.title ?? (props.value ? t('walkthroughSettings.unavailable') : runtimeDefault && selections.has('') ? t('agentInput.model.useCliSettings') : t('walkthroughSettings.chooseModel')),
            itemProps: { testID: props.testID ?? 'walkthrough.summaryModel', subtitleLines: 0,
                accessoryLayout: viewportClass === 'compact' ? 'stacked' : 'adaptive' } }}
        onSelect={(id) => {
            const discoveryTarget = discoveryTargets.get(id);
            if (discoveryTarget) {
                if (!props.machineId) return;
                setDiscoveryTargetKey(discoveryTarget); setOpen(true);
                if (discoveryTarget === discoveryTargetKey) probe.probe.onRefresh?.();
                return;
            }
            const selection = selections.get(id);
            if (!selection) return;
            props.onChange(id); props.onSelection?.(selection); setDiscoveryTargetKey(null); setOpen(false);
        }} />;
}
