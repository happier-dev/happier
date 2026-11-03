import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineLiveStreamControlSidebandV1Schema } from '@happier-dev/protocol';

import { createAgentDesktopComputerDriver } from './agentDesktopDriver';
import { createManagedComputerDriver } from './managedComputerDriver';
import { createComputerCaptureSource } from '../source';

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), calls: [] as string[][] }));
// Only the native subprocess boundary is replaced; schemas, grounding and settlement run normally.
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: boundary.spawn }));

const target = { kind: 'window', displayId: ':73', pid: 42, windowId: 'atspi:1.42:/window/1' } as const;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAABk';
const window = { id: target.windowId, pid: target.pid, title: 'Fixture', app_name: 'Fixture', bounds: { x: 20, y: 30, width: 200, height: 100 } };
function nativeResponse(args: string[]): unknown {
  return args.includes('list-windows') ? [window]
  : args.includes('list-displays') ? [{ id: '0', bounds: { x: 0, y: 0, width: 800, height: 600 }, is_primary: true, scale: 1 }]
    : args.includes('snapshot') ? { snapshot_id: 's1', window, complete: true, tree: { role: 'window', children: [
      { ref_id: '@s1:e1', role: 'button', name: 'Apply', bounds: { x: 30, y: 40, width: 20, height: 10 } },
      { ref_id: '@s1:e2', role: 'textfield', name: 'Name', value: 'old', states: ['focused'] },
    ] } }
      : args.includes('screenshot') ? { data: png, format: 'png', width: 200, height: 100, scale_factor: 1 }
        : { action: args[0], disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } };
}
function setup(respond: (args: string[]) => unknown = nativeResponse) {
  boundary.calls.length = 0;
  boundary.spawn.mockImplementation((_path: string, args: string[]) => {
    boundary.calls.push(args);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(), exitCode: null });
    queueMicrotask(async () => {
      const data = await respond(args);
      const envelope = typeof data === 'object' && data !== null && 'ok' in data ? data : { version: '2.5', ok: true, command: args.find(a => !a.startsWith('--')), data };
      child.stdout.end(JSON.stringify(envelope));
      child.emit('close', 0, null);
    });
    return child;
  });
}
afterEach(() => { vi.restoreAllMocks(); });

describe('agent-desktop native driver', () => {
  it('delivers viewer arrow chords using the pinned native key names without dropping modifiers', async () => {
    const delivered: string[] = [];
    const accepted = new Set(['ctrl+shift+left', 'alt+up', 'meta+right', 'down']);
    setup(args => {
      if (!args.includes('press')) return nativeResponse(args);
      const chord = args[args.indexOf('press') + 1].toLowerCase();
      // v1.0.2 platform key maps accept left/up/right/down, not DOM Arrow* names.
      if (!accepted.has(chord)) return { version: '2.5', ok: false, command: 'press',
        error: { code: 'INVALID_ARGS', disposition: { delivery: 'not_delivered', retry: 'safe' } } };
      delivered.push(chord);
      return nativeResponse(args);
    });
    const source = createComputerCaptureSource({ sessionId: 'viewer-arrows', target: { kind: 'display', displayId: ':73' },
      provider: 'agent-desktop', executablePath: '/managed/agent-desktop' });
    const failures: string[] = [];
    const stream = await source.adapter.start({ streamId: 'viewer-arrows', streamFamily: 'screen', sourceMachineId: 'machine', targetMachineId: 'machine', caps: {},
      startRequest: { v: 1, streamId: 'viewer-arrows', streamFamily: 'screen', sourceId: source.sourceId, codecId: 'image.frame.v1',
        routeKind: 'loopback_direct', sourceMachineId: 'machine', targetMachineId: 'machine' },
      startedAtMs: 0, expiresAtMs: 60_000, nowMs: () => 0, offerFrame: () => ({ ok: true }), applyControl: () => ({ ok: true }),
      emitReceipt(receipt) { if (receipt.reasonCode) failures.push(receipt.reasonCode); } });
    if (!stream.ok) throw new Error(stream.reasonCode);
    try {
      for (const event of [
        { key: 'ArrowLeft', modifiers: ['control', 'shift'] }, { key: 'ArrowUp', modifiers: ['alt'] },
        { key: 'ArrowRight', modifiers: ['meta'] }, { key: 'ArrowDown' },
      ]) {
        const sideband = MachineLiveStreamControlSidebandV1Schema.parse({ v: 1, streamId: 'viewer-arrows', sourceId: source.sourceId,
          eventId: event.key, kind: 'keyboard_key', ...event });
        expect(stream.session.applySidebandControl?.(sideband)).toEqual({ ok: true });
      }
      await vi.waitFor(() => expect(boundary.calls.filter(args => args.includes('press'))).toHaveLength(4));
      await vi.waitFor(() => expect(source.handBack()).toBe(true));
      expect(delivered).toEqual(['ctrl+shift+left', 'alt+up', 'meta+right', 'down']);
      expect(failures).toEqual([]);
    } finally { await stream.session.stop(); await source.close(); }
  });
  it('reports unsupported Fn before native input instead of silently dropping the modifier', async () => {
    setup();
    const driver = await createAgentDesktopComputerDriver({ displayId: ':73', executablePath: '/managed/agent-desktop' });
    try {
      expect(await driver.input(target, null, { kind: 'press', key: 'Tab', modifiers: ['fn'] }))
        .toEqual({ status: 'failed', code: 'input_not_supported' });
      expect(boundary.calls.some(args => args.includes('press'))).toBe(false);
    } finally { await driver.close(); }
  });
  it('maps modifier chords and modified double clicks to the pinned atomic native commands', async () => {
    setup();
    const driver = await createAgentDesktopComputerDriver({ displayId: ':73', executablePath: '/managed/agent-desktop' });
    try {
      expect(await driver.input(target, null, { kind: 'press', key: 'Tab', modifiers: ['control', 'shift'] })).toEqual({ status: 'dispatched' });
      expect(boundary.calls.find(args => args.includes('press'))).toContain('ctrl+shift+Tab');
      const capture = await driver.capture(target);
      expect(await driver.input(target, capture.captureId, { kind: 'click', x: 10, y: 20, button: 'right', clickCount: 2, modifiers: ['meta', 'control'] }))
        .toEqual({ status: 'dispatched' });
      expect(boundary.calls.find(args => args.includes('mouse-click')))
        .toEqual(['--headed', 'mouse-click', '--xy=30,50', '--button', 'right', '--count', '2', '--modifiers', 'meta', '--modifiers', 'ctrl']);
    } finally { await driver.close(); }
  });
  it.skipIf(process.platform !== 'linux').each(['preflight', 'dispatch'] as const)('keeps a released drag ahead of later hover during native %s', async phase => {
    let resumeNative!: () => void;
    const nativePending = new Promise<void>(resolve => { resumeNative = resolve; });
    let enteredNative!: () => void;
    const nativeEntered = new Promise<void>(resolve => { enteredNative = resolve; });
    let prepareDrag = false;
    let dragCaptured = false;
    setup(async args => {
      if (prepareDrag && args.includes('snapshot')) dragCaptured = true;
      if (prepareDrag && ((phase === 'preflight' && dragCaptured && args.includes('list-displays'))
        || (phase === 'dispatch' && args.includes('drag')))) {
        prepareDrag = false;
        enteredNative();
        await nativePending;
      }
      return nativeResponse(args);
    });
    const source = createComputerCaptureSource({ sessionId: 'hover-drag', target: { kind: 'display', displayId: ':73' },
      provider: 'agent-desktop', executablePath: '/managed/agent-desktop' });
    const failures: string[] = [];
    const stream = await source.adapter.start({ streamId: 'hover-drag', streamFamily: 'screen', sourceMachineId: 'machine', targetMachineId: 'machine', caps: {},
      startRequest: { v: 1, streamId: 'hover-drag', streamFamily: 'screen', sourceId: source.sourceId, codecId: 'image.frame.v1',
        routeKind: 'loopback_direct', sourceMachineId: 'machine', targetMachineId: 'machine' },
      startedAtMs: 0, expiresAtMs: 60_000, nowMs: () => 0, offerFrame: () => ({ ok: true }), applyControl: () => ({ ok: true }),
      emitReceipt(receipt) { if (receipt.reasonCode) failures.push(receipt.reasonCode); } });
    if (!stream.ok) throw new Error(stream.reasonCode);
    const sideband = { v: 1, streamId: 'hover-drag', sourceId: source.sourceId } as const;
    try {
      await source.interrupt();
      expect(stream.session.applySidebandControl?.({ ...sideband, eventId: 'before', kind: 'move', x: 0.5, y: 0.4 })).toEqual({ ok: true });
      await vi.waitFor(() => expect(boundary.calls.some(args => args.includes('mouse-move'))).toBe(true));
      prepareDrag = true;
      expect(stream.session.applySidebandControl?.({ ...sideband, eventId: 'release', kind: 'drag', fromX: 0.5, fromY: 0.4, toX: 0.6, toY: 0.5 })).toEqual({ ok: true });
      await nativeEntered;
      expect(stream.session.applySidebandControl?.({ ...sideband, eventId: 'after', kind: 'move', x: 0.6, y: 0.5 })).toEqual({ ok: true });
      resumeNative();
      await vi.waitFor(() => expect(boundary.calls.filter(args => args.includes('mouse-move'))).toHaveLength(2));
      await vi.waitFor(() => expect(source.handBack()).toBe(true));
      expect(boundary.calls.filter(args => args.includes('mouse-move') || args.includes('drag'))).toEqual([
        ['--headed', 'mouse-move', '--xy=400,240'],
        ['--headed', 'drag', '--from-xy=400,240', '--to-xy=480,300'],
        ['--headed', 'mouse-move', '--xy=480,300'],
      ]);
      expect(failures).toEqual([]);
      expect(boundary.spawn.mock.results.every(result => result.value.kill.mock.calls.length === 0)).toBe(true);
    } finally { resumeNative(); await stream.session.stop(); await source.close(); }
  });
  it('refuses clipboard writes without exposing text in native argv and preserves clipboard reads', async () => {
    let clipboard: string | null = 'remote 日本';
    setup(args => {
      if (args.includes('clipboard-get')) return clipboard === null ? { type: 'text', found: false } : { type: 'text', text: clipboard };
      if (args.includes('clipboard-set')) { clipboard = args.at(-1) ?? ''; return { type: 'text', disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } }; }
      return {};
    });
    const driver = await createAgentDesktopComputerDriver({ displayId: ':73', executablePath: '/managed/agent-desktop' });
    try {
      expect(await driver.clipboard?.(target, { kind: 'read' })).toEqual({ ok: true, text: 'remote 日本' });
      const text = '--local 👋 password\nwith whitespace';
      const result = await driver.clipboard?.(target, { kind: 'write', text });
      expect(boundary.calls.flat().some(arg => arg.includes(text))).toBe(false);
      expect(result).toEqual({ ok: false, code: 'input_not_supported' });
      expect(clipboard).toBe('remote 日本');
      expect(boundary.calls.some(args => args.includes('clipboard-set'))).toBe(false);
      clipboard = null;
      expect(await driver.clipboard?.(target, { kind: 'read' })).toEqual({ ok: false, code: 'clipboard_text_unavailable' });
    } finally { await driver.close(); }
  });
  it('maps grounded hover to physical mouse movement without a button press', async () => {
    setup();
    const driver = await createAgentDesktopComputerDriver({ displayId: ':73', executablePath: '/managed/agent-desktop' });
    try {
      const capture = await driver.capture(target);
      expect(await driver.input(target, capture.captureId, { kind: 'move', x: 10, y: 20 }))
        .toEqual({ status: 'dispatched' });
      expect(boundary.calls.find(args => args.includes('mouse-move')))
        .toEqual(['--headed', 'mouse-move', '--xy=30,50']);
    } finally { await driver.close(); }
  });
  it('captures the native snapshot window descriptor without requiring list-windows metadata', async () => {
    setup(args => args.includes('list-windows') ? [window]
      : args.includes('screenshot') ? { data: png, format: 'png', width: 200, height: 100, scale_factor: 1 }
        : { complete: true, window: { id: target.windowId, title: 'Fixture' },
          tree: { ref_id: '@s1:e1', role: 'button', name: 'Apply' } });
    const driver = await createAgentDesktopComputerDriver({ displayId: ':73', executablePath: '/managed/agent-desktop' });
    try {
      expect((await driver.capture(target)).accessibility)
        .toEqual({ complete: true, nodes: [{ id: '@s1:e1', role: 'button', name: 'Apply' }] });
    } finally { await driver.close(); }
  });
  it('uses the provider owner default for an already admitted executable', async () => {
    setup();
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/agent-desktop',
      settings: { enabledProviders: ['cua', 'agent-desktop'], defaultProvider: 'agent-desktop' } });
    try {
      expect(await driver.listTargets()).toContainEqual(expect.objectContaining({ target }));
    } finally { await driver.close(); }
  });
  it('delivers a grounded pointer click through the pinned CLI xy argument', async () => {
    setup();
    const driver = await createAgentDesktopComputerDriver({ displayId: ':73', executablePath: '/managed/agent-desktop' });
    try {
      const capture = await driver.capture(target);
      expect(await driver.input(target, capture.captureId, { kind: 'click', x: 10, y: 20 }))
        .toEqual({ status: 'dispatched' });
      // v1.0.2 mouse-click accepts --xy; independent --x/--y are rejected by clap.
      expect(boundary.calls.find(args => args.includes('mouse-click')))
        .toEqual(['--headed', 'mouse-click', '--xy=30,50', '--button', 'left']);
    } finally { await driver.close(); }
  });
  it('bounds picker frames while retaining native capture geometry', async () => {
    const sharp = (await import('sharp')).default;
    const image = (await sharp({ create: { width: 400, height: 200, channels: 3, background: 'white' } }).png().toBuffer()).toString('base64');
    setup(args => args.includes('list-windows') ? [window] : { data: image, format: 'png', width: 400, height: 200, scale_factor: 2 });
    const driver = await createAgentDesktopComputerDriver({ displayId: ':73', executablePath: '/managed/agent-desktop' });
    try {
      const frame = await driver.captureFrame(target, { maxImageDimension: 100 });
      expect(frame.geometry).toMatchObject({ captureWidth: 100, captureHeight: 50, nativeWidth: 200, nativeHeight: 100, scaleX: 2, scaleY: 2 });
      expect(await sharp(frame.png).metadata()).toMatchObject({ width: 100, height: 50 });
    } finally { await driver.close(); }
  });
  it('preserves native window IDs and qualified refs and leaves element delivery headless', async () => {
    setup();
    const driver = await createAgentDesktopComputerDriver({ displayId: ':73', executablePath: '/managed/agent-desktop' });
    try {
      expect(await driver.listTargets()).toContainEqual(expect.objectContaining({ target, title: 'Fixture' }));
      const capture = await driver.capture(target);
      expect(capture.accessibility).toMatchObject({ complete: true, nodes: [
        { id: '@s1:e1', role: 'button', name: 'Apply' }, { id: '@s1:e2', role: 'textfield', name: 'Name', value: 'old' },
      ] });
      await driver.captureFrame(target);
      expect(await driver.input(target, capture.captureId, { kind: 'element', elementId: '@s1:e1', action: 'click' }))
        .toEqual({ status: 'dispatched' });
      const action = boundary.calls.find(args => args.includes('click'))!;
      expect(action).toContain('@s1:e1');
      expect(action).not.toContain('--headed');
      expect(await driver.input(target, capture.captureId, { kind: 'element', elementId: '@s1:e1', action: 'click' }))
        .toEqual({ status: 'failed', code: 'computer_element_stale' });
    } finally { await driver.close(); }
  });

  it('refuses elements absent from the latest capture without dispatching them', async () => {
    setup();
    const driver = await createAgentDesktopComputerDriver({ displayId: ':73', executablePath: '/managed/agent-desktop' });
    try {
      const capture = await driver.capture(target);
      expect(await driver.input(target, capture.captureId, { kind: 'element', elementId: '@other:e1', action: 'set_value', value: 'new' }))
        .toEqual({ status: 'failed', code: 'computer_element_stale' });
      expect(boundary.calls.some(args => args.includes('set-value'))).toBe(false);
    } finally { await driver.close(); }
  });

  it('maps native STALE_REF as recoverable but never reports uncertain delivery as a safe failure', async () => {
    let delivery = 'not_delivered';
    setup(args => args.includes('snapshot') ? { snapshot_id: 's1', window, complete: true, tree: { ref_id: '@s1:e1', role: 'button', name: 'Apply' } }
      : args.includes('screenshot') ? { data: png, format: 'png', width: 200, height: 100, scale_factor: 1 }
        : args.includes('list-windows') ? [window]
          : { version: '2.5', ok: false, command: 'click', error: { code: 'STALE_REF', disposition: { delivery, retry: delivery === 'not_delivered' ? 'safe' : 'unsafe' } } });
    const driver = await createAgentDesktopComputerDriver({ displayId: ':73', executablePath: '/managed/agent-desktop' });
    try {
      const capture = await driver.capture(target);
      expect(await driver.input(target, capture.captureId, { kind: 'element', elementId: '@s1:e1', action: 'click' }))
        .toEqual({ status: 'failed', code: 'computer_element_stale' });
      delivery = 'delivery_uncertain';
      const next = await driver.capture(target);
      expect(await driver.input(target, next.captureId, { kind: 'element', elementId: '@s1:e1', action: 'click' }))
        .toEqual({ status: 'interrupted', completion: 'unknown' });
    } finally { await driver.close(); }
  });
});
