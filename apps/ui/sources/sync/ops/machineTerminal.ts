import {
    DaemonTerminalCloseRequestSchema,
    DaemonTerminalCloseResponseSchema,
    DaemonTerminalEnsureRequestSchema,
    DaemonTerminalEnsureResponseSchema,
    DaemonTerminalInputRequestSchema,
    DaemonTerminalInputResponseSchema,
    DaemonTerminalResizeRequestSchema,
    DaemonTerminalResizeResponseSchema,
    DaemonTerminalRestartRequestSchema,
    DaemonTerminalRestartResponseSchema,
    DaemonTerminalStreamReadRequestSchema,
    DaemonTerminalStreamReadResponseSchema,
    TerminalStreamAckRequestSchema,
    TerminalStreamAckResponseSchema,
    TerminalStreamBytesFrameSchema,
    TerminalStreamInputRequestSchema,
    TerminalStreamInputResponseSchema,
    TerminalStreamReadRequestSchema,
    TerminalStreamReadResponseSchema,
    decodeTerminalStreamBytesFrame,
    encodeTerminalStreamBytes,
    type DaemonTerminalCloseRequest,
    type DaemonTerminalCloseResponse,
    type DaemonTerminalEnsureRequest,
    type DaemonTerminalEnsureResponse,
    type DaemonTerminalInputRequest,
    type DaemonTerminalInputResponse,
    type DaemonTerminalResizeRequest,
    type DaemonTerminalResizeResponse,
    type DaemonTerminalRestartRequest,
    type DaemonTerminalRestartResponse,
    type DaemonTerminalStreamReadRequest,
    type DaemonTerminalStreamReadResponse,
    type TerminalStreamAckRequest,
    type TerminalStreamAckResponse,
    type TerminalStreamBytesFrame,
    type TerminalStreamInputRequest,
    type TerminalStreamInputResponse,
    type TerminalStreamReadRequest,
    type TerminalStreamReadResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

type MachineTerminalOpts = Readonly<{
    serverId?: string | null;
    timeoutMs?: number | null;
}>;

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

export async function machineTerminalEnsure(
    machineId: string,
    input: DaemonTerminalEnsureRequest,
    opts?: MachineTerminalOpts,
): Promise<DaemonTerminalEnsureResponse> {
    const payload = DaemonTerminalEnsureRequestSchema.parse(input);
    const response = await machineRpcWithServerScope<unknown, DaemonTerminalEnsureRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_ENSURE,
        payload,
    });
    const parsed = DaemonTerminalEnsureResponseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
    }
    return parsed.data;
}

export async function machineTerminalStreamRead(
    machineId: string,
    input: DaemonTerminalStreamReadRequest,
    opts?: MachineTerminalOpts,
): Promise<DaemonTerminalStreamReadResponse> {
    const payload = DaemonTerminalStreamReadRequestSchema.parse(input);
    const response = await machineRpcWithServerScope<unknown, DaemonTerminalStreamReadRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
        payload,
    });
    const parsed = DaemonTerminalStreamReadResponseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ);
    }
    return parsed.data;
}

export function encodeMachineTerminalBytes(bytes: Uint8Array): string {
    return encodeTerminalStreamBytes(bytes);
}

export function decodeMachineTerminalBytesFrame(frame: TerminalStreamBytesFrame): Uint8Array {
    return decodeTerminalStreamBytesFrame(TerminalStreamBytesFrameSchema.parse(frame));
}

export async function machineTerminalStreamReadBytes(
    machineId: string,
    input: TerminalStreamReadRequest,
    opts?: MachineTerminalOpts,
): Promise<TerminalStreamReadResponse> {
    const payload = TerminalStreamReadRequestSchema.parse(input);
    const response = await machineRpcWithServerScope<unknown, TerminalStreamReadRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
        payload,
    });
    const parsed = TerminalStreamReadResponseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES);
    }
    return parsed.data;
}

export async function machineTerminalStreamAcknowledge(
    machineId: string,
    input: TerminalStreamAckRequest,
    opts?: MachineTerminalOpts,
): Promise<TerminalStreamAckResponse> {
    const payload = TerminalStreamAckRequestSchema.parse(input);
    const response = await machineRpcWithServerScope<unknown, TerminalStreamAckRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK,
        payload,
    });
    const parsed = TerminalStreamAckResponseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK);
    }
    return parsed.data;
}

export async function machineTerminalStreamSendInput(
    machineId: string,
    input: TerminalStreamInputRequest,
    opts?: MachineTerminalOpts,
): Promise<TerminalStreamInputResponse> {
    const payload = TerminalStreamInputRequestSchema.parse(input);
    const response = await machineRpcWithServerScope<unknown, TerminalStreamInputRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT,
        payload,
    });
    const parsed = TerminalStreamInputResponseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT);
    }
    return parsed.data;
}

export async function machineTerminalInput(
    machineId: string,
    input: DaemonTerminalInputRequest,
    opts?: MachineTerminalOpts,
): Promise<DaemonTerminalInputResponse> {
    const payload = DaemonTerminalInputRequestSchema.parse(input);
    const response = await machineRpcWithServerScope<unknown, DaemonTerminalInputRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_INPUT,
        payload,
    });
    const parsed = DaemonTerminalInputResponseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_TERMINAL_INPUT);
    }
    return parsed.data;
}

export async function machineTerminalResize(
    machineId: string,
    input: DaemonTerminalResizeRequest,
    opts?: MachineTerminalOpts,
): Promise<DaemonTerminalResizeResponse> {
    const payload = DaemonTerminalResizeRequestSchema.parse(input);
    const response = await machineRpcWithServerScope<unknown, DaemonTerminalResizeRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_RESIZE,
        payload,
    });
    const parsed = DaemonTerminalResizeResponseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_TERMINAL_RESIZE);
    }
    return parsed.data;
}

export async function machineTerminalClose(
    machineId: string,
    input: DaemonTerminalCloseRequest,
    opts?: MachineTerminalOpts,
): Promise<DaemonTerminalCloseResponse> {
    const payload = DaemonTerminalCloseRequestSchema.parse(input);
    const response = await machineRpcWithServerScope<unknown, DaemonTerminalCloseRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_CLOSE,
        payload,
    });
    const parsed = DaemonTerminalCloseResponseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_TERMINAL_CLOSE);
    }
    return parsed.data;
}

export async function machineTerminalRestart(
    machineId: string,
    input: DaemonTerminalRestartRequest,
    opts?: MachineTerminalOpts,
): Promise<DaemonTerminalRestartResponse> {
    const payload = DaemonTerminalRestartRequestSchema.parse(input);
    const response = await machineRpcWithServerScope<unknown, DaemonTerminalRestartRequest>({
        machineId,
        serverId: opts?.serverId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_RESTART,
        payload,
    });
    const parsed = DaemonTerminalRestartResponseSchema.safeParse(response);
    if (!parsed.success) {
        throwUnsupportedResponse(RPC_METHODS.DAEMON_TERMINAL_RESTART);
    }
    return parsed.data;
}
