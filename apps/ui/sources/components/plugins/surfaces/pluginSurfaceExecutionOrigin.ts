import * as React from 'react';
import { arePluginMachineExecutionOriginsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginContributionIdentityV1Schema, type PluginUiResourceBindingCapabilityV1 } from '@happier-dev/protocol';

import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useActivePluginAccountAvailabilityReleaseClassifier } from '@/sync/domains/plugins/availability/projection';
import { usePluginMachineExecutionOriginSelection } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { createPluginUiProjectedActionResolver, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionSupplies, readPluginUiExecutionOriginCandidates } from '@/sync/domains/plugins/ui/projectionUnion';
import { resolvePluginUiProjectionContributionId } from '@/sync/domains/plugins/ui/projectionRefs';
import { readRequiredPluginSurfaceHostMethods } from './boundPluginSurfaceController';

function record(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

/** Declared machine-backed capabilities, not execution availability or a selector policy. */
export function isPluginSurfaceMachineBound(params: Readonly<{
    pluginId: string;
    renderer: Readonly<Record<string, unknown>>;
    projection: PluginUiProjectionModel | null | undefined;
    headerActions?: unknown;
    resourceCapability?: PluginUiResourceBindingCapabilityV1;
}>): boolean {
    const family = params.renderer.kind === 'reactNative' ? 'reactNativeBundle'
        : params.renderer.kind === 'hostedWeb' ? 'hostedWeb' : null;
    const artifacts = family === 'reactNativeBundle' ? params.projection?.reactNativeBundlesById
        : family === 'hostedWeb' ? params.projection?.hostedWebById : null;
    const artifactId = family ? resolvePluginUiProjectionContributionId({ family, pluginId: params.pluginId,
        contributionId: params.renderer.contributionId, entriesById: artifacts ?? {} }) : null;
    const artifact = artifactId ? artifacts?.[artifactId] : null;
    const methods = readRequiredPluginSurfaceHostMethods(params.renderer.requiredHostMethods
        ?? record(params.renderer.model)?.requiredHostMethods ?? artifact?.requiredHostMethods);
    if (methods === null) return false;
    // The same Resource methods also serve Account-owned borrowed host reads.
    // Only the selected member's declared daemon Resource capability implies a target.
    if ((methods.includes('readResource') && params.resourceCapability?.readable === true)
        || (methods.includes('watchResource') && params.resourceCapability?.dynamic === true)) return true;
    if (methods.some(method => method === 'readStoredImage' || method === 'watchLiveStream'
        || method === 'statOpenableContent' || method === 'readOpenableContent'
        || method === 'selectActionInput')) return true;
    const actions = Object.values(params.projection?.actionsById ?? {});
    if (methods.includes('executeAction') && actions.some(action => action.pluginId === params.pluginId
        && action.execution.target === 'daemon')) return true;
    return Array.isArray(params.headerActions) && params.headerActions.some(action => {
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
}>) {
    const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier();
    const supplied = React.useMemo(() => readPluginUiExecutionOriginCandidates({
        projection: params.projection ?? null, pluginId: params.pluginId, entry: params.entry,
    }), [params.entry, params.pluginId, params.projection]);
    const readCurrentCandidates = React.useCallback(() => readPluginUiExecutionOriginCandidates({
        projection: readCurrentAppShellPluginUiProjection(), pluginId: params.pluginId,
    }), [params.pluginId]);
    const readSourceCandidates = React.useCallback(() => readCurrentCandidates().sourceCandidates, [readCurrentCandidates]);
    const readDeclaredDefaultOrigins = React.useCallback(() => readCurrentCandidates().declaredDefaultOrigins, [readCurrentCandidates]);
    const selection = usePluginMachineExecutionOriginSelection({
        pluginId: params.pluginId, enabled: params.enabled, classifyRelease,
        ...supplied, readSourceCandidates, readDeclaredDefaultOrigins,
    });
    const selectedSupply = React.useMemo(() => selection.selectedOrigin
        ? readPluginUiContributionSupplies(params.entry).find(supply => supply.executionOrigin
            && arePluginMachineExecutionOriginsEqual(supply.executionOrigin, selection.selectedOrigin!)) ?? null
        : null, [params.entry, selection.selectedOrigin]);
    const isExecutionOriginCurrent = React.useCallback(() => {
        const fresh = selection.resolveExecutionOrigin();
        if (!fresh || !selectedSupply?.executionOrigin || !selectedSupply.occurrenceId
            || selectedSupply.phase !== 'current' || !selectedSupply.interactionEnabled
            || !arePluginMachineExecutionOriginsEqual(fresh.origin, selectedSupply.executionOrigin)) return false;
        const projection = readCurrentAppShellPluginUiProjection();
        const entry = params.entry && projection
            ? projection.surfacePlacementsById[params.entry.id] ?? projection.settingsPagesById[params.entry.id]
            : null;
        return readPluginUiContributionSupplies(entry).some(supply => (
                supply.executionOrigin && arePluginMachineExecutionOriginsEqual(supply.executionOrigin, fresh.origin)
                && supply.occurrenceId === selectedSupply.occurrenceId
                && supply.generation === selectedSupply.generation
                && supply.serverId === selectedSupply.serverId
                && supply.phase === 'current' && supply.interactionEnabled
            ));
    }, [params.entry, selectedSupply, selection.resolveExecutionOrigin]);
    return { selection, selectedSupply, isExecutionOriginCurrent };
}
