import { SystemTaskSpecSchema, type SystemTaskResult, type SystemTaskSpec } from '@happier-dev/protocol';
import type {
    NativeSshAuthPromptEvent,
    NativeSshAuthPromptResponse,
    NativeSshHostKeyPromptEvent,
    NativeSshHostKeyVerification,
    NativeSshModule,
    NativeSshSubscription,
} from '@happier-dev/ssh-native';

import {
    buildNativeSystemTaskFailureResult,
    buildNativeSystemTaskSuccessResult,
} from './bridges/events';
import {
    isNativeSshBootstrapCapabilityAvailable,
    isNativeSshBootstrapTaskKind,
    loadOptionalNativeSshModule,
    resolveDefaultNativeSshSystemTaskCapability,
} from './bridges/native';
import {
    readNativeSshBootstrapDedupeKey,
    readNativeSshTaskCredentials,
    runNativeRemoteSshBootstrapTask,
    type RunNativeRemoteSshBootstrapTaskParams,
} from './remoteSshBootstrap/nativeTask';
import {
    createDefaultNativeSshBridgeInterruptionStore,
    createNativeSshBridgeInterruptionStore,
} from './nativeSshBridgeInterruptionStore';
import { resolveTrustedHostKeyDecision } from '@/sync/domains/remoteHosts/hostKeys/resolveTrustedHostKeyDecision';
import type { RemoteHostTrustedHostKeyStore } from '@/sync/domains/remoteHosts/hostKeys/model';
import type {
    NativeSshSystemTaskCapability,
    SystemTaskBridgeListenerSet,
    SystemTasksBridge,
} from './types';

export { createNativeSshBridgeInterruptionStore };

export type NativeSshBridgeInterruptionMarker = Readonly<{
    taskId: string;
    key: string;
    startedAtMs: number;
}>;

export type NativeSshBridgeInterruptionStore = Readonly<{
    read: (key: string) => NativeSshBridgeInterruptionMarker | null;
    write: (marker: NativeSshBridgeInterruptionMarker) => void;
    remove: (key: string) => void;
    list?: () => readonly NativeSshBridgeInterruptionMarker[];
}>;

type NativeTaskRecord = {
    taskId: string;
    key: string;
    completed: boolean;
    abortController: AbortController;
    listeners: Set<SystemTaskBridgeListenerSet>;
    events: unknown[];
    result: SystemTaskResult | null;
    pendingHostKeyPrompts: Map<string, NativeSshHostKeyPromptEvent>;
    pendingAuthPrompts: Map<string, NativeSshAuthPromptEvent>;
    pendingSharedPrompts: Array<{
        resolve: (answer: unknown) => void;
        reject: (error: unknown) => void;
    }>;
    hostKeyScope: Readonly<{
        host: string;
        port: number;
        requestIdPrefix: string;
    }>;
    remoteHostId: string | null;
    removeNativeListeners: (() => void)[];
};

export type CreateNativeSshBridgeOptions = Readonly<{
    capability?: NativeSshSystemTaskCapability;
    nativeModule?: NativeSshModule | null;
    runBootstrapTask?: (params: RunNativeRemoteSshBootstrapTaskParams) => Promise<unknown>;
    interruptionStore?: NativeSshBridgeInterruptionStore | null;
    trustedHostKeyStore?: RemoteHostTrustedHostKeyStore | null;
}>;

let nextNativeTaskNumber = 1;

function createTaskId(): string {
    return `native_ssh_task_${nextNativeTaskNumber++}`;
}

export function readNativeSshBridgeInterruptionKey(spec: Readonly<{
    kind: string;
    params: unknown;
}>): string {
    return `native-ssh-interrupted:${readNativeSshBootstrapDedupeKey(spec)}`;
}

function emitEvent(record: NativeTaskRecord, payload: unknown) {
    record.events.push(payload);
    for (const listener of record.listeners) {
        listener.onEvent(payload);
    }
}

function emitResult(record: NativeTaskRecord, payload: SystemTaskResult) {
    if (record.completed) {
        return;
    }
    record.completed = true;
    record.result = payload;
    for (const listener of record.listeners) {
        listener.onResult(payload);
    }
}

function toFailureResult(taskId: string, error: unknown): SystemTaskResult {
    const rawMessage = error instanceof Error ? error.message : String(error ?? '');
    const stableCode = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code.trim()
        : '';
    const code = rawMessage === 'native_ssh_task_cancelled'
        ? 'cancelled'
        : stableCode || rawMessage || 'native_ssh_task_failed';
    return buildNativeSystemTaskFailureResult({
        taskId,
        code,
        message: rawMessage || code,
    });
}

function isNativeHostKeyPromptEvent(value: unknown): value is NativeSshHostKeyPromptEvent {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return typeof candidate.promptId === 'string'
        && typeof candidate.requestId === 'string'
        && typeof candidate.host === 'string'
        && typeof candidate.port === 'number'
        && typeof candidate.algorithm === 'string'
        && typeof candidate.fingerprintSha256 === 'string'
        && (candidate.status === 'unknown' || candidate.status === 'changed');
}

function isNativeAuthPromptEvent(value: unknown): value is NativeSshAuthPromptEvent {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    const common = typeof candidate.promptId === 'string'
        && typeof candidate.requestId === 'string'
        && typeof candidate.host === 'string'
        && typeof candidate.port === 'number'
        && typeof candidate.username === 'string';
    if (!common) {
        return false;
    }
    if (candidate.kind === 'private-key-passphrase') {
        return true;
    }
    return candidate.kind === 'keyboard-interactive' && Array.isArray(candidate.prompts);
}

function isHostKeyPromptInTaskScope(
    scope: NativeTaskRecord['hostKeyScope'],
    prompt: Readonly<{ requestId: string; host: string; port: number }>,
): boolean {
    return prompt.requestId.startsWith(`${scope.requestIdPrefix}:`)
        && prompt.port === scope.port
        && prompt.host.trim().toLowerCase() === scope.host.trim().toLowerCase();
}

function buildHostKeyPromptSystemTaskEvent(
    taskId: string,
    event: NativeSshHostKeyPromptEvent,
): unknown {
    return {
        protocolVersion: 1,
        taskId,
        tsMs: Date.now(),
        type: 'prompt',
        stepId: 'ssh.hostTrust',
        message: event.status === 'changed' ? 'Replace this SSH host key?' : 'Trust this SSH host?',
        data: {
            kind: event.status === 'changed' ? 'ssh.replaceHostKey' : 'ssh.trustHost',
            promptId: event.promptId,
            host: event.host,
            keyType: event.algorithm,
            fingerprint: event.fingerprintSha256,
            ...(event.status === 'changed'
                ? { existingFingerprint: event.existingFingerprintSha256 ?? null }
                : {}),
        },
    };
}

function buildAuthPromptSystemTaskEvent(
    taskId: string,
    event: NativeSshAuthPromptEvent,
): unknown {
    return {
        protocolVersion: 1,
        taskId,
        tsMs: Date.now(),
        type: 'prompt',
        stepId: 'ssh.auth',
        message: event.kind === 'private-key-passphrase'
            ? 'Enter the SSH private-key passphrase.'
            : 'Answer the SSH authentication prompt.',
        data: event.kind === 'private-key-passphrase'
            ? {
                kind: 'ssh.privateKeyPassphrase',
                promptId: event.promptId,
                host: event.host,
                port: event.port,
                username: event.username,
                keyLabel: event.keyLabel ?? null,
                attemptsRemaining: event.attemptsRemaining ?? null,
            }
            : {
                kind: 'ssh.keyboardInteractive',
                promptId: event.promptId,
                host: event.host,
                port: event.port,
                username: event.username,
                name: event.name ?? null,
                instruction: event.instruction ?? null,
                prompts: event.prompts,
            },
    };
}

function readHostKeyResponse(
    prompt: NativeSshHostKeyPromptEvent,
    answer: unknown,
): NativeSshHostKeyVerification {
    const value = answer && typeof answer === 'object' && !Array.isArray(answer)
        ? answer as Record<string, unknown>
        : {};
    if (value.trusted === true) {
        return {
            decision: 'accept-once',
            fingerprintSha256: prompt.fingerprintSha256,
        };
    }
    return {
        decision: 'reject',
        reason: 'SSH host trust was declined.',
    };
}

function readRemoteHostIdFromSpec(spec: Readonly<{ params: unknown }>): string | null {
    const params = spec.params && typeof spec.params === 'object' && !Array.isArray(spec.params)
        ? spec.params as Record<string, unknown>
        : {};
    return typeof params.remoteHostId === 'string' && params.remoteHostId.trim()
        ? params.remoteHostId.trim()
        : null;
}

function shouldRememberHostKey(answer: unknown): boolean {
    return Boolean(answer && typeof answer === 'object' && !Array.isArray(answer)
        && (answer as Record<string, unknown>).remember === true);
}

function readAuthPromptResponse(
    prompt: NativeSshAuthPromptEvent,
    answer: unknown,
): NativeSshAuthPromptResponse {
    const value = answer && typeof answer === 'object' && !Array.isArray(answer)
        ? answer as Record<string, unknown>
        : {};
    if (prompt.kind === 'private-key-passphrase') {
        return typeof value.passphrase === 'string'
            ? { decision: 'submit', value: value.passphrase }
            : { decision: 'cancel', reason: 'SSH private-key passphrase prompt was cancelled.' };
    }
    const answers = Array.isArray(value.keyboardInteractiveAnswers)
        ? value.keyboardInteractiveAnswers.flatMap((entry): Array<Readonly<{ id: string; value: string }>> => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
            const candidate = entry as Record<string, unknown>;
            return typeof candidate.id === 'string' && typeof candidate.value === 'string'
                ? [{ id: candidate.id, value: candidate.value }]
                : [];
        })
        : [];
    return answers.length > 0
        ? { decision: 'submit', answers }
        : { decision: 'cancel', reason: 'SSH keyboard-interactive prompt was cancelled.' };
}

export function createNativeSshBridge(
    options: CreateNativeSshBridgeOptions = {},
): SystemTasksBridge {
    const capability = options.capability ?? resolveDefaultNativeSshSystemTaskCapability();
    const runBootstrapTask = options.runBootstrapTask ?? runNativeRemoteSshBootstrapTask;
    const nativeModule = options.nativeModule === undefined
        ? loadOptionalNativeSshModule()
        : options.nativeModule;
    const interruptionStore = options.interruptionStore === undefined
        ? createDefaultNativeSshBridgeInterruptionStore()
        : options.interruptionStore;
    const trustedHostKeyStore = options.trustedHostKeyStore ?? null;
    const records = new Map<string, NativeTaskRecord>();
    const taskIdByDedupeKey = new Map<string, string>();

    async function runRecord(record: NativeTaskRecord, spec: SystemTaskSpec) {
        const hostKeySubscription: NativeSshSubscription | null = nativeModule?.addListener?.(
            'hostKeyPrompt',
            (payload) => {
                if (!isNativeHostKeyPromptEvent(payload)) {
                    return;
                }
                if (!isHostKeyPromptInTaskScope(record.hostKeyScope, payload)) {
                    return;
                }
                const trustedRecord = trustedHostKeyStore?.get({
                    host: payload.host,
                    port: payload.port,
                    algorithm: payload.algorithm,
                }) ?? null;
                const trustedDecision = trustedHostKeyStore
                    ? resolveTrustedHostKeyDecision({ event: payload, trusted: trustedRecord })
                    : null;
                if (trustedDecision?.action === 'accept' && nativeModule?.respondToHostKeyPrompt) {
                    trustedHostKeyStore?.markSeen({
                        host: payload.host,
                        port: payload.port,
                        algorithm: payload.algorithm,
                    });
                    void nativeModule.respondToHostKeyPrompt(payload.promptId, trustedDecision.verification);
                    return;
                }
                const promptPayload = trustedDecision?.action === 'prompt' && trustedDecision.promptKind === 'ssh.replaceHostKey'
                    ? {
                        ...payload,
                        status: 'changed' as const,
                        existingFingerprintSha256: trustedDecision.existingFingerprintSha256 ?? payload.existingFingerprintSha256,
                    }
                    : payload;
                if (promptPayload.status === 'unknown' || promptPayload.status === 'changed') {
                    record.pendingHostKeyPrompts.set(promptPayload.promptId, promptPayload);
                }
                emitEvent(record, buildHostKeyPromptSystemTaskEvent(record.taskId, promptPayload));
            },
        ) ?? null;
        if (hostKeySubscription) {
            record.removeNativeListeners.push(() => hostKeySubscription.remove());
        }
        const authPromptSubscription: NativeSshSubscription | null = nativeModule?.addListener?.(
            'authPrompt',
            (payload) => {
                if (!isNativeAuthPromptEvent(payload)) {
                    return;
                }
                if (!isHostKeyPromptInTaskScope(record.hostKeyScope, payload)) {
                    return;
                }
                record.pendingAuthPrompts.set(payload.promptId, payload);
                emitEvent(record, buildAuthPromptSystemTaskEvent(record.taskId, payload));
            },
        ) ?? null;
        if (authPromptSubscription) {
            record.removeNativeListeners.push(() => authPromptSubscription.remove());
        }
        try {
            const data = await runBootstrapTask({
                taskId: record.taskId,
                spec,
                nativeModule,
                signal: record.abortController.signal,
                events: {
                    event: (payload) => {
                        emitEvent(record, payload);
                    },
                },
                prompt: async () => await new Promise<unknown>((resolve, reject) => {
                    if (record.abortController.signal.aborted) {
                        reject(new Error('native_ssh_task_cancelled'));
                        return;
                    }
                    record.pendingSharedPrompts.push({ resolve, reject });
                }),
            });
            emitResult(record, buildNativeSystemTaskSuccessResult({
                taskId: record.taskId,
                data,
            }));
        } catch (error) {
            emitResult(record, toFailureResult(record.taskId, error));
        } finally {
            for (const remove of record.removeNativeListeners) {
                remove();
            }
            interruptionStore?.remove(readNativeSshBridgeInterruptionKey(spec));
            taskIdByDedupeKey.delete(record.key);
        }
    }

    return {
        capabilities: {
            nativeSsh: capability,
        },
        async start(spec) {
            const parsedSpec = SystemTaskSpecSchema.parse(spec);
            if (!isNativeSshBootstrapTaskKind(parsedSpec.kind)) {
                throw new Error('native_ssh_task_not_allowed');
            }
            if (!isNativeSshBootstrapCapabilityAvailable(capability)) {
                throw new Error(capability.unavailableReason ?? 'native_ssh_unavailable');
            }
            const credentials = readNativeSshTaskCredentials(parsedSpec);
            const dedupeKey = readNativeSshBootstrapDedupeKey(parsedSpec);
            const interruptionKey = readNativeSshBridgeInterruptionKey(parsedSpec);
            const existingTaskId = taskIdByDedupeKey.get(dedupeKey);
            if (existingTaskId) {
                return existingTaskId;
            }
            const taskId = createTaskId();
            const record: NativeTaskRecord = {
                taskId,
                key: dedupeKey,
                completed: false,
                abortController: new AbortController(),
                listeners: new Set(),
                events: [],
                result: null,
                pendingHostKeyPrompts: new Map(),
                pendingAuthPrompts: new Map(),
                pendingSharedPrompts: [],
                hostKeyScope: {
                    host: credentials.host,
                    port: credentials.port,
                    requestIdPrefix: taskId,
                },
                remoteHostId: readRemoteHostIdFromSpec(parsedSpec),
                removeNativeListeners: [],
            };
            records.set(taskId, record);
            const interrupted = interruptionStore?.read(interruptionKey);
            if (interrupted) {
                interruptionStore?.remove(interruptionKey);
                emitResult(record, buildNativeSystemTaskFailureResult({
                    taskId,
                    code: 'native_ssh_task_interrupted',
                    message: 'Previous native SSH bootstrap was interrupted before completion.',
                }));
                return taskId;
            }
            interruptionStore?.write({
                taskId,
                key: interruptionKey,
                startedAtMs: Date.now(),
            });
            taskIdByDedupeKey.set(dedupeKey, taskId);
            void runRecord(record, parsedSpec);
            return taskId;
        },
        async subscribe(taskId, listeners) {
            const record = records.get(taskId);
            if (!record) {
                return () => {};
            }
            record.listeners.add(listeners);
            for (const event of record.events) {
                listeners.onEvent(event);
            }
            if (record.result) {
                listeners.onResult(record.result);
            }
            return () => {
                record.listeners.delete(listeners);
            };
        },
        async cancel(taskId) {
            const record = records.get(taskId);
            if (!record || record.completed) {
                return;
            }
            record.abortController.abort();
            for (const prompt of record.pendingSharedPrompts.splice(0)) {
                prompt.reject(new Error('native_ssh_task_cancelled'));
            }
            emitResult(record, buildNativeSystemTaskFailureResult({
                taskId,
                code: 'cancelled',
                message: 'cancelled',
            }));
        },
        async respond(taskId, answer) {
            const record = records.get(taskId);
            if (!record || record.completed) {
                return;
            }
            const shouldAnswerHostKey = answer && typeof answer === 'object' && !Array.isArray(answer)
                && typeof (answer as Record<string, unknown>).trusted === 'boolean'
                && record.pendingHostKeyPrompts.size > 0;
            const shouldAnswerAuthPrompt = answer && typeof answer === 'object' && !Array.isArray(answer)
                && (
                    typeof (answer as Record<string, unknown>).passphrase === 'string'
                    || Array.isArray((answer as Record<string, unknown>).keyboardInteractiveAnswers)
                )
                && record.pendingAuthPrompts.size > 0;
            if (!shouldAnswerHostKey && !shouldAnswerAuthPrompt) {
                const pendingSharedPrompt = record.pendingSharedPrompts.shift();
                if (pendingSharedPrompt) {
                    pendingSharedPrompt.resolve(answer);
                    return;
                }
            }
            if (shouldAnswerAuthPrompt) {
                if (!nativeModule?.respondToAuthPrompt) {
                    return;
                }
                const [promptId, prompt] = [...record.pendingAuthPrompts.entries()][0] ?? [null, null];
                if (!promptId || !prompt) {
                    return;
                }
                record.pendingAuthPrompts.delete(promptId);
                await nativeModule.respondToAuthPrompt(promptId, readAuthPromptResponse(prompt, answer));
                return;
            }
            if (!nativeModule?.respondToHostKeyPrompt) {
                return;
            }
            const [promptId, prompt] = [...record.pendingHostKeyPrompts.entries()]
                .find(([, pending]) => pending.status === 'unknown' || pending.status === 'changed')
                ?? [null, null];
            if (!promptId || !prompt) {
                return;
            }
            record.pendingHostKeyPrompts.delete(promptId);
            if (shouldRememberHostKey(answer)) {
                trustedHostKeyStore?.trust({
                    host: prompt.host,
                    port: prompt.port,
                    algorithm: prompt.algorithm,
                    fingerprintSha256: prompt.fingerprintSha256,
                    ...(record.remoteHostId ? { remoteHostId: record.remoteHostId } : {}),
                });
            }
            await nativeModule.respondToHostKeyPrompt(promptId, readHostKeyResponse(prompt, answer));
        },
    };
}
