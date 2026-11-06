import * as React from 'react';

import type { DaemonVoiceInferenceModelStatus } from '@happier-dev/protocol/daemon/voiceInference';

import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { VOICE_ADVANCED_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import {
    captureActiveServerAccountScopeCurrentness,
    captureActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useVoiceExecutionMachineId } from '@/voice/credentials/useExecutionMachinePresentation';
import {
    getMachineContributionRegistryProjectionRevision,
    subscribeMachineContributionRegistryProjectionInvalidation,
} from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { createVoiceModelCancellationCommand } from '@/voice/settings/voiceModelCancellation';
import { useCurrentUiContextMountedCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { resolveVoiceExecutionMachineId } from '@/voice/settings/executionMachine';
import { t } from '@/text';
import {
    DaemonVoiceInferenceClient,
    type DaemonVoiceInferenceModelMachineScope,
} from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import {
    createDaemonVoiceModelCatalogObservation,
    getDaemonVoiceModelCatalogObservation,
    readDaemonVoiceModelCatalogErrorCode as readErrorCode,
    type DaemonVoiceModelCatalogErrorCode,
} from './daemonVoiceModelCatalogObservation';
export type { DaemonVoiceModelCatalogErrorCode } from './daemonVoiceModelCatalogObservation';

export type DaemonVoiceModelCatalogState = Readonly<{
    /** Per-pack daemon status snapshots, keyed-by-pack-id in the consumer. */
    statuses: readonly DaemonVoiceInferenceModelStatus[];
    errorCode: DaemonVoiceModelCatalogErrorCode;
    loading: boolean;
    /** Pack id of an in-flight install/remove action, or null when idle. */
    actionPackId: string | null;
    /** Last failed mutation, scoped to its pack so healthy rows stay usable. */
    actionError: Readonly<{
        packId: string;
        operation: 'install' | 'remove';
        errorCode: Exclude<DaemonVoiceModelCatalogErrorCode, null>;
    }> | null;
}>;

type DaemonVoiceModelCatalogClient = Pick<
    DaemonVoiceInferenceClient,
    'listModels' | 'getModelsStatus'
>;

type CatalogActionState = Pick<DaemonVoiceModelCatalogState, 'actionPackId' | 'actionError'>;

/**
 * Merge the effective selected-host discovery list with explicit status for
 * every canonical catalog pack, then expose per-pack install/remove actions.
 * This drives the whole grouped STT/TTS list and preserves external discovered
 * packs without hiding never-installed built-ins. Polls while any pack is
 * installing or an action is in flight so progress and warm/ready transitions
 * stream into the UI.
 */
export function useDaemonVoiceModelCatalogState(params?: Readonly<{
    enabled?: boolean;
    pollIntervalMs?: number;
    client?: DaemonVoiceModelCatalogClient;
    /** Re-fetch when the canonical execution-machine identity changes. */
    refreshKey?: unknown;
}>): Readonly<{
    state: DaemonVoiceModelCatalogState;
    refresh: () => Promise<void>;
    install: (packId: string) => Promise<void>;
    remove: (packId: string) => Promise<void>;
    cancel: () => void;
}> {
    const providedClient = params?.client;
    const enabled = params?.enabled !== false;
    const client = React.useMemo<DaemonVoiceModelCatalogClient>(
        () => providedClient ?? new DaemonVoiceInferenceClient(),
        [providedClient],
    );
    const settingsScope = useAccountSettingsScope();
    const actions = useMountedActionExecution(settingsScope);
    const capturedAccount = captureActiveServerAccountScopeLifetime();
    const account = capturedAccount && areServerAccountScopesEqual(settingsScope, capturedAccount.scope)
        ? capturedAccount : null;
    const selectedMachineId = useVoiceExecutionMachineId();
    const machineId = (typeof params?.refreshKey === 'string' ? params.refreshKey.trim() : '') || selectedMachineId;
    const serverId = account?.scope.serverId ?? settingsScope?.serverId ?? null;
    const subscribeRevision = React.useCallback((listener: () => void) => machineId
        ? subscribeMachineContributionRegistryProjectionInvalidation({ machineId, serverId }, listener)
        : () => {}, [machineId, serverId]);
    const readRevision = React.useCallback(() => machineId
        ? getMachineContributionRegistryProjectionRevision({ machineId, serverId }) : 0, [machineId, serverId]);
    const revision = React.useSyncExternalStore(subscribeRevision, readRevision, readRevision);
    const observation = React.useMemo(() => account && machineId && !providedClient
        ? getDaemonVoiceModelCatalogObservation(account, machineId, revision)
        : createDaemonVoiceModelCatalogObservation({ account, machineId, revision }),
    [account, machineId, revision, providedClient]);
    const observed = React.useSyncExternalStore(observation.subscribe, observation.getSnapshot, observation.getSnapshot);
    const machineScope = React.useMemo<DaemonVoiceInferenceModelMachineScope | undefined>(() => {
        return machineId ? { machineId } : undefined;
    }, [machineId]);
    const [actionState, setActionState] = React.useState<CatalogActionState>({ actionPackId: null, actionError: null });
    const state = React.useMemo<DaemonVoiceModelCatalogState>(() => ({
        statuses: observed.statuses, errorCode: observed.errorCode, loading: observed.loading, ...actionState,
    }), [observed, actionState]);
    const refreshSequenceRef = React.useRef(0);
    const nextActionTokenRef = React.useRef(0);
    const activeActionTokenRef = React.useRef<number | null>(null);
    const activeActionAbortControllerRef = React.useRef<AbortController | null>(null);
    const actionScopeGenerationRef = React.useRef(0);
    const enabledRef = React.useRef(enabled);
    const readLifetimeRef = React.useRef<AbortController | null>(null);
    const [cancellationCommand, setCancellationCommand] = React.useState<ReturnType<typeof createVoiceModelCancellationCommand>>(null);
    useCurrentUiContextMountedCommand(cancellationCommand, t('common.cancel'));

    const refreshCatalog = React.useCallback(async (requireNewObservation = false) => {
        const sequence = ++refreshSequenceRef.current;
        if (!enabledRef.current) {
            setActionState({ actionPackId: null, actionError: null });
            return;
        }
        try {
            const signal = readLifetimeRef.current?.signal;
            if (!signal || signal.aborted) return;
            const statuses = await observation.read({ client, requireNewObservation, signal });
            if (!statuses) return;
            if (refreshSequenceRef.current !== sequence) return;
            setActionState((current) => {
                const failedStatus = current.actionError
                    ? statuses.find((status) => status.packId === current.actionError?.packId)
                    : null;
                const actionNowSucceeded = current.actionError?.operation === 'install'
                    ? failedStatus?.installState === 'installed'
                    : current.actionError?.operation === 'remove'
                        ? failedStatus?.installState === 'not_installed'
                        : false;
                return actionNowSucceeded ? { ...current, actionError: null } : current;
            });
        } catch {
            // The shared observation retains the typed read failure.
        }
    }, [client, enabled, observation]);
    const refresh = React.useCallback(() => refreshCatalog(true), [refreshCatalog]);

    React.useEffect(() => account?.onRetire(observation.invalidate).dispose, [account, observation]);

    React.useEffect(() => {
        const controller = new AbortController();
        readLifetimeRef.current = controller;
        return () => {
            if (readLifetimeRef.current === controller) readLifetimeRef.current = null;
            controller.abort();
        };
    }, [observation, enabled]);

    React.useEffect(() => {
        if (enabled && observed.stale && !observed.loading && observed.errorCode === null) void refreshCatalog();
    }, [enabled, observed.stale, observed.loading, observed.errorCode, refreshCatalog]);

    React.useEffect(() => {
        // Refs used by async owners represent committed lifecycle state. Never
        // write them during render: a Suspense/concurrent render may be
        // abandoned while sharing the current tree's ref objects.
        enabledRef.current = enabled;
        setCancellationCommand(null);
        if (enabled) {
            // Observation identity already isolates Account/Machine/revision.
            // Mutation custody stays local to the committed controller.
            setActionState({ actionPackId: null, actionError: null });
            void refreshCatalog();
            return () => {
                enabledRef.current = false;
                refreshSequenceRef.current += 1;
                // The action promise can outlive this hook owner. Invalidate
                // it at the same lifecycle boundary as status refreshes so a
                // late mutation cannot update state or start a new daemon RPC
                // after unmount (or after this client/scope is replaced).
                actionScopeGenerationRef.current += 1;
                activeActionTokenRef.current = null;
                activeActionAbortControllerRef.current?.abort();
                activeActionAbortControllerRef.current = null;
            };
        }
        setActionState({ actionPackId: null, actionError: null });
        actionScopeGenerationRef.current += 1;
        activeActionTokenRef.current = null;
        activeActionAbortControllerRef.current?.abort();
        activeActionAbortControllerRef.current = null;
        return () => {
            enabledRef.current = false;
            refreshSequenceRef.current += 1;
        };
    }, [enabled, params?.refreshKey, refreshCatalog]);

    const anyInstalling = state.statuses.some((status) => status.installState === 'installing');

    React.useEffect(() => {
        const shouldPoll = enabled && (state.actionPackId !== null || anyInstalling);
        if (!shouldPoll) {
            return;
        }
        const pollIntervalMs = params?.pollIntervalMs
            ?? VOICE_RUNTIME_CONFIG_DEFAULTS.daemonInference.statusPollMs;
        let cancelled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const poll = async () => {
            await refreshCatalog();
            if (cancelled) return;
            timeout = setTimeout(() => {
                void poll();
            }, pollIntervalMs);
        };
        timeout = setTimeout(() => {
            void poll();
        }, pollIntervalMs);
        return () => {
            cancelled = true;
            if (timeout !== null) clearTimeout(timeout);
        };
    }, [anyInstalling, enabled, params?.pollIntervalMs, refreshCatalog, state.actionPackId]);

    const runAction = React.useCallback(async (
        packId: string,
        operation: 'install' | 'remove',
        action: (id: string, isCurrent: () => boolean, signal: AbortSignal) => Promise<unknown>,
    ) => {
        if (!enabledRef.current) {
            return;
        }
        if (activeActionTokenRef.current !== null) return;
        const actionToken = ++nextActionTokenRef.current;
        const actionScopeGeneration = actionScopeGenerationRef.current;
        const actionAbortController = new AbortController();
        const account = captureActiveServerAccountScopeCurrentness();
        const retirement = account.onRetire(() => actionAbortController.abort());
        activeActionTokenRef.current = actionToken;
        activeActionAbortControllerRef.current = actionAbortController;
        const actionStillOwnsState = () => (
            enabledRef.current
            && activeActionTokenRef.current === actionToken
            && actionScopeGenerationRef.current === actionScopeGeneration
        );
        const command = createVoiceModelCancellationCommand({ packId, execution: 'daemon',
            machineId: machineScope?.machineId ?? resolveVoiceExecutionMachineId(),
            account: 'scope' in account ? account : null,
            isCurrent: () => actionStillOwnsState() && !actionAbortController.signal.aborted,
            cancel: () => actionAbortController.abort() });
        setCancellationCommand(command);
        observation.publish({ ...observation.getSnapshot(), errorCode: null });
        setActionState((current) => ({
            ...current,
            actionPackId: packId,
            actionError: null,
        }));
        let refreshAfterAction = true;
        try {
            refreshAfterAction = await action(packId, () => actionStillOwnsState() && account.isCurrent(), actionAbortController.signal) !== false;
        } catch (error) {
            if (!actionStillOwnsState()) return;
            if (actionAbortController.signal.aborted) return;
            const errorCode = readErrorCode(error) ?? 'internal_error';
            setActionState((current) => ({
                ...current,
                actionError: { packId, operation, errorCode },
            }));
        } finally {
            retirement.dispose();
            if (!actionStillOwnsState()) return;
            setCancellationCommand(current => current === command ? null : current);
            setActionState((current) => ({ ...current, actionPackId: null }));
            activeActionTokenRef.current = null;
            if (activeActionAbortControllerRef.current === actionAbortController) {
                activeActionAbortControllerRef.current = null;
            }
            // Mutation completion and status reconciliation are different
            // lifecycle phases. Do not keep the row visually/action-locked
            // while route discovery or a remote status request is slow; the
            // refresh owns its own error handling and stale-response guard.
            if (refreshAfterAction && account.isCurrent()) void refreshCatalog();
        }
    }, [enabled, machineScope, refreshCatalog, observation]);

    const mutate = React.useCallback((packId: string, operation: 'install' | 'remove') =>
        runAction(packId, operation, async (id, isCurrent, signal) => {
            if (!isCurrent()) return false;
            const failure: { error?: unknown } = {};
            const result = await actions.execute('settings.invoke', {
                anchor: VOICE_ADVANCED_SETTINGS.settings[operation === 'install' ? 'installSpeechModel' : 'removeSpeechModel'].anchor,
                input: { kind: 'model_pack', packId: id, ...(machineScope ? { machineId: machineScope.machineId } : {}) },
            }, { signal, executorOptions: { voiceModelPackPresentation: {
                isCurrent, onError: error => { failure.error = error; },
            } } });
            if ('error' in failure) throw failure.error;
            return result.ok;
        }), [actions.execute, machineScope, runAction]);
    const install = React.useCallback((packId: string) => mutate(packId, 'install'), [mutate]);
    const remove = React.useCallback((packId: string) => mutate(packId, 'remove'), [mutate]);

    const cancel = React.useCallback(() => {
        activeActionAbortControllerRef.current?.abort();
    }, []);

    return { state, refresh, install, remove, cancel };
}
