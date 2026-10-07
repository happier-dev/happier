import { describe, expect, it, vi } from 'vitest';
import { ComputerControlStatusResponseV1Schema, type MachineLiveStreamFrameV1 } from '@happier-dev/protocol';
import type { ComputerDriverCapture, ComputerDriverInputResult, ManagedComputerDriver } from './driver/managedComputerDriver';
import { createComputerCaptureSource } from './source';

// The native OS adapter is the external boundary; source, input arbitration and stream adapter stay real.
const native = vi.hoisted(() => ({
  capture: vi.fn<ManagedComputerDriver['capture']>(), captureFrame: vi.fn<ManagedComputerDriver['captureFrame']>(),
  input: vi.fn<ManagedComputerDriver['input']>(), close: vi.fn<ManagedComputerDriver['close']>(),
  listTargets: vi.fn<ManagedComputerDriver['listTargets']>(async () => { throw new Error('Unexpected native enumeration'); }),
  checkPermissions: vi.fn<ManagedComputerDriver['checkPermissions']>(async () => { throw new Error('Unexpected native permission read'); }),
}));
vi.mock('./driver/managedComputerDriver', () => ({ createManagedComputerDriver: async (): Promise<ManagedComputerDriver> => native }));

const geometry = { captureWidth: 100, captureHeight: 100, nativeWidth: 100, nativeHeight: 100,
  originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 100, height: 100 } };
const observation: ComputerDriverCapture = { png: Buffer.from('pixels'), captureId: 'capture', geometry,
  accessibility: { complete: true, nodes: [{ id: 'button', role: 'button', name: 'Sign in', bounds: { x: 10, y: 10, width: 20, height: 20 } }] } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

describe('computer source status projection', () => {
  it('streams actual agent activity and takeover settlement without using image cadence', async () => {
    const captured = deferred<ComputerDriverCapture>();
    const dispatched = deferred<ComputerDriverInputResult>();
    const inputEntered = deferred<void>();
    native.capture.mockReturnValue(captured.promise);
    native.captureFrame.mockResolvedValue({ png: observation.png, geometry });
    native.input.mockImplementation(() => { inputEntered.resolve(undefined); return dispatched.promise; });
    native.close.mockResolvedValue(undefined);
    const source = createComputerCaptureSource({ sessionId: 'session', target: { kind: 'window', displayId: ':77', pid: 1, windowId: 2 } });
    const frames: MachineLiveStreamFrameV1[] = [];
    const stream = await source.adapter.start({ streamId: 'stream', streamFamily: 'screen',
      sourceMachineId: 'machine', targetMachineId: 'machine', caps: {},
      startRequest: { v: 1, streamId: 'stream', streamFamily: 'screen', sourceId: source.sourceId, codecId: 'image.frame.v1',
        routeKind: 'loopback_direct', sourceMachineId: 'machine', targetMachineId: 'machine' },
      startedAtMs: 0, expiresAtMs: 60_000, nowMs: () => 0,
      offerFrame(frame) { frames.push(frame); return { ok: true }; }, applyControl: () => ({ ok: true }), emitReceipt() {} });
    if (!stream.ok) throw new Error(stream.reasonCode);
    const statuses = () => frames.filter(frame => frame.payloadKind === 'metadata').map(frame =>
      ComputerControlStatusResponseV1Schema.parse(JSON.parse(Buffer.from(frame.payloadBase64, 'base64').toString('utf8'))));
    const pending: Promise<unknown>[] = [];
    try {
      const capture = source.observe();
      pending.push(capture);
      expect(statuses().at(-1)).toMatchObject({ sourceId: source.sourceId, activity: { kind: 'capture' } });
      captured.resolve(observation);
      await capture;
      expect(statuses().at(-1)?.activity).toBeUndefined();
      const input = source.input('capture', { kind: 'click', x: 15, y: 15 }, 'agent');
      pending.push(input);
      expect(statuses().at(-1)).toMatchObject({ controller: 'agent', activity: { kind: 'click', targetLabel: 'Sign in' },
        activeTarget: { x: 0.2, y: 0.2, width: 0.2, height: 0.2, label: 'Sign in' } });
      await inputEntered.promise;
      const interrupt = source.interrupt();
      expect(statuses().at(-1)).toMatchObject({ controller: 'human', stopping: true });
      dispatched.resolve({ status: 'interrupted', completion: 'unknown' });
      await input;
      await interrupt;
      expect(statuses().at(-1)).toMatchObject({ controller: 'human', stopping: false, uncertain: true });
      expect(statuses().at(-1)?.activity).toBeUndefined();
      await source.observe('human');
      expect(statuses().at(-1)).toMatchObject({ controller: 'human', uncertain: false });
      source.handBack();
      expect(statuses().at(-1)).toMatchObject({ controller: 'idle', uncertain: false });
      // The viewer never acknowledged the first image; status still advanced through every transition.
      expect(frames.filter(frame => frame.payloadKind === 'image_keyframe')).toHaveLength(1);
    } finally {
      captured.resolve(observation);
      dispatched.resolve({ status: 'dispatched' });
      await Promise.allSettled(pending);
      await stream.session.stop();
      await source.close();
    }
  });
});
