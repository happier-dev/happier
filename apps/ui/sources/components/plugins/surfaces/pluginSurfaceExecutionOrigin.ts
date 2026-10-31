import * as React from 'react';
import { arePluginMachineExecutionOriginsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';

import { readCurrentAppShellPluginUiProjection, readCurrentAppShellPluginUiExecutionOriginCandidates,
    subscribeCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { useActivePluginAccountAvailabilityReleaseClassifier } from '@/sync/domains/plugins/availability/projection';
import { usePluginMachineExecutionOriginSelection } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { createPluginUiProjectedActionResolver, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionSupplies } from '@/sync/domains/plugins/ui/projectionUnion';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getPluginExecutionOriginCandidateOrigin, type PluginExecutionOriginContextualTarget } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { resolvePluginUiProjectionContributionId } from '@/sync/domains/plugins/ui/projectionRefs';
import { readSelectedPluginUiResourceCapability } from '@/sync/domains/plugins/ui/resourceCapability';
import { readRequiredPluginSurfaceHostMethods } from './boundPluginSurfaceController';

function record(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

/** Declared machine-backed capabilities, not execution availability or a selector policy. */
export function isPluginSurfaceMachineBound(params: Readonly<{
    pluginId: string;
    surface: Readonly<{
        renderer: Readonly<Record<string, unknown>>;
        runtime?: unknown;
        headerActions?: unknown;
    }>;
    projection: PluginUiProjectionModel | null | undefined;
}>): boolean {
    const { renderer } = params.surface;
    const family = renderer.kind === 'reactNative' ? 'reactNativeBundle'
        : renderer.kind === 'hostedWeb' ? 'hostedWeb' : null;
    const artifacts = family === 'reactNativeBundle' ? params.projection?.reactNativeBundlesById
        : family === 'hostedWeb' ? params.projection?.hostedWebById : null;
    const artifactId = family ? resolvePluginUiProjectionContributionId({ family, pluginId: params.pluginId,
        contributionId: renderer.contributionId, entriesById: artifacts ?? {} }) : null;
    const artifact = artifactId ? artifacts?.[artifactId] : null;
    const methods = readRequiredPluginSurfaceHostMethods(renderer.requiredHostMethods
        ?? record(renderer.model)?.requiredHostMethods ?? artifact?.requiredHostMethods);
    if (methods === null) return false;
    const declaredExecution = params.projection?.installedPackagesById[params.pluginId]?.declaredExecution;
    // Mounted contribution points are read from the selected daemon even when
    // its renderer can also present Account data without required host methods.
    if (declaredExecution?.contributionPoints === true
        || params.projection?.installedPackagesById[params.pluginId]?.declaresContributionPoints === true) return true;
    // The same Resource methods also serve Account-owned borrowed host reads.
    // A declared daemon Resource capability implies demand for a target. For an
    // Account renderer, suppliers carry that declaration; only Administration's
    // selected supplier can grant the mounted transport its capability.
    // requiredHostMethods is the renderer's compatibility minimum, not an
    // inventory of the selected member's declared daemon Resource reads.
    if (readSelectedPluginUiResourceCapability(params.surface).readable
        || readPluginUiContributionSupplies(params.surface).some(supply => supply.resourceCapability?.readable)) return true;
    if (methods.some(method => method === 'readStoredImage' || method === 'watchLiveStream'
        || method === 'statOpenableContent' || method === 'readOpenableContent'
        || method === 'selectActionInput')) return true;
    const actions = Object.values(params.projection?.actionsById ?? {});
    if (methods.includes('executeAction') && (declaredExecution?.daemonActions === true
        || actions.some(action => action.pluginId === params.pluginId && action.execution.target === 'daemon'))) return true;
    return Array.isArray(params.surface.headerActions) && params.surface.headerActions.some(action => {
        const command = record(record(action)?.command);
        const identity = PluginContributionIdentityV1Schema.safeParse(command?.action);
        return command?.kind === 'executeAction' && identity.success
            && createPluginUiProjectedActionResolver(params.projection?.actionsById)(identity.data)?.execution.target === 'daemon';
    });
}

/** Presentation adapts producer custody; Administration remains the sole selector. */
export function usePluginSurfaceExecutionOrigin(params: Readonly<{
    pluginId: string;
    projection: PluginUiProjectionModel | null | undefined;
    entry?: Readonly<{ id: string }> | null;
    enabled: boolean;
    /** Only a rendered Run-on selector needs the full Machine label projection. */
    includeMachineCandidates?: boolean;
    contextualTarget?: PluginExecutionOriginContextualTarget | null;
}>) {
    const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier();
    // Selection is plugin-scoped, just like the shell's Administration
    // reporter. The open page narrows only the selected producer's supply,
    // never the candidates or defaults used to choose that producer.
    const readCurrentCandidates = React.useCallback(() => readCurrentAppShellPluginUiExecutionOriginCandidates(params.pluginId), [params.pluginId]);
    const supplied = React.useSyncExternalStore(subscribeCommittedAppShellPluginUiProjection, readCurrentCandidates, readCurrentCandidates);
    const readSourceCandidates = React.useCallback(() => readCurrentCandidates().sourceCandidates, [readCurrentCandidates]);
    const readMachineRejections = React.useCallback(() => readCurrentCandidates().machineRejections, [readCurrentCandidates]);
    const readDeclaredDefaultOrigins = React.useCallback(() => readCurrentCandidates().declaredDefaultOrigins, [readCurrentCandidates]);
    const selection = usePluginMachineExecutionOriginSelection({
        pluginId: params.pluginId, enabled: params.enabled, classifyRelease,
        includeMachineCandidates: params.includeMachineCandidates,
        ...supplied, readSourceCandidates, readMachineRejections, readDeclaredDefaultOrigins,
        contextualTarget: params.contextualTarget,
    });
    const selectedSupplyFromSelection = React.useMemo(() => selection.selectedOrigin
        ? readPluginUiContributionSupplies(params.entry).find(supply => supply.executionOrigin
            && arePluginMachineExecutionOriginsEqual(supply.executionOrigin, selection.selectedOrigin!)) ?? null
        : null, [params.entry, selection.selectedOrigin]);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const lastSelectedSupply = React.useRef<Readonly<{
        accountLifetime: typeof accountLifetime;
        entryId: string;
        supply: NonNullable<typeof selectedSupplyFromSelection>;
    }> | null>(null);
    const previous = lastSelectedSupply.current;
    // Presence/projection readiness can withdraw execution without replacing
    // the admitted producer. Retain only its exact presentation identity;
    // invocation still resolves fresh Administration authority below.
    const offlineCandidate = previous?.supply.executionOrigin && selection.state.kind === 'unavailable'
        ? selection.candidates.find(candidate => arePluginMachineExecutionOriginsEqual(
            getPluginExecutionOriginCandidateOrigin(candidate), previous.supply.executionOrigin!,
        )) : null;
    const sourceNotReady = offlineCandidate?.validation.kind === 'rejected'
        && offlineCandidate.validation.reason === 'source_not_ready';
    const hasPreviousPresentation = params.enabled && accountLifetime?.isCurrent() === true
        && previous?.accountLifetime === accountLifetime && previous.entryId === params.entry?.id;
    const matchesPreviousSupply = (supply: NonNullable<typeof selectedSupplyFromSelection>) => (
        supply.executionOrigin !== null && previous?.supply.executionOrigin != null
        && arePluginMachineExecutionOriginsEqual(supply.executionOrigin, previous.supply.executionOrigin)
        && supply.occurrenceId === previous.supply.occurrenceId
        && supply.pluginVersion === previous.supply.pluginVersion
        && supply.serverId === previous.supply.serverId
    );
    const canRetainSupply = hasPreviousPresentation
        && (!selection.selectedOrigin || arePluginMachineExecutionOriginsEqual(selection.selectedOrigin, previous.supply.executionOrigin!))
        && offlineCandidate?.validation.kind === 'rejected'
        && (offlineCandidate.validation.reason === 'offline' || offlineCandidate.validation.reason === 'stale'
            || offlineCandidate.validation.reason === 'home_unreachable' || offlineCandidate.validation.reason === 'daemon_unavailable'
            || offlineCandidate.validation.reason === 'daemon_invalid_response' || sourceNotReady);
    const retainedSupply = canRetainSupply ? readPluginUiContributionSupplies(params.entry).find(supply => (
        matchesPreviousSupply(supply)
        // A registry refresh withdraws authority, not this mounted identity.
        // Otherwise its targeted replacement is immediately canceled and
        // restarted when the same occurrence is admitted. A definitive
        // source-not-ready answer is not an establishing refresh.
        && (supply.unavailableReasonCode !== 'plugin_source_not_ready' || supply.phase === 'establishing')
    )) ?? null : null;
    const selectedSupply = selectedSupplyFromSelection ?? retainedSupply;
    // Fresh invocation authority can withdraw before the descriptive selection
    // publication catches up. Do not erase the same establishing presentation
    // in that intermediate turn; the unavailable/refusal guard above still
    // decides whether it survives the completed selection publication.
    const awaitingSelectionPublication = hasPreviousPresentation && selection.state.kind === 'selected'
        && selectedSupplyFromSelection?.phase === 'establishing' && matchesPreviousSupply(selectedSupplyFromSelection);
    React.useLayoutEffect(() => {
        if (selection.canExecute && selectedSupplyFromSelection && params.entry && accountLifetime?.isCurrent()) {
            lastSelectedSupply.current = { accountLifetime, entryId: params.entry.id, supply: selectedSupplyFromSelection };
        } else if (!retainedSupply && !awaitingSelectionPublication) {
            lastSelectedSupply.current = null;
        }
    }, [accountLifetime, awaitingSelectionPublication, params.entry, retainedSupply, selectedSupplyFromSelection, selection.canExecute]);
    const isExecutionOriginCurrent = React.useCallback((options?: Readonly<{ recordUse?: boolean }>) => {
        const fresh = selection.resolveExecutionOrigin({ recordUse: options?.recordUse === true });
        if (!fresh || !selectedSupply?.executionOrigin || !selectedSupply.occurrenceId
            || selectedSupply.phase !== 'current' || !selectedSupply.interactionEnabled
            || !arePluginMachineExecutionOriginsEqual(fresh.origin, selectedSupply.executionOrigin)) return false;
        const projection = readCurrentAppShellPluginUiProjection();
        const entry = params.entry && projection
            ? projection.surfacePlacementsById[params.entry.id] ?? projection.settingsPagesById[params.entry.id]
                ?? projection.composerControlsById[params.entry.id] ?? projection.composerRegionsById[params.entry.id]
                ?? projection.composerReferencesById[params.entry.id]
            : null;
        return readPluginUiContributionSupplies(entry).some(supply => (
                supply.executionOrigin && arePluginMachineExecutionOriginsEqual(supply.executionOrigin, fresh.origin)
                && supply.occurrenceId === selectedSupply.occurrenceId
                && supply.serverId === selectedSupply.serverId
                && supply.phase === 'current' && supply.interactionEnabled
            ));
    }, [params.entry, selectedSupply, selection.resolveExecutionOrigin]);
    // The exact mounted supplier can enter establishment before the shell's
    // committed selection publication catches up in layout. Its positive
    // loading fact must accompany the fresh guard that already refuses it.
    const loading = selection.loading || (selection.state.kind === 'selected'
        && selectedSupply?.phase === 'establishing');
    return { selection, selectedSupply, loading, isExecutionOriginCurrent };
}
