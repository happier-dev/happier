import * as React from 'react';
import type { ManagedMachinePresetUpdateInputV1, ManagedMachinePresetV1, PresetMutationResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { MachinePresetActionInputV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

import { getServerProfileById, areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeStates, useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
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
type ScopedQueryState<T> = MachinePresetQueryState<T> & Readonly<{ homeId: string | null; accountId: string }>;
type PresetCollectionRead = {
    binding: ServerCredentialAccountScopeBinding;
    homeId: string;
    controller: AbortController;
    retirement: { dispose(): void };
    awaitingApproval: boolean;
};

export function isMachinePresetAccessLost(code: string): boolean {
    return code === 'permission_denied' || code === 'preset_not_found' || code === 'action_account_scope_changed';
}

/** One scoped read lifetime for preset detail and editing, including approvals and Home invalidation. */
export function useMachinePresetQuery<T>(input: Readonly<{
    serverId: string; homeId: string | null; presetId?: string; binding: ServerCredentialAccountScopeBinding | null;
    resolution: ServerCredentialAccountScopeResolution;
    read: ((options: MachinePresetCollectionOptions<T>) => Promise<MachinePresetCollectionSettledResult<T>>) | null;
    refreshRevision?: number;
    onApprovalPending?: (approval: ActionApprovalRegistration) => void;
    onAccessLost?: (code: string) => void;
    onInvalidated?: () => void;
}>) {
    const { serverId, homeId, presetId, binding, resolution, read, refreshRevision } = input;
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
        setState({ queryKey, value: null, loading: false, error: code });
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
        if (!binding?.isCurrent() || !read || !presetId) return;
        const controller = new AbortController();
        pendingRead.current = controller;
        const retirement = binding.onRetire(() => controller.abort());
        setState(current => ({ queryKey, value: current.queryKey === queryKey ? current.value : null, loading: true, error: null }));
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
            setState(current => ({ queryKey, loading: false, error: result.kind === 'failed' ? result.code : null,
                value: result.kind === 'succeeded' ? result.value : current.queryKey === queryKey ? current.value : null }));
        }).catch(() => {
            if (!controller.signal.aborted && binding.isCurrent()) setState(current => ({ ...current, loading: false, error: 'request_failed' }));
        }).finally(() => {
            if (approvalRead.current?.controller === controller) approvalRead.current = null;
        });
        return () => { controller.abort(); retirement.dispose(); if (approvalRead.current?.controller === controller) approvalRead.current = null; };
    }, [binding, read, presetId, queryKey, withdraw, revision, refreshRevision]);
    React.useEffect(() => subscribeHomeAccountChange(event => {
        if (event.machineResourcesAffect === false) return;
        if (!presetId || !areServerProfileIdentifiersEquivalent(serverId, event.serverId)) return;
        // This read has not executed yet: its post-decision result satisfies preceding wakes.
        if (approvalRead.current?.controller === pendingRead.current && approvalRead.current && !approvalRead.current.controller.signal.aborted) return;
        pendingRead.current?.abort();
        callbacks.current.onInvalidated?.();
        refresh();
    }), [serverId, presetId]);
    const sameScope = resolution.kind === 'bound' && state.queryKey === queryKey;
    return { sameScope, state: sameScope
        ? binding?.isCurrent() ? state : { ...state, loading: !!presetId }
        : { queryKey, value: null, loading: !!presetId && (resolution.kind === 'bound' || resolution.kind === 'resolving'),
            error: resolution.kind === 'bound' || resolution.kind === 'resolving' ? null : resolution.kind }, setState, queryKey, refresh, withdraw };
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
    resolution: ServerCredentialAccountScopeResolution;
    client: ReturnType<typeof createManagedProvisionerClient> | null;
    homeId: string | null;
    preset?: ManagedMachinePresetV1;
    provisioner?: MachineProvisionersListResultV1['provisioners'][number];
    optionsInput: ManagedProvisionerOptionsInput;
    onApprovalPending: (approval: ActionApprovalRegistration) => void;
}>) {
    const { binding, resolution, client, homeId, preset, provisioner, optionsInput, onApprovalPending } = input;
    const optionsSchema = optionsInput.kind === 'ready' ? optionsInput.schema : null;
    const optionsInputError = optionsInput.kind === 'unavailable' ? optionsInput.error : null;
    const settings = useManagedMachineAccountSettings(binding, resolution);
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
    const reads = React.useRef(new Map<string, PresetCollectionRead>());
    const refreshTargets = React.useRef(new Set<string>());
    const refreshAll = React.useCallback(() => {
        for (const serverId of bindings.keys()) refreshTargets.current.add(serverId);
        refresh();
    }, [bindings, refresh]);
    React.useEffect(() => () => {
        for (const read of reads.current.values()) { read.controller.abort(); read.retirement.dispose(); }
        reads.current.clear();
    }, []);
    React.useEffect(() => {
        setState(current => {
            const retained = Object.entries(current).filter(([serverId, entry]) => {
                const resolution = accountScopes.get(serverId)?.resolution;
                return resolution?.kind === 'bound' && resolution.scope.accountId === entry.accountId
                    && getServerProfileById(serverId)?.serverIdentityId === entry.homeId;
            });
            return retained.length === Object.keys(current).length ? current : Object.fromEntries(retained);
        });
        for (const [serverId, read] of reads.current) {
            const binding = bindings.get(serverId);
            if (binding?.accountId === read.binding.accountId && binding.revision === read.binding.revision
                && binding.isCurrent() && read.binding.isCurrent()
                && getServerProfileById(serverId)?.serverIdentityId === read.homeId && !refreshTargets.current.has(serverId)) continue;
            read.controller.abort(); read.retirement.dispose(); reads.current.delete(serverId);
        }
        for (const [serverId, binding] of bindings) {
            if (reads.current.has(serverId)) continue;
            const homeId = getServerProfileById(serverId)?.serverIdentityId;
            if (!homeId) {
                setState(current => ({ ...current, [serverId]: { homeId: null, accountId: binding.accountId,
                    value: null, loading: false, error: 'server_identity_unavailable' } }));
                continue;
            }
            const controller = new AbortController();
            const retirement = binding.onRetire(() => controller.abort());
            const pendingRead: PresetCollectionRead = { binding, homeId, controller, retirement, awaitingApproval: false };
            reads.current.set(serverId, pendingRead);
            setState(current => ({ ...current, [serverId]: { homeId, accountId: binding.accountId,
                value: current[serverId]?.homeId === homeId && current[serverId]?.accountId === binding.accountId ? current[serverId]!.value : null,
                loading: Boolean(homeId), error: homeId ? null : 'server_identity_unavailable' } }));
            const client = createMachinePresetCollectionClient(binding.scope, homeId);
            void client.list({ signal: controller.signal, onApprovalPending: approval => {
                if (!binding.isCurrent() || controller.signal.aborted) return;
                pendingRead.awaitingApproval = true;
                setState(current => ({ ...current, [serverId]: { ...current[serverId]!, approval } }));
                approvalRef.current?.(approval, serverId);
            }, onApprovalSettled: () => {
                pendingRead.awaitingApproval = false;
            } }).then(result => {
                if (controller.signal.aborted || !binding.isCurrent()) return;
                setState(current => ({ ...current, [serverId]: { homeId, accountId: binding.accountId, loading: false,
                    value: result.kind === 'succeeded' ? reconcilePresets(current[serverId]?.value, result.value)
                        : isMachinePresetAccessLost(result.code) ? null : current[serverId]?.value ?? null,
                    error: result.kind === 'failed' ? result.code : null } }));
            }).catch(() => {
                if (controller.signal.aborted || !binding.isCurrent()) return;
                setState(current => ({ ...current, [serverId]: { homeId, accountId: binding.accountId,
                    value: current[serverId]?.value ?? null, loading: false, error: 'request_failed' } }));
            }).finally(() => {
                pendingRead.awaitingApproval = false;
                retirement.dispose();
            });
        }
        refreshTargets.current.clear();
    }, [accountScopes, bindings, refreshRevision]);
    React.useEffect(() => subscribeHomeAccountChange(event => {
        if (event.machineResourcesAffect === false) return;
        const serverId = [...bindings.keys()].find(id => areServerProfileIdentifiersEquivalent(id, event.serverId));
        if (!serverId || reads.current.get(serverId)?.awaitingApproval) return;
        refreshTargets.current.add(serverId);
        refresh();
    }), [bindings, refresh]);
    return React.useMemo(() => {
        const presetsByServerId: Record<string, readonly ManagedMachinePresetV1[]> = {};
        const statesByServerId: Record<string, MachinePresetQueryState<readonly ManagedMachinePresetV1[]>> = {};
        for (const serverId of JSON.parse(requestedIdsKey) as string[]) {
            const scopeId = resolveServerProfileScopeIdForIdentifier(serverId) || serverId;
            const scope = accountScopes.get(scopeId);
            const binding = scope?.binding;
            const entry = state[scopeId];
            const sameScope = scope?.resolution.kind === 'bound' && entry?.accountId === scope.resolution.scope.accountId
                && entry.homeId === getServerProfileById(serverId)?.serverIdentityId;
            if (!getServerProfileById(serverId)?.serverIdentityId) {
                statesByServerId[serverId] = { value: null, loading: false, error: 'server_identity_unavailable' };
            } else if (!binding?.isCurrent()) {
                const resolving = !scope || scope.resolution.kind === 'resolving' || scope.resolution.kind === 'bound';
                statesByServerId[serverId] = { value: sameScope ? entry.value : null, loading: resolving, error: resolving ? null : scope!.resolution.kind };
                if (sameScope && entry.value) presetsByServerId[serverId] = entry.value;
            } else if (sameScope) {
                statesByServerId[serverId] = entry;
                if (entry.value) presetsByServerId[serverId] = entry.value;
            } else statesByServerId[serverId] = { value: null, loading: true, error: null };
        }
        const previous = presetsProjectionRef.current;
        const unchanged = Object.keys(previous).length === Object.keys(presetsByServerId).length
            && Object.entries(presetsByServerId).every(([serverId, presets]) => previous[serverId] === presets);
        if (!unchanged) presetsProjectionRef.current = presetsByServerId;
        return { presetsByServerId: presetsProjectionRef.current, statesByServerId, refresh: refreshAll };
    }, [state, accountScopes, requestedIdsKey, refreshAll]);
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
    const { state, setState, queryKey, refresh } = useMachinePresetQuery({ serverId, homeId, presetId, binding, resolution, read, onApprovalPending });
    const visibleState: MachinePresetQueryState<MachinePresetHistoryData> = !homeId
        ? { value: null, loading: false, error: 'server_identity_unavailable' }
        : state;

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
