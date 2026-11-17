import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimulatorDeviceResourceV1 } from '@happier-dev/protocol';

import type { SimulatorOperationChild } from '../process';
import type { MachineLiveStreamCaptureStartInput } from '../../../peer/mediation/stream/captureAdapter';
import { createSimulatorFrameProducerCaptureAdapter } from './adapter';
import { readSimulatorLogSideband, withSimulatorLogs } from './logs';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
// Device log subprocesses are an OS boundary; framing and the pushed-log owner stay real.
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn }));

afterEach(() => spawn.mockReset());

describe('capture log delivery', () => {
    it.each([undefined, 512])('delivers logs with frame ceiling %s and clears them on capture stop', async maxFrameBytes => {
        const child = Object.assign(new EventEmitter(), {
            stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true),
        }) satisfies SimulatorOperationChild;
        spawn.mockReturnValue(child);
        const resource: SimulatorDeviceResourceV1 = {
            v: 1, simulatorId: 'logs-device', deviceId: 'logs-device', platform: 'ios', displayName: 'iPhone',
            capture: { status: 'available', sourceId: 'screen', supportedCodecs: ['image.mjpeg'], inputMode: 'none' },
        };
        const frames: { payloadKind: string; payloadBase64: string }[] = [];
        const input: MachineLiveStreamCaptureStartInput = {
            streamId: 'logs-stream', streamFamily: 'screen', sourceMachineId: 'mac', targetMachineId: 'mac',
            caps: maxFrameBytes === undefined ? {} : { maxFrameBytes },
            startRequest: { v: 1, streamId: 'logs-stream', streamFamily: 'screen', sourceMachineId: 'mac', targetMachineId: 'mac', routeKind: 'server_relay', codecId: 'image.mjpeg' },
            startedAtMs: 0, expiresAtMs: Infinity, nowMs: () => 1,
            offerFrame: frame => { frames.push(frame); return { ok: true }; },
            applyControl: () => ({ ok: true }), emitReceipt: () => {},
        };
        const adapter = withSimulatorLogs(resource, createSimulatorFrameProducerCaptureAdapter({
            sourceId: 'screen', sourceCodecs: ['image.mjpeg'],
            // Platform frame producer boundary: this test exercises its real capture adapter.
            producer: { start: async () => ({ stop() {} }) },
        }));
        const result = await adapter.start(input);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('Capture failed to start');
        try {
            child.stdout.write('I/App: viewer log\n');
            expect(readSimulatorLogSideband(resource.simulatorId)).toMatchObject({ kind: 'logs', message: 'I/App: viewer log' });
            expect(frames.map(frame => JSON.parse(Buffer.from(frame.payloadBase64, 'base64').toString()))).toContainEqual(
                expect.objectContaining({ kind: 'logs', message: 'I/App: viewer log' }),
            );
        } finally {
            await result.session.stop();
        }
        expect(readSimulatorLogSideband(resource.simulatorId)).toBeUndefined();
        expect(child.kill).toHaveBeenCalledOnce();
    });
});
