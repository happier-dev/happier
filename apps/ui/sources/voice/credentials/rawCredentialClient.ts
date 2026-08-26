import {
    DaemonVoiceClientRawCredentialMaterializeRequestV1Schema,
    DaemonVoiceClientRawCredentialMaterializeResponseV1Schema,
    type ConnectedServiceCredentialRevisionV1,
    type DaemonPluginReactNativeBundleCacheIdentityV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { VoiceCredentialAccessPhase, VoiceRawCredentialAccess } from '@happier-dev/plugin-sdk/voice';

import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';

import { createSelectedVoiceMachineClient } from './selectedMachineClient';

type ClientVoiceCredentialPhase = Exclude<VoiceCredentialAccessPhase, 'speech'>;
type VoiceRawCredentialMaterializationRequest = Parameters<VoiceRawCredentialAccess['materialize']>[0];
type VoiceRawCredentialCancellationOptions = NonNullable<
    Parameters<VoiceRawCredentialAccess['materialize']>[1]
>;

type SelectedVoiceMachineClient = Readonly<{
    invoke(method: string, payload: unknown, signal?: AbortSignal | null): Promise<unknown>;
}>;

function unavailable(): PluginError {
    return new PluginError({
        code: 'plugin_voice_credential_access_unavailable',
        message: 'Raw credential access is unavailable',
    });
}

function invalidRequest(): PluginError {
    return new PluginError({
        code: 'plugin_voice_provider_result_invalid',
        message: 'Raw credential materialization request is invalid or undeclared',
    });
}

function materializationFailed(): PluginError {
    return new PluginError({
        code: 'plugin_voice_provider_operation_failed',
        message: 'Raw credential materialization failed',
    });
}

export function createVoiceClientRawCredentialAccess(input: Readonly<{
    identity: DaemonPluginReactNativeBundleCacheIdentityV1;
    phase: ClientVoiceCredentialPhase;
    /** Host-owned lifetime for the one settings/prepare/connection invocation. */
    signal: AbortSignal;
    /** Captured account credential/source authority for that exact invocation. */
    isInvocationCurrent(): boolean;
    isCurrent(): boolean;
    /** Exact daemon target captured with the credential-source lease. */
    machineId?: string | null;
    client?: SelectedVoiceMachineClient;
}>): VoiceRawCredentialAccess {
    const identity = Object.freeze({ ...input.identity });
    let expectedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null = null;
    const machineId = input.machineId;
    const client = input.client ?? (machineId === undefined
        ? createSelectedVoiceMachineClient()
        : createSelectedVoiceMachineClient({ resolveMachineId: () => machineId }));
    return Object.freeze({
        async materialize(
            rawRequest: VoiceRawCredentialMaterializationRequest,
            options: VoiceRawCredentialCancellationOptions = {},
        ) {
            const request = DaemonVoiceClientRawCredentialMaterializeRequestV1Schema.safeParse({
                cacheIdentity: identity,
                phase: input.phase,
                expectedCredentialRevision,
                request: rawRequest,
            });
            if (!request.success) throw invalidRequest();
            if (input.signal.aborted || !input.isCurrent() || !input.isInvocationCurrent()) {
                throw unavailable();
            }
            const mergedSignal = mergeAbortSignals([input.signal, options.signal]);
            const signal = mergedSignal.signal;
            throwIfAborted(signal);
            let rawResponse: unknown;
            try {
                rawResponse = await client.invoke(
                    RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_MATERIALIZE,
                    request.data,
                    signal,
                );
            } catch {
                mergedSignal.dispose();
                if (input.signal.aborted || !input.isCurrent() || !input.isInvocationCurrent()) {
                    throw unavailable();
                }
                throwIfAborted(options.signal);
                throw unavailable();
            }
            mergedSignal.dispose();
            if (input.signal.aborted || !input.isCurrent() || !input.isInvocationCurrent()) {
                throw unavailable();
            }
            throwIfAborted(options.signal);
            const response = DaemonVoiceClientRawCredentialMaterializeResponseV1Schema.safeParse(rawResponse);
            if (!response.success) throw materializationFailed();
            if (!response.data.ok) {
                if (response.data.errorCode === 'plugin_voice_provider_result_invalid') throw invalidRequest();
                if (response.data.errorCode === 'plugin_voice_provider_operation_failed') {
                    throw materializationFailed();
                }
                throw unavailable();
            }
            if (!Object.hasOwn(response.data, 'credentialRevision')) throw unavailable();
            const credentialRevision = response.data.credentialRevision ?? null;
            if (credentialRevision === null) throw unavailable();
            if (
                expectedCredentialRevision !== null
                && credentialRevision !== expectedCredentialRevision
            ) {
                throw unavailable();
            }
            expectedCredentialRevision = credentialRevision;
            return Object.freeze({
                kind: 'httpHeaders' as const,
                headers: Object.freeze({ ...response.data.materialization.headers }),
            });
        },
    });
}
