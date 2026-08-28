import {
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
    openAutomationSessionStartRequestEnvelopeV1,
    sameAutomationAccountCurrentnessWitnessV1,
    SessionServerStartDispatchRequestV1Schema,
    SessionServerStartDispatchResultV1Schema,
    type AutomationRunCause,
    type AccountEncryptionCurrentnessResponse,
    type AccountScopedCryptoMaterialSnapshotV1,
    type SessionServerStartDispatchResultV1,
    type SessionSpawnNewInputV2,
} from '@happier-dev/protocol';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
    isAvailableE2eeAutomationAccountEncryptionV1,
    resolveValidatedAutomationAccountEncryptionV1,
    type AvailableAutomationAccountEncryptionV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';

type ExecuteSessionStart = (
    input: SessionSpawnNewInputV2,
    options: Readonly<{
        signal: AbortSignal;
        actionCaller: Readonly<{
            kind: 'automationRun';
            automationId: string;
            runId: string;
            cause: AutomationRunCause;
        }>;
    }>,
) => Promise<SessionServerStartDispatchResultV1>;

export type SessionServerStartRpcRegistrationOptions = Readonly<{
    /** Exact authenticated machine bound to this daemon instance. */
    machineId: string;
    resolveAccountId: (signal?: AbortSignal) => Promise<string | null>;
    /** Persisted installation identity; absence is not an acceptable target. */
    resolveInstallationId: () => string | null | Promise<string | null>;
    /** Canonical server currentness endpoint, never a cached local mode. */
    resolveAccountEncryptionCurrentness: (
        signal?: AbortSignal,
    ) => Promise<AccountEncryptionCurrentnessResponse>;
    /** Fresh local Account material, admitted only by canonical currentness. */
    resolveAccountEncryptionMaterial: (
        signal?: AbortSignal,
    ) => Promise<AccountScopedCryptoMaterialSnapshotV1 | null>;
    /**
     * The local canonical Session create entrypoint. Production binds this to
     * the V2 Action owner with its in-process target transport; it is not an
     * RPC caller and cannot loop back through Socket.
     */
    executeSessionStart: ExecuteSessionStart;
}>;

function readSignal(signal: AbortSignal | undefined): AbortSignal {
    return signal ?? new AbortController().signal;
}

function unavailable(): SessionServerStartDispatchResultV1 {
    return { type: 'error', code: 'target_unavailable', retryable: true };
}

async function resolveCurrentTarget(params: Readonly<{
    options: SessionServerStartRpcRegistrationOptions;
    request: ReturnType<typeof SessionServerStartDispatchRequestV1Schema.parse>;
    signal: AbortSignal;
}>): Promise<AvailableAutomationAccountEncryptionV1 | null> {
    try {
        const [accountId, installationId] = await Promise.all([
            params.options.resolveAccountId(params.signal),
            params.options.resolveInstallationId(),
        ]);
        if (
            params.signal.aborted
            || accountId !== params.request.target.accountId
            || installationId !== params.request.target.machineInstallationId
        ) {
            return null;
        }
        const encryption = await resolveValidatedAutomationAccountEncryptionV1({
            signal: params.signal,
            resolveAccountEncryptionCurrentness:
                params.options.resolveAccountEncryptionCurrentness,
            resolveAccountEncryptionMaterial:
                params.options.resolveAccountEncryptionMaterial,
        });
        return !params.signal.aborted
            && encryption.kind === 'available'
            && sameAutomationAccountCurrentnessWitnessV1(
                params.request.start.accountCurrentness,
                encryption.witness,
            )
            ? encryption
            : null;
    } catch {
        return null;
    }
}

/**
 * Registers the one closed server-authored Session-start receiver. It verifies
 * exact daemon identity and Account currentness before it opens the
 * mode-correct V2 envelope, then delegates directly to the incumbent local
 * Session owner.
 */
export function registerSessionServerStartRpcHandler(
    rpc: RpcHandlerRegistrar,
    options: SessionServerStartRpcRegistrationOptions,
): void {
    rpc.registerHandler(SESSION_SERVER_START_DAEMON_RPC_METHOD_V1, async (raw, context) => {
        const parsed = SessionServerStartDispatchRequestV1Schema.safeParse(raw);
        if (!parsed.success) {
            return { type: 'error', code: 'invalid_input', retryable: false };
        }
        const signal = readSignal(context?.signal);
        if (signal.aborted) {
            return { type: 'error', code: 'cancelled', retryable: true };
        }
        const request = parsed.data;
        if (request.target.machineId !== options.machineId) return unavailable();

        // The opaque envelope remains closed until this initial exact-target
        // check succeeds. Its inner V2 shape is never a server concern.
        const currentTarget = await resolveCurrentTarget({ options, request, signal });
        if (!currentTarget) {
            return signal.aborted
                ? { type: 'error', code: 'cancelled', retryable: true }
                : unavailable();
        }
        if (signal.aborted) {
            return { type: 'error', code: 'cancelled', retryable: true };
        }
        const opened = openAutomationSessionStartRequestEnvelopeV1({
            mode: currentTarget.witness.mode,
            envelope: request.start.requestEnvelope,
            ...(isAvailableE2eeAutomationAccountEncryptionV1(currentTarget)
                ? { material: currentTarget.material.material }
                : {}),
        });
        if (opened.kind !== 'available') {
            return { type: 'error', code: 'invalid_input', retryable: false };
        }
        if (opened.input.executionTarget.machineId !== request.target.machineId) {
            // The server deliberately keeps V2 opaque, so the exact daemon must
            // bind the opened request back to the server-stamped target before
            // the canonical Session owner can create or rejoin anything.
            return { type: 'error', code: 'invalid_input', retryable: false };
        }
        if (opened.input.creationKey !== `automation-run:${request.start.runId}`) {
            return { type: 'error', code: 'invalid_input', retryable: false };
        }

        // The source may have spent arbitrary time resolving policy/defaults
        // since the first read. Recheck immediately before the local create
        // owner receives authority to effect the start.
        if (!await resolveCurrentTarget({ options, request, signal })) {
            return signal.aborted
                ? { type: 'error', code: 'cancelled', retryable: true }
                : unavailable();
        }
        if (signal.aborted) {
            return { type: 'error', code: 'cancelled', retryable: true };
        }
        try {
            const result = await options.executeSessionStart(opened.input, {
                signal,
                actionCaller: {
                    kind: 'automationRun',
                    automationId: request.start.automationId,
                    runId: request.start.runId,
                    cause: request.start.cause,
                },
            });
            const parsedResult = SessionServerStartDispatchResultV1Schema.safeParse(result);
            return parsedResult.success
                ? parsedResult.data
                : { type: 'error', code: 'spawn_failed', retryable: true };
        } catch {
            return signal.aborted
                ? { type: 'error', code: 'cancelled', retryable: true }
                : { type: 'error', code: 'spawn_failed', retryable: true };
        }
    });
}
