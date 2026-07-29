import {
    DaemonBrowserRecordingCancelRequestV1Schema,
    DaemonBrowserRecordingCancelResponseV1Schema,
    DaemonBrowserRecordingCleanupRequestV1Schema,
    DaemonBrowserRecordingCleanupResponseV1Schema,
    DaemonBrowserRecordingListRequestV1Schema,
    DaemonBrowserRecordingListResponseV1Schema,
    DaemonBrowserRecordingStartRequestV1Schema,
    DaemonBrowserRecordingStartResponseV1Schema,
    DaemonBrowserRecordingStatusRequestV1Schema,
    DaemonBrowserRecordingStatusResponseV1Schema,
    DaemonBrowserRecordingStopRequestV1Schema,
    DaemonBrowserRecordingStopResponseV1Schema,
    type BrowserRecordingSessionV1,
    type DaemonBrowserRecordingCancelRequestV1,
    type DaemonBrowserRecordingCancelResponseV1,
    type DaemonBrowserRecordingCancelInputV1,
    type DaemonBrowserRecordingCleanupRequestV1,
    type DaemonBrowserRecordingCleanupResponseV1,
    type DaemonBrowserRecordingCleanupInputV1,
    type DaemonBrowserRecordingListRequestV1,
    type DaemonBrowserRecordingListResponseV1,
    type DaemonBrowserRecordingListInputV1,
    type DaemonBrowserRecordingStartInputV1,
    type DaemonBrowserRecordingStartRequestV1,
    type DaemonBrowserRecordingStartResponseV1,
    type DaemonBrowserRecordingStatusRequestV1,
    type DaemonBrowserRecordingStatusResponseV1,
    type DaemonBrowserRecordingStatusInputV1,
    type DaemonBrowserRecordingStopRequestV1,
    type DaemonBrowserRecordingStopResponseV1,
    type DaemonBrowserRecordingStopInputV1,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

export type BrowserRecordingMachineRpcFailureReason =
    | 'unavailable'
    | 'request_failed'
    | 'invalid_response';

export type BrowserRecordingMachineRpcInputBase = Readonly<{
    machineId: string;
    serverId?: string | null;
}>;

export type BrowserRecordingStartClientInput = BrowserRecordingMachineRpcInputBase & Readonly<{
    input: DaemonBrowserRecordingStartInputV1;
}>;

export type BrowserRecordingStopClientInput = BrowserRecordingMachineRpcInputBase & DaemonBrowserRecordingStopInputV1;
export type BrowserRecordingCancelClientInput = BrowserRecordingMachineRpcInputBase & DaemonBrowserRecordingCancelInputV1;
export type BrowserRecordingStatusClientInput = BrowserRecordingMachineRpcInputBase & DaemonBrowserRecordingStatusInputV1;
export type BrowserRecordingListClientInput = BrowserRecordingMachineRpcInputBase & DaemonBrowserRecordingListInputV1;
export type BrowserRecordingCleanupClientInput = BrowserRecordingMachineRpcInputBase & DaemonBrowserRecordingCleanupInputV1;

export type BrowserRecordingStartClientResult =
    | Readonly<{ ok: true; result: DaemonBrowserRecordingStartResponseV1['result'] }>
    | Readonly<{ ok: false; reason: BrowserRecordingMachineRpcFailureReason }>;
export type BrowserRecordingStopClientResult =
    | Readonly<{ ok: true; result: DaemonBrowserRecordingStopResponseV1['result'] }>
    | Readonly<{ ok: false; reason: BrowserRecordingMachineRpcFailureReason }>;
export type BrowserRecordingCancelClientResult =
    | Readonly<{ ok: true; result: DaemonBrowserRecordingCancelResponseV1['result'] }>
    | Readonly<{ ok: false; reason: BrowserRecordingMachineRpcFailureReason }>;
export type BrowserRecordingStatusClientResult =
    | Readonly<{ ok: true; recording: BrowserRecordingSessionV1 | null }>
    | Readonly<{ ok: false; reason: BrowserRecordingMachineRpcFailureReason }>;
export type BrowserRecordingListClientResult =
    | Readonly<{ ok: true; recordings: readonly BrowserRecordingSessionV1[] }>
    | Readonly<{ ok: false; reason: BrowserRecordingMachineRpcFailureReason }>;
export type BrowserRecordingCleanupClientResult =
    | Readonly<{ ok: true; result: DaemonBrowserRecordingCleanupResponseV1['result'] }>
    | Readonly<{ ok: false; reason: BrowserRecordingMachineRpcFailureReason }>;

type MachineRpcCallInput<TPayload> = BrowserRecordingMachineRpcInputBase & Readonly<{
    method: string;
    payload: TPayload;
}>;

async function callBrowserRecordingMachineRpc<TPayload>(
    input: MachineRpcCallInput<TPayload>,
): Promise<Readonly<{ ok: true; raw: unknown }> | Readonly<{ ok: false; reason: BrowserRecordingMachineRpcFailureReason }>> {
    try {
        const raw = await machineRpcWithServerScope<unknown, TPayload>({
            machineId: input.machineId,
            serverId: input.serverId,
            method: input.method,
            payload: input.payload,
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        return { ok: true, raw };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}

function recordingMatchesStartInput(
    recording: BrowserRecordingSessionV1,
    input: DaemonBrowserRecordingStartInputV1,
): boolean {
    return recording.browserSessionId === input.browserSessionId
        && recording.viewId === input.viewId
        && recording.profileId === input.profileId
        && recording.targetKind === input.targetKind
        && recording.adapterKind === input.adapterKind
        && recording.captureKind === input.captureKind;
}

function recordingMatchesRecordingId(
    recording: BrowserRecordingSessionV1,
    recordingId: string,
): boolean {
    return recording.recordingId === recordingId;
}

function allRecordingsMatchView(
    recordings: readonly BrowserRecordingSessionV1[],
    viewId: string,
): boolean {
    return recordings.every((recording) => recording.viewId === viewId);
}

function parsedCallFailure(): Readonly<{ ok: false; reason: 'invalid_response' }> {
    return { ok: false, reason: 'invalid_response' };
}

export async function startBrowserRecordingViaMachineRpc(
    input: BrowserRecordingStartClientInput,
): Promise<BrowserRecordingStartClientResult> {
    const payload: DaemonBrowserRecordingStartRequestV1 = DaemonBrowserRecordingStartRequestV1Schema.parse({
        protocolVersion: 1,
        machineId: input.machineId,
        input: input.input,
    });
    const raw = await callBrowserRecordingMachineRpc({
        machineId: input.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_BROWSER_RECORDING_START,
        payload,
    });
    if (!raw.ok) return raw;

    const parsed = DaemonBrowserRecordingStartResponseV1Schema.safeParse(raw.raw);
    if (!parsed.success) return parsedCallFailure();
    const result = parsed.data.result;
    if (result.status === 'started' && !recordingMatchesStartInput(result.recording, input.input)) {
        return parsedCallFailure();
    }
    return { ok: true, result };
}

export async function stopBrowserRecordingViaMachineRpc(
    input: BrowserRecordingStopClientInput,
): Promise<BrowserRecordingStopClientResult> {
    const payload: DaemonBrowserRecordingStopRequestV1 = DaemonBrowserRecordingStopRequestV1Schema.parse({
        protocolVersion: 1,
        machineId: input.machineId,
        recordingId: input.recordingId,
        navigationGenerationEnd: input.navigationGenerationEnd,
        ...(input.stoppedAtMs !== undefined ? { stoppedAtMs: input.stoppedAtMs } : {}),
        ...(input.expiresAtMs !== undefined ? { expiresAtMs: input.expiresAtMs } : {}),
    });
    const raw = await callBrowserRecordingMachineRpc({
        machineId: input.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_BROWSER_RECORDING_STOP,
        payload,
    });
    if (!raw.ok) return raw;

    const parsed = DaemonBrowserRecordingStopResponseV1Schema.safeParse(raw.raw);
    if (!parsed.success) return parsedCallFailure();
    const result = parsed.data.result;
    if (result.status !== 'unavailable' && !recordingMatchesRecordingId(result.recording, input.recordingId)) {
        return parsedCallFailure();
    }
    return { ok: true, result };
}

export async function cancelBrowserRecordingViaMachineRpc(
    input: BrowserRecordingCancelClientInput,
): Promise<BrowserRecordingCancelClientResult> {
    const payload: DaemonBrowserRecordingCancelRequestV1 = DaemonBrowserRecordingCancelRequestV1Schema.parse({
        protocolVersion: 1,
        machineId: input.machineId,
        recordingId: input.recordingId,
        reason: input.reason,
        ...(input.atMs !== undefined ? { atMs: input.atMs } : {}),
    });
    const raw = await callBrowserRecordingMachineRpc({
        machineId: input.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_BROWSER_RECORDING_CANCEL,
        payload,
    });
    if (!raw.ok) return raw;

    const parsed = DaemonBrowserRecordingCancelResponseV1Schema.safeParse(raw.raw);
    if (!parsed.success) return parsedCallFailure();
    const result = parsed.data.result;
    if (result.status !== 'unavailable' && !recordingMatchesRecordingId(result.recording, input.recordingId)) {
        return parsedCallFailure();
    }
    return { ok: true, result };
}

export async function fetchBrowserRecordingStatusViaMachineRpc(
    input: BrowserRecordingStatusClientInput,
): Promise<BrowserRecordingStatusClientResult> {
    const payload: DaemonBrowserRecordingStatusRequestV1 = DaemonBrowserRecordingStatusRequestV1Schema.parse({
        protocolVersion: 1,
        machineId: input.machineId,
        recordingId: input.recordingId,
    });
    const raw = await callBrowserRecordingMachineRpc({
        machineId: input.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS,
        payload,
    });
    if (!raw.ok) return raw;

    const parsed = DaemonBrowserRecordingStatusResponseV1Schema.safeParse(raw.raw);
    if (!parsed.success) return parsedCallFailure();
    const recording = parsed.data.recording;
    if (recording && !recordingMatchesRecordingId(recording, input.recordingId)) {
        return parsedCallFailure();
    }
    return { ok: true, recording };
}

export async function listBrowserRecordingsForViewViaMachineRpc(
    input: BrowserRecordingListClientInput,
): Promise<BrowserRecordingListClientResult> {
    const payload: DaemonBrowserRecordingListRequestV1 = DaemonBrowserRecordingListRequestV1Schema.parse({
        protocolVersion: 1,
        machineId: input.machineId,
        viewId: input.viewId,
    });
    const raw = await callBrowserRecordingMachineRpc({
        machineId: input.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_BROWSER_RECORDING_LIST,
        payload,
    });
    if (!raw.ok) return raw;

    const parsed = DaemonBrowserRecordingListResponseV1Schema.safeParse(raw.raw);
    if (!parsed.success || !allRecordingsMatchView(parsed.data.recordings, input.viewId)) {
        return parsedCallFailure();
    }
    return { ok: true, recordings: parsed.data.recordings };
}

export async function cleanupBrowserRecordingsViaMachineRpc(
    input: BrowserRecordingCleanupClientInput,
): Promise<BrowserRecordingCleanupClientResult> {
    const payload: DaemonBrowserRecordingCleanupRequestV1 = DaemonBrowserRecordingCleanupRequestV1Schema.parse({
        protocolVersion: 1,
        machineId: input.machineId,
        ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    });
    const raw = await callBrowserRecordingMachineRpc({
        machineId: input.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.DAEMON_BROWSER_RECORDING_CLEANUP,
        payload,
    });
    if (!raw.ok) return raw;

    const parsed = DaemonBrowserRecordingCleanupResponseV1Schema.safeParse(raw.raw);
    return parsed.success ? { ok: true, result: parsed.data.result } : parsedCallFailure();
}
