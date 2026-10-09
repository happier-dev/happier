import { DaemonTerminalCloseRequestSchema, DaemonTerminalCloseResponseSchema, DaemonTerminalEnsureRequestSchema, DaemonTerminalEnsureResponseSchema, DaemonTerminalListRequestV1Schema, DaemonTerminalListResponseV1Schema, DaemonTerminalInputRequestSchema, DaemonTerminalInputResponseSchema, DaemonTerminalResizeRequestSchema, DaemonTerminalResizeResponseSchema, DaemonTerminalRestartRequestSchema, DaemonTerminalRestartResponseSchema, DaemonTerminalStreamReadRequestSchema, DaemonTerminalStreamReadResponseSchema, type DaemonTerminalCloseRequest, type DaemonTerminalCloseResponse, type DaemonTerminalEnsureRequest, type DaemonTerminalEnsureResponse, type DaemonTerminalListRequestV1, type DaemonTerminalListResponseV1, type DaemonTerminalInputRequest, type DaemonTerminalInputResponse, type DaemonTerminalResizeRequest, type DaemonTerminalResizeResponse, type DaemonTerminalRestartRequest, type DaemonTerminalRestartResponse, type DaemonTerminalStreamReadRequest, type DaemonTerminalStreamReadResponse } from '@happier-dev/protocol/daemon/terminal';
import { TerminalStreamAckRequestSchema, TerminalStreamAckResponseSchema, TerminalStreamBytesFrameSchema, TerminalStreamReadRequestSchema, TerminalStreamReadResponseSchema, decodeTerminalStreamBytesFrame, encodeTerminalStreamBytes, type TerminalStreamAckRequest, type TerminalStreamAckResponse, type TerminalStreamBytesFrame, type TerminalStreamReadRequest, type TerminalStreamReadResponse } from '@happier-dev/protocol/terminal/stream';
import { TerminalStreamInputRequestSchema, TerminalStreamInputResponseSchema, type TerminalStreamInputRequest, type TerminalStreamInputResponse } from '@happier-dev/protocol/terminal/input';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { isRpcMethodNotAvailableError } from '@/sync/runtime/rpcErrors';

type MachineTerminalOpts = Readonly<{
    serverId?: string | null;
    accountId?: string | null;
    timeoutMs?: number | null;
    signal?: AbortSignal;
}>;

const pendingTerminalCreations = new Map<string, Set<Promise<unknown>>>();
function terminalCreationKey(machineId: string, terminalKey: string, opts?: MachineTerminalOpts): string {
    return JSON.stringify([opts?.serverId?.trim() ?? null, machineId.trim(), terminalKey]);
}
async function trackTerminalCreation<T>(key: string, run: () => Promise<T>): Promise<T> {
    const operation = run();
    const pending = pendingTerminalCreations.get(key) ?? new Set<Promise<unknown>>();
    pending.add(operation);
    pendingTerminalCreations.set(key, pending);
    try { return await operation; }
    finally {
        pending.delete(operation);
        if (pending.size === 0) pendingTerminalCreations.delete(key);
    }
}

/** Initial Action issuance/association shares the incumbent physical-creation custody. */
export function trackPendingMachineTerminalCreation<T>(machineId: string, terminalKey: string,
    run: () => Promise<T>, opts?: MachineTerminalOpts): Promise<T> {
    return trackTerminalCreation(terminalCreationKey(machineId, terminalKey, opts), run);
}

/** A connecting/restarting pane may not yet appear in the daemon's PTY list. */
export async function awaitPendingMachineTerminalCreation(machineId: string, terminalKey: string,
    opts?: MachineTerminalOpts & Readonly<{ shouldStopWaiting?: () => boolean }>): Promise<void> {
    const key = terminalCreationKey(machineId, terminalKey, opts);
    while (pendingTerminalCreations.has(key)) {
        if (opts?.shouldStopWaiting?.()) return;
        // An initial issuance can install durable Artifact custody while another
        // Inbox already holds the physical operation. Observe that association
        // after either operation settles, without waiting for a human decision.
        await Promise.race(pendingTerminalCreations.get(key)!);
    }
}

function throwUnsupportedResponse(method: string): never {
    throw new Error(`Unsupported response from machine RPC (${method})`);
}

/** Null means this daemon lacks listing; operational failures retain their real result. */
export async function machineTerminalList(
    machineId: string,
    opts?: MachineTerminalOpts & DaemonTerminalListRequestV1,
): Promise<DaemonTerminalListResponseV1 | null> {
    let response: unknown;
    try {
        response = await machineRpcWithServerScope<unknown, DaemonTerminalListRequestV1>({
            machineId,
            serverId: opts?.serverId,
            accountId: opts?.accountId,
            timeoutMs: opts?.timeoutMs ?? undefined,
            method: RPC_METHODS.DAEMON_TERMINAL_LIST,
            payload: DaemonTerminalListRequestV1Schema.parse({ ...(opts?.workspace ? { workspace: opts.workspace } : {}) }),
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });
    } catch (error) {
        if (isRpcMethodNotAvailableError(error)) return null;
        throw error;
    }
    const parsed = DaemonTerminalListResponseV1Schema.safeParse(response);
    if (!parsed.success) throwUnsupportedResponse(RPC_METHODS.DAEMON_TERMINAL_LIST);
    return parsed.data;
}

export async function machineTerminalEnsure(
    machineId: string,
    input: DaemonTerminalEnsureRequest,
    opts?: MachineTerminalOpts,
): Promise<DaemonTerminalEnsureResponse> {
    const payload = DaemonTerminalEnsureRequestSchema.parse(input);
    return trackTerminalCreation(terminalCreationKey(machineId, payload.terminalKey, opts), async () => {
        const response = await machineRpcWithServerScope<unknown, DaemonTerminalEnsureRequest>({
            machineId,
            serverId: opts?.serverId,
            accountId: opts?.accountId,
            timeoutMs: opts?.timeoutMs ?? undefined,
            method: RPC_METHODS.DAEMON_TERMINAL_ENSURE,
            payload,
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        const parsed = DaemonTerminalEnsureResponseSchema.safeParse(response);
        if (!parsed.success) {
            throwUnsupportedResponse(RPC_METHODS.DAEMON_TERMINAL_ENSURE);
        }
        return parsed.data;
    });
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
        accountId: opts?.accountId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_STREAM_READ,
        payload,
        ...(opts?.signal ? { signal: opts.signal } : {}),
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
        accountId: opts?.accountId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
        payload,
        ...(opts?.signal ? { signal: opts.signal } : {}),
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
        accountId: opts?.accountId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK,
        payload,
        ...(opts?.signal ? { signal: opts.signal } : {}),
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
        accountId: opts?.accountId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT,
        payload,
        ...(opts?.signal ? { signal: opts.signal } : {}),
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
        accountId: opts?.accountId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_INPUT,
        payload,
        ...(opts?.signal ? { signal: opts.signal } : {}),
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
        accountId: opts?.accountId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_RESIZE,
        payload,
        ...(opts?.signal ? { signal: opts.signal } : {}),
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
        accountId: opts?.accountId,
        timeoutMs: opts?.timeoutMs ?? undefined,
        method: RPC_METHODS.DAEMON_TERMINAL_CLOSE,
        payload,
        ...(opts?.signal ? { signal: opts.signal } : {}),
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
    return trackTerminalCreation(terminalCreationKey(machineId, payload.terminalKey, opts), async () => {
        const response = await machineRpcWithServerScope<unknown, DaemonTerminalRestartRequest>({
            machineId,
            serverId: opts?.serverId,
            accountId: opts?.accountId,
            timeoutMs: opts?.timeoutMs ?? undefined,
            method: RPC_METHODS.DAEMON_TERMINAL_RESTART,
            payload,
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        const parsed = DaemonTerminalRestartResponseSchema.safeParse(response);
        if (!parsed.success) {
            throwUnsupportedResponse(RPC_METHODS.DAEMON_TERMINAL_RESTART);
        }
        return parsed.data;
    });
}
