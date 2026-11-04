import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { MachineLiveStreamFrameV1, MachineLiveStreamRelayEnvelopeV1, MachineLiveStreamWireFrameV1 } from '@happier-dev/protocol';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { applyMachineLiveStreamRelayBackpressure } from '../../../../../server/sources/app/machines/peer/mediation/stream/metering';
import { createBrowserSidecarCdpControlAdapter, type BrowserSidecarCdpEventSubscriber } from '../sidecar/controlAdapter';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';
import { createDaemonMachineLiveStreamCaptureAdapter } from '../../peer/mediation/stream/captureAdapter';
import { createMachineLiveStreamRelayTerminator } from '../../peer/mediation/stream/relay';
import { createBrowserCdpScreencastProducer } from './cdpScreencast';
import { registerBrowserLiveCapture } from './registration';

// Constructed transport workload, not a claim about a real page's JPEG size or phone speed.
const frameCount = 120;
const frameBytes = 32_768;
const slowAckEvery = 10;

async function measure(viewers: readonly string[]) {
    const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
    const commands: string[] = [];
    const view = { browserSessionId: 'browser', viewId: 'view' };
    let now = 1_000;
    const transport = {
        openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
        dispatchPageCommand: async (command: { method: string }) => { commands.push(command.method); return {}; },
        dispatchBrowserCommand: async () => ({ success: true }),
        subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
            listeners.add(listener); return () => { listeners.delete(listener); };
        },
    };
    const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: view.browserSessionId, sidecarId: 'sidecar', transport });
    const contextCapture = { transport, resolvePageHandle: adapter.resolvePageHandle,
        subscribeCdpEvents: transport.subscribeCdpEvents, subscribeViewLifecycle: adapter.subscribeViewLifecycle };
    const producer = createBrowserCdpScreencastProducer({ contextCapture, nowMs: () => now });
    const registry = createMachineLiveStreamCaptureRegistry();
    const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => null });
    const images = new Map<string, MachineLiveStreamFrameV1[]>();
    const queues = new Map<string, MachineLiveStreamWireFrameV1[]>();
    let wireBytes = 0;
    let serverCpuUs = 0;
    let dropped = 0;
    const relay = createMachineLiveStreamRelayTerminator({ machineId: 'machine', nowMs: () => now,
        captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(registry), emitEnvelope(envelope) {
            if (envelope.message.kind !== 'frame') return;
            const frame = envelope.message.frame;
            // The server boundary is serialization plus its real queue/drop owner, not the
            // socket/auth/encryption handler. CPU figures below name this limited stage.
            const cpu = process.cpuUsage();
            const { payloadBase64, ...header } = frame;
            const serialized = JSON.stringify({ ...header, payload: { t: 'plain', v: payloadBase64 } });
            wireBytes += Buffer.byteLength(serialized);
            const wireFrame: MachineLiveStreamWireFrameV1 = JSON.parse(serialized);
            const pressure = applyMachineLiveStreamRelayBackpressure({ streamId: frame.streamId, routeKind: 'server_relay',
                frames: [...(queues.get(frame.streamId) ?? []), wireFrame], maxWindowFrames: 1,
                maxWindowBytes: frameBytes * 2, capIntervalExceeded: false });
            queues.set(frame.streamId, [...pressure.frames]);
            dropped += pressure.framesDropped;
            const used = process.cpuUsage(cpu);
            serverCpuUs += used.user + used.system;
            if (frame.payloadKind !== 'metadata') images.set(frame.streamId, [...(images.get(frame.streamId) ?? []), frame]);
            if (frame.streamId === 'fast' || frame.payloadKind === 'metadata') ack(frame.streamId, frame.sequence + 1);
        } });
    function ack(streamId: string, nextSequence: number, windowFrames = 1) {
        queues.set(streamId, []);
        const envelope: MachineLiveStreamRelayEnvelopeV1 = { v: 1, sourceMachineId: 'machine', targetMachineId: 'viewer',
            message: { kind: 'control', control: { v: 1, streamId, kind: 'ack', nextSequence, windowFrames } } };
        expect(relay.applyControl(envelope)).toEqual({ ok: true });
    }
    const emit = (index: number) => {
        now = 1_000 + Math.round(index * 1_000 / 60);
        const payload = Buffer.alloc(frameBytes, index).toString('base64');
        for (const listener of listeners) listener({ method: 'Page.screencastFrame', sessionId: 'cdp-page',
            params: { sessionId: index, data: payload, metadata: { deviceWidth: 1280, deviceHeight: 720 } } });
    };
    try {
        await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...view, platform: 'web',
            target: { kind: 'externalUrl', targetId: 'external', url: 'http://fixture.test' } });
        expect(commands.filter(method => method === 'Page.startScreencast')).toHaveLength(0);
        for (const streamId of viewers) {
            const sourceId = browserViewKey(view);
            expect(await relay.start({ v: 1, streamId, streamFamily: 'browser.streamed', sourceId,
                sourceMachineId: 'machine', targetMachineId: 'viewer', routeKind: 'server_relay',
                authorization: { payload: { v: 1, grantId: 'grant', accountId: 'account', flowKind: 'live_stream',
                    routeKind: 'server_relay', sourceMachineId: 'machine', targetMachineId: 'viewer', streamId,
                    streamFamily: 'browser.streamed', sourceId, iat: 1_000, exp: 61_000,
                    aud: 'happier-live-stream-relay-authorization' },
                    signature: { keyId: 'key', alg: 'Ed25519', valueBase64Url: 'AQID' } } }, 'present_user'))
                .toEqual({ ok: true, streamId });
        }
        serverCpuUs = 0;
        const cpu = process.cpuUsage();
        const wall = performance.now();
        for (let index = 1; index <= frameCount; index++) {
            emit(index);
            if (viewers.includes('slow') && index % slowAckEvery === 0) {
                const latest = images.get('slow')?.at(-1);
                if (latest) {
                    const before = images.get('slow')?.length;
                    ack('slow', latest.sequence + 1, 0);
                    expect(images.get('slow')).toHaveLength(before ?? 0);
                    ack('slow', latest.sequence + 1);
                }
            }
        }
        const elapsedMs = performance.now() - wall;
        const used = process.cpuUsage(cpu);
        const counts = Object.fromEntries([...images].map(([id, frames]) => [id, frames.length]));
        const framesPerSecond = Object.fromEntries([...images].map(([id, frames]) => {
            const seconds = [0, 0];
            for (const frame of frames) {
                const second = Math.ceil((frame.timestampMs - 1_000) / 1_000) - 1;
                seconds[second] = (seconds[second] ?? 0) + 1;
            }
            return [id, seconds];
        }));
        const payloadSizes = [...images.values()].flat().map(frame => frame.payloadSizeBytes);
        const newest = images.get('slow')?.at(-1);
        const newestAgeMs = newest ? now - newest.timestampMs : null;
        for (const streamId of viewers) await relay.stop(streamId);
        const commandsAfterStop = commands.length;
        emit(frameCount + 1);
        expect(commands).toHaveLength(commandsAfterStop);
        // Quality transitions restart the SAME screencast. They must never add a
        // second active encoder or leave one running after the final consumer.
        let activeCaptures = 0;
        for (const method of commands) {
            if (method === 'Page.startScreencast') activeCaptures++;
            if (method === 'Page.stopScreencast') activeCaptures--;
            expect(activeCaptures).toBeGreaterThanOrEqual(0);
            expect(activeCaptures).toBeLessThanOrEqual(1);
        }
        expect(activeCaptures).toBe(0);
        expect(commands.filter(method => method === 'Page.screencastFrameAck')).toHaveLength(frameCount);
        return { viewers, frameCount, frameBytes, counts, framesPerSecond, wireBytes, dropped, newestAgeMs, elapsedMs,
            imageBytesPerFrame: { min: Math.min(...payloadSizes), max: Math.max(...payloadSizes) },
            newestPayloadByte: newest ? Buffer.from(newest.payloadBase64, 'base64')[0] : null,
            daemonCpuUs: used.user + used.system - serverCpuUs, serverQueueAndSerializationCpuUs: serverCpuUs };
    } finally { await relay.dispose(); registration.dispose(); await producer.dispose(); adapter.dispose(); }
}

describe('browser frame delivery cost contract', () => {
    it('measures one viewer and an independently slow viewer through the real capture and relay', async () => {
        const single = await measure(['fast']);
        const shared = await measure(['fast', 'slow']);
        console.info('BR_FRAMEBUDGET_MEASUREMENT', JSON.stringify({ single, shared }));
        expect(single.counts.fast).toBe(frameCount);
        expect(shared.counts.fast).toBe(frameCount);
        // One initial image, then one newest image for each slow viewer consumption.
        expect(shared.counts.slow).toBe(1 + frameCount / slowAckEvery);
        expect(shared.dropped).toBe(0);
        expect(shared.newestAgeMs).toBe(0);
        expect(shared.newestPayloadByte).toBe(frameCount);
        expect(shared.framesPerSecond).toEqual({ fast: [60, 60], slow: [7, 6] });
        expect(shared.imageBytesPerFrame).toEqual({ min: frameBytes, max: frameBytes });
    });
});
