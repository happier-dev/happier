import type { SimulatorDeviceResourceV1, SimulatorSidebandMessageV1 } from '@happier-dev/protocol';
import type { MachineLiveStreamCaptureAdapter } from '../../../peer/mediation/stream/captureAdapter';
import { resolveAndroidAdbTooling } from '../android/tooling';
import { startSimulatorLogs } from '../logs';

type LogMessage = Extract<SimulatorSidebandMessageV1, { kind: 'logs' }>;
const activeLogs = new Map<symbol, Readonly<{ simulatorId: string; latest?: LogMessage }>>();

/** Snapshot of the same pushed producer, for the sideband Action. No second read channel. */
export function readSimulatorLogSideband(simulatorId: string): LogMessage | undefined {
    let latest: LogMessage | undefined;
    for (const log of activeLogs.values()) {
        if (log.simulatorId === simulatorId && log.latest && (!latest || latest.emittedAtMs <= log.latest.emittedAtMs)) latest = log.latest;
    }
    return latest;
}

export function withSimulatorLogs(resource: SimulatorDeviceResourceV1, adapter: MachineLiveStreamCaptureAdapter): MachineLiveStreamCaptureAdapter {
    return { start: async input => {
        let sequence = 1;
        let stopped = false;
        let logs: ReturnType<typeof startSimulatorLogs> | undefined;
        const key = Symbol(resource.simulatorId);
        const stopLogs = () => { stopped = true; activeLogs.delete(key); logs?.stop(); };
        const result = await adapter.start({ ...input,
            offerFrame: frame => input.offerFrame({ ...frame, sequence: sequence++ }),
            emitReceipt: receipt => { if (receipt.terminal) stopLogs(); input.emitReceipt(receipt); },
        });
        if (!result.ok || stopped) return result;
        const empty: LogMessage = { v: 1, kind: 'logs', simulatorId: resource.simulatorId, emittedAtMs: input.nowMs(), level: 'info', message: '' };
        const emit = (message: LogMessage) => {
            if (stopped) return;
            activeLogs.set(key, { simulatorId: resource.simulatorId, latest: message });
            const payload = Buffer.from(JSON.stringify(message));
            const offered = input.offerFrame({ v: 1, streamId: input.streamId, sequence: sequence++, timestampMs: message.emittedAtMs,
                payloadKind: 'metadata', payloadEncoding: 'binary_base64', payloadBase64: payload.toString('base64'),
                payloadSizeBytes: payload.length });
            if (!offered.ok && offered.reasonCode !== 'backpressure_window_exhausted') stopLogs();
        };
        const reportFailure = (reason: string) => emit({ ...empty, emittedAtMs: input.nowMs(), level: 'error', message: reason });
        const startLogs = async () => {
            const tooling = resource.platform === 'android' ? await resolveAndroidAdbTooling() : { ok: true as const, command: 'xcrun' };
            if (stopped) return;
            if (!tooling.ok) { reportFailure(tooling.reasonCode); return; }
            activeLogs.set(key, { simulatorId: resource.simulatorId });
            // JSON can expand each UTF-8 byte into six bytes (escaped controls).
            // Reserve the envelope, using the admitted frame ceiling as the only budget.
            const ceiling = input.getFramePayloadByteLimit?.({ v: 1, streamId: input.streamId, sequence, timestampMs: empty.emittedAtMs,
                payloadKind: 'metadata', payloadEncoding: 'binary_base64', payloadBase64: '', payloadSizeBytes: 0 }) ?? input.caps.maxFrameBytes;
            const maxLineBytes = Math.floor((ceiling - Buffer.byteLength(JSON.stringify(empty))) / 6);
            if (maxLineBytes <= 0) { reportFailure('max_frame_bytes'); return; }
            logs = startSimulatorLogs({ platform: resource.platform, deviceId: resource.deviceId,
                simulatorId: resource.simulatorId, command: tooling.command, maxLineBytes, now: input.nowMs, emit,
                failed: reportFailure,
            });
            if (stopped) logs?.stop();
        };
        // Optional logs never delay video readiness. The capture lifetime also
        // covers tooling resolution, so a late resolution cannot orphan a child.
        void startLogs().catch(() => reportFailure('simulator_logs_tooling_failed'));
        return { ...result, session: { ...result.session, stop: async () => { stopLogs(); await result.session.stop(); } } };
    } };
}
