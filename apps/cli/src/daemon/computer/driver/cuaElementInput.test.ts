import { describe, expect, it, vi } from 'vitest';
import { captureResult, native, target } from './nativeComputerBoundary.testkit';
import { createManagedComputerDriver } from './managedComputerDriver';

describe('Cua snapshot element delivery', () => {
  it('refuses window hover instead of pretending the native overlay moved the app pointer', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state' ? captureResult()
      : { structuredContent: { effect: 'unverifiable' } });
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      const capture = await driver.capture(target);
      expect(await driver.input(target, capture.captureId, { kind: 'move', x: 10, y: 20 }))
        .toEqual({ status: 'failed', code: 'input_not_supported' });
      expect(native.tools.some(tool => tool.name === 'move_cursor')).toBe(false);
    } finally { await driver.close(); }
  });
  it('settles a native pre-delivery stale-token refusal without unknown completion', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state'
      ? { ...captureResult(), structuredContent: { ...captureResult().structuredContent,
        elements: [{ element_index: 0, element_token: 's12345678:0', role: 'button' }] } }
      : { isError: true, structuredContent: { status: 'refused', refusal: { code: 'stale_element_token' } } });
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      const capture = await driver.capture(target);
      expect(await driver.input(target, capture.captureId, { kind: 'element', elementId: '0', action: 'click' }))
        .toEqual({ status: 'failed', code: 'computer_element_stale' });
    } finally { await driver.close(); }
  });
  it.each(['linux', 'darwin', 'win32'])('preserves the native screenshot snapshot for grounded drag and diagonal wheel on %s', async platform => {
    vi.stubGlobal('process', { ...process, platform });
    const displayId = platform === 'linux' ? ':73' : 'primary';
    const sourceTarget = { ...target, displayId };
    let screenshotContext = false;
    // Cua 0.37.0 (2d2f992), platform-linux/tools/impl_.rs:
    // tree-only reads replace the snapshot without a screenshot scale; drag
    // and coordinate scroll resolve that snapshot rather than capture_id.
    native.call.mockImplementation(async ({ name, arguments: args }) => {
      if (name === 'get_window_state') {
        if (args.display_only !== true) screenshotContext = args.include_screenshot !== false;
        return captureResult();
      }
      if (name === 'check_permissions') return { structuredContent: { screen_recording: true, accessibility: true } };
      if ((name === 'drag' || name === 'scroll') && !screenshotContext) {
        return { isError: true, structuredContent: { code: 'screenshot_context_missing' } };
      }
      return { structuredContent: { effect: 'unverifiable' } };
    });
    const driver = await createManagedComputerDriver({ displayId, executablePath: '/managed/cua-driver' });
    try {
      const capture = await driver.capture(sourceTarget);
      expect(await driver.input(sourceTarget, capture.captureId, { kind: 'drag', fromX: 10, fromY: 10, toX: 50, toY: 20 })).toEqual({ status: 'dispatched' });
      expect(native.tools.find(tool => tool.name === 'drag')?.arguments).toMatchObject({ from_x: 10, from_y: 10, to_x: 50, to_y: 20, coordinate_frame: 'window' });
      const next = await driver.capture(sourceTarget);
      expect(await driver.input(sourceTarget, next.captureId, { kind: 'wheel', x: 50, y: 20, deltaX: -2, deltaY: 3 })).toEqual({ status: 'dispatched' });
      expect(native.tools.filter(tool => tool.name === 'scroll').map(tool => tool.arguments)).toMatchObject([
        { x: 50, y: 20, direction: 'left', amount: 2 }, { x: 50, y: 20, direction: 'up', amount: 3 },
      ]);
    } finally { await driver.close(); }
  });
  it('dispatches desktop drag and wheel with one native target representation', async () => {
    native.call.mockImplementation(async ({ name, arguments: args }) => args.target && args.scope
      ? { isError: true, structuredContent: { code: 'invalid_action_target' } }
      : name === 'get_desktop_state'
      ? { ...captureResult(), structuredContent: { display: 'primary', capture_id: 'desktop', screenshot_width: 200,
        screenshot_height: 100, screen_width: 200, screen_height: 100, scale_factor: 1 } }
      : name === 'get_screen_size' ? { structuredContent: { width: 200, height: 100, scale_factor: 1 } }
        : name === 'check_permissions' ? { structuredContent: { x11: true, xsend_event: true } }
          : { structuredContent: { effect: 'unverifiable' } });
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    const desktop = { kind: 'display' as const, displayId: ':73' };
    try {
      const capture = await driver.capture(desktop);
      expect(await driver.input(desktop, capture.captureId, { kind: 'drag', fromX: 10, fromY: 10, toX: 50, toY: 20 })).toEqual({ status: 'dispatched' });
      expect(native.tools.find(tool => tool.name === 'drag')?.arguments).toMatchObject({
        target: { kind: 'desktop', display_id: 'primary' }, from_x: 10, from_y: 10, to_x: 50, to_y: 20,
      });
      const next = await driver.capture(desktop);
      expect(await driver.input(desktop, next.captureId, { kind: 'wheel', x: 50, y: 20, deltaX: 0, deltaY: 1 })).toEqual({ status: 'dispatched' });
      expect(native.tools.find(tool => tool.name === 'scroll')?.arguments).toMatchObject({ target: { kind: 'desktop', display_id: 'primary' }, x: 50, y: 20 });
    } finally { await driver.close(); }
  });
  it('uses the exact native token for click and set value and consumes the observation once', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state'
      ? { ...captureResult(), structuredContent: { ...captureResult().structuredContent,
        elements: [{ element_index: 0, element_token: 's12345678:0', role: 'entry', label: 'Name', value: 'old' }] } }
      : { structuredContent: { effect: 'confirmed', evidence: [{ kind: 'value_readback' }] } });
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      const capture = await driver.capture(target);
      expect(await driver.input(target, capture.captureId, { kind: 'element', elementId: '0', action: 'set_value', value: 'new' }))
        .toEqual({ status: 'verified', property: 'value_readback' });
      expect(native.tools.find(tool => tool.name === 'set_value')?.arguments)
        .toMatchObject({ element_token: 's12345678:0', value: 'new', delivery_mode: 'background' });
      expect(await driver.input(target, capture.captureId, { kind: 'element', elementId: '0', action: 'click' }))
        .toEqual({ status: 'failed', code: 'computer_element_stale' });
      const next = await driver.capture(target);
      await driver.input(target, next.captureId, { kind: 'element', elementId: '0', action: 'click' });
      expect(native.tools.find(tool => tool.name === 'click')?.arguments).toMatchObject({ element_token: 's12345678:0' });
    } finally { await driver.close(); }
  });

  it('never substitutes a later native index when the observed token is absent', async () => {
    native.call.mockImplementation(async () => captureResult());
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      const capture = await driver.capture(target);
      expect(await driver.input(target, capture.captureId, { kind: 'element', elementId: '0', action: 'click' }))
        .toEqual({ status: 'failed', code: 'computer_element_stale' });
      expect(native.tools.some(tool => tool.name === 'click' || tool.name === 'press_key')).toBe(false);
    } finally { await driver.close(); }
  });
});
