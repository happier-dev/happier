import { describe, expect, it, vi } from 'vitest';
import { ComputerActionResultV1Schema, ComputerControlStatusResponseV1Schema, type MachineLiveStreamFrameV1 } from '@happier-dev/protocol';
import { backgroundTextRefusalResult, native, target, captureResult } from './driver/nativeComputerBoundary.testkit';
import { createComputerCaptureSource } from './source';

// Source, driver, native codec and input recovery stay real beneath the shared stdio boundary.
function observation() {
  const result = captureResult();
  return { ...result, structuredContent: { ...result.structuredContent,
    window_bounds: { x: 0, y: 0, width: 200, height: 100 },
    elements: [{ element_index: 0, role: 'button', label: 'Sign in', frame: { x: 20, y: 10, w: 40, h: 20 } }],
  } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

describe.skipIf(process.platform !== 'linux')('computer source status projection', () => {
  it.each(['first', 'subsequent'] as const)('preserves safe native capture refusals and hides unknown errors on the %s frame', async phase => {
    for (const failure of ['capture_permission_denied', 'capture_permission_unknown', 'target_mismatch', 'target_not_found', 'capture_unavailable', 'driver_unavailable', 'driver_result_invalid', 'unknown-code', 'exception']) {
      let failCapture = phase === 'first';
      native.call.mockImplementation(async ({ name }) => {
        if (name !== 'get_window_state') return { structuredContent: { x11: true, xsend_event: true } };
        if (!failCapture) return observation();
        if (failure === 'exception') throw new Error('private native exception');
        return { isError: true, structuredContent: { code: failure, detail: 'private native detail' } };
      });
      const source = createComputerCaptureSource({ sessionId: 'capture-refusal', target, executablePath: '/managed/cua-driver' });
      const receipt = deferred<string>();
      // The real stdio codec classifies a lost native reply as driver_unavailable.
      const expected = failure === 'unknown-code' ? 'capture_source_unavailable'
        : failure === 'exception' ? 'driver_unavailable' : failure;
      const stream = await source.adapter.start({ streamId: 'capture-refusal', streamFamily: 'screen', sourceMachineId: 'machine', targetMachineId: 'machine', caps: {},
        startRequest: { v: 1, streamId: 'capture-refusal', streamFamily: 'screen', sourceId: source.sourceId, codecId: 'image.frame.v1',
          routeKind: 'loopback_direct', sourceMachineId: 'machine', targetMachineId: 'machine' },
        startedAtMs: 0, expiresAtMs: 60_000, nowMs: () => 0, offerFrame: () => ({ ok: true }), applyControl: () => ({ ok: true }),
        emitReceipt(value) { if (value.reasonCode) receipt.resolve(value.reasonCode); } });
      try {
        if (phase === 'first') expect(stream).toMatchObject({ ok: false, reasonCode: expected });
        else {
          if (!stream.ok) throw new Error(stream.reasonCode);
          failCapture = true;
          stream.session.applySidebandControl?.({ v: 1, streamId: 'capture-refusal', sourceId: source.sourceId,
            eventId: 'next-frame', kind: 'request_keyframe' });
          expect(await receipt.promise).toBe(expected);
        }
      } finally {
        if (stream.ok) await stream.session.stop();
        await source.close();
      }
    }
  });
  it.each(['native', 'transport'] as const)('retains a native text refusal cause only when available for an interrupted agent action: %s', async failure => {
    native.call.mockImplementation(async ({ name }) => {
      if (name === 'get_window_state') return observation();
      if (failure === 'transport') throw new Error('Lost native acknowledgement');
      return backgroundTextRefusalResult();
    });
    const source = createComputerCaptureSource({ sessionId: 'agent-text-refusal', target, executablePath: '/managed/cua-driver' });
    try {
      const capture = await source.observe();
      const result = ComputerActionResultV1Schema.parse(await source.input(capture.captureId, { kind: 'type', text: 'a' }, 'agent'));
      expect(result).toMatchObject({ status: 'interrupted', completion: 'unknown' });
      if (failure === 'native') expect(result).toHaveProperty('code', 'background_unavailable');
      else expect(result).not.toHaveProperty('code');
      expect(source.status()).toMatchObject({ uncertain: true });
    } finally { await source.close(); }
  });
  it('retains a native text refusal cause in the human receipt without allowing later input', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state' ? observation() : backgroundTextRefusalResult());
    const source = createComputerCaptureSource({ sessionId: 'viewer-text-refusal', target, executablePath: '/managed/cua-driver' });
    const first = deferred<string>();
    const later = deferred<string>();
    const failures: string[] = [];
    const stream = await source.adapter.start({ streamId: 'text-refusal', streamFamily: 'screen', sourceMachineId: 'machine', targetMachineId: 'machine', caps: {},
      startRequest: { v: 1, streamId: 'text-refusal', streamFamily: 'screen', sourceId: source.sourceId, codecId: 'image.frame.v1',
        routeKind: 'loopback_direct', sourceMachineId: 'machine', targetMachineId: 'machine' },
      startedAtMs: 0, expiresAtMs: 60_000, nowMs: () => 0, offerFrame: () => ({ ok: true }), applyControl: () => ({ ok: true }),
      emitReceipt(receipt) {
        if (!receipt.reasonCode) return;
        failures.push(receipt.reasonCode);
        (failures.length === 1 ? first : later).resolve(receipt.reasonCode);
      } });
    if (!stream.ok) throw new Error(stream.reasonCode);
    try {
      await source.observe();
      expect(stream.session.applySidebandControl?.({ v: 1, streamId: 'text-refusal', sourceId: source.sourceId,
        eventId: 'text', kind: 'keyboard_text', text: 'a' })).toEqual({ ok: true });
      expect(await first.promise).toBe('background_unavailable');
      expect(source.status()).toMatchObject({ controller: 'human', uncertain: true });
      expect(stream.session.applySidebandControl?.({ v: 1, streamId: 'text-refusal', sourceId: source.sourceId,
        eventId: 'later-key', kind: 'keyboard_key', key: 'Return' })).toEqual({ ok: true });
      expect(await later.promise).toBe('human_input_interruption_uncertain');
      expect(native.tools.filter(tool => tool.name === 'press_key')).toEqual([]);
    } finally { await stream.session.stop(); await source.close(); }
  });
  it('preserves viewer key modifiers through the real source and pinned native driver', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state' ? observation()
      : name === 'check_permissions' ? { structuredContent: { x11: true, xsend_event: true } }
        : { structuredContent: { effect: 'unverifiable' } });
    const source = createComputerCaptureSource({ sessionId: 'viewer-modifiers', target, executablePath: '/managed/cua-driver' });
    const stream = await source.adapter.start({ streamId: 'modifiers', streamFamily: 'screen', sourceMachineId: 'machine', targetMachineId: 'machine', caps: {},
      startRequest: { v: 1, streamId: 'modifiers', streamFamily: 'screen', sourceId: source.sourceId, codecId: 'image.frame.v1',
        routeKind: 'loopback_direct', sourceMachineId: 'machine', targetMachineId: 'machine' },
      startedAtMs: 0, expiresAtMs: 60_000, nowMs: () => 0, offerFrame: () => ({ ok: true }), applyControl: () => ({ ok: true }), emitReceipt: () => {} });
    if (!stream.ok) throw new Error(stream.reasonCode);
    try {
      await source.interrupt();
      stream.session.applySidebandControl?.({ v: 1, streamId: 'modifiers', sourceId: source.sourceId, eventId: 'key', kind: 'keyboard_key', key: 'Tab', modifiers: ['control', 'shift'] });
      await vi.waitFor(() => expect(native.tools.find(tool => tool.name === 'press_key')?.arguments)
        .toMatchObject({ key: 'Tab', modifiers: ['control', 'shift'] }));
    } finally { await stream.session.stop(); await source.close(); }
  });
  it('binds an element snapshot to its immutable provider and refuses another snapshot before native input', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state' ? observation()
      : { structuredContent: { x11: true, xsend_event: true } });
    const source = createComputerCaptureSource({ sessionId: 'provider-snapshot', target, provider: 'cua', executablePath: '/managed/cua-driver' });
    try {
      const capture = await source.observe();
      expect(source.provider).toBe('cua');
      expect(capture).toMatchObject({ provider: 'cua' });
      const workBefore = native.tools.length;
      expect(await source.input('another-provider-capture', { kind: 'element', elementId: '0', action: 'click' }, 'agent'))
        .toMatchObject({ status: 'failed', code: 'computer_element_stale', provider: 'cua' });
      expect(native.tools.slice(workBefore)).toEqual([]);
    } finally { await source.close(); }
  });

  it('keeps retired status readable without starting a native process or claiming fresh grants', async () => {
    native.call.mockResolvedValue({ structuredContent: { x11: true, xsend_event: true } });
    const source = createComputerCaptureSource({ sessionId: 'retired-status', target, executablePath: '/managed/cua-driver' });
    await source.close();
    expect(await source.readStatus()).toEqual(source.status());
    expect(native.instances).toHaveLength(0);
  });

  it('delivers admitted viewer keys and text without screenshot or accessibility work and still requires a fresh agent observation after hand-back', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state' ? observation()
      : name === 'check_permissions' ? { structuredContent: { x11: true, xsend_event: true } }
        : { structuredContent: { effect: 'unverifiable' } });
    const source = createComputerCaptureSource({ sessionId: 'interactive-keyboard', target, executablePath: '/managed/cua-driver' });
    const failures: string[] = [];
    const stream = await source.adapter.start({ streamId: 'keyboard-viewer', streamFamily: 'screen',
      sourceMachineId: 'machine', targetMachineId: 'machine', caps: {},
      startRequest: { v: 1, streamId: 'keyboard-viewer', streamFamily: 'screen', sourceId: source.sourceId, codecId: 'image.frame.v1',
        routeKind: 'loopback_direct', sourceMachineId: 'machine', targetMachineId: 'machine' },
      startedAtMs: 0, expiresAtMs: 60_000, nowMs: () => 0,
      offerFrame: () => ({ ok: true }), applyControl: () => ({ ok: true }),
      emitReceipt(receipt) { if (receipt.reasonCode) failures.push(receipt.reasonCode); },
    });
    if (!stream.ok) throw new Error(stream.reasonCode);
    try {
      const capture = await source.observe();
      const start = native.tools.length;
      for (const event of [{ kind: 'keyboard_text', text: 'hello' }, { kind: 'keyboard_key', key: 'Return' }] as const) {
        expect(stream.session.applySidebandControl?.({ v: 1, streamId: 'keyboard-viewer', sourceId: source.sourceId,
          eventId: event.kind, ...event })).toEqual({ ok: true });
      }
      await vi.waitFor(() => expect(native.tools.some(tool => tool.name === 'press_key')).toBe(true));
      expect(failures).toEqual([]);
      const keyboardWork = native.tools.slice(start);
      expect(keyboardWork.filter(tool => tool.name === 'get_window_state')).toEqual([]);
      expect(keyboardWork.find(tool => tool.name === 'type_text')?.arguments).toMatchObject({ pid: target.pid, window_id: target.windowId, text: 'hello', delivery_mode: 'background' });
      expect(source.status()).toMatchObject({ controller: 'human', uncertain: false });
      await vi.waitFor(() => expect(source.handBack()).toBe(true));
      expect(await source.input(capture.captureId, { kind: 'press', key: 'Return' }, 'agent'))
        .toMatchObject({ status: 'failed', code: 'observation_required' });
      const fresh = await source.observe();
      expect(await source.input(fresh.captureId, { kind: 'press', key: 'Return' }, 'agent')).toMatchObject({ status: 'dispatched' });
    } finally { await stream.session.stop(); await source.close(); }
  });

  it.each(['unknown', 'stale'] as const)('reports the actual %s native viewer input failure without replaying physical input', async kind => {
    let physicalInputs = 0;
    native.call.mockImplementation(async ({ name, arguments: args }) => {
      if (name === 'get_window_state') {
        const result = observation();
        // Moving after the fresh viewer observation refuses before the physical effect.
        if (kind === 'stale' && args.display_only === true) result.structuredContent.window_bounds.x = 1;
        return result;
      }
      if (name === 'click') { physicalInputs += 1; throw new Error('Lost native acknowledgement'); }
      throw new Error(`Unexpected native method ${name}`);
    });
    const source = createComputerCaptureSource({ sessionId: 'native-unknown', target, executablePath: '/managed/cua-driver' });
    const failure = deferred<string>();
    const stream = await source.adapter.start({ streamId: 'viewer-input', streamFamily: 'screen',
      sourceMachineId: 'machine', targetMachineId: 'machine', caps: {},
      startRequest: { v: 1, streamId: 'viewer-input', streamFamily: 'screen', sourceId: source.sourceId, codecId: 'image.frame.v1',
        routeKind: 'loopback_direct', sourceMachineId: 'machine', targetMachineId: 'machine' },
      startedAtMs: 0, expiresAtMs: 60_000, nowMs: () => 0,
      offerFrame: () => ({ ok: true }), applyControl: () => ({ ok: true }),
      emitReceipt(receipt) { if (receipt.reasonCode) failure.resolve(receipt.reasonCode); },
    });
    if (!stream.ok) throw new Error(stream.reasonCode);
    try {
      expect(stream.session.applySidebandControl?.({ v: 1, streamId: 'viewer-input', sourceId: source.sourceId,
        eventId: 'click-1', kind: 'tap', x: 0.5, y: 0.5 })).toEqual({ ok: true });
      expect(await failure.promise).toBe(kind === 'unknown' ? 'human_input_interruption_uncertain' : 'stale_capture');
      expect(source.status()).toMatchObject({ controller: 'human', uncertain: kind === 'unknown' });
      expect(physicalInputs).toBe(kind === 'unknown' ? 1 : 0);
    } finally {
      await stream.session.stop();
      await source.close();
    }
  });
  it('streams actual agent activity and takeover settlement without using image cadence', async () => {
    const captured = deferred<ReturnType<typeof observation>>();
    const dispatched = deferred<void>();
    const inputEntered = deferred<void>();
    let physicalInputs = 0;
    native.call.mockImplementation(async ({ name, arguments: args }) => {
      if (name === 'get_window_state') return args.include_accessibility_tree && args.include_screenshot ? captured.promise : observation();
      if (name === 'click') {
        physicalInputs += 1;
        inputEntered.resolve(undefined);
        await dispatched.promise;
        throw new Error('Lost native acknowledgement');
      }
      throw new Error(`Unexpected native method ${name}`);
    });
    const source = createComputerCaptureSource({ sessionId: 'session', target, executablePath: '/managed/cua-driver' });
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
      captured.resolve(observation());
      await capture;
      expect(statuses().at(-1)?.activity).toBeUndefined();
      const input = source.input('capture-1', { kind: 'click', x: 30, y: 15 }, 'agent');
      pending.push(input);
      expect(statuses().at(-1)).toMatchObject({ controller: 'agent', activity: { kind: 'click', targetLabel: 'Sign in' },
        activeTarget: { x: 0.2, y: 0.2, width: 0.2, height: 0.2, label: 'Sign in' } });
      await inputEntered.promise;
      const interrupt = source.interrupt();
      expect(statuses().at(-1)).toMatchObject({ controller: 'human', stopping: true });
      dispatched.resolve(undefined);
      await input;
      await interrupt;
      expect(statuses().at(-1)).toMatchObject({ controller: 'human', stopping: false, uncertain: true });
      expect(statuses().at(-1)?.activity).toBeUndefined();
      // The real driver quarantines unknown physical settlement. An unchanged
      // source cannot claim repair; the reselect journey lives in nativeInputRecovery.test.ts.
      await expect(source.observe('human')).rejects.toThrow('driver_unavailable');
      source.handBack();
      expect(source.status()).toMatchObject({ controller: 'idle', uncertain: true });
      expect(physicalInputs).toBe(1);
      // The viewer never acknowledged the first image; status still advanced through every transition.
      expect(frames.filter(frame => frame.payloadKind === 'image_keyframe')).toHaveLength(1);
    } finally {
      captured.resolve(observation());
      dispatched.resolve(undefined);
      await Promise.allSettled(pending);
      await stream.session.stop();
      await source.close();
    }
  });
});
