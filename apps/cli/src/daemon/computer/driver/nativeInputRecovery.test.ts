import { describe, expect, it, vi } from 'vitest';
import { native, target, captureResult } from './nativeComputerBoundary.testkit';
import { createManagedComputerDriver } from './managedComputerDriver';
import { createComputerCaptureSource } from '../source';
import { createComputerRoutes } from '../routes';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';

// Keep lifecycle/admission real beneath the shared stdio process boundary.
describe.skipIf(process.platform !== 'linux')('native input settlement and recovery', () => {
  it('keeps a proven capture target refusal known and allows a fresh observation', async () => {
    let refused = true;
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state' ? captureResult()
      : refused ? { isError: true, structuredContent: { effect: 'refused', error: { code: 'capture_target_mismatch' } } }
        : { structuredContent: { effect: 'unverifiable' } });
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      const capture = await driver.capture(target);
      expect(await driver.input(target, capture.captureId, { kind: 'click', x: 1, y: 1 }))
        .toEqual({ status: 'failed', code: 'capture_target_mismatch' });
      refused = false;
      const fresh = await driver.capture(target);
      expect(await driver.input(target, fresh.captureId, { kind: 'click', x: 1, y: 1 })).toEqual({ status: 'dispatched' });
    } finally { await driver.close(); }
  });

  it('refuses an old click after the window moves and admits a freshly captured origin', async () => {
    let originX = -20;
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state'
      ? { ...captureResult(), structuredContent: { ...captureResult().structuredContent,
        window_bounds: { ...captureResult().structuredContent.window_bounds, x: originX } } }
      : { structuredContent: { effect: 'unverifiable' } });
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      const capture = await driver.capture(target);
      originX = 60;
      expect(await driver.input(target, capture.captureId, { kind: 'click', x: 1, y: 1 }))
        .toEqual({ status: 'failed', code: 'stale_capture' });
      expect(native.tools.some(tool => tool.name === 'click')).toBe(false);
      const fresh = await driver.capture(target);
      expect(await driver.input(target, fresh.captureId, { kind: 'click', x: 1, y: 1 })).toEqual({ status: 'dispatched' });
    } finally { await driver.close(); }
  });

  it.each([false, true])('reselects an uncertain native source only after process exit and fresh observation (pending viewer: %s)', async pendingViewer => {
    let failClick = true;
    let nextCapture = 0;
    let viewerCaptures = 0;
    let framePending = false;
    native.call.mockImplementation(async ({ name }, transport: object) => {
      if (pendingViewer && name === 'get_window_state' && transport === native.instances[1] && viewerCaptures++ > 0) {
        framePending = true;
        return new Promise(() => {});
      }
      if (name === 'get_window_state') return { ...captureResult(), structuredContent: {
        ...captureResult().structuredContent, capture_id: `recovery-${nextCapture++}` } };
      if (name === 'list_windows') return { structuredContent: { windows: [{ pid: 42, window_id: 123, title: 'Editor' }] } };
      if (name === 'click' && failClick) throw new Error('lost native acknowledgement');
      return { structuredContent: { effect: 'unverifiable' } };
    });
    const registry = createMachineLiveStreamCaptureRegistry();
    const source = createComputerCaptureSource({ sessionId: 'session', target, executablePath: '/managed/cua-driver' });
    registry.register({ sourceId: source.sourceId, streamFamily: 'screen', computer: source, adapter: source.adapter,
      capabilities: { v: 1, sourceId: source.sourceId, sourceKind: 'screen', supportedCodecs: ['image.frame.v1'], inputMode: 'shared', sidebands: [], health: { status: 'available' } } });
    const routes = createComputerRoutes({ machineId: 'machine', registry, executablePath: '/managed/cua-driver' });
    const context = { authority: 'present_user' as const, defaultSessionId: 'session' };
    const oldCapture = await source.observe();
    if (pendingViewer) {
      const stream = await source.adapter.start({ streamId: 'recovery-stream', streamFamily: 'screen',
        sourceMachineId: 'machine', targetMachineId: 'machine', caps: {},
        startRequest: { v: 1, streamId: 'recovery-stream', streamFamily: 'screen', sourceId: source.sourceId,
          codecId: 'image.frame.v1', routeKind: 'loopback_direct', sourceMachineId: 'machine', targetMachineId: 'machine' },
        startedAtMs: 0, expiresAtMs: Number.POSITIVE_INFINITY, nowMs: () => 0,
        offerFrame: () => ({ ok: true }), applyControl: () => ({ ok: true }), emitReceipt() {} });
      if (!stream.ok) throw new Error(stream.reasonCode);
      expect(stream.session.applySidebandControl?.({ v: 1, streamId: 'recovery-stream', sourceId: source.sourceId,
        eventId: 'new-viewer-frame', kind: 'request_keyframe' })).toEqual({ ok: true });
      await vi.waitFor(() => expect(framePending).toBe(true));
    }
    expect(await source.input(oldCapture.captureId, { kind: 'click', x: 1, y: 1 }, 'agent'))
      .toMatchObject({ status: 'interrupted', completion: 'unknown' });
    expect(source.status().uncertain).toBe(true);
    const oldTransport = native.instances[0]!;
    native.close.mockImplementation(async (transport: { onclose?: () => void }) => {
      if (transport !== oldTransport) transport.onclose?.();
    });
    let finished = false;
    const repair = routes.dispatch('computer.target.select', { machineId: 'machine', target }, context)
      .then(result => { finished = true; return result; });
    await vi.waitFor(() => expect(oldTransport.close).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(registry.list()[0]?.computer).toBe(source);
    failClick = false;
    oldTransport.onclose?.();
    const selected = await repair;
    expect(selected).toMatchObject({ selectedTarget: target });
    const freshSource = registry.list()[0]!.computer!;
    expect(freshSource.sourceId).not.toBe(source.sourceId);
    await expect(source.observe()).rejects.toThrow('capture_source_unavailable');
    expect(await routes.dispatch('computer.input', { machineId: 'machine', sourceId: source.sourceId,
      captureId: oldCapture.captureId, operation: { kind: 'click', x: 1, y: 1 } }, context))
      .toMatchObject({ ok: false, errorCode: 'computer_target_selection_changed' });
    expect(await freshSource.input(oldCapture.captureId, { kind: 'click', x: 1, y: 1 }, 'agent'))
      .toMatchObject({ status: 'failed', code: 'stale_capture' });
    const freshCapture = await freshSource.observe();
    expect(await freshSource.input(freshCapture.captureId, { kind: 'click', x: 1, y: 1 }, 'agent'))
      .toMatchObject({ status: 'dispatched' });
    expect(native.tools.filter(tool => tool.name === 'click')).toHaveLength(2);
    await routes.dispose();
  });

  it('returns typed native initialization failure while selecting a source', async () => {
    const routes = createComputerRoutes({ machineId: 'machine', registry: createMachineLiveStreamCaptureRegistry(), executablePath: 'relative-driver' });
    expect(await routes.dispatch('computer.target.select', { machineId: 'machine', target },
      { authority: 'present_user', defaultSessionId: 'session' }))
      .toMatchObject({ ok: false, errorCode: 'driver_executable_invalid' });
    await routes.dispose();
  });

  it('retires the same target when an input becomes uncertain during awaited source enumeration', async () => {
    let rejectClick: ((error: Error) => void) | undefined;
    let finishEnumeration: ((value: unknown) => void) | undefined;
    native.call.mockImplementation(({ name }) => name === 'get_window_state' ? Promise.resolve(captureResult())
      : name === 'click' ? new Promise((_resolve, reject) => { rejectClick = reject; })
        : name === 'list_windows' ? new Promise(resolve => { finishEnumeration = resolve; })
          : Promise.resolve({ structuredContent: {} }));
    const registry = createMachineLiveStreamCaptureRegistry();
    const source = createComputerCaptureSource({ sessionId: 'session', target, executablePath: '/managed/cua-driver' });
    registry.register({ sourceId: source.sourceId, streamFamily: 'screen', computer: source, adapter: source.adapter,
      capabilities: { v: 1, sourceId: source.sourceId, sourceKind: 'screen', supportedCodecs: ['image.frame.v1'], inputMode: 'shared', sidebands: [], health: { status: 'available' } } });
    const routes = createComputerRoutes({ machineId: 'machine', registry, executablePath: '/managed/cua-driver', defaultDisplayId: ':73' });
    const captured = await source.observe();
    const clicking = source.input(captured.captureId, { kind: 'click', x: 1, y: 1 }, 'agent');
    await vi.waitFor(() => expect(rejectClick).toBeDefined());
    const selecting = routes.dispatch('computer.target.select', { machineId: 'machine', requestedTarget: 'Editor' },
      { authority: 'present_user', defaultSessionId: 'session' });
    const windows = { structuredContent: { windows: [{ pid: 42, window_id: 123, title: 'Editor' }] } };
    try {
      await vi.waitFor(() => expect(finishEnumeration).toBeDefined());
      rejectClick?.(new Error('lost click acknowledgement during enumeration'));
      expect(await clicking).toMatchObject({ status: 'interrupted', completion: 'unknown' });
      finishEnumeration?.(windows);
      expect(await selecting).toMatchObject({ selectedTarget: target });
      expect(registry.list()[0]?.computer?.sourceId).not.toBe(source.sourceId);
      await expect(source.observe()).rejects.toThrow('capture_source_unavailable');
    } finally {
      rejectClick?.(new Error('settle deferred native click'));
      finishEnumeration?.(windows);
      await Promise.allSettled([clicking, selecting]);
      await routes.dispose();
    }
  });

  it('retires an uncertain source while the viewer native initialization acknowledgement is pending', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state' ? captureResult()
      : { isError: true, structuredContent: { effect: 'refused', error: { code: 'tool_error' } } });
    const source = createComputerCaptureSource({ sessionId: 'session', target, executablePath: '/managed/cua-driver' });
    const captured = await source.observe();
    native.initialize.mockImplementation(() => new Promise(() => {}));
    const viewer = source.adapter.start({ streamId: 'initializing-viewer', streamFamily: 'screen',
      sourceMachineId: 'machine', targetMachineId: 'machine', caps: {},
      startRequest: { v: 1, streamId: 'initializing-viewer', streamFamily: 'screen', sourceId: source.sourceId,
        codecId: 'image.frame.v1', routeKind: 'loopback_direct', sourceMachineId: 'machine', targetMachineId: 'machine' },
      startedAtMs: 0, expiresAtMs: Number.POSITIVE_INFINITY, nowMs: () => 0,
      offerFrame: () => ({ ok: true }), applyControl: () => ({ ok: true }), emitReceipt() {} }).catch(() => undefined);
    await vi.waitFor(() => expect(native.instances).toHaveLength(2));
    expect(await source.input(captured.captureId, { kind: 'click', x: 1, y: 1 }, 'agent'))
      .toMatchObject({ status: 'interrupted', completion: 'unknown' });
    const closing = source.close();
    try {
      await vi.waitFor(() => expect(native.instances[1]?.close).toHaveBeenCalledOnce());
      expect(await closing).toEqual({ completion: 'unknown' });
      await viewer;
      await expect(source.observe()).rejects.toThrow('capture_source_unavailable');
    } finally {
      // Settle a deliberately unanswered handshake even when the retirement assertion is RED.
      native.instances[1]?.onclose?.();
      await closing;
      await viewer;
    }
  });

  it('returns typed native failure when reading an unusable selected source', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state' ? captureResult()
      : { isError: true, structuredContent: { effect: 'refused', error: { code: 'tool_error' } } });
    const registry = createMachineLiveStreamCaptureRegistry();
    const source = createComputerCaptureSource({ sessionId: 'session', target, executablePath: '/managed/cua-driver' });
    registry.register({ sourceId: source.sourceId, streamFamily: 'screen', computer: source, adapter: source.adapter,
      capabilities: { v: 1, sourceId: source.sourceId, sourceKind: 'screen', supportedCodecs: ['image.frame.v1'], inputMode: 'shared', sidebands: [], health: { status: 'available' } } });
    const routes = createComputerRoutes({ machineId: 'machine', registry, executablePath: '/managed/cua-driver' });
    const captured = await source.observe();
    await source.input(captured.captureId, { kind: 'click', x: 1, y: 1 }, 'agent');
    try {
      expect(await routes.dispatch('computer.target.get', { machineId: 'machine' },
        { authority: 'present_user', defaultSessionId: 'session' }))
        .toMatchObject({ ok: false, errorCode: 'driver_unavailable' });
      expect(registry.list()[0]?.computer).toBe(source);
    } finally { await routes.dispose(); }
  });

  it('reports unknown completion for an input failure that does not prove refusal before dispatch', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state' ? captureResult() : {
      isError: true, content: [], structuredContent: { effect: 'refused', error: { code: 'tool_error' } },
    });
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      const capture = await driver.capture(target);
      expect(await driver.input(target, capture.captureId, { kind: 'click', x: 1, y: 1 })).toEqual({ status: 'interrupted', completion: 'unknown' });
      expect(await driver.input(target, capture.captureId, { kind: 'click', x: 1, y: 1 })).toEqual({ status: 'failed', code: 'driver_unavailable' });
    } finally { await driver.close(); }
  });

});
