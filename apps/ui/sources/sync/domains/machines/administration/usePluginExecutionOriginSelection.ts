import * as React from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { t } from '@/text';
import { useCurrentUiContextMountedCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { CurrentUiContextPluginExecutionOriginCommand } from '@/components/appShell/currentUiContext/currentUiContextModel';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { type PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginExecutionOriginActionOutputSchemas, type PluginExecutionOriginActionId } from '@happier-dev/protocol/actions/pluginExecutionOriginActionFamily';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { getServerProfileById, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { storage } from '@/sync/domains/state/storageStore';
import {
    type OneShotAccountSettingsMutationResult,
} from '@/sync/engine/settings/syncSettings';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useActiveServerAccountScope } from '@/sync/store/hooks';

import {
    resolvePluginMachineMaterializationValidation,
    combinePluginMachineExecutionOriginCandidates,
    resolvePluginMachineExecutionOriginState,
    getPluginExecutionOriginCandidateOrigin,
    getPluginExecutionOriginCandidateVersion,
    isPluginMachineExecutionOriginCandidateSelectable,
    type PluginMachineExecutionOriginStateV1,
    type PluginMachineExecutionOriginRejectionV1,
    type PluginMachineReleaseClassificationV1,
    type PluginMachineSourceExecutionOriginCandidateV1,
    type PluginExecutionOriginCandidateV1,
    type PluginExecutionOriginContextualTarget,
} from './pluginExecutionOrigin';
import { executionOriginMachineSnapshotPublication, EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION,
    type ExecutionOriginMachineSnapshotSelection, type ExecutionOriginMachineSnapshotConnection,
    type PluginExecutionOriginDescriptiveInputs } from './pluginExecutionOriginMachineSnapshots';
import { readPluginExecutionOriginAutomaticHints } from './pluginExecutionOriginAutomaticHints';
export { readPluginExecutionOriginAutomaticHints } from './pluginExecutionOriginAutomaticHints';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { readCurrentPluginMachineExecutionTargetPreference, readPluginMachineExecutionTargetPreference,
    rememberPluginMachineExecutionOriginUse } from './selectionPreferences';
import { useMachineAdministrationTargetObservation } from '@/sync/domains/state/machineAdministrationUiState';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { readLocalDaemonSharedState, subscribeLocalDaemonSharedState } from '@/components/settings/machines/localControl/localDaemonSharedState';
import type { LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { buildMachineAdministrationCandidatesFromSnapshots } from './targetState';
import type { MachineAdministrationCandidateV1 } from './targetSelection';
import {
    resolveFreshMachineAdministrationExecutionTarget,
    type FreshMachineAdministrationExecutionTargetV1,
} from './useTargetSelection';

export type FreshPluginMachineExecutionOriginV1 = Readonly<{
    origin: PluginMachineExecutionOriginV1;
    materialization?: PluginMachineMaterializationV1;
    source?: PluginMachineSourceExecutionOriginCandidateV1['source'];
    machineTarget: FreshMachineAdministrationExecutionTargetV1;
    /** UI-local fence for origin selection changes, including A -> B -> A. */
    selectionRevision?: number;
}>;

type PluginExecutionOriginSelectionRevisionState = Readonly<{
    pluginId: string;
    origin: PluginMachineExecutionOriginV1 | null;
    target?: MachineAdministrationTargetV1 | null;
    revision: number;
}>;

const EMPTY_EXECUTION_ORIGIN_MATERIALIZATIONS: readonly PluginMachineMaterializationV1[] = Object.freeze([]);
const EMPTY_EXECUTION_ORIGIN_SOURCES: readonly PluginMachineSourceExecutionOriginCandidateV1[] = Object.freeze([]);
const EMPTY_PLUGIN_EXECUTION_CANDIDATES: readonly PluginExecutionOriginCandidateV1[] = Object.freeze([]);
const EMPTY_PLUGIN_EXECUTION_STATE: PluginMachineExecutionOriginStateV1 = Object.freeze({ kind: 'selectionRequired', candidates: EMPTY_PLUGIN_EXECUTION_CANDIDATES });

type StorageState = ReturnType<typeof storage.getState>;

function usePluginExecutionOriginMachineSnapshots(params: Readonly<{
    enabled: boolean;
    pluginId: string;
    materializations: readonly PluginMachineMaterializationV1[];
    sources: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    readinessServerIdentityId?: string;
    selection?: PluginExecutionOriginDescriptiveInputs;
}>): ExecutionOriginMachineSnapshotSelection {
    const activeServerId = useActiveServerSnapshot().serverId;
    const activeAccountScope = useActiveServerAccountScope(activeServerId);
    const profilesGeneration = useServerProfilesGeneration();
    const profiles = React.useMemo(() => listServerProfiles(), [profilesGeneration]);
    const activeHome = activeAccountScope && getServerProfileById(activeAccountScope.serverId)?.serverIdentityId;
    // Only a supplying or explicitly remembered Home can affect this plugin's
    // execution. Unrelated credential resolutions must not wake every reporter.
    // The active Home already uses Sync's admitted Account below.
    const rememberedHome = readPluginMachineExecutionTargetPreference(storage.getState().settings.machineAdministrationTargetsLocalV1, params.pluginId)?.serverIdentityId;
    const relevantHomes = React.useMemo(() => {
        const relevantServerIdentityIds = new Set([
        params.readinessServerIdentityId
            ?? rememberedHome
            ?? getServerProfileById(activeServerId)?.serverIdentityId,
        ...params.materializations.filter(entry => entry.pluginId === params.pluginId).map(entry => entry.serverIdentityId),
        ...params.sources.filter(entry => entry.source.origin.sourceRef.pluginId === params.pluginId).map(entry => entry.source.origin.serverIdentityId),
        ]);
        return params.enabled ? profiles
        .filter(profile => profile.serverIdentityId !== activeHome && relevantServerIdentityIds.has(profile.serverIdentityId))
        .map(profile => profile.serverIdentityId) : [];
    }, [params.enabled, params.pluginId, params.readinessServerIdentityId, params.materializations, params.sources,
        rememberedHome, activeServerId, activeHome, profiles]);
    const bindings = useServerCredentialAccountScopeBindings(relevantHomes);
    const accountScopesByServerId = React.useMemo(() => {
        const scopes = new Map([...bindings].flatMap(([serverId, binding]) =>
            binding.isCurrent() ? [[serverId, binding.scope] as const] : []));
        // The focused Account is already admitted by Sync, just as invocation
        // uses it. A page remount must not withdraw that authority while its
        // separate credential/picker readers initialize. Other Homes still
        // require their own current credential bindings.
        const activeHome = activeAccountScope && getServerProfileById(activeAccountScope.serverId)?.serverIdentityId;
        if (activeAccountScope && activeHome) scopes.set(activeHome, { serverId: activeHome, accountId: activeAccountScope.accountId });
        return scopes;
    }, [activeAccountScope, bindings, profiles]);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const bindingLifetimes = React.useMemo(() => [...bindings.values()], [bindings]);
    const snapshots = React.useMemo(() => {
        let connection: ExecutionOriginMachineSnapshotConnection | null = null;
        const listeners = new Set<() => void>();
        // Account capture may retire an incumbent while a sibling renders.
        // The owner withdraws synchronously; only React notification is deferred.
        const notify = () => {
            for (const listener of listeners) queueMicrotask(() => { if (listeners.has(listener)) listener(); });
        };
        return {
            get: () => connection?.getSnapshot() ?? EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION,
            read: () => connection?.readCurrent() ?? EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION,
            subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
            publish(inputs: Parameters<typeof executionOriginMachineSnapshotPublication.connect>[0] | null) {
                if (inputs) {
                    if (connection) connection.updateInputs(inputs);
                    else connection = executionOriginMachineSnapshotPublication.connect(inputs, notify);
                } else {
                    const previous = connection?.getSnapshot() ?? EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION;
                    connection?.dispose(); connection = null;
                    if (previous !== EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION) notify();
                }
            },
            dispose() { connection?.dispose(); connection = null; },
        };
    }, [params.pluginId, params.readinessServerIdentityId, activeServerId]);
    React.useLayoutEffect(() => {
        snapshots.publish(params.enabled ? { ...params, activeServerId, profiles, profilesGeneration,
            accountScopesByServerId, accountLifetime, bindings: bindingLifetimes } : null);
    }, [snapshots, activeServerId, params.enabled, params.materializations, params.pluginId, params.sources,
        params.readinessServerIdentityId, params.selection, profiles, profilesGeneration, accountScopesByServerId, accountLifetime, bindingLifetimes]);
    React.useLayoutEffect(() => () => snapshots.dispose(), [snapshots]);
    React.useSyncExternalStore(snapshots.subscribe, snapshots.get, snapshots.get);
    return params.enabled ? snapshots.read() : EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION;
}

export function advancePluginExecutionOriginSelectionRevision(
    previous: PluginExecutionOriginSelectionRevisionState,
    pluginId: string,
    origin: PluginMachineExecutionOriginV1 | null,
    target: MachineAdministrationTargetV1 | null = null,
): PluginExecutionOriginSelectionRevisionState {
    const unchanged = previous.pluginId === pluginId
        && previous.target?.serverIdentityId === target?.serverIdentityId
        && previous.target?.machineId === target?.machineId
        && (
            previous.origin === null
                ? origin === null
                : origin !== null && arePluginMachineExecutionOriginsEqual(previous.origin, origin)
        );
    return unchanged
        ? previous
        : Object.freeze({ pluginId, origin, target, revision: previous.revision + 1 });
}

type FreshPluginExecutionOriginParams = Readonly<{
    pluginId: string;
    origin: PluginMachineExecutionOriginV1 | null;
    storedTarget?: MachineAdministrationTargetV1 | null;
    reader: PluginAccountAvailabilityReader | null;
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
    sourceCandidates?: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    machineRejections?: readonly PluginMachineExecutionOriginRejectionV1[];
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
    autoPick?: boolean;
    renderedVersion?: string;
    contextualTarget?: PluginExecutionOriginContextualTarget | null;
}>;

/** Invocation-time candidates over the same Availability and raw machine owners. */
export function readFreshPluginMachineExecutionOriginCandidates(params: FreshPluginExecutionOriginParams): readonly PluginExecutionOriginCandidateV1[] {
    const admission = params.reader?.readMaterializations();
    const materializationCandidates = admission?.kind === 'available'
        ? admission.materializations.filter((entry) => entry.pluginId === params.pluginId).map((materialization) => {
            const release = params.classifyRelease(materialization);
            const machineRejection = !resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: materialization.serverIdentityId, machineId: materialization.machineId })
                ? 'offline' : params.machineRejections?.find(entry => entry.serverIdentityId === materialization.serverIdentityId
                    && entry.machineId === materialization.machineId)?.reason ?? null;
            return { materialization, ...release, validation: resolvePluginMachineMaterializationValidation({ materialization, release, machineRejection }) };
        }) : [];
    const sourceCandidates = (params.sourceCandidates ?? []).filter(candidate => candidate.source.origin.sourceRef.pluginId === params.pluginId)
        .map((candidate): PluginMachineSourceExecutionOriginCandidateV1 => {
        const origin = candidate.source.origin;
        const machineTarget = resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: origin.serverIdentityId, machineId: origin.sourceRef.machineId });
        return machineTarget ? candidate : { ...candidate, validation: { kind: 'rejected', reason: 'offline' } };
    });
    return combinePluginMachineExecutionOriginCandidates(materializationCandidates, sourceCandidates);
}

/** Invocation-time closure over the current Availability and raw machine owners. */
export function resolveFreshPluginMachineExecutionOrigin(params: FreshPluginExecutionOriginParams): FreshPluginMachineExecutionOriginV1 | null {
    const candidates = readFreshPluginMachineExecutionOriginCandidates(params);
    const admission = params.reader?.readMaterializations();
    const state = resolvePluginMachineExecutionOriginState({ pluginId: params.pluginId, storedOrigin: params.origin,
        automaticOrigin: executionOriginMachineSnapshotPublication.readAutomaticOrigin(params.pluginId, captureActiveServerAccountScopeLifetime()),
        storedTarget: params.storedTarget, homeServerIdentityId: getServerProfileById(getActiveServerAccountScope()?.serverId ?? '')?.serverIdentityId,
        candidates, declaredDefaultOrigins: params.declaredDefaultOrigins, contextualTarget: params.contextualTarget,
        autoPick: params.autoPick, renderedVersion: params.renderedVersion,
        ...readPluginExecutionOriginAutomaticHints(params.pluginId, candidates, undefined,
            admission?.kind === 'available' ? admission.materializations : [], params.reader?.readInstalledPlugins()) });
    if (state.kind !== 'selected') return null;
    const origin = state.origin;
    const machineTarget = resolveFreshMachineAdministrationExecutionTarget({
        serverIdentityId: origin.serverIdentityId,
        machineId: getPluginMachineExecutionOriginRef(origin).machineId,
    });
    if (!machineTarget) return null;
    return Object.freeze({ origin, ...('source' in state.candidate ? { source: state.candidate.source } : { materialization: state.candidate.materialization }), machineTarget });
}

export type PluginMachineExecutionOriginSelectionV1 = Readonly<{
    candidates: readonly PluginExecutionOriginCandidateV1[];
    machineCandidates?: readonly MachineAdministrationCandidateV1[];
    state: PluginMachineExecutionOriginStateV1;
    selectedOrigin: PluginMachineExecutionOriginV1 | null;
    /** Explicit device/Home Machine intent survives an unavailable current source. */
    storedTarget?: MachineAdministrationTargetV1 | null;
    /** Account availability has not been read yet: "no Machine" is not yet an answer. */
    loading: boolean;
    canExecute: boolean;
    selectOrigin: (origin: PluginMachineExecutionOriginV1) => Promise<PluginExecutionOriginSelectionMutationResult>;
    clearOrigin: () => Promise<PluginExecutionOriginSelectionMutationResult>;
    /** Currentness inspection uses recordUse:false; invocation records the existing last-use hint. */
    resolveExecutionOrigin: (options?: Readonly<{ recordUse?: boolean }>) => FreshPluginMachineExecutionOriginV1 | null;
}>;

export type PluginExecutionOriginSelectionMutationResult =
    | OneShotAccountSettingsMutationResult<void>
    | Readonly<{ status: 'applied'; value: void }>
    | Readonly<{ status: 'unavailable' }>
    | PluginExecutionOriginPreferenceApproval;

export type PluginExecutionOriginPreferenceApproval = Readonly<{
    status: 'approvalPending';
    scope: AccountSettingsScope;
    input: unknown;
    approval: ActionApprovalRequestCreatedResult & Readonly<{
        actionId: Exclude<PluginExecutionOriginActionId, 'plugins.execution_origin.list'>;
    }>;
}>;

/**
 * Exact plugin-origin selection over the canonical Account Availability
 * reader. Artifact release classification is a required dependency, keeping
 * immutable-content and compatibility authority out of Administration.
 */
export function usePluginMachineExecutionOriginSelection(params: Readonly<{
    pluginId: string;
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
    enabled?: boolean;
    sourceCandidates?: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    readSourceCandidates?: () => readonly PluginMachineSourceExecutionOriginCandidateV1[];
    /** Known installations whose canonical runtime describe has not answered yet. */
    establishingTargets?: readonly MachineAdministrationTargetV1[];
    machineRejections?: readonly PluginMachineExecutionOriginRejectionV1[];
    readMachineRejections?: () => readonly PluginMachineExecutionOriginRejectionV1[];
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
    autoPick?: boolean;
    renderedVersion?: string;
    readDeclaredDefaultOrigins?: () => readonly PluginMachineExecutionOriginV1[];
    /** Renderless app-shell consumers do not subscribe to machine labels or heartbeat timestamps. */
    includeMachineCandidates?: boolean;
    contextualTarget?: PluginExecutionOriginContextualTarget | null;
}>): PluginMachineExecutionOriginSelectionV1 {
    const reader = useActivePluginAccountAvailabilityReader(params.pluginId);
    const availabilityRevision = reader?.getObservationSnapshot(params.pluginId) ?? null;
    const enabled = params.enabled !== false;
    const materializationAdmission = React.useMemo(
        () => enabled ? reader?.readMaterializations() ?? null : null,
        [enabled, reader, availabilityRevision],
    );
    const availabilityNotLoaded = enabled && (reader === null || (materializationAdmission?.kind === 'unavailable'
        && materializationAdmission.code === 'account_availability_not_loaded'));
    const includeMachineCandidates = params.includeMachineCandidates !== false;
    const materializations = materializationAdmission?.kind === 'available'
        ? materializationAdmission.materializations : EMPTY_EXECUTION_ORIGIN_MATERIALIZATIONS;
    const sources = params.sourceCandidates ?? EMPTY_EXECUTION_ORIGIN_SOURCES;
    const presentationMachineSnapshots = useAllProfileMachineInventorySnapshots(enabled && includeMachineCandidates);
    const machineCandidates = React.useMemo(() => enabled && includeMachineCandidates
        ? buildMachineAdministrationCandidatesFromSnapshots({ snapshots: presentationMachineSnapshots })
        : Object.freeze([]), [enabled, includeMachineCandidates, presentationMachineSnapshots]);
    const selectStoredTarget = React.useCallback((state: StorageState) => params.contextualTarget !== undefined ? null
        : readPluginMachineExecutionTargetPreference(state.settings.machineAdministrationTargetsLocalV1, params.pluginId),
    [params.pluginId, params.contextualTarget !== undefined]);
    const storedTarget = useStoreWithEqualityFn(storage, selectStoredTarget,
        (left, right) => left?.serverIdentityId === right?.serverIdentityId && left?.machineId === right?.machineId);
    const expectedSettingsScope = useAccountSettingsScope();
    const expectedAccountLifetime = captureActiveServerAccountScopeLifetime();
    const lastUsedTarget = useMachineAdministrationTargetObservation(enabled ? expectedSettingsScope : null, `plugin.lastRunOn:${params.pluginId}`);
    const localRunner = getSystemTasksRunner();
    const localStatus = React.useSyncExternalStore(
        React.useCallback(listener => enabled ? subscribeLocalDaemonSharedState(localRunner, listener) : () => {}, [enabled, localRunner]),
        React.useCallback(() => enabled ? readLocalDaemonSharedState<LocalDaemonStatusData>(localRunner).status : null, [enabled, localRunner]),
    );
    const [contextualChoice, setContextualChoice] = React.useState<Readonly<{
        pluginId: string;
        target: PluginExecutionOriginContextualTarget;
        accountLifetime: typeof expectedAccountLifetime;
        origin: PluginMachineExecutionOriginV1;
    }> | null>(null);
    const hasContextualChoice = Boolean(params.contextualTarget && contextualChoice
        && contextualChoice.pluginId === params.pluginId
        && contextualChoice.accountLifetime === expectedAccountLifetime
        && contextualChoice.target.serverIdentityId === params.contextualTarget.serverIdentityId
        && contextualChoice.target.machineId === params.contextualTarget.machineId);
    const contextualChoiceRef = React.useRef(contextualChoice);
    contextualChoiceRef.current = contextualChoice;
    const storedOrigin = params.contextualTarget !== undefined
        ? hasContextualChoice ? contextualChoice!.origin : null
        : null;
    const contextualTarget = hasContextualChoice ? undefined : params.contextualTarget;
    const selectionRevisionRef = React.useRef<PluginExecutionOriginSelectionRevisionState>({
        pluginId: params.pluginId,
        origin: storedOrigin,
        revision: 0,
    });
    selectionRevisionRef.current = advancePluginExecutionOriginSelectionRevision(
        selectionRevisionRef.current,
        params.pluginId,
        storedOrigin,
        storedTarget,
    );
    const descriptiveInputs = React.useMemo<PluginExecutionOriginDescriptiveInputs>(() => ({
        availabilityRevision, installedPlugins: reader?.readInstalledPlugins(), classifyRelease: params.classifyRelease, storedOrigin, contextualTarget,
        homeServerIdentityId: getServerProfileById(expectedSettingsScope?.serverId ?? '')?.serverIdentityId,
        machineRejections: params.machineRejections, declaredDefaultOrigins: params.declaredDefaultOrigins,
        establishingTargets: params.establishingTargets, autoPick: params.autoPick, renderedVersion: params.renderedVersion,
        availabilityNotLoaded, localStatus,
    }), [availabilityRevision, reader, params.classifyRelease, storedOrigin, contextualTarget, expectedSettingsScope,
        params.machineRejections, params.declaredDefaultOrigins, params.establishingTargets, params.autoPick,
        params.renderedVersion, availabilityNotLoaded, localStatus]);
    const semanticMachineSelection = usePluginExecutionOriginMachineSnapshots({ enabled, pluginId: params.pluginId,
        materializations, sources, readinessServerIdentityId: params.contextualTarget?.serverIdentityId, selection: descriptiveInputs });
    const machineFactsKey = semanticMachineSelection.key;
    const candidates = semanticMachineSelection.selection?.candidates ?? EMPTY_PLUGIN_EXECUTION_CANDIDATES;
    const state = semanticMachineSelection.selection?.state ?? EMPTY_PLUGIN_EXECUTION_STATE;
    const loading = enabled && (semanticMachineSelection.selection?.loading ?? true);
    const currentParamsRef = React.useRef(params);
    currentParamsRef.current = params;
    const contextualFacts = React.useRef({ params, enabled, reader, expectedAccountLifetime, expectedSettingsScope });
    contextualFacts.current = { params, enabled, reader, expectedAccountLifetime, expectedSettingsScope };
    const contextualCommand = React.useMemo<CurrentUiContextPluginExecutionOriginCommand | null>(() => {
        const target = params.contextualTarget;
        const account = expectedAccountLifetime;
        if (!target || !account || !enabled) return null;
        const facts = () => {
            const latest = contextualFacts.current;
            if (!latest.enabled || latest.expectedAccountLifetime !== account || !account.isCurrent()
                || latest.params.pluginId !== params.pluginId
                || latest.params.contextualTarget?.serverIdentityId !== target.serverIdentityId
                || latest.params.contextualTarget?.machineId !== target.machineId
                || !areAccountSettingsScopesEqual(latest.expectedSettingsScope, storage.getState().settingsScope)) return null;
            return { pluginId: params.pluginId, origin: null, reader: latest.reader, classifyRelease: latest.params.classifyRelease,
                sourceCandidates: latest.params.readSourceCandidates?.() ?? latest.params.sourceCandidates,
                machineRejections: latest.params.readMachineRejections?.() ?? latest.params.machineRejections,
                declaredDefaultOrigins: latest.params.readDeclaredDefaultOrigins?.() ?? latest.params.declaredDefaultOrigins,
                autoPick: latest.params.autoPick, renderedVersion: latest.params.renderedVersion };
        };
        return {
            kind: 'pluginExecutionOrigin', pluginId: params.pluginId, account, target,
            read: () => {
                const current = facts();
                if (!current) return { status: 'unavailable' };
                const choice = contextualChoiceRef.current;
                const storedOrigin = choice?.accountLifetime === account && choice.pluginId === params.pluginId
                    && choice.target.serverIdentityId === target.serverIdentityId && choice.target.machineId === target.machineId
                    ? choice.origin : null;
                const candidates = readFreshPluginMachineExecutionOriginCandidates(current);
                const selection = resolvePluginMachineExecutionOriginState({ ...current, storedOrigin, candidates,
                    contextualTarget: storedOrigin ? undefined : target });
                return { status: 'available', storedOrigin, selectedOrigin: selection.kind === 'selected' ? selection.origin : null,
                    selectionSource: selection.kind === 'selected' ? selection.selectionSource : storedOrigin ? 'pinned' : null,
                    candidates: candidates.map(candidate => ({ origin: getPluginExecutionOriginCandidateOrigin(candidate),
                        version: getPluginExecutionOriginCandidateVersion(candidate), selectable: isPluginMachineExecutionOriginCandidateSelectable(candidate) })) };
            },
            apply: origin => {
                const current = facts();
                if (!current) return { status: 'unavailable' };
                if (origin) {
                    const admitted = resolveFreshPluginMachineExecutionOrigin({ ...current, origin });
                    if (!admitted || !arePluginMachineExecutionOriginsEqual(admitted.origin, origin)) return { status: 'unavailable' };
                }
                const choice = origin ? { pluginId: params.pluginId, target, accountLifetime: account, origin } : null;
                contextualChoiceRef.current = choice;
                setContextualChoice(choice);
                return { status: 'applied' };
            },
        };
    }, [enabled, expectedAccountLifetime, params.pluginId, params.contextualTarget?.serverIdentityId, params.contextualTarget?.machineId]);
    const readContextualCommandId = useCurrentUiContextMountedCommand(contextualCommand, t('settingsPlugins.executionOriginTitle'));

    const executePreference = React.useCallback(async (
        origin: PluginMachineExecutionOriginV1 | null,
    ): Promise<PluginExecutionOriginSelectionMutationResult> => {
        const isCurrent = () => enabled && expectedAccountLifetime?.isCurrent() === true
            && areAccountSettingsScopesEqual(expectedSettingsScope, expectedAccountLifetime.scope)
            && areAccountSettingsScopesEqual(expectedSettingsScope, storage.getState().settingsScope);
        const contextual = params.contextualTarget !== undefined;
        const commandId = contextual ? readContextualCommandId() : null;
        if (!expectedSettingsScope || !isCurrent() || (contextual && !commandId)) return { status: 'unavailable' };
        const actionId = origin === null ? 'plugins.execution_origin.clear' : 'plugins.execution_origin.set';
        const input = { pluginId: params.pluginId,
            ...(contextual ? { contextualTarget: { commandId } } : {}),
            ...(origin === null ? {} : { origin }) };
        // Resolve the canonical policy/provenance owner only on intent. Idle
        // plugin selectors do not construct Action dependencies or approval subscriptions.
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        if (!isCurrent()) return { status: 'unavailable' };
        const result = await createFrontDoorActionExecute()(actionId, input, {
            surface: 'ui', serverId: expectedSettingsScope.serverId, expectedAccountId: expectedSettingsScope.accountId,
        });
        if (!result.ok || !isCurrent()) return { status: 'unavailable' };
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (approval.success && approval.data.actionId === actionId) {
            return { status: 'approvalPending', scope: expectedSettingsScope, input,
                approval: { ...approval.data, actionId } };
        }
        const settled = PluginExecutionOriginActionOutputSchemas[actionId].safeParse(result.result);
        if (!settled.success) return { status: 'unavailable' };
        return settled.data.status === 'applied' ? { ...settled.data, value: undefined } : settled.data;
    }, [enabled, expectedAccountLifetime, expectedSettingsScope, params.contextualTarget, params.pluginId, readContextualCommandId]);

    const selectOrigin = React.useCallback((origin: PluginMachineExecutionOriginV1) => executePreference(origin), [executePreference]);
    const clearOrigin = React.useCallback(() => executePreference(null), [executePreference]);

    const resolveExecutionOrigin = React.useCallback((options?: Readonly<{ recordUse?: boolean }>) => {
        if (!enabled || expectedAccountLifetime?.isCurrent() !== true
            || !areAccountSettingsScopesEqual(expectedSettingsScope, storage.getState().settingsScope)) return null;
        const origin = params.contextualTarget !== undefined ? storedOrigin : null;
        const target = params.contextualTarget !== undefined ? null : readCurrentPluginMachineExecutionTargetPreference(params.pluginId);
        selectionRevisionRef.current = advancePluginExecutionOriginSelectionRevision(
            selectionRevisionRef.current,
            params.pluginId,
            origin,
            target,
        );
        const resolved = resolveFreshPluginMachineExecutionOrigin({
            pluginId: params.pluginId,
            origin,
            storedTarget: target,
            reader,
            classifyRelease: params.classifyRelease,
            sourceCandidates: currentParamsRef.current.readSourceCandidates?.() ?? currentParamsRef.current.sourceCandidates,
            machineRejections: currentParamsRef.current.readMachineRejections?.() ?? currentParamsRef.current.machineRejections,
            declaredDefaultOrigins: currentParamsRef.current.readDeclaredDefaultOrigins?.() ?? currentParamsRef.current.declaredDefaultOrigins,
            autoPick: currentParamsRef.current.autoPick, renderedVersion: currentParamsRef.current.renderedVersion,
            contextualTarget,
        });
        if (resolved && expectedSettingsScope && params.contextualTarget === undefined && options?.recordUse !== false) {
            rememberPluginMachineExecutionOriginUse(params.pluginId, resolved.origin, expectedSettingsScope);
        }
        return resolved === null
            ? null
            : Object.freeze({
                ...resolved,
                selectionRevision: selectionRevisionRef.current.revision,
            });
    }, [enabled, expectedAccountLifetime, expectedSettingsScope, contextualTarget, params.contextualTarget, params.classifyRelease, params.pluginId, reader, storedOrigin]);

    // The app shell consumes candidates/origin without asking to execute.
    // Reopen fresh release and Machine authority only when a consumer reads
    // execution availability, rather than repeating that work on every render.
    const readCanExecute = React.useMemo(() => {
        // Keep the existing memo's exact inputs and lifetime for repeated reads.
        let canExecute: boolean | undefined;
        return () => canExecute ??= enabled && resolveFreshPluginMachineExecutionOrigin({
            pluginId: params.pluginId,
            origin: storedOrigin,
            storedTarget,
            reader,
            classifyRelease: params.classifyRelease,
            sourceCandidates: params.sourceCandidates,
            machineRejections: params.machineRejections,
            declaredDefaultOrigins: params.declaredDefaultOrigins,
            autoPick: params.autoPick, renderedVersion: params.renderedVersion,
            contextualTarget,
        }) !== null;
    }, [enabled, machineFactsKey, params.classifyRelease, params.pluginId, params.sourceCandidates, params.machineRejections,
        contextualTarget, params.declaredDefaultOrigins, params.autoPick, params.renderedVersion, lastUsedTarget, localStatus, reader, storedOrigin, storedTarget]);

    return React.useMemo(() => ({
        candidates,
        machineCandidates,
        state,
        storedTarget,
        loading,
        selectedOrigin: enabled ? state.kind === 'selected' ? state.origin : state.kind === 'unavailable' ? state.storedOrigin : storedOrigin : null,
        get canExecute() { return readCanExecute(); },
        selectOrigin,
        clearOrigin,
        resolveExecutionOrigin,
    }), [
        candidates,
        readCanExecute,
        machineCandidates,
        enabled,
        clearOrigin,
        resolveExecutionOrigin,
        selectOrigin,
        state,
        storedOrigin,
        storedTarget,
        loading,
    ]);
}
