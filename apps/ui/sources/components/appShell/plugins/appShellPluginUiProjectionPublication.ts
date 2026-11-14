import { getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { shallow } from 'zustand/shallow';

import type { PluginAccountUiProjectionInputs } from '@/sync/domains/plugins/availability/reader';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { selectPluginDestinationSurfacePlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import {
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
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { PluginUiClientExecutableProjectionSource } from '@/components/plugins/reactNative/clientExecutableProjection';
import { EMPTY_MOUNTED_CLIENT_ACTION_PROJECTIONS } from './mountedClientActionDemand';
import { settleAppShellProjectionAvailability } from './projectionAvailability';
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
    mountedActionProjections: readonly PluginUiClientExecutableProjectionSource[];
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
// Nothing published for this Account and Home yet is pending, not unavailable: a reader keeps waiting instead of
// certifying an empty catalog. Unavailable comes only from published sources (no Machine, a failed census).
const EMPTY_UNION: PluginUiProjectionUnion = Object.freeze({ pluginUiProjection: null, phase: 'establishing',
    interactionEnabled: false, hasEstablishingMembers: false, machineId: null, serverId: null });
export const EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_SNAPSHOT: AppShellPluginUiProjectionSnapshot = Object.freeze({ accountLifetime: null,
    activeServerId: null,
    accountUiProjection: null, executionOriginMaterializations: NO_MATERIALIZATIONS,
    executionOriginPluginIds: NO_IDS, projectionTargets: NO_TARGETS,
    currentnessForActiveAccountByMachineId: NO_CURRENTNESS,
    projectionUnion: EMPTY_UNION, pluginUiProjection: null, mountedActionProjections: EMPTY_MOUNTED_CLIENT_ACTION_PROJECTIONS,
    skillSourceIdentity: EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY, candidateFactsByPluginId: NO_FACTS,
    destinationSurfacePlacements: NO_DESTINATION_PLACEMENTS, settingsPages: NO_SETTINGS_PAGES,
    connectedAccountResolution: Object.freeze({ kind: 'loading', descriptors: Object.freeze([]), conflicts: Object.freeze([]) }) });
const EMPTY_SNAPSHOT = EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_SNAPSHOT;

type InstalledPlugins = PluginAccountUiProjectionInputs['installedPlugins'];

export type AppShellPluginUiProjectionPublication = Readonly<{
    publishSources(sources: AppShellPluginUiProjectionSources): void;
    publishMountedActions(owner: symbol, lifetime: ActiveServerAccountScopeLifetime | null,
        source: PluginUiClientExecutableProjectionSource | null): void;
    publishMachineCurrentness(machineId: string, lifetime: ActiveServerAccountScopeLifetime | null, currentness: PluginUiProjectionCurrentness): void;
    publishExecutionOrigin(pluginId: string, lifetime: ActiveServerAccountScopeLifetime | null, origin: PluginMachineExecutionOriginV1 | null,
        selectableOrigins: readonly PluginMachineExecutionOriginV1[], hasStoredTarget?: boolean): void;
    getSnapshot(): AppShellPluginUiProjectionSnapshot;
    /** The published Home, read without deriving pending origin reports. */
    readActiveServerId(): AppShellPluginUiProjectionSnapshot['activeServerId'];
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
    let membersByMachineId: ReadonlyMap<string, PluginUiProjectionUnionMember> = new Map();
    let currentnessReports: ReadonlyMap<string, AppShellAccountScopedPluginUiCurrentnessReport> = new Map();
    let originReports: ReadonlyMap<string, AppShellAccountScopedPluginExecutionOriginReport> = new Map();
    let groupedOriginReports = originReports;
    let selectableByMachine: ReadonlyMap<string, Readonly<{
        byPlugin: ReadonlyMap<string, readonly PluginMachineExecutionOriginV1[]>;
        origins: readonly PluginMachineExecutionOriginV1[];
    }>> = new Map();
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
    /**
     * Origin candidates for Machines whose presentation sections are unread. Administration ranks
     * every candidate from installed-package facts; the union's presentation members stay
     * establishing for them, so an unread section is never published as an empty catalog.
     */
    const candidateMembersByMachineId = new Map<string, Readonly<{ member: PluginUiProjectionUnionMember;
        packages: PluginUiProjectionModel; candidate: PluginUiProjectionUnionMember;
        merge: ReturnType<typeof createInstalledPluginUiProjectionPublication> }>>();
    let candidateMembers = NO_MEMBERS;
    const mountedActions = new Map<symbol, Readonly<{
        source: PluginUiClientExecutableProjectionSource;
        lifetime: ActiveServerAccountScopeLifetime;
        retirement: ReturnType<ActiveServerAccountScopeLifetime['onRetire']>;
    }>>();
    const listeners = new Map<() => void, 'committed' | undefined>();
    /**
     * Origin reporters are one per plugin and report from the same commit, so
     * one upstream change arrives as a burst of reports. They are derived
     * together: once in a microtask, or earlier by a synchronous reader. A read
     * derives without notifying; the snapshot listeners last heard about is
     * kept so the one deferred notification compares against it.
     */
    let originReportsPending = false;
    let unnotifiedPrevious: AppShellPluginUiProjectionSnapshot | null = null;
    const notify = (notifiedPrevious: AppShellPluginUiProjectionSnapshot) => {
        const previous = unnotifiedPrevious ?? notifiedPrevious;
        unnotifiedPrevious = null;
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
        originReportsPending = false;
        unnotifiedPrevious = null;
        for (const member of mountedActions.values()) member.retirement.dispose();
        mountedActions.clear();
        currentnessReports = new Map();
        unionMembers = NO_MEMBERS;
        membersByMachineId = new Map();
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
        candidateMembersByMachineId.clear();
        candidateMembers = NO_MEMBERS;
        union = createPluginUiProjectionUnionPublication();
        accountMerge = createInstalledPluginUiProjectionPublication();
        candidates = createPluginUiExecutionOriginCandidatePublication();
        connectedAccounts = createConnectedAccountDescriptorProjectionPublication();
        skills = createPluginSkillSourceIdentityPublication();
        snapshot = EMPTY_SNAPSHOT;
    }

    function publishMountedActionSources(deferNotification = false) {
        const previous = snapshot;
        snapshot = Object.freeze({ ...snapshot, mountedActionProjections: mountedActions.size === 0
            ? EMPTY_MOUNTED_CLIENT_ACTION_PROJECTIONS
            : Object.freeze([...mountedActions.values()].map(member => member.source)) });
        // Retirement can occur while another component captures Account custody.
        // Withdraw the demand now; only its React notification is deferred.
        if (deferNotification) queueMicrotask(() => notify(previous));
        else notify(previous);
    }

    function publishConnectedAccounts(targets: readonly AppShellPluginProjectionTarget[], currentness: ReadonlyMap<string, PluginUiProjectionCurrentness>,
        admitted: ReadonlySet<string>, accountLifetime: ActiveServerAccountScopeLifetime | null) {
        // Account discovery already supplies authoring metadata to the registry.
        // Its completed answer must participate even when passive Machine
        // observers have no descriptor answer. This grants no native execution;
        // the existing union still reports incomplete Machine coverage.
        const descriptorInputs: ConnectedAccountDescriptorMachineProjection[] = sources?.availabilityInputs
            ? [{ kind: 'ready', descriptors: [] }] : [];
        const selectable = new Set(sources?.selectableMachineIds ?? NO_IDS);
        for (const { machineId } of targets) {
            const current = currentness.get(machineId);
            const projection = current?.connectedAccountProjection;
            if (!selectable.has(machineId)) continue;
            // Currentness owns the attempt's verdict. Retained descriptor
            // errors are not a failure of an establishing authority, and a
            // withdrawn authority is not a still-pending descriptor read.
            // A successful descriptor read settles independently of the rest
            // of this Machine's UI projection. Failed retained answers still
            // wait for the establishing attempt's own verdict.
            if (!current || (current.phase === 'establishing' && projection?.kind !== 'ready')) {
                descriptorInputs.push({ kind: 'loading' });
            } else if (current.phase === 'unavailable' || current.phase === 'retainedOffline') {
                descriptorInputs.push(projection?.kind === 'error' ? projection : { kind: 'error', reason: 'transport' });
            } else if (!projection) {
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
                    return (selectableByMachine.get(machineId)?.origins ?? []).some(origin => getPluginMachineExecutionOriginRef(origin).pluginId === descriptor.pluginId)
                        ? [] : [descriptor.pluginId];
                });
                descriptorInputs.push({ kind: 'ready', descriptors: projection.descriptors, executionUnavailablePluginIds });
            }
        }
        const resolution = connectedAccounts.publish(descriptorInputs);
        const unavailableReasonCode = sources?.availabilityInputs?.unavailableReasonCode;
        if (!unavailableReasonCode) return resolution;
        // Failed Account discovery cannot establish a complete registry, even
        // when an individual Machine answers during an incremental update.
        const failed: ConnectedAccountDescriptorProjectionResolution = { ...resolution, kind: 'error',
            reason: unavailableReasonCode === 'plugin_availability_invalid_response' ? 'malformed' : 'transport' };
        return shallow(snapshot.connectedAccountResolution, failed) ? snapshot.connectedAccountResolution : Object.freeze(failed);
    }

    function deriveOriginReports(quiet: boolean) {
        if (!originReportsPending) return;
        if (!quiet) { publishDerived(); return; }
        const previous = snapshot;
        publishDerived(undefined, true);
        if (snapshot !== previous && unnotifiedPrevious === null) unnotifiedPrevious = previous;
    }

    function publishDerived(changedMachineId?: string, quiet = false) {
        originReportsPending = false;
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
            const builds = new Map<string, {
                models: PluginUiProjectionModel[];
                completeUiPluginIds: Set<string>;
                materializationsByPluginId: Record<string, PluginMachineMaterializationV1>;
                serverIdentityId: string;
                hasUnprovenDeclarations: boolean;
            }>();
            for (const plugin of plugins ?? []) for (const installation of plugin.installations) {
                const report = installation.materialization;
                let build = builds.get(report.machineId);
                if (!build) {
                    build = { models: [], completeUiPluginIds: new Set(), materializationsByPluginId: {},
                        serverIdentityId: report.serverIdentityId, hasUnprovenDeclarations: false };
                    builds.set(report.machineId, build);
                }
                build.models.push(installation.uiModel);
                if (installation.uiDeclarationState === 'known') build.completeUiPluginIds.add(plugin.pluginId);
                build.materializationsByPluginId[plugin.pluginId] = report;
                build.serverIdentityId = report.serverIdentityId;
                build.hasUnprovenDeclarations ||= installation.uiDeclarationState === 'preparing';
            }
            const machines = new Map<string, InstalledMachineDeclarations>();
            for (const [machineId, build] of builds) {
                const next = Object.freeze({ ...build, models: Object.freeze(build.models),
                    materializationsByPluginId: Object.freeze(build.materializationsByPluginId) });
                machines.set(machineId, next);
                const old = installedByMachineId.get(machineId);
                if (old && old.serverIdentityId === next.serverIdentityId && old.hasUnprovenDeclarations === next.hasUnprovenDeclarations
                    && old.models.length === next.models.length && old.models.every((model, index) => model === next.models[index])
                    && old.completeUiPluginIds.size === next.completeUiPluginIds.size
                    && [...old.completeUiPluginIds].every(id => next.completeUiPluginIds.has(id))
                    && shallow(old.materializationsByPluginId, next.materializationsByPluginId)) {
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
            ...[...currentness.values()].flatMap(value => [value.pluginUiProjection?.installedPackagesById,
                value.installedPackagesProjection?.installedPackagesById])];
        let pluginIds = previous.executionOriginPluginIds;
        if (nextModelBasis.length !== modelBasis.length || nextModelBasis.some((value, index) => value !== modelBasis[index])) {
            const nextIds = [...new Set([...materializations.map(value => value.pluginId),
                // An establishing Machine's held packages are current facts beside its unread presentation.
                ...[...currentness.values()].flatMap(value => [...Object.keys(value.pluginUiProjection?.installedPackagesById ?? {}),
                    ...Object.keys(value.installedPackagesProjection?.installedPackagesById ?? {})]),
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
        // Each report owns one plugin's admissions. Replacing it must not
        // republish sibling Machines or walk the other plugins' origin facts.
        if (groupedOriginReports !== originReports) {
            // A changed plugin census can also withdraw origins on other Machines.
            changedMachineId = undefined;
            const changedMachines = new Map<string, Map<string, readonly PluginMachineExecutionOriginV1[]>>();
            const editMachine = (machineId: string) => {
                let plugins = changedMachines.get(machineId);
                if (!plugins) {
                    plugins = new Map(selectableByMachine.get(machineId)?.byPlugin);
                    changedMachines.set(machineId, plugins);
                }
                return plugins;
            };
            for (const id of new Set([...groupedOriginReports.keys(), ...originReports.keys()])) {
                const before = groupedOriginReports.get(id);
                const report = originReports.get(id);
                if (before?.selectableOrigins === report?.selectableOrigins) continue;
                for (const origin of before?.selectableOrigins ?? []) editMachine(getPluginMachineExecutionOriginRef(origin).machineId).delete(id);
                const grouped = new Map<string, PluginMachineExecutionOriginV1[]>();
                for (const origin of report?.selectableOrigins ?? []) {
                    const machineId = getPluginMachineExecutionOriginRef(origin).machineId;
                    const supplying = grouped.get(machineId) ?? [];
                    supplying.push(origin);
                    grouped.set(machineId, supplying);
                }
                for (const [machineId, origins] of grouped) editMachine(machineId).set(id, Object.freeze(origins));
            }
            const next = new Map(selectableByMachine);
            for (const [machineId, byPlugin] of changedMachines) {
                if (byPlugin.size === 0) { next.delete(machineId); continue; }
                const origins = Object.freeze([...byPlugin].sort(([left], [right]) => left.localeCompare(right)).flatMap(([, origins]) => origins));
                const previous = selectableByMachine.get(machineId);
                next.set(machineId, { byPlugin, origins: previous?.origins.length === origins.length
                    && origins.every((origin, index) => origin === previous.origins[index]) ? previous.origins : origins });
            }
            selectableByMachine = next;
            groupedOriginReports = originReports;
        }
        const nextMembers = targets.map(target => {
            const old = membersByMachineId.get(target.machineId);
            // A Machine report changes only that Machine's merge inputs.
            // Sources and origin selections still reconcile the whole membership.
            if (changedMachineId !== undefined && target.machineId !== changedMachineId && old) return old;
            const current = currentness.get(target.machineId);
            const declaration = installedByMachineId.get(target.machineId);
            let merge = machineMerges.get(target.machineId);
            if (!merge) { merge = createInstalledPluginUiProjectionPublication(); machineMerges.set(target.machineId, merge); }
            // Held plugin slices (a mounted surface's, the Session's) present those plugins
            // while the Machine's catalogue stays establishing: others are not loaded, never absent.
            const presentedPluginIds = current?.phase === 'establishing' && current.installedPackagesProjection
                ? current.presentedPluginIds ?? null : null;
            const member: PluginUiProjectionUnionMember = {
                machineId: target.machineId, serverId: target.serverId,
                serverIdentityId: declaration?.serverIdentityId ?? activeServerIdentity,
                materializationsByPluginId: declaration?.materializationsByPluginId,
                selectableExecutionOrigins: selectableByMachine.get(target.machineId)?.origins,
                projection: merge.publish(declaration?.models ?? NO_MODELS,
                    (presentedPluginIds ? current?.installedPackagesProjection : current?.pluginUiProjection) ?? null,
                    declaration?.materializationsByPluginId, undefined, declaration?.completeUiPluginIds),
                ...(presentedPluginIds ? { currentPluginIds: presentedPluginIds } : {}),
                phase: current?.phase === 'unavailable' || current?.phase === 'retainedOffline' ? current.phase
                    : current?.pluginUiProjection?.generation == null && declaration?.hasUnprovenDeclarations ? 'establishing' : current?.phase ?? 'establishing',
                unavailableReasonCode: current?.unavailableReasonCode, interactionEnabled: current?.interactionEnabled ?? false,
            };
            return old && shallow(old, member) ? old : member;
        });
        for (const id of machineMerges.keys()) if (!eligible.has(id)) machineMerges.delete(id);
        const members = unionMembers.length === nextMembers.length && nextMembers.every((member, index) => member === unionMembers[index])
            ? unionMembers : Object.freeze(nextMembers);
        if (unionMembers !== members) {
            unionMembers = members;
            membersByMachineId = new Map(members.map(member => [member.machineId, member]));
        }
        const projectionUnion = settleAppShellProjectionAvailability(union.publish(members, selections),
            availabilityInputs?.unavailableReasonCode, previous.projectionUnion,
            accountLifetime !== null && availabilityInputs === null);
        const accountUiProjection = sources.hostBundledUiEnabled ? availabilityInputs?.accountUiProjection ?? null : null;
        const pluginUiProjection = accountMerge.publish(accountUiProjection ? [accountUiProjection] : NO_MODELS,
            projectionUnion.pluginUiProjection, undefined, explicitSelections);
        const nextCandidateMembers = members.map(member => {
            const packages = currentness.get(member.machineId)?.installedPackagesProjection;
            if (!packages) { candidateMembersByMachineId.delete(member.machineId); return member; }
            const held = candidateMembersByMachineId.get(member.machineId);
            if (held?.member === member && held.packages === packages) return held.candidate;
            const merge = held?.merge ?? createInstalledPluginUiProjectionPublication();
            const declaration = installedByMachineId.get(member.machineId);
            const candidate: PluginUiProjectionUnionMember = { ...member, phase: 'current', unavailableReasonCode: undefined,
                interactionEnabled: true, projection: merge.publish(declaration?.models ?? NO_MODELS, packages,
                    declaration?.materializationsByPluginId, undefined, declaration?.completeUiPluginIds) };
            candidateMembersByMachineId.set(member.machineId, { member, packages, candidate, merge });
            return candidate;
        });
        for (const id of candidateMembersByMachineId.keys()) if (!eligible.has(id)) candidateMembersByMachineId.delete(id);
        if (candidateMembers.length !== nextCandidateMembers.length || nextCandidateMembers.some((member, index) => member !== candidateMembers[index])) {
            candidateMembers = nextCandidateMembers.every((member, index) => member === members[index]) ? members : Object.freeze(nextCandidateMembers);
        }
        const candidateFactsByPluginId = candidates.publish(pluginUiProjection, candidateMembers, pluginIds);
        const skillSourceIdentity = skills.publish(pluginUiProjection);
        const destinationSurfacePlacements = previous.pluginUiProjection?.surfacePlacementsById === pluginUiProjection?.surfacePlacementsById
            ? previous.destinationSurfacePlacements
            : pluginUiProjection ? selectPluginDestinationSurfacePlacements(pluginUiProjection) : NO_DESTINATION_PLACEMENTS;
        const settingsPages = previous.pluginUiProjection?.settingsPagesById === pluginUiProjection?.settingsPagesById
            ? previous.settingsPages
            : pluginUiProjection ? Object.freeze(Object.values(pluginUiProjection.settingsPagesById)) : NO_SETTINGS_PAGES;
        const connectedAccountResolution = publishConnectedAccounts(targets, currentness, admitted, accountLifetime);
        const next: AppShellPluginUiProjectionSnapshot = Object.freeze({ accountLifetime, activeServerId: sources.activeServerId, accountUiProjection,
            executionOriginMaterializations: materializations, executionOriginPluginIds: pluginIds, projectionTargets: targets,
            currentnessForActiveAccountByMachineId, projectionUnion, pluginUiProjection,
            mountedActionProjections: previous.mountedActionProjections, skillSourceIdentity,
            destinationSurfacePlacements, settingsPages, candidateFactsByPluginId, connectedAccountResolution });
        if ((Object.keys(next) as (keyof AppShellPluginUiProjectionSnapshot)[]).every(key => next[key] === previous[key])) return;
        snapshot = next;
        if (!quiet) notify(previous);
    }

    return {
        publishMountedActions(owner, lifetime, source) {
            const previous = mountedActions.get(owner);
            if (!source) {
                if (!previous || previous.lifetime !== lifetime) return;
                previous.retirement.dispose();
                mountedActions.delete(owner);
                publishMountedActionSources();
                return;
            }
            // A routed Host lifetime is independent of AppShell's active
            // lifetime. Both must be live and address the same exact Home/Account.
            if (!lifetime?.isCurrent() || !sources?.accountLifetime?.isCurrent()
                || !areServerAccountScopesEqual(lifetime.scope, sources.accountLifetime.scope)) return;
            if (previous?.source === source && previous.lifetime === lifetime) return;
            const retirement = previous?.lifetime === lifetime ? previous.retirement : lifetime.onRetire(() => {
                if (mountedActions.get(owner)?.lifetime !== lifetime) return;
                mountedActions.delete(owner);
                publishMountedActionSources(true);
            });
            if (previous?.retirement !== retirement) previous?.retirement.dispose();
            mountedActions.set(owner, { source, lifetime, retirement });
            publishMountedActionSources();
        },
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
                || currentness.serverId !== sources.activeServerId || !membersByMachineId.has(machineId)) return;
            const current = currentnessReports.get(machineId);
            if (current?.accountLifetime === accountLifetime && shallow(current.currentness, currentness)) return;
            currentnessReports = new Map(currentnessReports).set(machineId, Object.freeze({ accountLifetime, currentness }));
            if ((current?.currentness.pluginUiProjection ?? null) === currentness.pluginUiProjection
                && (current?.currentness.phase ?? 'establishing') === currentness.phase
                && current?.currentness.unavailableReasonCode === currentness.unavailableReasonCode
                && (current?.currentness.interactionEnabled ?? false) === currentness.interactionEnabled
                && (current?.currentness.installedPackagesProjection ?? null) === (currentness.installedPackagesProjection ?? null)
                && (current?.currentness.presentedPluginIds ?? null) === (currentness.presentedPluginIds ?? null)) {
                // Missing reports already contribute null/establishing/noninteractive
                // inputs. Their first matching answer, like Browser and descriptor
                // arrivals, changes the raw report without changing the catalog.
                const previous = snapshot;
                const reports = new Map(previous.currentnessForActiveAccountByMachineId).set(machineId, currentness);
                snapshot = Object.freeze({ ...previous, currentnessForActiveAccountByMachineId: reports,
                    connectedAccountResolution: current?.currentness.connectedAccountProjection === currentness.connectedAccountProjection
                        ? previous.connectedAccountResolution
                        : publishConnectedAccounts(previous.projectionTargets, reports, new Set(previous.executionOriginPluginIds), accountLifetime) });
                notify(previous);
                return;
            }
            publishDerived(machineId);
        },
        publishExecutionOrigin(pluginId: string, accountLifetime: ActiveServerAccountScopeLifetime | null, origin: PluginMachineExecutionOriginV1 | null,
            selectableOrigins: readonly PluginMachineExecutionOriginV1[], hasStoredTarget = false) {
            if (!sources || sources.accountLifetime !== accountLifetime || !isCurrent(accountLifetime)
                || !snapshot.executionOriginPluginIds.includes(pluginId)) return;
            const current = originReports.get(pluginId);
            const sameOrigin = current?.origin === origin;
            if (current?.accountLifetime === accountLifetime && sameOrigin && (current.hasStoredTarget === true) === hasStoredTarget
                && (current.selectableOrigins?.length ?? 0) === selectableOrigins.length
                && selectableOrigins.every((candidate, index) => candidate === current.selectableOrigins![index])) return;
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
            if (originReportsPending) return;
            originReportsPending = true;
            queueMicrotask(() => {
                deriveOriginReports(false);
                // A synchronous reader derived the burst already; tell listeners once.
                if (unnotifiedPrevious) notify(unnotifiedPrevious);
            });
        },
        getSnapshot: () => {
            if (!sources || !isCurrent(sources.accountLifetime)) return EMPTY_SNAPSHOT;
            deriveOriginReports(true);
            return snapshot;
        },
        readActiveServerId: () => (sources && isCurrent(sources.accountLifetime) ? snapshot : EMPTY_SNAPSHOT).activeServerId,
        subscribe(listener: () => void, scope?: 'committed') { listeners.set(listener, scope); return () => { listeners.delete(listener); }; },
        dispose() { retirement?.dispose(); retirement = undefined; sources = null; resetDerived(); listeners.clear(); },
    };
}
