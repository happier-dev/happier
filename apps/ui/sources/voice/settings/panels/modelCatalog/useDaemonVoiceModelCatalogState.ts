import * as React from 'react';

import type { DaemonVoiceInferenceModelStatus } from '@happier-dev/protocol';
import { listModelPackCatalogEntries } from '@happier-dev/protocol';

import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import { readDaemonErrorCode } from '../readDaemonErrorCode';

export type DaemonVoiceModelCatalogErrorCode =
    | 'feature_disabled'
    | 'machine_unreachable'
    | 'runtime_unavailable'
    | 'request_timeout'
    | 'internal_error'
    | null;

export type DaemonVoiceModelCatalogState = Readonly<{
    /** Per-pack daemon status snapshots, keyed-by-pack-id in the consumer. */
    statuses: readonly DaemonVoiceInferenceModelStatus[];
    errorCode: DaemonVoiceModelCatalogErrorCode;
    loading: boolean;
    /** Pack id of an in-flight install/remove action, or null when idle. */
    actionPackId: string | null;
}>;

type DaemonVoiceModelCatalogClient = Pick<
    DaemonVoiceInferenceClient,
    'getModelsStatus' | 'installModel' | 'removeModel'
>;

/** Catalog pack ids the daemon snapshot is requested for (all kinds). */
function allCatalogPackIds(): readonly string[] {
    return listModelPackCatalogEntries().map((entry) => entry.packId);
}

function createIdleState(): DaemonVoiceModelCatalogState {
    return {
        statuses: [],
        errorCode: null,
        loading: true,
        actionPackId: null,
    };
}

/**
 * Daemon status-RPC failure codes we render an explicit state for. Anything
 * outside this set (or a missing code) collapses to `internal_error` so an
 * unrecognized failure can never leak through as a non-union string and read as
 * a healthy/"ready" status. Keep in sync with {@link DaemonVoiceModelCatalogErrorCode}.
 */
const KNOWN_ERROR_CODES: ReadonlySet<Exclude<DaemonVoiceModelCatalogErrorCode, null>> = new Set<
    Exclude<DaemonVoiceModelCatalogErrorCode, null>
>(['feature_disabled', 'machine_unreachable', 'runtime_unavailable', 'request_timeout', 'internal_error']);

function readErrorCode(error: unknown): DaemonVoiceModelCatalogErrorCode {
    return readDaemonErrorCode(error, KNOWN_ERROR_CODES, 'internal_error');
}

/**
 * Fetch every catalog model pack's daemon install + readiness snapshot in one
 * RPC and expose per-pack install/remove actions. Unlike the single-pack
 * {@link useDaemonVoiceInferenceModelState}, this drives the whole catalog
 * grouped STT/TTS list. Polls while any pack is installing or an action is in
 * flight so download progress and warm/ready transitions stream into the UI.
 */
export function useDaemonVoiceModelCatalogState(params?: Readonly<{
    enabled?: boolean;
    pollIntervalMs?: number;
    client?: DaemonVoiceModelCatalogClient;
}>): Readonly<{
    state: DaemonVoiceModelCatalogState;
    refresh: () => Promise<void>;
    install: (packId: string) => Promise<void>;
    remove: (packId: string) => Promise<void>;
}> {
    const providedClient = params?.client;
    const enabled = params?.enabled !== false;
    const client = React.useMemo<DaemonVoiceModelCatalogClient>(
        () => providedClient ?? new DaemonVoiceInferenceClient(),
        [providedClient],
    );
    const [state, setState] = React.useState<DaemonVoiceModelCatalogState>(() => ({
        ...createIdleState(),
        loading: enabled,
    }));

    const refresh = React.useCallback(async () => {
        if (!enabled) {
            setState((current) => ({
                ...current,
                loading: false,
                actionPackId: null,
            }));
            return;
        }
        setState((current) => ({ ...current, loading: true }));
        try {
            const statuses = await client.getModelsStatus(allCatalogPackIds());
            setState((current) => ({
                ...current,
                statuses,
                errorCode: null,
                loading: false,
            }));
        } catch (error) {
            setState((current) => ({
                ...current,
                errorCode: readErrorCode(error),
                loading: false,
            }));
        }
    }, [client, enabled]);

    React.useEffect(() => {
        if (enabled) {
            void refresh();
            return;
        }
        setState((current) => ({
            ...current,
            loading: false,
            actionPackId: null,
        }));
    }, [enabled, refresh]);

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
        action: (id: string) => Promise<unknown>,
    ) => {
        if (!enabled) {
            return;
        }
        setState((current) => ({ ...current, actionPackId: packId, errorCode: null }));
        try {
            await action(packId);
        } catch (error) {
            setState((current) => ({ ...current, errorCode: readErrorCode(error) }));
        } finally {
            setState((current) => ({ ...current, actionPackId: null }));
            await refresh();
        }
    }, [enabled, refresh]);

    const install = React.useCallback(
        (packId: string) => runAction(packId, (id) => client.installModel({ packId: id })),
        [client, runAction],
    );

    const remove = React.useCallback(
        (packId: string) => runAction(packId, (id) => client.removeModel(id)),
        [client, runAction],
    );

    return { state, refresh, install, remove };
}
