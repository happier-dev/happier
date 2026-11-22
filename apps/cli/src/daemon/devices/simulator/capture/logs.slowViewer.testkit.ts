import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, vi } from 'vitest';
import type { MachineLiveStreamCapsV1, MachineLiveStreamControlV1, MachineLiveStreamFrameV1, MachineLiveStreamWireFrameV1 } from '@happier-dev/protocol';
import type { MachineLiveStreamCaptureSession } from '../../../peer/mediation/stream/captureAdapter';
import { createSimulatorFrameProducerCaptureAdapter, type SimulatorCaptureFrameProducerStartInput } from './adapter';
import { withSimulatorLogs } from './logs';

const { spawnLogProcess } = vi.hoisted(() => ({ spawnLogProcess: vi.fn() }));
// Only the device subprocess is mocked. The real producer, capture and remote
// Home credit/ACK owners are exercised by the caller's transport boundary.
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: spawnLogProcess }));

export async function expectNewestPictureUnderLogFlood(input: Readonly<{
    caps: MachineLiveStreamCapsV1;
    sendFrame: (frame: MachineLiveStreamFrameV1) => unknown;
    consumeAck: (control: MachineLiveStreamControlV1) => Promise<unknown>;
    readDelivered: () => readonly MachineLiveStreamWireFrameV1[];
}>): Promise<void> {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true),
    });
    spawnLogProcess.mockReturnValue(child);
    let producer: SimulatorCaptureFrameProducerStartInput | undefined;
    let capture: MachineLiveStreamCaptureSession | undefined;
    const operations: Promise<unknown>[] = [];
    const adapter = withSimulatorLogs({ v: 1, simulatorId: 'phone-logs', deviceId: 'phone-logs', platform: 'ios', displayName: 'Phone',
      capture: { status: 'available', sourceId: 'screen', supportedCodecs: ['image.mjpeg'], inputMode: 'none' } },
    createSimulatorFrameProducerCaptureAdapter({ sourceId: 'screen', sourceCodecs: ['image.mjpeg'],
      producer: { start: async value => { producer = value; return { stop() {} }; } } }));
    const started = await adapter.start({ streamId: 'stream_1', streamFamily: 'screen', sourceMachineId: 'machine-source', targetMachineId: 'machine-target',
      caps: input.caps, startedAtMs: 1_000, expiresAtMs: Infinity, nowMs: () => 1_000,
      startRequest: { v: 1, streamId: 'stream_1', streamFamily: 'screen', sourceMachineId: 'machine-source', targetMachineId: 'machine-target', routeKind: 'server_relay', codecId: 'image.mjpeg' },
      offerFrame: (offered: MachineLiveStreamFrameV1) => {
        operations.push(Promise.resolve(input.sendFrame(offered)));
        return { ok: true };
      }, applyControl: () => ({ ok: true }), emitReceipt: () => {},
    });
    if (!started.ok) throw new Error('Capture failed');
    capture = started.session;
    const emitPicture = (timestampMs: number) => {
      if (!producer) throw new Error('Producer not started');
      producer.emitFrame({ codecId: 'image.mjpeg', payload: new Uint8Array(16_000), timestampMs });
    };
    try {
      emitPicture(1_000);
      child.stdout.write('I/App: initial log\n');
      await Promise.all(operations.splice(0));
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const consumed = input.readDelivered().at(-1)!.sequence + 1;
        const beforeFlood = input.readDelivered().length;
        const newestTimestamp = 1_001 + cycle * 300 + 299;
        for (let offer = 0; offer < 300; offer += 1) {
          emitPicture(1_001 + cycle * 300 + offer);
          child.stdout.write(`I/App: ${cycle}:${offer} ${'x'.repeat(1_000)}\n`);
        }
        await Promise.all(operations.splice(0));
        expect.soft(input.readDelivered().slice(beforeFlood).filter(value => value.payloadKind === 'metadata')).toHaveLength(0);
        const beforeAck = input.readDelivered().length;
        const ack = { v: 1 as const, streamId: 'stream_1', kind: 'ack' as const, nextSequence: consumed };
        await input.consumeAck(ack);
        // Home forwards admitted ACKs to this capture session in production.
        expect(capture.applyControl?.(ack)).toEqual({ ok: true });
        await Promise.all(operations.splice(0));
        const delivered = input.readDelivered().slice(beforeAck);
        expect(delivered.filter(value => value.payloadKind === 'image_keyframe').map(value => value.timestampMs)).toEqual([newestTimestamp]);
        expect(delivered.filter(value => value.payloadKind === 'metadata')).toHaveLength(1);
        const log = delivered.find(value => value.payloadKind === 'metadata')!;
        if (log.payload.t !== 'plain') throw new Error('Expected plain fixture');
        expect(JSON.parse(Buffer.from(log.payload.v, 'base64').toString()).message).toContain(`${cycle}:299`);
      }
    } finally {
      await capture.stop();
      spawnLogProcess.mockReset();
    }
}
