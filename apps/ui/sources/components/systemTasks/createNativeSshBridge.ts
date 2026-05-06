import { SystemTaskSpecSchema, type SystemTaskResult, type SystemTaskSpec } from '@happier-dev/protocol';

import {
    buildNativeSystemTaskEvent,
    buildNativeSystemTaskFailureResult,
    buildNativeSystemTaskSuccessResult,
    type NativeSystemTaskEventInput,
} from './bridges/events';
import {
    isNativeSshBootstrapCapabilityAvailable,
    loadOptionalNativeSshModule,
    NATIVE_SSH_BOOTSTRAP_TASK_KIND,
    type NativeSshModule,
    type NativeSshSystemTaskBridgeRequest,
} from './bridges/native';
import {
    buildNativeSshTaskCredentials,
    parseNativeSshBootstrapTaskInput,
    runNativeRemoteSshBootstrapTask,
    type NativeSshRunBootstrapTaskParams,
} from './remoteSshBootstrap/nativeTask';
import type { NativeSshSystemTaskCapability, SystemTaskBridgeListenerSet, SystemTasksBridge } from './types';

export type NativeSshRunBootstrapTask = (params: NativeSshRunBootstrapTaskParams) => Promise<unknown>;

type NativeTaskRecord = {
    taskId: string;
    events: unknown[];
    result: SystemTaskResult | null;
    listeners: Set<SystemTaskBridgeListenerSet>;
    abortController: AbortController;
    pendingPrompt: { resolve: (answer: unknown) => void } | null;
    dedupeKey: string | null;
};

export function createNativeSshBridge(options: Readonly<{
    capability: NativeSshSystemTaskCapability;
    nativeSsh?: NativeSshModule | null;
    now?: () => number;
    runBootstrapTask?: NativeSshRunBootstrapTask;
}>): SystemTasksBridge {
    const nativeSsh = options.nativeSsh ?? loadOptionalNativeSshModule();
    const now = options.now ?? Date.now;
    const runBootstrapTask = options.runBootstrapTask ?? runNativeRemoteSshBootstrapTask;
    let nextTaskNumber = 1;
    const records = new Map<string, NativeTaskRecord>();
    const activeTaskIdByDedupeKey = new Map<string, string>();

    const complete = (record: NativeTaskRecord, result: SystemTaskResult) => {
        if (record.result) return;
        record.result = result;
        if (record.dedupeKey) activeTaskIdByDedupeKey.delete(record.dedupeKey);
        for (const listener of record.listeners) listener.onResult(result);
    };

    const emit = (record: NativeTaskRecord, input: NativeSystemTaskEventInput) => {
        const event = buildNativeSystemTaskEvent({ taskId: record.taskId, tsMs: now(), input });
        record.events.push(event);
        for (const listener of record.listeners) listener.onEvent(event);
    };

    const prompt = async (record: NativeTaskRecord, input: NativeSystemTaskEventInput): Promise<unknown> => {
        emit(record, { ...input, type: 'prompt' });
        return await new Promise((resolve) => {
            record.pendingPrompt = { resolve };
        });
    };

    return {
        capabilities: { nativeSsh: options.capability },
        async start(spec: SystemTaskSpec): Promise<string> {
            if (!isNativeSshBootstrapCapabilityAvailable(options.capability)) {
                throw new Error(`native_ssh_unavailable:${options.capability.unavailableReason ?? 'unknown'}`);
            }
            const parsed = SystemTaskSpecSchema.parse(spec);
            if (parsed.kind !== NATIVE_SSH_BOOTSTRAP_TASK_KIND) {
                throw new Error(`Unsupported native system task kind: ${parsed.kind}`);
            }
            const input = parseNativeSshBootstrapTaskInput(parsed);
            const dedupeKey = input.remoteHostId ? `${input.remoteHostId}:${parsed.kind}` : null;
            const activeTaskId = dedupeKey ? activeTaskIdByDedupeKey.get(dedupeKey) : null;
            if (activeTaskId) return activeTaskId;

            const taskId = `native-ssh-task-${nextTaskNumber++}`;
            const record: NativeTaskRecord = {
                taskId,
                events: [],
                result: null,
                listeners: new Set(),
                abortController: new AbortController(),
                pendingPrompt: null,
                dedupeKey,
            };
            records.set(taskId, record);
            if (dedupeKey) activeTaskIdByDedupeKey.set(dedupeKey, taskId);

            void runBootstrapTask({
                spec: parsed,
                taskId,
                nativeSsh,
                emit: (event) => emit(record, event),
                prompt: (event) => prompt(record, event),
            }).then(
                (data) => complete(record, buildNativeSystemTaskSuccessResult({ taskId, data })),
                (error) => complete(record, buildNativeSystemTaskFailureResult({
                    taskId,
                    code: record.abortController.signal.aborted ? 'cancelled' : 'native_ssh_bootstrap_failed',
                    message: error instanceof Error && error.message.trim() ? error.message.trim() : 'Native SSH bootstrap failed.',
                })),
            );

            return taskId;
        },
        async subscribe(taskId, listeners) {
            const record = records.get(taskId);
            if (!record) return () => {};
            for (const event of record.events) listeners.onEvent(event);
            if (record.result) listeners.onResult(record.result);
            record.listeners.add(listeners);
            return () => record.listeners.delete(listeners);
        },
        async cancel(taskId) {
            const record = records.get(taskId);
            if (!record || record.result) return;
            record.abortController.abort();
            record.pendingPrompt?.resolve(null);
            record.pendingPrompt = null;
            complete(record, buildNativeSystemTaskFailureResult({
                taskId,
                code: 'cancelled',
                message: 'System task execution was cancelled.',
            }));
        },
        async respond(taskId, answer) {
            const record = records.get(taskId);
            const pending = record?.pendingPrompt;
            if (!pending) return;
            record.pendingPrompt = null;
            pending.resolve(answer);
        },
    };
}

export function buildNativeSshSystemTaskBridgeRequest(spec: SystemTaskSpec): NativeSshSystemTaskBridgeRequest {
    const input = parseNativeSshBootstrapTaskInput(spec);
    return {
        taskKind: NATIVE_SSH_BOOTSTRAP_TASK_KIND,
        taskInput: input,
        credentials: buildNativeSshTaskCredentials(input),
    };
}
