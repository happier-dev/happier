import {
    createExecutionRunHostBackendFromSessionRuntime,
    type PublicExecutionRunSessionRuntimeFactoryParamsV1,
    type RuntimeCancelRequestV1,
    type RuntimeCancelResultV1,
    type RuntimeEventV1,
    type RuntimeInputPayloadV1,
    type RuntimeSendOptionsV1,
    type RuntimeSendResultV1,
    type SessionRuntimePermissionsV1,
    type SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';

import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { RuntimeTurnPromptMeta } from '@/agent/runtime/turns/runtimeTurnOperations';

import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';
import { wrapExecutionRunHostRuntime } from './hostRuntime/wrap';

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readSessionId(value: unknown): string | null {
    if (typeof value === 'string') return normalizeNonEmptyString(value);
    const record = readRecord(value);
    return normalizeNonEmptyString(record?.sessionId)
        ?? normalizeNonEmptyString(record?.providerSessionId);
}

function readRuntimeInputText(input: RuntimeInputPayloadV1): string {
    const record = readRecord(input);
    const text = record?.text;
    if (typeof text === 'string') return text;
    throw new Error('Execution-run turn operations require text runtime input.');
}

function normalizeNonEmptyStringList(values: readonly unknown[] | null | undefined): string[] {
    const normalized: string[] = [];
    for (const value of values ?? []) {
        const text = normalizeNonEmptyString(value);
        if (!text || normalized.includes(text)) continue;
        normalized.push(text);
    }
    return normalized;
}

function isUserMessageSeq(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function runtimeSendOptionsToTurnPromptMeta(options: RuntimeSendOptionsV1 | undefined): RuntimeTurnPromptMeta | undefined {
    const localId = normalizeNonEmptyString(options?.localInputId);
    const localIds = normalizeNonEmptyStringList([
        ...(localId ? [localId] : []),
        ...(options?.localInputIds ?? []),
    ]);
    const providerClaimedPendingLocalIds = normalizeNonEmptyStringList(options?.providerClaimedPendingLocalIds);
    const userMessageSeq = options?.userMessageSeq;
    const userMessageSeqs = [
        ...(isUserMessageSeq(userMessageSeq) ? [userMessageSeq] : []),
        ...normalizeSeqList(options?.userMessageSeqs),
    ].filter((seq, index, allSeqs) => allSeqs.indexOf(seq) === index);
    const meta: RuntimeTurnPromptMeta = {
        ...(localId ? { localId } : {}),
        ...(localIds.length > 0 ? { localIds } : {}),
        ...(providerClaimedPendingLocalIds.length > 0 ? { providerClaimedPendingLocalIds } : {}),
        ...(isUserMessageSeq(userMessageSeq) ? { userMessageSeq } : {}),
        ...(userMessageSeqs.length > 0 ? { userMessageSeqs } : {}),
    };
    return Object.keys(meta).length > 0 ? meta : undefined;
}

function normalizeSeqList(values: readonly unknown[] | null | undefined): number[] {
    const normalized: number[] = [];
    for (const value of values ?? []) {
        if (!isUserMessageSeq(value) || normalized.includes(value)) continue;
        normalized.push(value);
    }
    return normalized;
}

async function createSessionRuntimeFromTurnOperations(
    operations: RuntimeTurnOperations,
    params: PublicExecutionRunSessionRuntimeFactoryParamsV1 | undefined,
): Promise<SessionRuntimeV1> {
    const resumeSessionId = normalizeNonEmptyString(params?.resumeSessionId);
    const started = await operations.startOrLoadSession(
        resumeSessionId
            ? { resumeId: resumeSessionId, importHistory: false }
            : {},
    );
    const startedSessionId = readSessionId(started)
        ?? normalizeNonEmptyString(operations.readSessionIdentity().sessionId);
    if (!startedSessionId) {
        throw new Error('Execution-run turn operations did not return a session id.');
    }

    return Object.freeze({
        identity: {
            read: () => ({
                providerSessionId: normalizeNonEmptyString(operations.readSessionIdentity().sessionId)
                    ?? startedSessionId,
            }),
        },
        events: {
            subscribe: (handler: (event: RuntimeEventV1) => void) => (
                operations.subscribeRuntimeEvents((message) => {
                    handler(message as RuntimeEventV1);
                })
            ),
        },
        async send(input: RuntimeInputPayloadV1, options?: RuntimeSendOptionsV1): Promise<RuntimeSendResultV1> {
            const prompt = readRuntimeInputText(input);
            const meta = runtimeSendOptionsToTurnPromptMeta(options);
            if (options?.deliverAs === 'steer') {
                await operations.steerInFlightTurn(prompt, meta);
                return { status: 'accepted' };
            }
            operations.beginTurnLifecycle();
            await operations.sendTurnPrompt(prompt, meta);
            return { status: 'accepted' };
        },
        async cancel(_request: RuntimeCancelRequestV1): Promise<RuntimeCancelResultV1> {
            await operations.cancelTurn();
            return { status: 'cancelled' };
        },
        get permissions(): SessionRuntimePermissionsV1 | undefined {
            if (operations.permissionCapability === 'responds' && operations.respondToPermission) {
                return {
                    capability: 'responds',
                    respond: async (decision) => await operations.respondToPermission!(
                        decision.requestId,
                        decision.approved,
                    ),
                };
            }
            if (operations.permissionCapability === 'inline') {
                return { capability: 'inline' };
            }
            if (operations.permissionCapability === 'static') {
                return { capability: 'static' };
            }
            return undefined;
        },
        async dispose() {
            await operations.resetOrDisposeRuntime();
        },
    });
}

export function createExecutionRunHostRuntimeFromRuntimeTurnOperations(
    operations: RuntimeTurnOperations,
): ExecutionRunHostRuntime {
    const backend = createExecutionRunHostBackendFromSessionRuntime({
        createSessionRuntime: async (params) => await createSessionRuntimeFromTurnOperations(operations, params),
        waitForRuntimeTurnCompletion: async (_runtime, timeoutMs) => {
            await operations.waitForTurnCompletion({ timeoutMs });
        },
    }) as unknown as ExecutionRunHostRuntime;
    return wrapExecutionRunHostRuntime({
        readPermissionCapability: () => backend.permissionCapability,
        readResumeSupport: (opts) => backend.readResumeSupport(opts),
        provisionSession: (opts) => backend.provisionSession(opts),
        sendPrompt: (sessionId, prompt, meta) => backend.sendPrompt(sessionId, prompt, meta),
        readSendSteerPrompt: () => backend.sendSteerPrompt,
        cancel: (sessionId) => backend.cancel(sessionId),
        subscribeMessages: (handler) => backend.subscribeMessages(handler),
        readRespondToPermission: () => backend.permissionCapability === 'responds'
            ? backend.respondToPermission
            : undefined,
        readWaitForTurnCompletion: () => backend.waitForTurnCompletion,
        readProbeTurnLiveness: () => backend.probeTurnLiveness,
        dispose: () => backend.dispose(),
    });
}
