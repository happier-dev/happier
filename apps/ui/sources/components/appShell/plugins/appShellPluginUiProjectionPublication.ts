import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { shallow } from 'zustand/shallow';

import type { PluginAccountUiProjectionInputs } from '@/sync/domains/plugins/availability/reader';
import { arePluginUiMaterializationsEquivalent, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { selectPluginDestinationSurfacePlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import {
    arePluginUiProjectionUnionMembersEquivalent,
    createInstalledPluginUiProjectionPublication,
    createPluginUiExecutionOriginCandidatePublication,
    createPluginUiProjectionUnionPublication,
    type PluginUiExecutionOriginCandidateFacts,
    type PluginUiProjectionUnion,
    type PluginUiProjectionUnionMember,
    type PluginUiProjectionUnionOriginSelections,
} from '@/sync/domains/plugins/ui/projectionUnion';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createPluginSkillSourceIdentityPublication, EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY,
    type PluginSkillSourceIdentity } from '@/sync/domains/skills/pluginSkillSourceIdentity';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { loadPluginUiProjectionWarmCacheEntries } from '@/sync/domains/state/warmCachePersistence';
import {
    createConnectedAccountDescriptorProjectionPublication,
    type ConnectedAccountDescriptorMachineProjection,
    type ConnectedAccountDescriptorProjectionResolution,
} from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';

export type AppShellPluginProjectionTarget = Readonly<{ machineId: string; serverId: string | null }>;
export type AppShellAccountScopedPluginExecutionOriginReport = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    origin: PluginMachineExecutionOriginV1 | null;
    selectableOrigins?: readonly PluginMachineExecutionOriginV1[];
    hasStoredTarget?: boolean;
}>;
export type AppShellAccountScopedPluginUiCurrentnessReport = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    currentness: PluginUiProjectionCurrentness;
}>;
type InstalledMachineDeclarations = Readonly<{
    models: readonly PluginUiProjectionModel[];
    completeUiPluginIds: ReadonlySet<string>;
    materializationsByPluginId: Readonly<Record<string, PluginMachineMaterializationV1>>;
    serverIdentityId: string;
    hasUnprovenDeclarations: boolean;
}>;

export function resolveAppShellPluginProjectionTargets(params: Readonly<{
    activeServerId: string | null;
    onlineMachineIds: readonly string[];
    materializationMachineIds?: readonly string[];
    retainedMachineIds?: readonly string[];
}>): readonly AppShellPluginProjectionTarget[] {
    const serverId = params.activeServerId?.trim() ? params.activeServerId : null;
    const machineIds = new Set(params.onlineMachineIds.filter(machineId => machineId.trim().length > 0));
    for (const id of [...params.materializationMachineIds ?? [], ...params.retainedMachineIds ?? []]) {
        const machineId = id.trim();
        if (machineId) machineIds.add(machineId);
    }
    return Object.freeze([...machineIds].map(machineId => Object.freeze({ machineId, serverId }))
        .sort((left, right) => left.machineId.localeCompare(right.machineId)));
}

function isCurrent(lifetime: ActiveServerAccountScopeLifetime | null): boolean {
    return lifetime?.isCurrent() ?? true;
}

export function selectCurrentAppShellPluginUiCurrentness(input: Readonly<{
    reports: ReadonlyMap<string, AppShellAccountScopedPluginUiCurrentnessReport>;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}>): ReadonlyMap<string, PluginUiProjectionCurrentness> {
    return new Map([...input.reports].filter(([, report]) => report.accountLifetime === input.accountLifetime
        && isCurrent(report.accountLifetime)).map(([machineId, report]) => [machineId, report.currentness]));
}

export type AppShellPluginUiProjectionSources = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    availabilityInputs: PluginAccountUiProjectionInputs | null;
    hostBundledUiEnabled: boolean;
    activeServerId: string | null;
    serverProfilesGeneration: number;
    activeInventoryLoaded: boolean;
    onlineMachineIds: readonly string[];
    selectableMachineIds: readonly string[];
}>;
export type AppShellPluginUiProjectionSnapshot = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    activeServerId: string | null;
    accountUiProjection: PluginUiProjectionModel | null;
    executionOriginMaterializations: readonly PluginMachineMaterializationV1[];
    executionOriginPluginIds: readonly string[];
    projectionTargets: readonly AppShellPluginProjectionTarget[];
    currentnessForActiveAccountByMachineId: ReadonlyMap<string, PluginUiProjectionCurrentness>;
    projectionUnion: PluginUiProjectionUnion;
    pluginUiProjection: PluginUiProjectionModel | null;
    skillSourceIdentity: PluginSkillSourceIdentity;
    destinationSurfacePlacements: ReturnType<typeof selectPluginDestinationSurfacePlacements>;
    settingsPages: readonly PluginUiProjectionModel['settingsPagesById'][string][];
    candidateFactsByPluginId: ReadonlyMap<string, PluginUiExecutionOriginCandidateFacts>;
    connectedAccountResolution: ConnectedAccountDescriptorProjectionResolution;
}>;

const NO_MATERIALIZATIONS: readonly PluginMachineMaterializationV1[] = Object.freeze([]);
const NO_MODELS: readonly PluginUiProjectionModel[] = Object.freeze([]);
const NO_IDS: readonly string[] = Object.freeze([]);
const NO_TARGETS: readonly AppShellPluginProjectionTarget[] = Object.freeze([]);
const NO_MEMBERS: readonly PluginUiProjectionUnionMember[] = Object.freeze([]);
const NO_CURRENTNESS: ReadonlyMap<string, PluginUiProjectionCurrentness> = new Map();
const NO_FACTS: ReadonlyMap<string, PluginUiExecutionOriginCandidateFacts> = new Map();
const NO_DESTINATION_PLACEMENTS: ReturnType<typeof selectPluginDestinationSurfacePlacements> = Object.freeze([]);
const NO_SETTINGS_PAGES: readonly PluginUiProjectionModel['settingsPagesById'][string][] = Object.freeze([]);
const EMPTY_UNION: PluginUiProjectionUnion = Object.freeze({ pluginUiProjection: null, phase: 'unavailable',
    interactionEnabled: false, hasEstablishingMembers: false, machineId: null, serverId: null });
export const EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_SNAPSHOT: AppShellPluginUiProjectionSnapshot = Object.freeze({ accountLifetime: null,
    activeServerId: null,
    accountUiProjection: null, executionOriginMaterializations: NO_MATERIALIZATIONS,
    executionOriginPluginIds: NO_IDS, projectionTargets: NO_TARGETS,
    currentnessForActiveAccountByMachineId: NO_CURRENTNESS,
    projectionUnion: EMPTY_UNION, pluginUiProjection: null, skillSourceIdentity: EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY, candidateFactsByPluginId: NO_FACTS,
    destinationSurfacePlacements: NO_DESTINATION_PLACEMENTS, settingsPages: NO_SETTINGS_PAGES,
    connectedAccountResolution: Object.freeze({ kind: 'loading', descriptors: Object.freeze([]), conflicts: Object.freeze([]) }) });
const EMPTY_SNAPSHOT = EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_SNAPSHOT;

type InstalledPlugins = PluginAccountUiProjectionInputs['installedPlugins'];

export type AppShellPluginUiProjectionPublication = Readonly<{
    publishSources(sources: AppShellPluginUiProjectionSources): void;
    publishMachineCurrentness(machineId: string, lifetime: ActiveServerAccountScopeLifetime | null, currentness: PluginUiProjectionCurrentness): void;
    publishExecutionOrigin(pluginId: string, lifetime: ActiveServerAccountScopeLifetime | null, origin: PluginMachineExecutionOriginV1 | null,
        selectableOrigins: readonly PluginMachineExecutionOriginV1[], hasStoredTarget?: boolean): void;
    getSnapshot(): AppShellPluginUiProjectionSnapshot;
    subscribe(listener: () => void, scope?: 'committed'): () => void;
    dispose(): void;
}>;

/** The AppShell's existing aggregation owner, published by sources rather than evaluated by readers. */
export function createAppShellPluginUiProjectionPublication(): AppShellPluginUiProjectionPublication {
    let sources: AppShellPluginUiProjectionSources | null = null;
    let snapshot = EMPTY_SNAPSHOT;
    // Derivation inputs stay private: changing a supplier list is not itself
    // a consumer publication when the union and candidates are unchanged.
    let unionMembers = NO_MEMBERS;
    let currentnessReports: ReadonlyMap<string, AppShellAccountScopedPluginUiCurrentnessReport> = new Map();
    let originReports: ReadonlyMap<string, AppShellAccountScopedPluginExecutionOriginReport> = new Map();
    let groupedOriginReports = originReports;
    let selectableByMachine: ReadonlyMap<string, readonly PluginMachineExecutionOriginV1[]> = new Map();
    let selections: PluginUiProjectionUnionOriginSelections = new Map();
    let explicitSelections: PluginUiProjectionUnionOriginSelections = new Map();
    let installedInput: InstalledPlugins | undefined;
    let installedByMachineId: ReadonlyMap<string, InstalledMachineDeclarations> = new Map();
    let targetBasis: readonly unknown[] = [];
    let modelBasis: readonly unknown[] = [];
    let identityBasis: readonly unknown[] = [];
    let activeServerIdentity: string | undefined;
    let retirement: { dispose(): void } | undefined;
    let union = createPluginUiProjectionUnionPublication();
    let accountMerge = createInstalledPluginUiProjectionPublication();
    let candidates = createPluginUiExecutionOriginCandidatePublication();
    let connectedAccounts = createConnectedAccountDescriptorProjectionPublication();
    let skills = createPluginSkillSourceIdentityPublication();
    const machineMerges = new Map<string, ReturnType<typeof createInstalledPluginUiProjectionPublication>>();
    const listeners = new Map<() => void, 'committed' | undefined>();
    const notify = (previous: AppShellPluginUiProjectionSnapshot) => {
        // Committed readers consume declarations/candidates, not the raw
        // Machine reports which Browser and Voice still observe through React.
        const committedChanged = previous.accountLifetime !== snapshot.accountLifetime
            || previous.activeServerId !== snapshot.activeServerId
            || previous.pluginUiProjection !== snapshot.pluginUiProjection
            || previous.candidateFactsByPluginId !== snapshot.candidateFactsByPluginId
            || previous.projectionUnion.phase !== snapshot.projectionUnion.phase
            || previous.projectionUnion.interactionEnabled !== snapshot.projectionUnion.interactionEnabled
            || (previous.accountUiProjection === null) !== (snapshot.accountUiProjection === null);
        for (const [listener, scope] of listeners) if (scope !== 'committed' || committedChanged) listener();
    };

    function resetDerived() {
        currentnessReports = new Map();
        unionMembers = NO_MEMBERS;
        originReports = new Map();
        groupedOriginReports = originReports;
        selectableByMachine = new Map();
        selections = new Map();
        explicitSelections = new Map();
        installedInput = undefined;
        installedByMachineId = new Map();
        targetBasis = [];
        modelBasis = [];
        identityBasis = [];
        activeServerIdentity = undefined;
        machineMerges.clear();
        union = createPluginUiProjectionUnionPublication();
        accountMerge = createInstalledPluginUiProjectionPublication();
        candidates = createPluginUiExecutionOriginCandidatePublication();
        connectedAccounts = createConnectedAccountDescriptorProjectionPublication();
        skills = createPluginSkillSourceIdentityPublication();
        snapshot = EMPTY_SNAPSHOT;
    }

    function publishDerived() {
        if (!sources || !isCurrent(sources.accountLifetime)) return;
        const { accountLifetime, availabilityInputs } = sources;
        const previous = snapshot;
        const nextIdentityBasis = [sources.activeServerId, sources.serverProfilesGeneration];
        if (nextIdentityBasis.some((value, index) => value !== identityBasis[index]) || identityBasis.length === 0) {
            activeServerIdentity = resolvePortableServerIdentityForRoutingId(sources.activeServerId) ?? undefined;
            identityBasis = nextIdentityBasis;
        }
        const materializations = availabilityInputs?.materializations ?? NO_MATERIALIZATIONS;
        const plugins = availabilityInputs?.installedPlugins;
        if (plugins !== installedInput) {
            const machines = new Map<string, InstalledMachineDeclarations>();
            for (const plugin of plugins ?? []) for (const installation of plugin.installations) {
                const report = installation.materialization;
                const preceding = machines.get(report.machineId);
                machines.set(report.machineId, Object.freeze({
                    models: Object.freeze([...(preceding?.models ?? []), installation.uiModel]),
                    completeUiPluginIds: new Set([...preceding?.completeUiPluginIds ?? [],
                        ...(installation.uiDeclarationState === 'known' ? [plugin.pluginId] : [])]),
                    materializationsByPluginId: Object.freeze({ ...preceding?.materializationsByPluginId, [plugin.pluginId]: report }),
                    serverIdentityId: report.serverIdentityId,
                    hasUnprovenDeclarations: preceding?.hasUnprovenDeclarations === true || installation.uiDeclarationState === 'preparing',
                }));
            }
            for (const [machineId, next] of machines) {
                const old = installedByMachineId.get(machineId);
                if (old && old.serverIdentityId === next.serverIdentityId && old.hasUnprovenDeclarations === next.hasUnprovenDeclarations
                    && old.models.length === next.models.length && old.models.every((model, index) => model === next.models[index])
                    && old.completeUiPluginIds.size === next.completeUiPluginIds.size
                    && [...old.completeUiPluginIds].every(id => next.completeUiPluginIds.has(id))
                    && arePluginUiMaterializationsEquivalent(old.materializationsByPluginId, next.materializationsByPluginId)) {
                    machines.set(machineId, old);
                }
            }
            if (machines.size !== installedByMachineId.size || [...machines].some(([id, value]) => installedByMachineId.get(id) !== value)) {
                installedByMachineId = machines;
            }
            installedInput = plugins;
        }
        const nextTargetBasis = [sources.activeServerId, sources.onlineMachineIds, materializations, sources.activeInventoryLoaded, accountLifetime];
        let targets = previous.projectionTargets;
        if (nextTargetBasis.length !== targetBasis.length || nextTargetBasis.some((value, index) => value !== targetBasis[index])) {
            const retainedIds = !sources.activeInventoryLoaded && accountLifetime?.isCurrent()
                ? Object.values(loadPluginUiProjectionWarmCacheEntries(accountLifetime.scope.serverId, accountLifetime.scope.accountId)).map(entry => entry.machineId) : NO_IDS;
            const nextTargets = resolveAppShellPluginProjectionTargets({ activeServerId: sources.activeServerId,
                onlineMachineIds: sources.onlineMachineIds, materializationMachineIds: materializations.map(value => value.machineId), retainedMachineIds: retainedIds });
            if (nextTargets.length !== targets.length || nextTargets.some((target, index) => target.machineId !== targets[index]?.machineId || target.serverId !== targets[index]?.serverId)) targets = nextTargets;
            targetBasis = nextTargetBasis;
        }
        const eligible = new Set(targets.map(target => target.machineId));
        if ([...currentnessReports.keys()].some(id => !eligible.has(id))) {
            currentnessReports = new Map([...currentnessReports].filter(([id]) => eligible.has(id)));
        }
        const currentness = selectCurrentAppShellPluginUiCurrentness({ reports: currentnessReports, accountLifetime });
        const sameCurrentness = previous.currentnessForActiveAccountByMachineId.size === currentness.size
            && [...currentness].every(([id, value]) => previous.currentnessForActiveAccountByMachineId.get(id) === value);
        const currentnessForActiveAccountByMachineId = sameCurrentness ? previous.currentnessForActiveAccountByMachineId : currentness;
        const nextModelBasis = [materializations, installedByMachineId,
            ...[...currentness.values()].map(value => value.pluginUiProjection?.installedPackagesById)];
        let pluginIds = previous.executionOriginPluginIds;
        if (nextModelBasis.length !== modelBasis.length || nextModelBasis.some((value, index) => value !== modelBasis[index])) {
            const nextIds = [...new Set([...materializations.map(value => value.pluginId),
                ...[...currentness.values()].flatMap(value => Object.keys(value.pluginUiProjection?.installedPackagesById ?? {})),
                ...[...installedByMachineId.values()].flatMap(value => value.models.flatMap(model => Object.keys(model.installedPackagesById)))])]
                .sort((left, right) => left.localeCompare(right));
            if (nextIds.length !== pluginIds.length || nextIds.some((id, index) => id !== pluginIds[index])) pluginIds = Object.freeze(nextIds);
            modelBasis = nextModelBasis;
        }
        const admitted = new Set(pluginIds);
        if ([...originReports.keys()].some(id => !admitted.has(id))) {
            originReports = new Map([...originReports].filter(([id]) => admitted.has(id)));
            if ([...selections.keys()].some(id => !admitted.has(id))) {
                selections = new Map([...selections].filter(([id]) => admitted.has(id)));
            }
            if ([...explicitSelections.keys()].some(id => !admitted.has(id))) {
                explicitSelections = new Map([...explicitSelections].filter(([id]) => admitted.has(id)));
            }
        }
        // Machine presentation reports do not change the admitted origin facts.
        // Publish their grouping only when its own source reports change.
        if (groupedOriginReports !== originReports) {
            const grouped = new Map<string, PluginMachineExecutionOriginV1[]>();
            for (const [id, report] of originReports) {
                if (!admitted.has(id) || report.accountLifetime !== accountLifetime || !isCurrent(report.accountLifetime)) continue;
                for (const origin of report.selectableOrigins ?? []) {
                    const machineId = getPluginMachineExecutionOriginRef(origin).machineId;
                    const supplying = grouped.get(machineId) ?? [];
                    supplying.push(origin);
                    grouped.set(machineId, supplying);
                }
            }
            selectableByMachine = new Map([...grouped].map(([machineId, origins]) => [machineId, Object.freeze(origins)]));
            groupedOriginReports = originReports;
        }
        const previousMembers = new Map(unionMembers.map(member => [member.machineId, member]));
        const nextMembers = targets.map(target => {
            const current = currentness.get(target.machineId);
            const declaration = installedByMachineId.get(target.machineId);
            let merge = machineMerges.get(target.machineId);
            if (!merge) { merge = createInstalledPluginUiProjectionPublication(); machineMerges.set(target.machineId, merge); }
            const member: PluginUiProjectionUnionMember = {
                machineId: target.machineId, serverId: target.serverId,
                serverIdentityId: declaration?.serverIdentityId ?? activeServerIdentity,
                materializationsByPluginId: declaration?.materializationsByPluginId,
                selectableExecutionOrigins: selectableByMachine.get(target.machineId),
                projection: merge.publish(declaration?.models ?? NO_MODELS, current?.pluginUiProjection ?? null,
                    declaration?.materializationsByPluginId, undefined, declaration?.completeUiPluginIds),
                phase: current?.phase === 'unavailable' || current?.phase === 'retainedOffline' ? current.phase
                    : current?.pluginUiProjection?.generation == null && declaration?.hasUnprovenDeclarations ? 'establishing' : current?.phase ?? 'establishing',
                unavailableReasonCode: current?.unavailableReasonCode, interactionEnabled: current?.interactionEnabled ?? false,
            };
            const old = previousMembers.get(target.machineId);
            return old && (shallow(old, member) || arePluginUiProjectionUnionMembersEquivalent([old], [member])) ? old : member;
        });
        for (const id of machineMerges.keys()) if (!eligible.has(id)) machineMerges.delete(id);
        const members = arePluginUiProjectionUnionMembersEquivalent(unionMembers, nextMembers) ? unionMembers : Object.freeze(nextMembers);
        unionMembers = members;
        const projectionUnion = union.publish(members, selections);
        const accountUiProjection = sources.hostBundledUiEnabled ? availabilityInputs?.accountUiProjection ?? null : null;
        const pluginUiProjection = accountMerge.publish(accountUiProjection ? [accountUiProjection] : NO_MODELS,
            projectionUnion.pluginUiProjection, undefined, explicitSelections);
        const candidateFactsByPluginId = candidates.publish(pluginUiProjection, members, pluginIds);
        const skillSourceIdentity = skills.publish(pluginUiProjection);
        const destinationSurfacePlacements = previous.pluginUiProjection?.surfacePlacementsById === pluginUiProjection?.surfacePlacementsById
            ? previous.destinationSurfacePlacements
            : pluginUiProjection ? selectPluginDestinationSurfacePlacements(pluginUiProjection) : NO_DESTINATION_PLACEMENTS;
        const settingsPages = previous.pluginUiProjection?.settingsPagesById === pluginUiProjection?.settingsPagesById
            ? previous.settingsPages
            : pluginUiProjection ? Object.freeze(Object.values(pluginUiProjection.settingsPagesById)) : NO_SETTINGS_PAGES;
        const descriptorInputs: ConnectedAccountDescriptorMachineProjection[] = [];
        for (const machineId of sources.selectableMachineIds) {
            const current = currentness.get(machineId);
            const projection = current?.connectedAccountProjection;
            // Descriptor success is independent of unrelated Machine UI establishment.
            if (!projection || (projection.kind === 'ready' && current?.phase !== 'current' && current?.phase !== 'establishing')) {
                descriptorInputs.push({ kind: 'loading' });
            } else if (projection.kind !== 'ready') {
                descriptorInputs.push(projection);
            } else {
                const executionUnavailablePluginIds = projection.descriptors.flatMap(descriptor => {
                    if (!descriptor.pluginId || !admitted.has(descriptor.pluginId)) return [];
                    const report = originReports.get(descriptor.pluginId);
                    if (!report || report.accountLifetime !== accountLifetime || !isCurrent(report.accountLifetime)) {
                        descriptorInputs.push({ kind: 'loading' });
                        return [descriptor.pluginId];
                    }
                    return (selectableByMachine.get(machineId) ?? []).some(origin => getPluginMachineExecutionOriginRef(origin).pluginId === descriptor.pluginId)
                        ? [] : [descriptor.pluginId];
                });
                descriptorInputs.push({ kind: 'ready', descriptors: projection.descriptors, executionUnavailablePluginIds });
            }
        }
        const connectedAccountResolution = connectedAccounts.publish(descriptorInputs);
        const next: AppShellPluginUiProjectionSnapshot = Object.freeze({ accountLifetime, activeServerId: sources.activeServerId, accountUiProjection,
            executionOriginMaterializations: materializations, executionOriginPluginIds: pluginIds, projectionTargets: targets,
            currentnessForActiveAccountByMachineId, projectionUnion, pluginUiProjection, skillSourceIdentity,
            destinationSurfacePlacements, settingsPages, candidateFactsByPluginId, connectedAccountResolution });
        if ((Object.keys(next) as (keyof AppShellPluginUiProjectionSnapshot)[]).every(key => next[key] === previous[key])) return;
        snapshot = next;
        notify(previous);
    }

    return {
        publishSources(next: AppShellPluginUiProjectionSources) {
            if (!isCurrent(next.accountLifetime)) return;
            if (sources && (Object.keys(next) as (keyof AppShellPluginUiProjectionSources)[]).every(key => next[key] === sources![key])) return;
            if (sources?.accountLifetime !== next.accountLifetime || sources?.activeServerId !== next.activeServerId) {
                retirement?.dispose();
                resetDerived();
                retirement = next.accountLifetime?.onRetire(() => {
                    if (sources?.accountLifetime !== next.accountLifetime) return;
                    const previous = snapshot;
                    sources = null;
                    resetDerived();
                    // Account capture may retire an owner during another React render.
                    queueMicrotask(() => notify(previous));
                });
            }
            sources = next;
            publishDerived();
        },
        publishMachineCurrentness(machineId: string, accountLifetime: ActiveServerAccountScopeLifetime | null, currentness: PluginUiProjectionCurrentness) {
            if (!sources || sources.accountLifetime !== accountLifetime || !isCurrent(accountLifetime)
                || currentness.serverId !== sources.activeServerId) return;
            const current = currentnessReports.get(machineId);
            if (current?.accountLifetime === accountLifetime && shallow(current.currentness, currentness)) return;
            currentnessReports = new Map(currentnessReports).set(machineId, Object.freeze({ accountLifetime, currentness }));
            publishDerived();
        },
        publishExecutionOrigin(pluginId: string, accountLifetime: ActiveServerAccountScopeLifetime | null, origin: PluginMachineExecutionOriginV1 | null,
            selectableOrigins: readonly PluginMachineExecutionOriginV1[], hasStoredTarget = false) {
            if (!sources || sources.accountLifetime !== accountLifetime || !isCurrent(accountLifetime)
                || !snapshot.executionOriginPluginIds.includes(pluginId)) return;
            const current = originReports.get(pluginId);
            const sameOrigin = current?.origin === origin || Boolean(current?.origin && origin && arePluginMachineExecutionOriginsEqual(current.origin, origin));
            if (current?.accountLifetime === accountLifetime && sameOrigin && (current.hasStoredTarget === true) === hasStoredTarget
                && (current.selectableOrigins?.length ?? 0) === selectableOrigins.length
                && selectableOrigins.every((candidate, index) => arePluginMachineExecutionOriginsEqual(candidate, current.selectableOrigins![index]!))) return;
            originReports = new Map(originReports).set(pluginId, Object.freeze({ accountLifetime, origin, selectableOrigins, hasStoredTarget }));
            if (!sameOrigin && (current?.origin || origin)) {
                const next = new Map(selections);
                if (origin) next.set(pluginId, origin);
                else next.delete(pluginId);
                selections = next;
            }
            if ((!sameOrigin || (current?.hasStoredTarget === true) !== hasStoredTarget)
                && ((current?.hasStoredTarget && current.origin) || (hasStoredTarget && origin))) {
                const next = new Map(explicitSelections);
                if (hasStoredTarget && origin) next.set(pluginId, origin);
                else next.delete(pluginId);
                explicitSelections = next;
            }
            publishDerived();
        },
        getSnapshot: () => sources && isCurrent(sources.accountLifetime) ? snapshot : EMPTY_SNAPSHOT,
        subscribe(listener: () => void, scope?: 'committed') { listeners.set(listener, scope); return () => { listeners.delete(listener); }; },
        dispose() { retirement?.dispose(); retirement = undefined; sources = null; resetDerived(); listeners.clear(); },
    };
}
