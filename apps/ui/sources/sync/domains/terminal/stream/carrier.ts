import {
    isTerminalLegacyClientFallbackAllowed,
    terminalInputEventToPtyAction,
    type TerminalInputEvent as ProtocolTerminalInputEvent,
} from '@happier-dev/protocol';
import Constants from 'expo-constants';
import uiPackage from '../../../../../package.json';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
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

type TerminalStreamCarrierOperation = 'acknowledge' | 'input';

export class TerminalStreamCarrierError extends Error {
    readonly code: string;
    readonly rpcErrorCode: string;
    readonly operation: TerminalStreamCarrierOperation;

    constructor(operation: TerminalStreamCarrierOperation, code: string, message?: string | null) {
        const fallbackCode = operation === 'acknowledge'
            ? 'terminal_ack_delivery_failed'
            : 'terminal_input_failed';
        const resolvedCode = code || fallbackCode;
        super(message || resolvedCode);
        this.name = 'TerminalStreamCarrierError';
        this.operation = operation;
        this.code = resolvedCode;
        this.rpcErrorCode = resolvedCode;
    }
}

export class TerminalStreamInputError extends TerminalStreamCarrierError {
    constructor(code: string, message?: string | null) {
        super('input', code, message);
        this.name = 'TerminalStreamInputError';
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

export function resolveTerminalStreamAppRelease(input: Readonly<{
    expoVersion?: string | null;
    packageVersion: string;
}>): string {
    const runtimeVersion = input.expoVersion?.trim();
    return runtimeVersion || input.packageVersion;
}

const CURRENT_TERMINAL_APP_RELEASE = resolveTerminalStreamAppRelease({
    expoVersion: Constants.expoConfig?.version,
    packageVersion: uiPackage.version,
});

function assertLegacyClientFallbackAllowed(peerByteStreamCapability: 'disabled' | 'unknown'): void {
    if (isTerminalLegacyClientFallbackAllowed({
        currentAppRelease: CURRENT_TERMINAL_APP_RELEASE,
        peerByteStreamCapability,
    })) {
        return;
    }
    throw new TerminalStreamCarrierError(
        'input',
        'terminal_legacy_compatibility_expired',
        `Legacy terminal stream compatibility is unavailable in app release ${CURRENT_TERMINAL_APP_RELEASE}`,
    );
}

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

function isPredecessorTerminalStreamRpcError(error: unknown): boolean {
    const rpcErrorCode = readRpcErrorCode(error);
    return (
        rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        || rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
    );
}

function isControlCursorCompatibilityRejection(
    response: Awaited<ReturnType<typeof machineTerminalStreamReadBytes>>,
): boolean {
    return !response.ok && response.code === 'terminal_invalid_request';
}

export function createMachineRpcTerminalStreamCarrier(
    options: MachineTerminalStreamCarrierOptions,
): TerminalStreamCarrier {
    const rpcOptions = { serverId: options.serverId, timeoutMs: options.timeoutMs };
    let inputSendTail: Promise<void> = Promise.resolve();
    let controlCursorTerminalId: string | null = null;
    let controlCursor = 0;
    let controlCursorCapability: 'unknown' | 'supported' | 'predecessor' = 'unknown';
    const readLegacy = async (
        request: TerminalStreamReadRequest,
        cursor: number = request.cursor.value,
    ) => {
        assertLegacyClientFallbackAllowed('unknown');
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
            cursor,
            response,
        });
    };
    const sendLegacyInput = async (terminalId: string, protocolEvent: ProtocolTerminalInputEvent): Promise<void> => {
        const fallbackAction = terminalInputEventToPtyAction(protocolEvent);
        if (fallbackAction.kind === 'unsupported') {
            throw new TerminalStreamInputError(fallbackAction.code, fallbackAction.message);
        }
        if (fallbackAction.kind === 'noop') {
            return;
        }
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
    const sendInputNow = async (terminalId: string, event: TerminalInputEvent) => {
        const protocolEvent = toProtocolTerminalInputEvent(event);
        let response: Awaited<ReturnType<typeof machineTerminalStreamSendInput>> | null;
        try {
            response = await machineTerminalStreamSendInput(
                options.machineId,
                {
                    terminalId,
                    event: protocolEvent,
                },
                rpcOptions,
            );
        } catch (error) {
            if (!isPredecessorTerminalStreamRpcError(error)) {
                throw error;
            }
            response = null;
        }
        if (response === null) {
            assertLegacyClientFallbackAllowed('unknown');
            return sendLegacyInput(terminalId, protocolEvent);
        }
        if (response.ok) {
            return;
        }
        if (response.code !== 'terminal_byte_stream_unavailable') {
            throw new TerminalStreamInputError(response.code, response.message);
        }
        assertLegacyClientFallbackAllowed('disabled');
        return sendLegacyInput(terminalId, protocolEvent);
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

            let response: Awaited<ReturnType<typeof machineTerminalStreamReadBytes>> | null;
            if (controlCursorTerminalId !== request.terminalId) {
                controlCursorTerminalId = request.terminalId;
                controlCursor = 0;
            }
            const readBytes = (includeControlCursor: boolean) => machineTerminalStreamReadBytes(
                options.machineId,
                {
                    terminalId: request.terminalId,
                    byteOffset: request.cursor.value,
                    ...(includeControlCursor ? { controlCursor } : {}),
                    ackedByteOffset: request.ackedByteOffset,
                    creditBytes: request.creditBytes,
                    maxBytes: request.maxBytes,
                    maxFrames: request.maxFrames,
                    rendererId: request.rendererId,
                    surfaceEpoch: request.surfaceEpoch,
                },
                rpcOptions,
            );
            try {
                response = await readBytes(controlCursorCapability !== 'predecessor');
                if (
                    controlCursorCapability === 'unknown'
                    && isControlCursorCompatibilityRejection(response)
                ) {
                    const predecessorResponse = await readBytes(false);
                    if (!isControlCursorCompatibilityRejection(predecessorResponse)) {
                        controlCursorCapability = 'predecessor';
                    }
                    response = predecessorResponse;
                } else if (response.ok && response.nextControlCursor !== undefined) {
                    controlCursorCapability = 'supported';
                }
            } catch (error) {
                if (!isPredecessorTerminalStreamRpcError(error)) {
                    throw error;
                }
                response = null;
            }
            if (response === null) {
                return readLegacy(request, 0);
            }
            if (terminalByteStreamReadRequiresLegacyFallback(response)) {
                return readLegacy(request, 0);
            }
            if (response.ok && response.nextControlCursor !== undefined) {
                controlCursor = response.nextControlCursor;
            }
            return mapTerminalByteStreamReadResponse(response);
        },
        acknowledge: async (ack: TerminalRendererAck) => {
            const response = await machineTerminalStreamAcknowledge(
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
            if (!response.ok) {
                throw new TerminalStreamCarrierError('acknowledge', response.code, response.message);
            }
        },
        sendInput: enqueueInputSend,
    };
}
