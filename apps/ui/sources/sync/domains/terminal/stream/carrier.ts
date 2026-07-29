import {
    terminalInputEventToPtyAction,
    type TerminalInputEvent as ProtocolTerminalInputEvent,
} from '@happier-dev/protocol';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import {
    machineTerminalInput,
    machineTerminalResize,
    machineTerminalStreamAcknowledge,
    machineTerminalStreamRead,
    machineTerminalStreamReadBytes,
    machineTerminalStreamSendInput,
} from '@/sync/ops/machineTerminal';

import {
    mapLegacyTerminalReadResponse,
    mapTerminalByteStreamReadResponse,
    terminalByteStreamReadRequiresLegacyFallback,
} from './frames';
import type {
    TerminalInputEvent,
    TerminalRendererAck,
    TerminalStreamCarrier,
    TerminalStreamReadRequest,
} from './model';

export class TerminalStreamInputError extends Error {
    readonly code: string;

    constructor(code: string, message?: string | null) {
        super(message || code || 'terminal_input_failed');
        this.name = 'TerminalStreamInputError';
        this.code = code || 'terminal_input_failed';
    }
}

export function readTerminalStreamInputErrorCode(error: unknown): string | null {
    if (error instanceof TerminalStreamInputError) {
        return error.code;
    }
    if (!error || typeof error !== 'object') {
        return null;
    }
    const raw = error as Readonly<{ code?: unknown; errorCode?: unknown }>;
    const rpcErrorCode = readRpcErrorCode(error);
    if (typeof rpcErrorCode === 'string' && rpcErrorCode.trim()) {
        return rpcErrorCode.trim();
    }
    const maybeCode = typeof raw.code === 'string' && raw.code.trim() ? raw.code.trim() : null;
    if (maybeCode) {
        return maybeCode;
    }
    const maybeErrorCode = typeof raw.errorCode === 'string' && raw.errorCode.trim() ? raw.errorCode.trim() : null;
    return maybeErrorCode;
}

type LegacyTerminalMutationResponse = Readonly<{
    ok: boolean;
    errorCode?: string;
    error?: string;
}>;

type MachineTerminalStreamCarrierOptions = Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

function toMutableModifiers(modifiers: readonly string[]): ('shift' | 'ctrl' | 'alt' | 'meta')[] {
    return modifiers.filter((modifier): modifier is 'shift' | 'ctrl' | 'alt' | 'meta' => (
        modifier === 'shift' || modifier === 'ctrl' || modifier === 'alt' || modifier === 'meta'
    ));
}

function toProtocolTerminalInputEvent(event: TerminalInputEvent): ProtocolTerminalInputEvent {
    switch (event.t) {
        case 'text':
            return { t: 'text', text: event.text };
        case 'key':
            return { t: 'key', key: event.key, modifiers: toMutableModifiers(event.modifiers) };
        case 'paste':
            return { t: 'paste', text: event.text, bracketed: event.bracketed };
        case 'ime':
            return event.text === undefined
                ? { t: 'ime', phase: event.phase }
                : { t: 'ime', phase: event.phase, text: event.text };
        case 'mouse':
            return event.button === undefined
                ? {
                    t: 'mouse',
                    kind: event.kind,
                    x: event.x,
                    y: event.y,
                    modifiers: toMutableModifiers(event.modifiers),
                }
                : {
                    t: 'mouse',
                    kind: event.kind,
                    button: event.button,
                    x: event.x,
                    y: event.y,
                    modifiers: toMutableModifiers(event.modifiers),
                };
        case 'resize':
            return { t: 'resize', cols: event.cols, rows: event.rows };
    }
}

function assertLegacyMutationOk(response: LegacyTerminalMutationResponse) {
    if (response.ok) {
        return;
    }
    throw new TerminalStreamInputError(
        response.errorCode || 'terminal_input_failed',
        response.error || response.errorCode || 'terminal_input_failed',
    );
}

export function createMachineRpcTerminalStreamCarrier(
    options: MachineTerminalStreamCarrierOptions,
): TerminalStreamCarrier {
    const rpcOptions = { serverId: options.serverId, timeoutMs: options.timeoutMs };
    let inputSendTail: Promise<void> = Promise.resolve();
    const readLegacy = async (
        request: TerminalStreamReadRequest,
        cursor: number = request.cursor.value,
    ) => {
        const response = await machineTerminalStreamRead(
            options.machineId,
            {
                terminalId: request.terminalId,
                cursor,
                maxBytes: request.maxBytes,
                maxEvents: request.maxFrames,
            },
            rpcOptions,
        );
        return mapLegacyTerminalReadResponse({
            terminalId: request.terminalId,
            cursor: request.cursor.value,
            response,
        });
    };
    const sendInputNow = async (terminalId: string, event: TerminalInputEvent) => {
        const protocolEvent = toProtocolTerminalInputEvent(event);
        const response = await machineTerminalStreamSendInput(
            options.machineId,
            {
                terminalId,
                event: protocolEvent,
            },
            rpcOptions,
        );
        if (response.ok) {
            return;
        }
        if (response.code !== 'terminal_byte_stream_unavailable') {
            throw new TerminalStreamInputError(response.code, response.message);
        }

        const fallbackAction = terminalInputEventToPtyAction(protocolEvent);
        if (fallbackAction.kind === 'resize') {
            const resizeResponse = await machineTerminalResize(
                options.machineId,
                { terminalId, cols: fallbackAction.cols, rows: fallbackAction.rows },
                rpcOptions,
            );
            assertLegacyMutationOk(resizeResponse);
            return;
        }

        if (fallbackAction.kind === 'write') {
            const inputResponse = await machineTerminalInput(
                options.machineId,
                { terminalId, data: fallbackAction.data },
                rpcOptions,
            );
            assertLegacyMutationOk(inputResponse);
        }
    };
    const enqueueInputSend = (terminalId: string, event: TerminalInputEvent): Promise<void> => {
        const task = inputSendTail.then(() => sendInputNow(terminalId, event));
        inputSendTail = task.catch(() => {
            // Keep later terminal input moving after this send reports a transient failure.
        });
        return task;
    };

    return {
        kind: 'machine-rpc-base64',
        read: async (request: TerminalStreamReadRequest) => {
            if (request.cursor.mode === 'legacy-event-cursor') {
                return readLegacy(request);
            }

            const response = await machineTerminalStreamReadBytes(
                options.machineId,
                {
                    terminalId: request.terminalId,
                    byteOffset: request.cursor.value,
                    ackedByteOffset: request.ackedByteOffset,
                    creditBytes: request.creditBytes,
                    maxBytes: request.maxBytes,
                    maxFrames: request.maxFrames,
                    rendererId: request.rendererId,
                    surfaceEpoch: request.surfaceEpoch,
                },
                rpcOptions,
            );
            if (terminalByteStreamReadRequiresLegacyFallback(response)) {
                return readLegacy(request, 0);
            }
            return mapTerminalByteStreamReadResponse(response);
        },
        acknowledge: async (ack: TerminalRendererAck) => {
            await machineTerminalStreamAcknowledge(
                options.machineId,
                {
                    terminalId: ack.terminalId,
                    rendererId: ack.rendererId,
                    surfaceEpoch: ack.surfaceEpoch,
                    ackedByteOffset: ack.ackedByteOffset,
                    creditBytes: ack.creditBytes,
                },
                rpcOptions,
            );
        },
        sendInput: enqueueInputSend,
    };
}
