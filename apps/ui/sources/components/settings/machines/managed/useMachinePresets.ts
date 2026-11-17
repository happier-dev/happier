import * as React from 'react';
import { getDemoMachinePresets } from '@/demoMode/runtime/demoMachineReadProjection';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { MachinePresetUpdateDraftInput } from '@/sync/domains/machines/presets/machinePresetEditDraft';
type PresetMutationResultV1 = OpenedMachinePresetActionOutputV1<'machines.presets.update'>;
import { hasOpenedManagedMachinePresetCreationV1, type OpenedManagedMachinePresetV1, type ManagedMachinePresetListEntryV1, type OpenedMachinePresetActionOutputV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import { MACHINE_PRESET_PREPARE_ACTION_ID_V1, type MachinePresetActionInputV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { ActionOperationAcceptedResultSchema, type ActionOperationAcceptedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveManagedConfigurationCost } from '@happier-dev/protocol/machines/managed/configurationPresentation';

import { getServerProfileById, areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeStates, useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { retainShallow } from '@/sync/domains/state/structuralSharing';
import { invalidateMachinePresets, isMachinePresetAccessLost, readMachinePresetsSnapshot, retainMachinePresets, subscribeMachinePresets, type MachinePresetQueryState } from '@/sync/engine/machines/machinePresetsResource';
export { isMachinePresetAccessLost, type MachinePresetQueryState } from '@/sync/engine/machines/machinePresetsResource';
import { createMachinePresetCollectionClient, type MachinePresetHistoryData, type MachinePresetCollectionResult, type MachinePresetCollectionSettledResult, type MachinePresetCollectionOptions, type MachinePresetCollectionFilter } from './machinePresetCollectionClient';
import { buildManagedPresetHistory } from './managedPresetHistory';
import type { createManagedProvisionerClient } from './managedProvisionerClient';
import { createManagedConfiguratorDraft, refreshManagedConfiguratorProvisioner, beginManagedConfiguratorRead, settleManagedConfiguratorRead, managedConfiguratorFacts, managedConfiguratorOptionsSelectors, type ManagedConfiguratorDraft } from './managedConfiguratorModel';
import { useManagedMachineAccountSettings } from './useManagedMachineAccountSettings';
import type { ManagedProvisionerOptionsInput } from './useManagedProvisionerOptionsInput';
import { describeManagedNativeFailureDiagnostic } from './managedNativeFailurePresentation';
import { readManagedConfiguration } from './readManagedConfiguration';
import { managedConfiguratorReadiness } from './managedConfiguratorModel';
import { refreshManagedProvisionerAvailability } from './managedProvisionerAvailability';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { resumeActionExecutionResult } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import { useActionOperationStopControl } from '@/components/inbox/actionOperations/useActionOperationStopControl';
import { canRequestActionOperationStop } from '@/components/inbox/actionOperations/actionOperationPresentation';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';

const NO_PREPARATION_APPROVAL_REFRESH = () => {};
const EMPTY_TEAM_DEMO_PRESETS: readonly ManagedMachinePresetListEntryV1[] = [];

/** Last-reported private preparation and the canonical admitted Action lifecycle, without freshness inference. */
export function useMachinePresetPreparation(input: Readonly<{
    serverId: string;
    preset: OpenedManagedMachinePresetV1 | null;
    /** The caller selects a target for a new Prepare; this never locates an older build. */
    machineId: string | null;
    onChanged: () => void;
}>) {
    const { serverId, preset, machineId } = input;
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const scopeKey = JSON.stringify([binding?.scope, binding?.revision, preset?.id]);
    const execute = React.useMemo(() => createFrontDoorActionExecute(), []);
    const callbacks = React.useRef(input);
    callbacks.current = input;
    const request = React.useRef<AbortController | null>(null);
    const [pendingScope, setPendingScope] = React.useState<string | null>(null);
    const [failure, setFailure] = React.useState<Readonly<{ scopeKey: string; code: string }> | null>(null);
    const [accepted, setAccepted] = React.useState<Readonly<{
        scopeKey: string; presetRevision: number; value: ActionOperationAcceptedResult;
    }> | null>(null);
    const approval = useActionApprovalContinuation({ scopeKey, serverId,
        onExecuted: NO_PREPARATION_APPROVAL_REFRESH });
    React.useEffect(() => () => { request.current?.abort(); }, [scopeKey]);

    const prepare = React.useCallback(async () => {
        if (!binding?.isCurrent() || !preset || !machineId || request.current) return null;
        const controller = new AbortController();
        request.current = controller;
        const retirement = binding.onRetire(() => controller.abort());
        setPendingScope(scopeKey);
        setFailure(null);
        const actionInput: MachinePresetActionInputV1<typeof MACHINE_PRESET_PREPARE_ACTION_ID_V1> = {
            homeId: preset.homeId, id: preset.id, expectedRevision: preset.revision, machineId,
        };
        try {
            const result = await resumeActionExecutionResult({
                result: await execute(MACHINE_PRESET_PREPARE_ACTION_ID_V1, actionInput, {
                    surface: 'ui', authority: 'present_user', serverId: binding.scope.serverId,
                    expectedAccountId: binding.scope.accountId, signal: controller.signal,
                }),
                actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1, actionInput, scope: binding.scope,
                signal: controller.signal, onApprovalPending: approval.requestApproval,
            });
            if (controller.signal.aborted || !binding.isCurrent()) return null;
            if (!result.ok) { setFailure({ scopeKey, code: result.errorCode }); return null; }
            const value = ActionOperationAcceptedResultSchema.parse(result.result);
            setAccepted({ scopeKey, presetRevision: preset.revision, value });
            callbacks.current.onChanged();
            return value;
        } catch {
            if (!controller.signal.aborted && binding.isCurrent()) setFailure({ scopeKey, code: 'request_failed' });
            return null;
        } finally {
            retirement.dispose();
            if (request.current === controller) {
                request.current = null;
                setPendingScope(null);
            }
        }
    }, [binding, preset, machineId, scopeKey, execute, approval.requestApproval]);

    const prepared = binding?.isCurrent() ? preset?.prepared ?? null : null;
    // A newer private row wins over a prior click. The accepted receipt remains useful once that row names it.
    const currentAccepted = accepted?.scopeKey === scopeKey
        && (accepted.presetRevision === preset?.revision || accepted.value.operationId === prepared?.operationId) ? accepted.value : null;
    const operationId = currentAccepted?.operationId ?? prepared?.operationId ?? '';
    const observed = useActionOperation({ serverId: binding?.isCurrent() ? binding.scope.serverId : null, operationId },
        currentAccepted && binding ? { machineId: currentAccepted.machineId,
            actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1, lifetime: binding } : undefined);
    const operation = binding?.isCurrent() && observed?.snapshot.scope.accountId === binding.scope.accountId
        && observed.snapshot.actionId === MACHINE_PRESET_PREPARE_ACTION_ID_V1 ? observed : null;
    const previous = React.useRef({ scopeKey, operationId, state: operation?.snapshot.state });
    React.useEffect(() => {
        const state = operation?.snapshot.state;
        if (previous.current.scopeKey === scopeKey && previous.current.operationId === operationId
            && previous.current.state !== state && state && isActionOperationTerminal(state)) callbacks.current.onChanged();
        previous.current = { scopeKey, operationId, state };
    }, [scopeKey, operationId, operation?.snapshot.state]);
    const stopControl = useActionOperationStopControl(operation);
    const canCancel = operation !== null && canRequestActionOperationStop(operation.snapshot, operation.observation);
    const openOperation = React.useCallback(() => {
        if (operation) openActionOperationDetail({ serverId: operation.serverId, operationId: operation.snapshot.operationId });
    }, [operation]);
    const estimates = React.useMemo(() => prepared?.status === 'ready' ? {
        storageBytes: prepared.artifactSizeBytes ?? null,
        // Compute pricing does not price a retained prepared artifact.
        cost: resolveManagedConfigurationCost({ provider: null }),
    } : null, [prepared]);
    return { prepared, estimates, reportedStatus: prepared?.status ?? null, prepare, retry: prepare,
        pending: pendingScope === scopeKey && !approval.approvalPending,
        error: failure?.scopeKey === scopeKey ? failure.code : null,
        approval, operation, openOperation, canCancel, stopControl };
}

type MachinePresetQueryValue = Pick<OpenedManagedMachinePresetV1, 'id' | 'controller'> | Pick<MachinePresetHistoryData, 'preset'>;
/** Readiness and data are facts; starting another read does not replace a ready receipt. */
function retainQueryReceipt<T, S extends MachinePresetQueryState<T>>(previous: S, next: S): S {
    const value = sameStrictJsonValue(previous.value, next.value) ? previous.value : next.value;
    const retained = { ...next, value };
    return Object.keys(previous).length === Object.keys(retained).length
        && Object.entries(retained).every(([key, value]) => Object.is(Reflect.get(previous, key), value)) ? previous : retained;
}

/** One scoped read lifetime for preset detail and editing, including approvals and Home invalidation. */
export function useMachinePresetQuery<T extends MachinePresetQueryValue>(input: Readonly<{
    serverId: string; homeId: string | null; presetId?: string; binding: ServerCredentialAccountScopeBinding | null;
    resolution: ServerCredentialAccountScopeResolution;
    read: ((options: MachinePresetCollectionOptions<T>) => Promise<MachinePresetCollectionSettledResult<T>>) | null;
    refreshRevision?: number;
    onApprovalPending?: (approval: ActionApprovalRegistration) => void;
    onAccessLost?: (code: string) => void;
    onInvalidated?: () => void;
}>) {
    const { serverId, homeId, presetId, binding, resolution, read, refreshRevision } = input;
    const presented = useLayoutPresentationActive();
    // Credential revisions cancel custody; only the exact Home/Account identifies retained presentation.
    const queryKey = JSON.stringify([serverId, homeId, resolution.kind === 'bound' ? resolution.scope : null, presetId]);
    const [state, setState] = React.useState<MachinePresetQueryState<T> & { queryKey: string }>(
        { queryKey, value: null, loading: true, error: null });
    const [revision, refresh] = React.useReducer(value => value + 1, 0);
    const callbacks = React.useRef(input);
    callbacks.current = input;
    const pendingRead = React.useRef<AbortController | null>(null);
    const approvalRead = React.useRef<{ controller: AbortController; pending: number } | null>(null);
    const withdraw = React.useCallback((code: string) => {
        pendingRead.current?.abort();
        setState(current => retainQueryReceipt(current, { queryKey, value: null, loading: false, error: code }));
        callbacks.current.onAccessLost?.(code);
    }, [queryKey]);
    React.useEffect(() => {
        if (state.queryKey === queryKey) return;
        // Only a retained row or failure can be left behind by another scope; a read that has shown nothing yet
        // (the Account or Home was still resolving) simply starts again under the resolved scope.
        if (state.value || state.error) { withdraw('action_account_scope_changed'); return; }
        pendingRead.current?.abort();
        setState({ queryKey, value: null, loading: !!presetId, error: null });
    }, [queryKey, state.queryKey, state.value, state.error, presetId, withdraw]);
    React.useEffect(() => {
        if (!presented || !binding?.isCurrent() || !read || !presetId) return;
        const controller = new AbortController();
        pendingRead.current = controller;
        const retirement = binding.onRetire(() => controller.abort());
        setState(current => current.queryKey === queryKey ? current
            : { queryKey, value: null, loading: true, error: null });
        void read({ signal: controller.signal, onApprovalPending: approval => {
            if (!controller.signal.aborted && binding.isCurrent()) {
                approvalRead.current = { controller, pending: approvalRead.current?.controller === controller ? approvalRead.current.pending + 1 : 1 };
                callbacks.current.onApprovalPending?.(approval);
            }
        }, onApprovalSettled: () => {
            const current = approvalRead.current;
            if (current?.controller !== controller) return;
            current.pending -= 1;
            if (current.pending === 0) approvalRead.current = null;
        } }).then(result => {
            if (controller.signal.aborted || !binding.isCurrent()) return;
            if (result.kind === 'failed' && isMachinePresetAccessLost(result.code)) { withdraw(result.code); return; }
            setState(current => retainQueryReceipt(current, { queryKey, loading: false, error: result.kind === 'failed' ? result.code : null,
                value: result.kind === 'succeeded' ? result.value : current.queryKey === queryKey ? current.value : null }));
        }).catch(() => {
            if (!controller.signal.aborted && binding.isCurrent()) setState(current => retainQueryReceipt(current, { ...current, loading: false, error: 'request_failed' }));
        }).finally(() => {
            if (approvalRead.current?.controller === controller) approvalRead.current = null;
        });
        return () => { controller.abort(); retirement.dispose(); if (approvalRead.current?.controller === controller) approvalRead.current = null; };
    }, [presented, binding, read, presetId, queryKey, withdraw, revision, refreshRevision]);
    const retainedValue: MachinePresetQueryValue | null = state.queryKey === queryKey ? state.value : null;
    const selectedPreset = retainedValue && ('preset' in retainedValue ? retainedValue.preset : retainedValue);
    React.useEffect(() => presented ? subscribeHomeAccountChange(event => {
        if (event.machineResourcesAffect === false) return;
        if (!presetId || !areServerProfileIdentifiersEquivalent(serverId, event.serverId)) return;
        // Only this preset's controller contributes live availability; unknown and recovery wakes still refresh.
        if (selectedPreset && event.source === 'socket' && event.changeKinds?.length
            && event.changeKinds.every(kind => kind === 'machine') && event.entityIds?.length
            && (!selectedPreset.controller || !event.entityIds.includes(selectedPreset.controller.machineId))) return;
        // This read has not executed yet: its post-decision result satisfies preceding wakes.
        if (approvalRead.current?.controller === pendingRead.current && approvalRead.current && !approvalRead.current.controller.signal.aborted) return;
        pendingRead.current?.abort();
        callbacks.current.onInvalidated?.();
        refresh();
    }, { reconnect: 'refresh' }) : undefined, [presented, serverId, presetId, selectedPreset]);
    const sameScope = resolution.kind === 'bound' && state.queryKey === queryKey;
    return { sameScope, state: sameScope
        ? binding?.isCurrent() ? state : { ...state, loading: !!presetId }
        : { queryKey, value: null, loading: !!presetId && (resolution.kind === 'bound' || resolution.kind === 'resolving'),
            error: resolution.kind === 'bound' || resolution.kind === 'resolving' ? null : resolution.kind }, setState, queryKey, refresh, refreshRevision: revision, withdraw };
}

/** Current future-launch facts use the same native selection and policy model as its editor. */
export function useMachinePresetConfiguration(input: Readonly<{
    binding: ServerCredentialAccountScopeBinding | null;
    resolution: ServerCredentialAccountScopeResolution;
    client: ReturnType<typeof createManagedProvisionerClient> | null;
    homeId: string | null;
    preset?: OpenedManagedMachinePresetV1;
    provisioner?: MachineProvisionersListResultV1['provisioners'][number];
    optionsInput: ManagedProvisionerOptionsInput;
    refreshPreset?: () => void;
    refreshRevision?: number;
    onApprovalPending: (approval: ActionApprovalRegistration) => void;
}>) {
    const { binding, resolution, client, homeId, preset, provisioner, optionsInput, onApprovalPending } = input;
    const optionsSchema = optionsInput.kind === 'ready' ? optionsInput.schema : null;
    const optionsInputError = optionsInput.kind === 'unavailable' ? optionsInput.error : null;
    const settings = useManagedMachineAccountSettings(binding, resolution);
    const queryKey = stableJsonStringify([binding?.scope, binding?.revision, homeId, preset, provisioner?.occurrenceId]);
    const [state, setState] = React.useState<Readonly<{ queryKey: string; draft: ManagedConfiguratorDraft | null; error: string | null }>>(
        { queryKey: '', draft: null, error: null });
    const readCleanup = React.useRef<(() => void) | null>(null);
    const refreshedAvailability = React.useRef(input.refreshRevision);
    const readConfiguration = React.useCallback(() => {
        readCleanup.current?.();
        readCleanup.current = null;
        if (!hasOpenedManagedMachinePresetCreationV1(preset) || preset.teamAcquireDelegated || !binding?.isCurrent() || !client || !homeId || !provisioner) return;
        if (preset.launch.schemaVersion !== provisioner.descriptor.schemaVersion) {
            setState({ queryKey, draft: null, error: 'option_unavailable' });
            return;
        }
        const initial: ManagedConfiguratorDraft = { ...createManagedConfiguratorDraft({ provisioner, controller: preset.controller,
            name: preset.launch.name, ...(preset.launch.credentials ? { credentials: preset.launch.credentials } : {}),
            ...(preset.setup !== undefined ? { setup: preset.setup } : {}),
            preset: { id: preset.id, revision: preset.revision, name: preset.name,
                ...(preset.retention ? { retention: preset.retention } : {}),
                ...(preset.wakeOnAcceptedMessage !== undefined ? { wakeOnAcceptedMessage: preset.wakeOnAcceptedMessage } : {}) } }),
            selected: { id: `preset:${preset.id}`, title: preset.name, launch: preset.launch.choices } };
        const selectors = optionsSchema ? managedConfiguratorOptionsSelectors(initial, optionsSchema) : null;
        const waitingForSchema = optionsInput.kind === 'loading';
        const canReadOptions = optionsInput.kind === 'ready' && selectors !== null;
        setState(current => {
            const previous = current.queryKey === queryKey ? current.draft : null;
            const draft = beginManagedConfiguratorRead(previous
                ? refreshManagedConfiguratorProvisioner(previous, provisioner, preset.controller) : initial,
                waitingForSchema || canReadOptions ? 'loading' : 'unavailable');
            const error = waitingForSchema || canReadOptions ? current.queryKey === queryKey ? current.error : null
                : optionsInputError ?? 'option_unavailable';
            return current.queryKey === queryKey && current.draft === draft && current.error === error
                ? current : { queryKey, draft, error };
        });
        if (!canReadOptions) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => {
            abort.abort();
            setState({ queryKey: '', draft: null, error: null });
        });
        const actionInput = { homeId, ...(preset.controller ? { controller: preset.controller } : {}), contribution: provisioner.contribution,
            ...(preset.launch.credentials ? { credentials: preset.launch.credentials } : {}) };
        if (refreshedAvailability.current !== input.refreshRevision) {
            refreshManagedProvisionerAvailability(binding, actionInput);
            refreshedAvailability.current = input.refreshRevision;
        }
        void readManagedConfiguration({ binding, client, nativeInput: actionInput, occurrenceId: provisioner.occurrenceId,
            provisioner: provisioner.descriptor, selectors,
            signal: abort.signal, onApprovalPending }).then(result => {
            if (result.kind === 'retired') return;
            setState(current => {
                if (current.queryKey !== queryKey || !current.draft) return current;
                const draft = settleManagedConfiguratorRead(current.draft, result);
                const error = result.failure ? describeManagedNativeFailureDiagnostic(result.failure.code, result.failure.nativeCause)
                    : result.check?.available ? null : describeManagedNativeFailureDiagnostic(result.check?.code ?? 'provisioner_unavailable', result.check?.nativeCause);
                return current.draft === draft && current.error === error ? current : { queryKey, draft, error };
            });
        });
        readCleanup.current = () => { abort.abort(); retirement.dispose(); };
    }, [binding, client, homeId, preset, provisioner, queryKey, optionsInput.kind, optionsSchema, optionsInputError, onApprovalPending, input.refreshRevision]);
    React.useEffect(() => { readConfiguration(); return () => readCleanup.current?.(); }, [readConfiguration]);
    const refresh = () => {
        if (binding && homeId && provisioner) refreshManagedProvisionerAvailability(binding, { homeId,
            ...(preset?.controller ? { controller: preset.controller } : {}), contribution: provisioner.contribution });
        readConfiguration();
    };
    const visibleDraft = binding?.isCurrent() && hasOpenedManagedMachinePresetCreationV1(preset) && provisioner && state.queryKey === queryKey ? state.draft : null;
    const facts = React.useMemo(() => visibleDraft && settings.settings
        ? managedConfiguratorFacts({ ...visibleDraft, categoryPreferences: settings.settings.machineRetentionDefaultsV1 }) : null,
        [visibleDraft, settings.settings]);
    const delegated = binding?.isCurrent() && hasOpenedManagedMachinePresetCreationV1(preset) && preset.teamAcquireDelegated === true;
    const error = delegated ? null : state.queryKey === queryKey ? state.error ?? settings.error : settings.error;
    const readiness = React.useMemo(() => managedConfiguratorReadiness(visibleDraft, error, facts), [visibleDraft, error, facts]);
    return { facts: delegated ? null : facts,
        readiness,
        unavailable: Boolean(error) || !delegated && facts?.optionStatus === 'unavailable',
        loading: delegated ? false : visibleDraft?.optionStatus === 'loading',
        error,
        creationEnabled: settings.settings?.managedMachineCreationEnabled === true,
        creationDisabled: settings.settings?.managedMachineCreationEnabled === false, refresh: delegated ? input.refreshPreset ?? refresh : refresh };
}

/** Every collection surface projects the one Account-owned machines-sync resource. */
export function useMachinePresets(serverIds: readonly string[], onApprovalPending?: (approval: ActionApprovalRegistration, serverId: string) => void,
    filter?: MachinePresetCollectionFilter) {
    const sharedWithTeamId = filter?.sharedWithTeamId;
    const presented = useLayoutPresentationActive();
    const accountScopes = useServerCredentialAccountScopeStates(serverIds);
    const requestedIdsKey = JSON.stringify(serverIds);
    const requestedIds = React.useMemo(() => JSON.parse(requestedIdsKey) as string[], [requestedIdsKey]);
    const approvalRef = React.useRef(onApprovalPending);
    approvalRef.current = onApprovalPending;
    const snapshots = React.useRef<Readonly<Record<string, MachinePresetQueryState<readonly ManagedMachinePresetListEntryV1[]>>>>({});
    const readSnapshot = React.useCallback(() => {
        const next: Record<string, MachinePresetQueryState<readonly ManagedMachinePresetListEntryV1[]>> = {};
        for (const serverId of requestedIds) {
            const demo = getDemoMachinePresets(serverId);
            const homeId = getServerProfileById(serverId)?.serverIdentityId;
            const scope = accountScopes.get(resolveServerProfileScopeIdForIdentifier(serverId) || serverId);
            const resolution = scope?.resolution;
            let entry: MachinePresetQueryState<readonly ManagedMachinePresetListEntryV1[]>;
            if (demo) entry = { value: sharedWithTeamId === undefined ? demo : EMPTY_TEAM_DEMO_PRESETS, loading: false, error: null };
            else if (!homeId) entry = { value: null, loading: false, error: 'server_identity_unavailable' };
            else if (resolution && resolution.kind !== 'bound' && resolution.kind !== 'resolving') {
                entry = { value: null, loading: false, error: resolution.kind };
            } else entry = readMachinePresetsSnapshot(serverId, homeId,
                resolution?.kind === 'bound' ? resolution.scope.accountId : undefined, { sharedWithTeamId });
            next[serverId] = retainShallow(snapshots.current[serverId], entry);
        }
        snapshots.current = retainShallow(snapshots.current, next);
        return snapshots.current;
    }, [requestedIds, accountScopes, sharedWithTeamId]);
    const subscribe = React.useCallback((notify: () => void) => presented
        ? subscribeMachinePresets(requestedIds, notify) : () => {}, [presented, requestedIds]);
    const statesByServerId = React.useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
    React.useEffect(() => {
        if (!presented) return;
        const releases: Array<() => void> = [];
        for (const [serverId, scope] of accountScopes) {
            const homeId = getServerProfileById(serverId)?.serverIdentityId;
            if (scope.binding?.isCurrent() && homeId && !getDemoMachinePresets(serverId)) {
                releases.push(retainMachinePresets(scope.binding, homeId, approval => approvalRef.current?.(approval, serverId), { sharedWithTeamId }));
            }
        }
        return () => { for (const release of releases) release(); };
    }, [presented, accountScopes, sharedWithTeamId]);
    const refresh = React.useCallback(() => {
        for (const serverId of requestedIds) invalidateMachinePresets(serverId);
    }, [requestedIds]);
    const projection = React.useRef<Readonly<Record<string, readonly ManagedMachinePresetListEntryV1[]>>>({});
    return React.useMemo(() => {
        const next: Record<string, readonly ManagedMachinePresetListEntryV1[]> = {};
        for (const [serverId, state] of Object.entries(statesByServerId)) if (state.value) next[serverId] = state.value;
        projection.current = retainShallow(projection.current, next);
        return { presetsByServerId: projection.current, statesByServerId, refresh };
    }, [statesByServerId, refresh]);
}

type PresetDetailMutation =
    | Readonly<{ actionId: 'machines.presets.archive' | 'machines.presets.restore'; input: MachinePresetActionInputV1<'machines.presets.archive'> }>
    | Readonly<{ actionId: 'machines.presets.update'; input: MachinePresetUpdateDraftInput }>;

/** A selected preset's label needs that record, without its managed-Machine history or the inventory. */
export function useMachinePreset(serverId: string, presetId: string,
    onApprovalPending?: (approval: ActionApprovalRegistration) => void) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const homeId = getServerProfileById(serverId)?.serverIdentityId ?? null;
    const client = React.useMemo(() => binding && homeId ? createMachinePresetCollectionClient(binding.scope, homeId) : null,
        [binding, homeId]);
    const read = React.useMemo(() => client && homeId
        ? async (options: MachinePresetCollectionOptions<OpenedManagedMachinePresetV1>): Promise<MachinePresetCollectionSettledResult<OpenedManagedMachinePresetV1>> => {
            const result = await client.read('machines.presets.get', { homeId, id: presetId }, {
                signal: options.signal, onApprovalPending: options.onApprovalPending, onApprovalSettled: options.onApprovalSettled,
            });
            if (result.kind === 'failed') return result;
            return result.value.kind === 'refused' ? { kind: 'failed', code: result.value.code }
                : { kind: 'succeeded', value: result.value.preset };
        } : null, [client, homeId, presetId]);
    const { state, refresh } = useMachinePresetQuery({ serverId, homeId, presetId, binding, resolution, read, onApprovalPending });
    return { state, refresh };
}

/** Mounted detail reads the one preset and actual admitted rows; archive never rewrites those rows. */
export function useMachinePresetDetail(serverId: string, presetId: string,
    onApprovalPending?: (approval: ActionApprovalRegistration) => void) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const homeId = getServerProfileById(serverId)?.serverIdentityId ?? null;
    const accountId = binding?.accountId ?? null;
    const [mutationResult, setMutationResult] = React.useState<Readonly<{ queryKey: string; value: PresetMutationResultV1 }> | null>(null);
    const approvalRef = React.useRef(onApprovalPending);
    approvalRef.current = onApprovalPending;
    const client = React.useMemo(() => binding && homeId ? createMachinePresetCollectionClient(binding.scope, homeId) : null,
        [binding, homeId]);
    const read = React.useMemo(() => client ? (options: MachinePresetCollectionOptions<MachinePresetHistoryData>) => client.detail(presetId, options) : null,
        [client, presetId]);
    const { state, setState, queryKey, refresh, refreshRevision } = useMachinePresetQuery({ serverId, homeId, presetId, binding, resolution, read, onApprovalPending });
    const visibleState: MachinePresetQueryState<MachinePresetHistoryData> = !homeId
        ? { value: null, loading: false, error: 'server_identity_unavailable' }
        : state;

    // Archive, restore and the page's in-place edits are one reviewed write of the visible revision.
    const mutate = React.useCallback(async (request: (preset: OpenedManagedMachinePresetV1, homeId: string) => PresetDetailMutation): Promise<MachinePresetCollectionResult<PresetMutationResultV1>> => {
        const preset = visibleState.value?.preset;
        if (!binding?.isCurrent() || !client || !homeId || !preset) return { kind: 'failed', code: 'action_account_scope_changed' };
        const { actionId, input } = request(preset, homeId);
        const controller = new AbortController();
        const retirement = binding.onRetire(() => controller.abort());
        const settle = (value: PresetMutationResultV1) => {
            if (!binding.isCurrent()) return;
            setMutationResult({ queryKey, value });
            if (value.kind === 'saved') {
                setState(current => current.queryKey === queryKey && current.value
                    ? { ...current, value: { ...current.value, preset: value.preset } } : current);
            } else if (value.kind === 'refused' && isMachinePresetAccessLost(value.code)) {
                setState({ queryKey, value: null, loading: false, error: value.code });
            }
        };
        try {
            const result = await client.execute(actionId, input, {
                    preset,
                    signal: controller.signal, onApprovalPending: approval => approvalRef.current?.(approval),
                    onApprovalSucceeded: value => { retirement.dispose(); settle(value); },
                    onApprovalFailed: code => {
                        retirement.dispose();
                        if (!binding.isCurrent()) return;
                        setState(current => current.queryKey === queryKey
                            ? { ...current, loading: false, error: code, ...(isMachinePresetAccessLost(code) ? { value: null } : {}) }
                            : current);
                    },
                });
            if (result.kind === 'succeeded') settle(result.value);
            // Deferred approval retains this exact credential lifetime until its own retirement.
            if (result.kind !== 'approval_pending') retirement.dispose();
            return result;
        } catch (error) { retirement.dispose(); throw error; }
    }, [binding, client, homeId, queryKey, serverId, visibleState.value?.preset]);
    const archiveOrRestore = React.useCallback(() => mutate((preset, home): PresetDetailMutation => ({
        actionId: preset.archivedAt === undefined ? 'machines.presets.archive' : 'machines.presets.restore',
        input: { homeId: home, id: preset.id, expectedRevision: preset.revision } })), [mutate]);
    /** Writes only the changed fields through the same Action the configurator's Save uses. */
    const update = React.useCallback((patch: MachinePresetUpdateDraftInput['patch']) => mutate((preset, home): PresetDetailMutation => ({
        actionId: 'machines.presets.update', input: { homeId: home, id: preset.id, expectedRevision: preset.revision, patch } })), [mutate]);
    const history = React.useMemo(() => visibleState.value && homeId ? buildManagedPresetHistory({ serverId, homeId, presetId,
        machines: visibleState.value.machines }) : [], [visibleState.value?.machines, homeId, presetId, serverId]);
    return { state: visibleState, history, refresh, refreshRevision, archiveOrRestore, update, accountId, scope: binding?.scope ?? null,
        mutationResult: mutationResult?.queryKey === queryKey ? mutationResult.value : null };
}
