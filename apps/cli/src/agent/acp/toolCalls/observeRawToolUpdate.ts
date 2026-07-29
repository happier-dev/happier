import type { AcpToolCallAccumulator } from './AcpToolCallAccumulator';
import type {
    AcpToolAccumulatorEmission,
    AcpToolObservationPatch,
} from './types';

type RawToolUpdateType = 'tool_call' | 'tool_call_update';

export type ParsedRawAcpToolUpdate = Readonly<Record<string, unknown>> & Readonly<{
    sessionUpdate: RawToolUpdateType;
    toolCallId: string;
}>;

export type ObserveRawAcpToolUpdateParams = Readonly<{
    accumulator: AcpToolCallAccumulator;
    update: unknown;
    sessionId: string;
    turnId: string;
    sidechainId: string | null;
    revision: number;
    observedAtMs: number;
    semanticName?: string | null;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

export function parseRawAcpToolUpdate(value: unknown): ParsedRawAcpToolUpdate {
    if (!isRecord(value)) throw new Error('ACP tool update must be an object');
    if (value.sessionUpdate !== 'tool_call' && value.sessionUpdate !== 'tool_call_update') {
        throw new Error('ACP tool update has an unsupported sessionUpdate discriminant');
    }
    if (typeof value.toolCallId !== 'string' || value.toolCallId.trim().length === 0) {
        throw new Error('ACP tool update requires a nonblank exact toolCallId');
    }
    if (value.sessionUpdate === 'tool_call' && typeof value.title !== 'string') {
        throw new Error('ACP tool_call requires a title');
    }
    return value as ParsedRawAcpToolUpdate;
}

function copyNullableString(
    source: Readonly<Record<string, unknown>>,
    target: Record<string, unknown>,
    key: 'title' | 'kind' | 'status',
): void {
    if (!hasOwn(source, key)) return;
    const value = source[key];
    if (value === null || typeof value === 'string') target[key] = value;
}

export function readRawAcpToolObservationPatch(
    update: Readonly<Record<string, unknown>>,
): AcpToolObservationPatch {
    const patch: Record<string, unknown> = {};
    copyNullableString(update, patch, 'title');
    copyNullableString(update, patch, 'kind');
    copyNullableString(update, patch, 'status');
    if (hasOwn(update, 'rawInput')) patch.rawInput = update.rawInput;
    if (hasOwn(update, 'rawOutput')) patch.rawOutput = update.rawOutput;
    if (hasOwn(update, 'error')) patch.error = update.error;
    if (hasOwn(update, 'content') && (update.content === null || Array.isArray(update.content))) {
        patch.content = update.content;
        if (update.rawOutput === undefined && Array.isArray(update.content) && update.content.length > 0) {
            patch.rawOutput = update.content;
        }
    }
    if (hasOwn(update, 'locations') && (update.locations === null || Array.isArray(update.locations))) {
        patch.locations = update.locations;
    }
    return Object.freeze(patch) as AcpToolObservationPatch;
}

export function observeRawAcpToolUpdate(
    params: ObserveRawAcpToolUpdateParams,
): AcpToolAccumulatorEmission {
    const update = parseRawAcpToolUpdate(params.update);
    return params.accumulator.observe({
        sessionId: params.sessionId,
        turnId: params.turnId,
        sidechainId: params.sidechainId,
        toolCallId: update.toolCallId,
        revision: params.revision,
        observedAtMs: params.observedAtMs,
        source: update.sessionUpdate,
        patch: readRawAcpToolObservationPatch(update),
        ...(params.semanticName === undefined ? {} : { semanticName: params.semanticName }),
    });
}
