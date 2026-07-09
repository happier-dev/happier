import * as React from 'react';

import type {
    DaemonVoiceInferenceModelStatus,
    DaemonVoiceInferenceServiceState,
} from '@happier-dev/protocol';

import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import { readDaemonErrorCode } from '../readDaemonErrorCode';

type DaemonVoiceInferenceModelStateErrorCode =
    | 'feature_disabled'
    | 'machine_unreachable'
    | 'runtime_unavailable'
    | 'model_not_installed'
    | 'request_timeout'
    | 'invalid_audio_input'
    | 'unsupported_codec'
    | 'cancelled'
    | 'upload_size_unavailable'
    | 'upload_failed'
    | 'download_failed'
    | 'internal_error'
    | null;

export type DaemonVoiceInferenceModelState = Readonly<{
    serviceState: DaemonVoiceInferenceServiceState | null;
    model: DaemonVoiceInferenceModelStatus | null;
    errorCode: DaemonVoiceInferenceModelStateErrorCode;
    loading: boolean;
    actionInFlight: 'install' | 'remove' | null;
}>;

type DaemonVoiceInferenceModelClient = Pick<
    DaemonVoiceInferenceClient,
    'getStatus' | 'getModelsStatus' | 'installModel' | 'removeModel'
>;

function createIdleState(): DaemonVoiceInferenceModelState {
    return {
        serviceState: null,
        model: null,
        errorCode: null,
        loading: true,
        actionInFlight: null,
    };
}

/**
 * Daemon failure codes this panel renders an explicit state for. Anything
 * outside this set (or a missing code) collapses to `internal_error` so an
 * unrecognized failure can never leak through as a non-union string and read as
 * a healthy/"ready" status. Keep in sync with {@link DaemonVoiceInferenceModelStateErrorCode}.
 */
const KNOWN_ERROR_CODES: ReadonlySet<Exclude<DaemonVoiceInferenceModelStateErrorCode, null>> = new Set<
    Exclude<DaemonVoiceInferenceModelStateErrorCode, null>
>([
    'feature_disabled',
    'machine_unreachable',
    'runtime_unavailable',
    'model_not_installed',
    'request_timeout',
    'invalid_audio_input',
    'unsupported_codec',
    'cancelled',
    'upload_size_unavailable',
    'upload_failed',
    'download_failed',
    'internal_error',
]);

function readErrorCode(error: unknown): DaemonVoiceInferenceModelStateErrorCode {
    return readDaemonErrorCode(error, KNOWN_ERROR_CODES, 'internal_error');
}

export function useDaemonVoiceInferenceModelState(params: Readonly<{
    packId: string | null;
    pollIntervalMs?: number;
    client?: DaemonVoiceInferenceModelClient;
}>): Readonly<{
    state: DaemonVoiceInferenceModelState;
    refresh: () => Promise<void>;
    install: () => Promise<void>;
    remove: () => Promise<void>;
}> {
    const client = React.useMemo<DaemonVoiceInferenceModelClient>(
        () => params.client ?? new DaemonVoiceInferenceClient(),
        [params.client],
    );
    const [state, setState] = React.useState<DaemonVoiceInferenceModelState>(() => createIdleState());
    const packId = params.packId;

    const refresh = React.useCallback(async () => {
        setState((current) => ({
            ...current,
            loading: true,
        }));
        try {
            const [status, models] = await Promise.all([
                client.getStatus(),
                packId ? client.getModelsStatus([packId]) : Promise.resolve([]),
            ]);
            setState((current) => ({
                ...current,
                serviceState: status.serviceState,
                model: packId ? (models[0] ?? null) : null,
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
    }, [client, packId]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    React.useEffect(() => {
        const shouldPoll =
            state.actionInFlight === 'install'
            || state.model?.installState === 'installing';
        if (!shouldPoll) {
            return;
        }
        const interval = setInterval(() => {
            void refresh();
        }, params.pollIntervalMs ?? VOICE_RUNTIME_CONFIG_DEFAULTS.daemonInference.statusPollMs);
        return () => clearInterval(interval);
    }, [params.pollIntervalMs, refresh, state.actionInFlight, state.model?.installState]);

    const install = React.useCallback(async () => {
        if (!packId) {
            return;
        }
        setState((current) => ({
            ...current,
            actionInFlight: 'install',
            errorCode: null,
        }));
        try {
            await client.installModel({ packId });
        } catch (error) {
            setState((current) => ({
                ...current,
                errorCode: readErrorCode(error),
            }));
        } finally {
            setState((current) => ({
                ...current,
                actionInFlight: null,
            }));
            await refresh();
        }
    }, [client, packId, refresh]);

    const remove = React.useCallback(async () => {
        if (!packId) {
            return;
        }
        setState((current) => ({
            ...current,
            actionInFlight: 'remove',
            errorCode: null,
        }));
        try {
            await client.removeModel(packId);
        } catch (error) {
            setState((current) => ({
                ...current,
                errorCode: readErrorCode(error),
            }));
        } finally {
            setState((current) => ({
                ...current,
                actionInFlight: null,
            }));
            await refresh();
        }
    }, [client, packId, refresh]);

    return {
        state,
        refresh,
        install,
        remove,
    };
}
