import * as React from 'react';
import type { ManagedMachinePresetUpdateInputV1, ManagedMachinePresetV1, PresetMutationResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { MachinePresetActionInputV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

import { getServerProfileById, areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeStates, useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { publishHomeAccountChange, subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { createMachinePresetCollectionClient, type MachinePresetHistoryData, type MachinePresetCollectionResult, type MachinePresetCollectionSettledResult, type MachinePresetCollectionOptions } from './machinePresetCollectionClient';
import { buildManagedPresetHistory } from './managedPresetHistory';
import type { createManagedProvisionerClient } from './managedProvisionerClient';
import { createManagedConfiguratorDraft, refreshManagedConfiguratorOptions, managedConfiguratorFacts, managedConfiguratorOptionsSelectors, type ManagedConfiguratorDraft } from './managedConfiguratorModel';
import { useManagedMachineAccountSettings } from './useManagedMachineAccountSettings';
import type { ManagedProvisionerOptionsInput } from './useManagedProvisionerOptionsInput';

export type MachinePresetQueryState<T> = Readonly<{
    value: T | null;
    loading: boolean;
    error: string | null;
    approval?: ActionApprovalRegistration;
}>;
type ScopedQueryState<T> = MachinePresetQueryState<T> & Readonly<{ accountId: string }>;

export function isMachinePresetAccessLost(code: string): boolean {
    return code === 'permission_denied' || code === 'preset_not_found' || code === 'action_account_scope_changed';
}

/** One scoped read lifetime for preset detail and editing, including approvals and Home invalidation. */
export function useMachinePresetQuery<T>(input: Readonly<{
    serverId: string; homeId: string | null; presetId?: string; binding: ServerCredentialAccountScopeBinding | null;
    read: ((options: MachinePresetCollectionOptions<T>) => Promise<MachinePresetCollectionSettledResult<T>>) | null;
    refreshRevision?: number;
    onApprovalPending?: (approval: ActionApprovalRegistration) => void;
    onAccessLost?: (code: string) => void;
    onInvalidated?: () => void;
}>) {
    const { serverId, homeId, presetId, binding, read, refreshRevision } = input;
    const queryKey = JSON.stringify([serverId, homeId, binding?.accountId, binding?.revision, presetId]);
    const [state, setState] = React.useState<MachinePresetQueryState<T> & { queryKey: string }>(
        { queryKey, value: null, loading: true, error: null });
    const [revision, refresh] = React.useReducer(value => value + 1, 0);
    const callbacks = React.useRef(input);
    callbacks.current = input;
    const pendingRead = React.useRef<AbortController | null>(null);
    const withdraw = React.useCallback((code: string) => {
        pendingRead.current?.abort();
        setState({ queryKey, value: null, loading: false, error: code });
        callbacks.current.onAccessLost?.(code);
    }, [queryKey]);
    React.useEffect(() => {
        if (!binding?.isCurrent() || !read || !presetId) return;
        const controller = new AbortController();
        pendingRead.current = controller;
        const retirement = binding.onRetire(() => withdraw('action_account_scope_changed'));
        setState(current => ({ queryKey, value: current.queryKey === queryKey ? current.value : null, loading: true, error: null }));
        void read({ signal: controller.signal, onApprovalPending: approval => {
            if (!controller.signal.aborted && binding.isCurrent()) callbacks.current.onApprovalPending?.(approval);
        } }).then(result => {
            if (controller.signal.aborted || !binding.isCurrent()) return;
            if (result.kind === 'failed' && isMachinePresetAccessLost(result.code)) { withdraw(result.code); return; }
            setState(current => ({ queryKey, loading: false, error: result.kind === 'failed' ? result.code : null,
                value: result.kind === 'succeeded' ? result.value : current.queryKey === queryKey ? current.value : null }));
        }).catch(() => {
            if (!controller.signal.aborted && binding.isCurrent()) setState(current => ({ ...current, loading: false, error: 'request_failed' }));
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [binding, read, presetId, queryKey, withdraw, revision, refreshRevision]);
    React.useEffect(() => subscribeHomeAccountChange(event => {
        if (!presetId || !areServerProfileIdentifiersEquivalent(serverId, event.serverId)) return;
        pendingRead.current?.abort();
        callbacks.current.onInvalidated?.();
        refresh();
    }), [serverId, presetId]);
    return { state: binding?.isCurrent() && state.queryKey === queryKey ? state
        : { queryKey, value: null, loading: !!presetId, error: null }, setState, queryKey, refresh, withdraw };
}

function reconcilePresets(previous: readonly ManagedMachinePresetV1[] | null | undefined,
    incoming: readonly ManagedMachinePresetV1[]): readonly ManagedMachinePresetV1[] {
    if (!previous) return incoming;
    const byId = new Map(previous.map(preset => [preset.id, preset]));
    const next = incoming.map(preset => {
        const existing = byId.get(preset.id);
        return existing && stableJsonStringify(existing) === stableJsonStringify(preset) ? existing : preset;
    });
    return next.length === previous.length && next.every((preset, index) => preset === previous[index]) ? previous : next;
}

/** Current future-recipe facts use the same native selection and policy model as its editor. */
export function useMachinePresetConfiguration(input: Readonly<{
    binding: ServerCredentialAccountScopeBinding | null;
    client: ReturnType<typeof createManagedProvisionerClient> | null;
    homeId: string | null;
    preset?: ManagedMachinePresetV1;
    provisioner?: MachineProvisionersListResultV1['provisioners'][number];
    optionsInput: ManagedProvisionerOptionsInput;
    onApprovalPending: (approval: ActionApprovalRegistration) => void;
}>) {
    const { binding, client, homeId, preset, provisioner, optionsInput, onApprovalPending } = input;
    const optionsSchema = optionsInput.kind === 'ready' ? optionsInput.schema : null;
    const optionsInputError = optionsInput.kind === 'unavailable' ? optionsInput.error : null;
    const settings = useManagedMachineAccountSettings(binding ?? undefined);
    const queryKey = stableJsonStringify([binding?.scope, binding?.revision, homeId, preset, provisioner?.occurrenceId]);
    const [state, setState] = React.useState<Readonly<{ queryKey: string; draft: ManagedConfiguratorDraft | null; error: string | null }>>(
        { queryKey: '', draft: null, error: null });
    const [refreshRevision, refresh] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        if (!binding?.isCurrent() || !client || !homeId || !preset || !provisioner) return;
        if (preset.recipe.schemaVersion !== provisioner.descriptor.schemaVersion) {
            setState({ queryKey, draft: null, error: 'option_unavailable' });
            return;
        }
        const initial: ManagedConfiguratorDraft = { ...createManagedConfiguratorDraft({ provisioner, controller: preset.controller,
            name: preset.recipe.name, ...(preset.recipe.credentials ? { credentials: preset.recipe.credentials } : {}),
            ...(preset.environment !== undefined ? { environment: preset.environment } : {}),
            preset: { id: preset.id, revision: preset.revision, name: preset.name,
                ...(preset.retention ? { retention: preset.retention } : {}),
                ...(preset.wakeOnAcceptedMessage !== undefined ? { wakeOnAcceptedMessage: preset.wakeOnAcceptedMessage } : {}) } }),
            selected: { id: `preset:${preset.id}`, title: preset.name, launch: preset.recipe.choices } };
        const selectors = optionsSchema ? managedConfiguratorOptionsSelectors(initial, optionsSchema) : null;
        const waitingForSchema = optionsInput.kind === 'loading';
        const canReadOptions = optionsInput.kind === 'ready' && selectors !== null;
        setState(current => ({ queryKey, error: waitingForSchema || canReadOptions ? null : optionsInputError ?? 'option_unavailable',
            draft: { ...(current.queryKey === queryKey ? current.draft ?? initial : initial),
                provisioner, choicesSchema: initial.choicesSchema, optionStatus: waitingForSchema || canReadOptions ? 'loading' : 'unavailable' } }));
        if (!canReadOptions) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => {
            abort.abort();
            setState({ queryKey: '', draft: null, error: null });
        });
        const actionInput = { homeId, controller: preset.controller, contribution: provisioner.contribution,
            ...(preset.recipe.credentials ? { credentials: preset.recipe.credentials } : {}) };
        void Promise.all([
            client.read('machines.provisioners.check', actionInput, { signal: abort.signal, onApprovalPending }),
            client.read('machines.provisioners.options', { ...actionInput, selectors }, { signal: abort.signal, onApprovalPending }),
        ]).then(([check, options]) => {
            if (abort.signal.aborted || !binding.isCurrent()) return;
            setState(current => {
                if (current.queryKey !== queryKey || !current.draft) return current;
                const draft = { ...current.draft, check: check.kind === 'succeeded' ? check.value : undefined };
                return { queryKey, error: check.kind === 'failed' ? check.code : options.kind === 'failed' ? options.code
                    : check.value.available ? null : 'provisioner_unavailable',
                    draft: options.kind === 'succeeded' ? refreshManagedConfiguratorOptions(draft, options.value)
                        : { ...draft, optionStatus: 'unavailable' } };
            });
        }).catch(() => {
            if (!abort.signal.aborted && binding.isCurrent()) setState(current => current.queryKey === queryKey && current.draft
                ? { ...current, error: 'unavailable', draft: { ...current.draft, optionStatus: 'unavailable' } } : current);
        });
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, client, homeId, preset, provisioner, queryKey, optionsInput.kind, optionsSchema, optionsInputError, onApprovalPending, refreshRevision]);
    const visibleDraft = binding?.isCurrent() && preset && provisioner && state.queryKey === queryKey ? state.draft : null;
    const facts = React.useMemo(() => visibleDraft && settings.settings
        ? managedConfiguratorFacts({ ...visibleDraft, categoryPreferences: settings.settings.machineRetentionDefaultsV1 }) : null,
        [visibleDraft, settings.settings]);
    return { facts, loading: visibleDraft?.optionStatus === 'loading',
        error: state.queryKey === queryKey ? state.error ?? settings.error : settings.error,
        creationEnabled: settings.settings?.managedMachineCreationEnabled === true,
        creationDisabled: settings.settings?.managedMachineCreationEnabled === false, refresh };
}

/** Exact-Home collection projection; it owns no recipe or resource persistence. */
export function useMachinePresets(serverIds: readonly string[], onApprovalPending?: (approval: ActionApprovalRegistration, serverId: string) => void) {
    const accountScopes = useServerCredentialAccountScopeStates(serverIds);
    const bindings = React.useMemo(() => new Map([...accountScopes].flatMap(([serverId, entry]) => entry.binding ? [[serverId, entry.binding] as const] : [])), [accountScopes]);
    const requestedIdsKey = JSON.stringify(serverIds);
    const [state, setState] = React.useState<Readonly<Record<string, ScopedQueryState<readonly ManagedMachinePresetV1[]>>>>({});
    const [refreshRevision, setRefreshRevision] = React.useState(0);
    const presetsProjectionRef = React.useRef<Readonly<Record<string, readonly ManagedMachinePresetV1[]>>>({});
    const approvalRef = React.useRef(onApprovalPending);
    approvalRef.current = onApprovalPending;
    const refresh = React.useCallback(() => setRefreshRevision(value => value + 1), []);
    React.useEffect(() => {
        const aborters: AbortController[] = [];
        const retirements: Readonly<{ dispose(): void }>[] = [];
        for (const [serverId, binding] of bindings) {
            const controller = new AbortController();
            aborters.push(controller);
            retirements.push(binding.onRetire(() => {
                controller.abort();
                setState(current => {
                    if (!(serverId in current)) return current;
                    const next = { ...current };
                    delete next[serverId];
                    return next;
                });
            }));
            const homeId = getServerProfileById(serverId)?.serverIdentityId;
            setState(current => ({ ...current, [serverId]: { accountId: binding.accountId,
                value: current[serverId]?.accountId === binding.accountId ? current[serverId]!.value : null,
                loading: Boolean(homeId), error: homeId ? null : 'server_identity_unavailable' } }));
            if (!homeId) continue;
            const client = createMachinePresetCollectionClient(binding.scope, homeId);
            void client.list({ signal: controller.signal, onApprovalPending: approval => {
                if (!binding.isCurrent() || controller.signal.aborted) return;
                setState(current => ({ ...current, [serverId]: { ...current[serverId]!, approval } }));
                approvalRef.current?.(approval, serverId);
            } }).then(result => {
                if (controller.signal.aborted || !binding.isCurrent()) return;
                setState(current => ({ ...current, [serverId]: { accountId: binding.accountId, loading: false,
                    value: result.kind === 'succeeded' ? reconcilePresets(current[serverId]?.value, result.value)
                        : isMachinePresetAccessLost(result.code) ? null : current[serverId]?.value ?? null,
                    error: result.kind === 'failed' ? result.code : null } }));
            }).catch(() => {
                if (controller.signal.aborted || !binding.isCurrent()) return;
                setState(current => ({ ...current, [serverId]: { accountId: binding.accountId,
                    value: current[serverId]?.value ?? null, loading: false, error: 'request_failed' } }));
            });
        }
        return () => { aborters.forEach(controller => controller.abort()); retirements.forEach(retirement => retirement.dispose()); };
    }, [bindings, refreshRevision]);
    React.useEffect(() => subscribeHomeAccountChange(event => {
        if ([...bindings.keys()].some(serverId => areServerProfileIdentifiersEquivalent(serverId, event.serverId))) refresh();
    }), [bindings, refresh]);
    return React.useMemo(() => {
        const presetsByServerId: Record<string, readonly ManagedMachinePresetV1[]> = {};
        const statesByServerId: Record<string, MachinePresetQueryState<readonly ManagedMachinePresetV1[]>> = {};
        for (const serverId of JSON.parse(requestedIdsKey) as string[]) {
            const scopeId = resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
            const scope = accountScopes.get(scopeId);
            const binding = scope?.binding;
            const entry = state[scopeId];
            if (!getServerProfileById(serverId)?.serverIdentityId) {
                statesByServerId[serverId] = { value: null, loading: false, error: 'server_identity_unavailable' };
            } else if (!binding?.isCurrent()) {
                const resolving = !scope || scope.resolution.kind === 'resolving' || scope.resolution.kind === 'bound';
                statesByServerId[serverId] = { value: null, loading: resolving, error: resolving ? null : scope!.resolution.kind };
            } else if (entry?.accountId === binding.accountId) {
                statesByServerId[serverId] = entry;
                if (entry.value) presetsByServerId[serverId] = entry.value;
            } else statesByServerId[serverId] = { value: null, loading: true, error: null };
        }
        const previous = presetsProjectionRef.current;
        const unchanged = Object.keys(previous).length === Object.keys(presetsByServerId).length
            && Object.entries(presetsByServerId).every(([serverId, presets]) => previous[serverId] === presets);
        if (!unchanged) presetsProjectionRef.current = presetsByServerId;
        return { presetsByServerId: presetsProjectionRef.current, statesByServerId, refresh };
    }, [state, accountScopes, requestedIdsKey, refresh]);
}

type PresetDetailMutation =
    | Readonly<{ actionId: 'machines.presets.archive' | 'machines.presets.restore'; input: MachinePresetActionInputV1<'machines.presets.archive'> }>
    | Readonly<{ actionId: 'machines.presets.update'; input: MachinePresetActionInputV1<'machines.presets.update'> }>;

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
    const { state, setState, queryKey, refresh } = useMachinePresetQuery({ serverId, homeId, presetId, binding, read, onApprovalPending });
    const resolving = resolution.kind === 'resolving' || resolution.kind === 'bound';
    const visibleState: MachinePresetQueryState<MachinePresetHistoryData> = !homeId
        ? { value: null, loading: false, error: 'server_identity_unavailable' }
        : !binding?.isCurrent()
            ? { value: null, loading: resolving, error: resolving ? null : resolution.kind }
            : state.queryKey === queryKey ? state : { value: null, loading: true, error: null };

    // Archive, restore and the page's in-place edits are one reviewed write of the visible revision.
    const mutate = React.useCallback(async (request: (preset: ManagedMachinePresetV1, homeId: string) => PresetDetailMutation): Promise<MachinePresetCollectionResult<PresetMutationResultV1>> => {
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
                publishHomeAccountChange(serverId);
            } else if (value.kind === 'refused' && isMachinePresetAccessLost(value.code)) {
                setState({ queryKey, value: null, loading: false, error: value.code });
            }
        };
        try {
            const result = await client.execute(actionId, input, {
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
    const update = React.useCallback((patch: ManagedMachinePresetUpdateInputV1['patch']) => mutate((preset, home): PresetDetailMutation => ({
        actionId: 'machines.presets.update', input: { homeId: home, id: preset.id, expectedRevision: preset.revision, patch } })), [mutate]);
    const history = React.useMemo(() => visibleState.value && homeId ? buildManagedPresetHistory({ serverId, homeId, presetId,
        machines: visibleState.value.machines }) : [], [visibleState.value?.machines, homeId, presetId, serverId]);
    return { state: visibleState, history, refresh, archiveOrRestore, update, accountId,
        mutationResult: mutationResult?.queryKey === queryKey ? mutationResult.value : null };
}
