import * as React from 'react';
import { getAgentCore, getAgentStaticModels } from '@happier-dev/agents';
import { buildBackendTargetKeyV2, type BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { PluginBackendExecutionRunCapabilitiesV1Schema } from '@happier-dev/protocol/plugins/backendDefinitionV1';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useSetting } from '@/sync/domains/state/storage';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';
import { decodeScmDiffSummaryModelOverride, encodeScmDiffSummaryModelOverride } from '@/settings/scmDiffSummary/settings';
import { t } from '@/text';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readScmDiffSummaryModelCatalogForMachine } from '@/sync/ops/actions/scmDiffSummarySettingsCatalog';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { ScmDiffSummaryModelCatalogObservationV1Schema } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { SpawnFailureV1 } from '@happier-dev/protocol/machines/processes/spawnFailureV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { projectAgentModelChoices, readAgentModelChoiceTarget as targetFor, type AgentModelChoicePurpose } from './projectAgentModelChoices';
export type { AgentModelSelection } from './projectAgentModelChoices';

/** The person's words for an Agent whose process did not start: what happened and what to check, never the errno or a path. */
function describeAgentStartFailure(failure: SpawnFailureV1): Readonly<{ title: string; next: string }> {
    if (failure.errno === 'ENOENT') return { title: t('walkthroughSettings.startFailure.notInstalled.title'), next: t('walkthroughSettings.startFailure.notInstalled.next') };
    if (failure.errno === 'EACCES' || failure.errno === 'EPERM') return { title: t('walkthroughSettings.startFailure.cannotRun.title'), next: t('walkthroughSettings.startFailure.cannotRun.next') };
    return { title: t('walkthroughSettings.startFailure.other.title'), next: t('walkthroughSettings.startFailure.other.next') };
}

type SummaryUnavailableReason = NonNullable<ReturnType<typeof ScmDiffSummaryModelCatalogObservationV1Schema.parse>['unavailableTargets']>[number]['reason'];

/** Why the Machine's automatic choice skips an Agent whose explicit models stay selectable, with the next action; the section heading names the Agent. Account metadata is the catalog's notice, not the Agent's. */
function describeAutomaticUnavailable(reason: SummaryUnavailableReason): string | null {
    switch (reason) {
        case 'native_sign_in_required': return t('walkthroughSettings.automaticUnavailable.signIn');
        case 'native_auth_unavailable': return t('walkthroughSettings.automaticUnavailable.authUnknown');
        case 'connected_default_unavailable': return t('walkthroughSettings.automaticUnavailable.connected');
        case 'account_metadata_unavailable': return null;
    }
}

type GroupedUnavailableReason = Exclude<SummaryUnavailableReason, 'account_metadata_unavailable'>;

/** One message for several Agents the automatic choice skips for the same reason, with the next action. */
function describeGroupedUnavailable(reason: GroupedUnavailableReason, count: number): Readonly<{ title: string; next: string }> {
    switch (reason) {
        case 'native_sign_in_required': return { title: t('walkthroughSettings.groupedUnavailable.signIn.title', { count }), next: t('walkthroughSettings.groupedUnavailable.signIn.next') };
        case 'native_auth_unavailable': return { title: t('walkthroughSettings.groupedUnavailable.authUnknown.title', { count }), next: t('walkthroughSettings.groupedUnavailable.authUnknown.next') };
        case 'connected_default_unavailable': return { title: t('walkthroughSettings.groupedUnavailable.connected.title', { count }), next: t('walkthroughSettings.groupedUnavailable.connected.next') };
    }
}

/** The catalog notice row: pressing it reads the Machine's catalog again. */
export const SCM_SUMMARY_CATALOG_NOTICE_ITEM_ID = 'catalog-refresh';
/** The shared message for Agents that offer no model yet: pressing it reads the Machine's catalog again. */
export const SCM_SUMMARY_GROUPED_AGENTS_RETRY_ITEM_ID = 'grouped-agents-refresh';

/** One offered-model projection for Settings, the picker, and restored generation controls. */
export function useAgentModelChoices(params: Readonly<{
    value: string;
    purpose?: AgentModelChoicePurpose;
    machineId?: string | null;
    serverId?: string | null;
    cwd?: string | null;
    defaultBackendTarget?: BackendTargetRefV2 | null;
    /** A mounted result still observes its selected model when its picker is hidden. */
    observeSelection?: boolean;
    /** A saved result observes its producer without changing the next-generation selection. */
    observedValue?: string;
}>) {
    const [open, setOpen] = React.useState(false);
    const [discoveryTargetKey, setDiscoveryTarget] = React.useState<string | null>(null);
    const pendingDiscoveryTarget = React.useRef<string | null>(null);
    const setDiscoveryTargetKey = React.useCallback((targetKey: string | null) => {
        pendingDiscoveryTarget.current = targetKey;
        setDiscoveryTarget(targetKey);
    }, []);
    const enabledAgentIds = useEnabledAgentIds();
    const presented = useLayoutPresentationActive();
    const observing = presented && (open || params.observeSelection === true);
    const { snapshot: acpCatalog } = useAcpCatalogForServer(params.serverId, undefined, { enabled: observing });
    const catalogReady = acpCatalog?.catalog.status === 'ready' && !acpCatalog.stale;
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey') as Record<string, boolean> | undefined;
    const daemon = useDaemonMergedProjectionInputs({ machineId: params.machineId ?? null, serverId: params.serverId ?? null, enabled: observing && Boolean(params.machineId) });
    const entries = React.useMemo(() => getResolvedBackendCatalogEntries({ enabledAgentIds,
        acpCatalogSnapshot: acpCatalog?.catalog, backendEnabledByTargetKey,
        retainedAcpCatalogRecord: acpCatalog?.data,
        discoveredBackendIds: daemon.inputs?.discoveredBackendIds,
        mergedProviderProjectionById: daemon.inputs?.mergedProviderProjectionById,
        mergedBackendProjectionById: daemon.inputs?.mergedBackendProjectionById,
    }), [enabledAgentIds, acpCatalog, backendEnabledByTargetKey, daemon.inputs]);
    const selected = decodeScmDiffSummaryModelOverride(params.value);
    const catalogValue = params.value || params.observedValue || '';
    const purpose = params.purpose ?? 'walkthrough';
    const [summaryCatalog, setSummaryCatalog] = React.useState<Readonly<{
        lifetime: ServerAccountScopeLifetime;
        machineId: string; serverId: string; catalog: ReturnType<typeof ScmDiffSummaryModelCatalogObservationV1Schema.parse>;
    }> | null>(null);
    const [catalogRefresh, setCatalogRefresh] = React.useState(0);
    const [catalogReadFailed, setCatalogReadFailed] = React.useState(false);
    const summaryServerId = params.serverId || getActiveServerSnapshot().serverId;
    const catalogBindings = useServerCredentialAccountScopeBindings([summaryServerId]);
    const catalogLifetime = catalogBindings.values().next().value ?? null;
    // A failed read keeps the last observation of this same Account, Home and Machine; another identity retires it.
    const catalogIdentity = React.useRef<Readonly<{ machineId: string | null; serverId: string; lifetime: ServerAccountScopeLifetime | null }> | null>(null);
    React.useEffect(() => {
        const previous = catalogIdentity.current;
        if (previous && (previous.machineId !== (params.machineId ?? null) || previous.serverId !== summaryServerId || previous.lifetime !== catalogLifetime)) {
            setSummaryCatalog(null);
            setCatalogReadFailed(false);
        }
        catalogIdentity.current = { machineId: params.machineId ?? null, serverId: summaryServerId, lifetime: catalogLifetime };
    }, [params.machineId, summaryServerId, catalogLifetime]);
    React.useEffect(() => {
        if (purpose !== 'walkthrough' || !observing || !params.machineId || !catalogLifetime) return;
        const machineId = params.machineId;
        const abort = new AbortController();
        let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
        void (async () => {
            try {
                account = await captureLazyActionAccountContext(summaryServerId, abort.signal);
                if (abort.signal.aborted || !catalogLifetime.isCurrent()) return;
                // A target stays selected for projection; only an explicit operation bypasses the Machine cache once.
                const requestedDiscoveryTarget = pendingDiscoveryTarget.current;
                pendingDiscoveryTarget.current = null;
                const catalog = await readScmDiffSummaryModelCatalogForMachine(account, machineId, abort.signal,
                    { discoveryTargetKey: requestedDiscoveryTarget, modelSelector: decodeScmDiffSummaryModelOverride(catalogValue) });
                if (!abort.signal.aborted && catalogLifetime.isCurrent()) {
                    if (catalog) setSummaryCatalog({ lifetime: catalogLifetime, machineId, serverId: summaryServerId, catalog });
                    setCatalogReadFailed(catalog === null);
                }
            } catch { if (!abort.signal.aborted) setCatalogReadFailed(true); }
            finally { account?.dispose(); }
        })();
        return () => { abort.abort(); account?.dispose(); };
    }, [purpose, observing, params.machineId, catalogValue, summaryServerId, daemon.inputs, backendEnabledByTargetKey, catalogRefresh, discoveryTargetKey, catalogLifetime]);
    const executableCatalog = summaryCatalog && summaryCatalog.machineId === params.machineId && summaryCatalog.serverId === summaryServerId
        && summaryCatalog.lifetime === catalogLifetime && summaryCatalog.lifetime.isCurrent() ? summaryCatalog.catalog : null;
    // Why an Agent could not list models, by target: the Machine's typed observation, never a path or native message.
    const probeFailures = new Map((executableCatalog?.probeFailures ?? []).map(failure => [failure.backendTargetKey, failure.spawnFailure]));
    const unavailableTargets = new Map((executableCatalog?.unavailableTargets ?? []).map(target => [target.backendTargetKey, target.reason]));
    const accountMetadataUnavailable = executableCatalog?.unavailableReason === 'account_metadata_unavailable'
        || [...unavailableTargets.values()].includes('account_metadata_unavailable');
    // Retained choices remain explicit options; a failed read cannot authorize an automatic choice.
    const catalogInput = { executableProfiles: executableCatalog?.profiles, automaticProfiles: catalogReadFailed ? [] : executableCatalog?.automaticProfiles,
        discoveryTargetKeys: executableCatalog?.discoveryTargetKeys, probeFailureTargetKeys: [...probeFailures.keys()] };
    const selectedModelSelection = selected?.backendTargetKey && selected.modelId
        ? ProviderBoundModelRefSchema.parse({ agentTargetKey: selected.backendTargetKey, providerConnectionId: null, modelId: selected.modelId }) : null;
    const selectedEntry = entries.find((entry) => {
        const target = targetFor(entry);
        return target && buildBackendTargetKeyV2(target) === selected?.backendTargetKey;
    });
    const discoveryEntry = entries.find(entry => {
        const target = targetFor(entry);
        return target && buildBackendTargetKeyV2(target) === discoveryTargetKey;
    });
    const sources = entries.map(entry => {
        const staticModels = getAgentStaticModels(entry.agentId, { catalogOnly: true });
        const capability = entry.capabilities?.executionRun === undefined ? null
            : PluginBackendExecutionRunCapabilitiesV1Schema.safeParse(entry.capabilities.executionRun);
        const agentFormats = entry.kind === 'builtInAgent' ? getAgentCore(entry.agentId)?.structuredOutput?.formats : null;
        return { entry, models: staticModels, catalogModels: staticModels, agentFormats,
            selectable: entry.kind !== 'configuredBackend' || catalogReady,
            runnerCapable: capability === null || (capability.success && capability.data.supported),
            discoverable: purpose === 'runner' || entry.kind === 'configuredBackend' || entry === discoveryEntry || entry === selectedEntry || agentFormats?.includes('json') === true };
    });
    const initialDefault = projectAgentModelChoices({ purpose, sources, ...catalogInput, selected: selectedModelSelection,
        defaultBackendTarget: params.defaultBackendTarget, defaultModelTitle: t('agentInput.model.useCliSettings') }).defaultProfile;
    const defaultEntry = entries.find(entry => {
        const target = targetFor(entry);
        return target && buildBackendTargetKeyV2(target) === initialDefault?.modelSelector?.backendTargetKey;
    });
    const probeEntry = discoveryEntry ?? selectedEntry ?? (!params.value ? defaultEntry : undefined);
    const probeTarget = probeEntry ? targetFor(probeEntry) : params.defaultBackendTarget;
    const probe = useNewSessionPreflightModelsState({ backendTarget: probeTarget,
        runtimeCarrierAgentId: probeEntry?.agentId, selectedMachineId: params.machineId ?? null,
        capabilityServerId: params.serverId ?? '',
        cwd: params.cwd,
        enabled: purpose === 'runner' && observing && Boolean(params.machineId) && (probeEntry?.kind !== 'configuredBackend' || catalogReady),
    });
    const projected = projectAgentModelChoices({ purpose, ...catalogInput, selected: selectedModelSelection,
        defaultBackendTarget: params.defaultBackendTarget, defaultModelTitle: t('agentInput.model.useCliSettings'),
        sources: sources.map(source => {
            const target = targetFor(source.entry);
            const key = target ? buildBackendTargetKeyV2(target) : null;
            const dynamic = key && probe.preflightModelsTargetKey === key ? probe.preflightModels : null;
            return { ...source, models: dynamic?.availableModels ?? source.models };
        }) });
    const { selections, catalogProfiles, defaultProfile } = projected;
    const discoveryTargets = new Map<string, string>();
    const customModelTargets = new Map<string, string>();
    const costTierLabels = { low: t('walkthroughSettings.costLow'), standard: t('walkthroughSettings.costStandard'), premium: t('walkthroughSettings.costPremium') } as const;
    const items: DropdownMenuItem[] = [];
    const sections: Record<string, Readonly<{ icon: React.ReactNode; note?: string }>> = {};
    // Agents that offer no model yet (they can be asked for one, or could not start) share one section when there are
    // several, so a long list of empty Agents reads as one line per Agent and a reason most of them share is said once.
    const modelLessGroups = purpose === 'walkthrough' && params.machineId ? projected.groups.filter(group => group.offered.length === 0
        && (group.discoverable || probeFailures.has(group.targetKey)) && !group.customModelIdAllowed) : [];
    const groupedTargetKeys = new Set(modelLessGroups.length >= 2 ? modelLessGroups.map(group => group.targetKey) : []);
    for (const { entry, target, targetKey, offered: usable, hiddenModelCount: hidden, discoverable, customModelIdAllowed, selectable } of projected.groups) {
        if (groupedTargetKeys.has(targetKey)) continue;
        // Only models that can write a walkthrough are offered. An agent with none keeps its section only where a
        // machine can ask it for models that could: one whose format supports it, a configured agent, or the one asked.
        const startFailure = probeFailures.get(targetKey);
        if (usable.length === 0 && !(params.machineId && discoverable) && !startFailure) continue;
        sections[entry.title] = { icon: React.createElement(AgentIcon, { agentId: entry.agentId, size: 18 }),
            ...(hidden > 0 ? { note: t('walkthroughSettings.hiddenModels', { count: hidden }) } : {}) };
        for (const profile of usable) {
            // One row per model; the default is that row, marked, and the quiet line carries the catalog's relative cost when it has one.
            const meta = [profile.catalogId === defaultProfile?.catalogId ? t('walkthroughSettings.defaultModel') : null,
                profile.costTier ? costTierLabels[profile.costTier] : null].filter(Boolean).join(' · ') || undefined;
            items.push({ id: profile.catalogId, title: profile.title, category: entry.title, subtitle: meta,
                disabled: !selectable,
                ...(!selectable && acpCatalog?.catalog.status === 'loading'
                    ? { rightElement: React.createElement(ActivitySpinner, { size: 'small' }) } : {}) });
        }
        if (customModelIdAllowed) {
            const id = `backend-custom-model:${targetKey}`;
            customModelTargets.set(id, targetKey);
            items.push({ id, category: entry.title, title: t('settingsSession.replayResume.summaryRunner.customTitle'),
                disabled: !selectable,
                subtitle: t('settingsSession.replayResume.summaryRunner.customModelIdSubtitle') });
        }
        // Finding more models is one operation at the end of its agent's section, offered only where a machine can answer it.
        if (!params.machineId || !discoverable && !startFailure) continue;
        const id = `backend-discovery:${targetKey}`;
        discoveryTargets.set(id, targetKey);
        const probing = probeEntry === entry;
        const failed = purpose === 'runner' && probing && probe.probe.failed;
        // The row keeps its height while discovery runs: only its trailing spinner and, on failure, its wording change.
        // An Agent that could not start says so in this row, under its known models, and pressing it asks again.
        // An Agent the automatic choice skips keeps its explicit models and says why here, with what to do about it.
        const row = startFailure ? describeAgentStartFailure(startFailure) : null;
        const automaticReason = !row && unavailableTargets.has(targetKey) ? describeAutomaticUnavailable(unavailableTargets.get(targetKey)!) : null;
        items.push({ id, category: entry.title,
            disabled: !selectable,
            title: row?.title ?? (failed ? t('walkthroughSettings.loadModelsFailed') : t('walkthroughSettings.loadModels')),
            ...(row ? { subtitle: row.next } : automaticReason ? { subtitle: automaticReason } : {}),
            rightElement: purpose === 'runner' && probing && !failed && probe.probe.phase !== 'idle' ? React.createElement(ActivitySpinner, { size: 'small' }) : undefined });
    }
    if (groupedTargetKeys.size > 0) {
        const category = t('walkthroughSettings.moreAgents');
        const reasonCounts = new Map<GroupedUnavailableReason, number>();
        for (const group of modelLessGroups) {
            const reason = unavailableTargets.get(group.targetKey);
            if (reason && reason !== 'account_metadata_unavailable') reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
        }
        const [sharedReason, sharedCount] = [...reasonCounts].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
        const shared = sharedReason && sharedCount >= 2 ? sharedReason : null;
        // The shared reason leads the section as one row with its count and next action; pressing it tries again.
        if (shared) {
            const copy = describeGroupedUnavailable(shared, sharedCount);
            items.push({ id: SCM_SUMMARY_GROUPED_AGENTS_RETRY_ITEM_ID, category, title: copy.title, subtitle: copy.next });
        }
        for (const { entry, targetKey, hiddenModelCount: hidden } of modelLessGroups) {
            const id = `backend-discovery:${targetKey}`;
            discoveryTargets.set(id, targetKey);
            // Each Agent is one row named for itself; pressing it asks that Agent for its models. Only a reason the
            // section has not already said, or the count of models it hides, stays on its row.
            const startFailure = probeFailures.get(targetKey);
            const failure = startFailure ? describeAgentStartFailure(startFailure) : null;
            const reason = unavailableTargets.get(targetKey);
            const own = failure ? `${failure.title}. ${failure.next}` : reason && reason !== shared ? describeAutomaticUnavailable(reason) : null;
            const subtitle = own ?? (hidden > 0 ? t('walkthroughSettings.hiddenModels', { count: hidden }) : undefined);
            items.push({ id, category, title: entry.title, icon: React.createElement(AgentIcon, { agentId: entry.agentId, size: 18 }),
                accessibilityLabel: t('walkthroughSettings.findModelsFor', { agent: entry.title }), ...(subtitle ? { subtitle } : {}) });
        }
    }
    // The catalog's own state is one quiet row above the Agents: the list is long, and the end of it is never seen.
    // A failed refresh wins: the last readable choices stay, and the row says they may be out of date.
    const catalogNotice = purpose !== 'walkthrough' || !executableCatalog ? null
        : catalogReadFailed ? { title: t('walkthroughSettings.catalogNotice.refreshFailed.title'), subtitle: t('walkthroughSettings.catalogNotice.refreshFailed.next') }
            : accountMetadataUnavailable ? { title: t('walkthroughSettings.catalogNotice.accountMetadata.title'), subtitle: t('walkthroughSettings.catalogNotice.accountMetadata.next') } : null;
    if (catalogNotice) items.unshift({ id: SCM_SUMMARY_CATALOG_NOTICE_ITEM_ID, ...catalogNotice });
    const defaultSelection = defaultProfile ? selections.get(defaultProfile.catalogId) : undefined;
    // An unset choice follows the default: it resolves to that row's selection without writing it.
    if (defaultSelection && purpose === 'walkthrough') selections.set('', defaultSelection);
    const effectiveId = (selected ? encodeScmDiffSummaryModelOverride(selected) : params.value)
        || (purpose === 'walkthrough' && defaultSelection ? defaultProfile!.catalogId : '');
    const restoredSelection = selections.get(effectiveId);
    if (params.value && restoredSelection) selections.set(params.value, restoredSelection);
    // An empty menu says why: the Machine has not answered yet, the answer could not be read, or nothing is offered.
    const awaitingCatalog = purpose === 'walkthrough' && observing && Boolean(params.machineId) && !executableCatalog;
    const needsMachine = purpose === 'walkthrough' && !params.machineId;
    const emptyLabel = awaitingCatalog
        ? t(catalogReadFailed ? 'walkthroughSettings.loadModelsFailed' : 'walkthroughSettings.loadingModels')
        : t(needsMachine ? 'walkthroughSettings.chooseMachineForModels' : 'walkthroughSettings.noModels');
    return { open, setOpen, emptyLabel, discoveryTargetKey, setDiscoveryTargetKey, selections, discoveryTargets, customModelTargets, items, sections,
        catalogProfiles, defaultProfile, groups: projected.groups,
        selectedItem: items.find(item => item.id === effectiveId), selectionAvailable: selections.has(params.value),
        onRefresh: purpose === 'walkthrough' ? () => setCatalogRefresh(value => value + 1) : probe.probe.onRefresh };
}
