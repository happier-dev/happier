import * as React from 'react';

import {
    listModelPackCatalogEntries,
    type DaemonVoiceInferenceModelStatus,
} from '@happier-dev/protocol';

import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import {
    DaemonVoiceInferenceClient,
    type DaemonVoiceInferenceModelMachineScope,
} from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import {
    readDaemonVoiceInferenceClientErrorCode,
    type DaemonVoiceInferenceClientErrorCode,
} from '@/voice/runtime/daemonInference/daemonVoiceInferenceErrors';

export type DaemonVoiceModelCatalogErrorCode = Extract<
    DaemonVoiceInferenceClientErrorCode,
    | 'feature_disabled'
    | 'machine_unreachable'
    | 'runtime_unavailable'
    | 'unsupported_runtime_family'
    | 'request_timeout'
    | 'internal_error'
> | null;

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
    'listModels' | 'getModelsStatus' | 'installModel' | 'acceptModelPackLicense' | 'removeModel'
>;

const CANONICAL_MODEL_PACK_IDS = listModelPackCatalogEntries().map((entry) => entry.packId);

function createIdleState(): DaemonVoiceModelCatalogState {
    return {
        statuses: [],
        errorCode: null,
        loading: true,
        actionPackId: null,
        actionError: null,
    };
}

/**
 * Daemon status-RPC failure codes we render an explicit state for. Anything
 * outside this set (or a missing code) collapses to `internal_error` so an
 * unrecognized failure can never leak through as a non-union string and read as
 * a healthy/"ready" status. Keep in sync with {@link DaemonVoiceModelCatalogErrorCode}.
 */
function readErrorCode(error: unknown): DaemonVoiceModelCatalogErrorCode {
    const code = readDaemonVoiceInferenceClientErrorCode(error);
    switch (code) {
        case 'feature_disabled':
        case 'machine_unreachable':
        case 'runtime_unavailable':
        case 'unsupported_runtime_family':
        case 'request_timeout':
        case 'internal_error':
            return code;
        default:
            return 'internal_error';
    }
}

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
    acceptLicense: (review: NonNullable<DaemonVoiceInferenceModelStatus['licenseReview']>) => Promise<void>;
    remove: (packId: string) => Promise<void>;
}> {
    const providedClient = params?.client;
    const enabled = params?.enabled !== false;
    const client = React.useMemo<DaemonVoiceModelCatalogClient>(
        () => providedClient ?? new DaemonVoiceInferenceClient(),
        [providedClient],
    );
    const machineScope = React.useMemo<DaemonVoiceInferenceModelMachineScope | undefined>(() => {
        const machineId = typeof params?.refreshKey === 'string' ? params.refreshKey.trim() : '';
        return machineId.length > 0 ? { machineId } : undefined;
    }, [params?.refreshKey]);
    const [state, setState] = React.useState<DaemonVoiceModelCatalogState>(() => ({
        ...createIdleState(),
        loading: enabled,
    }));
    const refreshSequenceRef = React.useRef(0);
    const nextActionTokenRef = React.useRef(0);
    const activeActionTokenRef = React.useRef<number | null>(null);
    const actionScopeGenerationRef = React.useRef(0);
    const enabledRef = React.useRef(enabled);

    const refresh = React.useCallback(async () => {
        const sequence = ++refreshSequenceRef.current;
        if (!enabledRef.current) {
            setState((current) => ({
                ...current,
                loading: false,
                actionPackId: null,
                actionError: null,
            }));
            return;
        }
        setState((current) => ({ ...current, loading: true }));
        try {
            const [discoveredStatuses, canonicalStatuses] = machineScope
                ? await Promise.all([
                    client.listModels(machineScope),
                    client.getModelsStatus(CANONICAL_MODEL_PACK_IDS, machineScope),
                ])
                : await Promise.all([
                    client.listModels(),
                    client.getModelsStatus(CANONICAL_MODEL_PACK_IDS),
                ]);
            const statusByPackId = new Map(
                discoveredStatuses.map((status) => [status.packId, status]),
            );
            for (const status of canonicalStatuses) {
                statusByPackId.set(status.packId, status);
            }
            const statuses = [...statusByPackId.values()];
            if (refreshSequenceRef.current !== sequence) return;
            setState((current) => {
                const failedStatus = current.actionError
                    ? statuses.find((status) => status.packId === current.actionError?.packId)
                    : null;
                const actionNowSucceeded = current.actionError?.operation === 'install'
                    ? failedStatus?.installState === 'installed'
                    : current.actionError?.operation === 'remove'
                        ? failedStatus?.installState === 'not_installed'
                        : false;
                return {
                    ...current,
                    statuses,
                    actionError: actionNowSucceeded ? null : current.actionError,
                    errorCode: null,
                    loading: false,
                };
            });
        } catch (error) {
            if (refreshSequenceRef.current !== sequence) return;
            setState((current) => ({
                ...current,
                errorCode: readErrorCode(error),
                loading: false,
            }));
        }
    }, [client, enabled, machineScope]);

    React.useEffect(() => {
        // Refs used by async owners represent committed lifecycle state. Never
        // write them during render: a Suspense/concurrent render may be
        // abandoned while sharing the current tree's ref objects.
        enabledRef.current = enabled;
        if (enabled) {
            // A status snapshot belongs to exactly one execution-machine
            // scope. Clear the previous scope before requesting the next one
            // so machine A's installed/actionable rows cannot be rendered or
            // mutated while machine B is still resolving.
            setState(() => ({
                ...createIdleState(),
                loading: true,
                actionPackId: null,
                actionError: null,
            }));
            void refresh();
            return () => {
                enabledRef.current = false;
                refreshSequenceRef.current += 1;
                // The action promise can outlive this hook owner. Invalidate
                // it at the same lifecycle boundary as status refreshes so a
                // late mutation cannot update state or start a new daemon RPC
                // after unmount (or after this client/scope is replaced).
                actionScopeGenerationRef.current += 1;
                activeActionTokenRef.current = null;
            };
        }
        setState((current) => ({
            ...current,
            loading: false,
            actionPackId: null,
            actionError: null,
        }));
        actionScopeGenerationRef.current += 1;
        activeActionTokenRef.current = null;
        return () => {
            enabledRef.current = false;
            refreshSequenceRef.current += 1;
        };
    }, [enabled, params?.refreshKey, refresh]);

    const anyInstalling = state.statuses.some((status) => status.installState === 'installing');

    React.useEffect(() => {
        const shouldPoll = enabled && (state.actionPackId !== null || anyInstalling);
        if (!shouldPoll) {
            return;
        }
        const interval = setInterval(() => {
            void refresh();
        }, params?.pollIntervalMs ?? VOICE_RUNTIME_CONFIG_DEFAULTS.daemonInference.statusPollMs);
        return () => clearInterval(interval);
    }, [anyInstalling, enabled, params?.pollIntervalMs, refresh, state.actionPackId]);

    const runAction = React.useCallback(async (
        packId: string,
        operation: 'install' | 'remove',
        action: (id: string) => Promise<unknown>,
    ) => {
        if (!enabledRef.current) {
            return;
        }
        if (activeActionTokenRef.current !== null) return;
        const actionToken = ++nextActionTokenRef.current;
        const actionScopeGeneration = actionScopeGenerationRef.current;
        activeActionTokenRef.current = actionToken;
        const actionStillOwnsState = () => (
            enabledRef.current
            && activeActionTokenRef.current === actionToken
            && actionScopeGenerationRef.current === actionScopeGeneration
        );
        setState((current) => ({
            ...current,
            actionPackId: packId,
            actionError: null,
            errorCode: null,
        }));
        try {
            await action(packId);
        } catch (error) {
            if (!actionStillOwnsState()) return;
            const errorCode = readErrorCode(error) ?? 'internal_error';
            setState((current) => ({
                ...current,
                actionError: { packId, operation, errorCode },
            }));
        } finally {
            if (!actionStillOwnsState()) return;
            setState((current) => ({ ...current, actionPackId: null }));
            activeActionTokenRef.current = null;
            // Mutation completion and status reconciliation are different
            // lifecycle phases. Do not keep the row visually/action-locked
            // while route discovery or a remote status request is slow; the
            // refresh owns its own error handling and stale-response guard.
            void refresh();
        }
    }, [enabled, refresh]);

    const install = React.useCallback(
        (packId: string) => runAction(packId, 'install', (id) => (
            machineScope
                ? client.installModel({ packId: id }, machineScope)
                : client.installModel({ packId: id })
        )),
        [client, machineScope, runAction],
    );

    const acceptLicense = React.useCallback(async (
        review: NonNullable<DaemonVoiceInferenceModelStatus['licenseReview']>,
    ) => {
        const input = {
            qualifiedPackId: `${review.pluginId}/${review.packId}`,
            pluginId: review.pluginId,
            packId: review.packId,
            pluginVersion: review.pluginVersion,
            packVersion: review.packVersion,
            licenseId: review.licenseId,
            licenseSourceUrl: review.licenseSourceUrl,
            licenseTextDigest: review.licenseTextDigest,
            artifactDigest: review.artifactDigest,
        };
        if (machineScope) await client.acceptModelPackLicense(input, machineScope);
        else await client.acceptModelPackLicense(input);
        await refresh();
    }, [client, machineScope, refresh]);

    const remove = React.useCallback(
        (packId: string) => runAction(packId, 'remove', (id) => (
            machineScope ? client.removeModel(id, machineScope) : client.removeModel(id)
        )),
        [client, machineScope, runAction],
    );

    return { state, refresh, install, acceptLicense, remove };
}
