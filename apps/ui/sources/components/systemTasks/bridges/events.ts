import {
    SYSTEM_TASK_PROTOCOL_VERSION,
    SystemTaskEventSchema,
    SystemTaskJsonValueSchema,
    SystemTaskResultSchema,
    type SystemTaskEvent,
    type SystemTaskJsonValue,
    type SystemTaskResult,
} from '@happier-dev/protocol';

export type NativeSystemTaskEventInput = Readonly<{
    type: string;
    stepId?: string;
    message?: string;
    data?: unknown;
}>;

export function buildNativeSystemTaskEvent(params: Readonly<{
    taskId: string;
    tsMs: number;
    input: NativeSystemTaskEventInput;
}>): SystemTaskEvent {
    const candidate = {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        taskId: params.taskId,
        tsMs: params.tsMs,
        type: params.input.type,
        ...(params.input.stepId ? { stepId: params.input.stepId } : {}),
        ...(params.input.message ? { message: params.input.message } : {}),
        ...(typeof params.input.data === 'undefined'
            ? {}
            : { data: parseJsonValue(params.input.data) }),
    };
    return SystemTaskEventSchema.parse(candidate);
}

export function buildNativeSystemTaskSuccessResult(params: Readonly<{
    taskId: string;
    data: unknown;
}>): SystemTaskResult {
    return SystemTaskResultSchema.parse({
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        taskId: params.taskId,
        ok: true,
        ...(typeof params.data === 'undefined' ? {} : { data: parseJsonValue(params.data) }),
    });
}

export function buildNativeSystemTaskFailureResult(params: Readonly<{
    taskId: string;
    code: string;
    message: string;
}>): SystemTaskResult {
    return SystemTaskResultSchema.parse({
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        taskId: params.taskId,
        ok: false,
        error: {
            code: params.code,
            message: params.message,
        },
    });
}

function parseJsonValue(value: unknown): SystemTaskJsonValue {
    return SystemTaskJsonValueSchema.parse(value);
}
