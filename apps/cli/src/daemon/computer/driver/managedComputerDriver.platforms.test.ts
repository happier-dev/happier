import { describe, expect, it, vi } from 'vitest';
import { native, png, captureResult } from './nativeComputerBoundary.testkit';
import { createManagedComputerDriver } from './managedComputerDriver';
import { createComputerRoutes } from '../routes';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';

// Responses characterized from Cua 0.37.0, source 2d2f99228d4d2508dc6fcc84c176b296e146714a.
function desktopResult(scale = 1) {
  return { content: [{ type: 'image', mimeType: 'image/png', data: png }], structuredContent: {
    display: 'primary', capture_id: 'desktop', screenshot_width: 200, screenshot_height: 100,
    screen_width: 200, screen_height: 100, scale_factor: scale,
  } };
}

describe('native Windows and Wayland sources', () => {
  it.each([false, true])('resolves Windows primary through selection and excludes overlapping controllers (display first: %s)', async displayFirst => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.stubEnv('DISPLAY', ':inherited');
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-inherited');
    native.call.mockImplementation(async ({ name }) => name === 'list_windows'
      ? { structuredContent: { windows: [{ pid: 42, window_id: 123, title: 'Editor' }] } }
      : name === 'get_screen_size' ? { structuredContent: { width: 200, height: 100, scale_factor: 2 } }
        : name === 'check_permissions' ? { structuredContent: { uia: true, post_message: true, elevated: false } }
          : name === 'get_desktop_state' ? desktopResult(2) : captureResult());
    const registry = createMachineLiveStreamCaptureRegistry();
    const routes = createComputerRoutes({ machineId: 'machine', registry, executablePath: '/managed/native-driver', defaultDisplayId: ':inherited' });
    const machine = { machineId: 'machine' };
    const human = { authority: 'present_user' as const, defaultSessionId: 'a' };
    const display = { kind: 'display' as const, displayId: 'primary' };
    const window = { kind: 'window' as const, displayId: 'primary', pid: 42, windowId: 123 };
    try {
      expect(await routes.dispatch('computer.targets.list', machine, human)).toMatchObject({
        targets: expect.arrayContaining([expect.objectContaining({ target: display }), expect.objectContaining({ target: window })]),
        grants: { capture: 'granted', input: 'granted' },
      });
      const first = displayFirst ? display : window;
      const second = displayFirst ? window : display;
      expect(await routes.dispatch('computer.target.select', { ...machine, target: first, access: 'use' }, human)).toMatchObject({ selectedTarget: first });
      expect(await routes.dispatch('computer.target.select', { ...machine, target: second }, { ...human, defaultSessionId: 'b' }))
        .toMatchObject({ ok: false, errorCode: 'computer_target_in_use' });
      expect(registry.list()).toHaveLength(1);
      const source = registry.list()[0]!.computer!;
      expect((await source.observe('human')).png).toEqual(Buffer.from(png, 'base64'));
      expect(native.instances[0]?.parameters.env).not.toHaveProperty('DISPLAY');
      expect(native.instances[0]?.parameters.env).not.toHaveProperty('WAYLAND_DISPLAY');
      expect(await routes.dispatch('computer.target.close', machine, human)).toMatchObject({ status: 'dispatched' });
      expect(await routes.dispatch('computer.target.select', { ...machine, target: second }, { ...human, defaultSessionId: 'b' }))
        .toMatchObject({ selectedTarget: second });
      expect(await routes.dispatch('computer.targets.list', { ...machine, displayId: 'monitor-2' }, human))
        .toMatchObject({ ok: false, errorCode: 'target_unsupported' });
    } finally { await routes.dispose(); }
  });

  it('keeps Windows pixels physical at high DPI and preserves known background refusal without foreground escalation', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    native.call.mockImplementation(async ({ name }) => name === 'check_permissions'
      ? { structuredContent: { uia: true, post_message: true } }
      : name === 'get_desktop_state' ? desktopResult(2)
        : name === 'get_screen_size' ? { structuredContent: { width: 200, height: 100, scale_factor: 2 } }
          : name === 'get_window_state' ? captureResult()
            : { structuredContent: { effect: 'unverifiable' } });
    const driver = await createManagedComputerDriver({ displayId: 'primary', executablePath: '/managed/native-driver' });
    const display = { kind: 'display' as const, displayId: 'primary' };
    const window = { kind: 'window' as const, displayId: 'primary', pid: 42, windowId: 123 };
    try {
      const captured = await driver.capture(display);
      expect(captured.geometry).toMatchObject({ nativeWidth: 200, captureWidth: 200, scaleX: 1 });
      expect(await driver.input(display, captured.captureId, { kind: 'click', x: 199, y: 99 })).toEqual({ status: 'dispatched' });
      expect(native.tools.find(tool => tool.name === 'click')?.arguments).toMatchObject({ x: 199, y: 99,
        target: { kind: 'desktop', display_id: 'primary' }, delivery_mode: 'foreground' });
      native.call.mockResolvedValue({ isError: true, structuredContent: { code: 'background_unavailable', target_class: 'Chrome_WidgetWin_1', event_kind: 'keystroke' } });
      expect(await driver.input(window, null, { kind: 'press', key: 'Return' }))
        .toEqual({ status: 'failed', code: 'background_unavailable' });
      expect(native.tools.find(tool => tool.name === 'press_key')?.arguments).toMatchObject({ pid: 42, window_id: 123, delivery_mode: 'background' });
      native.call.mockResolvedValue(captureResult());
      expect((await driver.capture(window)).captureId).toBe('capture-1');
      // The same code can follow an unresolved UIA invocation. It is not proof of nondelivery.
      native.call.mockResolvedValue({ isError: true, structuredContent: { code: 'background_unavailable', path: 'ax', effect: 'unverifiable', uia_status: 'timeout' } });
      expect(await driver.input(window, null, { kind: 'press', key: 'Return' })).toEqual({ status: 'interrupted', completion: 'unknown' });
    } finally { await driver.close(); }
  });

  it('binds the inherited Wayland socket, enables the pinned native backend and admits compositor metadata without X11', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-7');
    vi.stubEnv('DISPLAY', ':73');
    vi.stubEnv('HYPRLAND_INSTANCE_SIGNATURE', 'fixture-compositor');
    native.call.mockImplementation(async ({ name }) => name === 'list_windows' ? { structuredContent: { windows: [] } }
      : name === 'check_permissions' ? { structuredContent: { x11: false, xsend_event: false, wayland: true, wayland_enabled: true } }
        : name === 'get_screen_size' ? { structuredContent: { width: 200, height: 100, scale_factor: 1 } }
          : name === 'get_desktop_state' ? desktopResult() : { structuredContent: { effect: 'unverifiable' } });
    const registry = createMachineLiveStreamCaptureRegistry();
    const routes = createComputerRoutes({ machineId: 'machine', registry, executablePath: '/managed/native-driver', defaultDisplayId: ':73' });
    const human = { authority: 'present_user' as const, defaultSessionId: 'session' };
    const machine = { machineId: 'machine' };
    const target = { kind: 'display' as const, displayId: 'wayland-7' };
    try {
      expect(await routes.dispatch('computer.targets.list', machine, human)).toMatchObject({
        targets: [expect.objectContaining({ target })], grants: { capture: 'granted', input: 'granted' },
      });
      expect(await routes.dispatch('computer.target.select', { ...machine, target, access: 'use' }, human)).toMatchObject({ selectedTarget: target });
      const source = registry.list()[0]!.computer!;
      const capture = await source.observe('human');
      expect(await source.input(capture.captureId, { kind: 'click', x: 1, y: 1 }, 'human')).toMatchObject({ status: 'dispatched' });
      expect(native.instances[0]?.parameters.env).toMatchObject({ WAYLAND_DISPLAY: 'wayland-7', CUA_DRIVER_RS_ENABLE_WAYLAND: '1',
        HYPRLAND_INSTANCE_SIGNATURE: 'fixture-compositor' });
      expect(native.instances[0]?.parameters.env).not.toHaveProperty('DISPLAY');
      expect(await routes.dispatch('computer.targets.list', { ...machine, displayId: 'wayland-other' }, human))
        .toMatchObject({ ok: false, errorCode: 'target_unsupported' });
    } finally { await routes.dispose(); }
  });

  it('explains a Wayland session without enumerable native targets rather than reporting an empty supported desktop', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-7');
    native.call.mockImplementation(async ({ name }) => name === 'list_windows' ? { structuredContent: { windows: [] } } : { isError: true });
    const routes = createComputerRoutes({ machineId: 'machine', registry: createMachineLiveStreamCaptureRegistry(), executablePath: '/managed/native-driver' });
    try {
      expect(await routes.dispatch('computer.targets.list', { machineId: 'machine' }, { authority: 'present_user', defaultSessionId: 'session' }))
        .toMatchObject({ ok: false, errorCode: 'wayland_target_unavailable', error: expect.stringContaining('compositor') });
    } finally { await routes.dispose(); }
  });

  it('excludes a Wayland desktop and a window reached through its inherited XWayland connection', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-7');
    vi.stubEnv('DISPLAY', ':73');
    native.call.mockImplementation(async ({ name }) => name === 'list_windows'
      ? { structuredContent: { windows: [{ pid: 42, window_id: 123, title: 'Editor' }] } }
      : { structuredContent: { width: 200, height: 100, scale_factor: 1 } });
    const registry = createMachineLiveStreamCaptureRegistry();
    const routes = createComputerRoutes({ machineId: 'machine', registry, executablePath: '/managed/native-driver' });
    const human = { authority: 'present_user' as const, defaultSessionId: 'a' };
    try {
      expect(await routes.dispatch('computer.target.select', { machineId: 'machine', target: { kind: 'display', displayId: 'wayland-7' } }, human))
        .toMatchObject({ selectedTarget: { kind: 'display', displayId: 'wayland-7' } });
      expect(await routes.dispatch('computer.target.select', { machineId: 'machine', target: { kind: 'window', displayId: ':73.0', pid: 42, windowId: 123 } },
        { ...human, defaultSessionId: 'b' })).toMatchObject({ ok: false, errorCode: 'computer_target_in_use' });
      expect(registry.list()).toHaveLength(1);
      expect(await routes.dispatch('computer.target.select', { machineId: 'machine', target: { kind: 'display', displayId: ':74' } },
        { ...human, defaultSessionId: 'independent-x11' })).toMatchObject({ selectedTarget: { kind: 'display', displayId: ':74' } });
      expect(registry.list()).toHaveLength(2);
    } finally { await routes.dispose(); }
  });
});
