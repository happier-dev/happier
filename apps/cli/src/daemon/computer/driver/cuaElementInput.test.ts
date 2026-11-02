import { describe, expect, it } from 'vitest';
import { captureResult, native, target } from './nativeComputerBoundary.testkit';
import { createManagedComputerDriver } from './managedComputerDriver';

describe('Cua snapshot element delivery', () => {
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
  it('maps grounded drag and diagonal wheel through the native window coordinate frame', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_window_state' ? captureResult()
      : { structuredContent: { effect: 'unverifiable' } });
    const driver = await createManagedComputerDriver({ displayId: ':73', executablePath: '/managed/cua-driver' });
    try {
      const capture = await driver.capture(target);
      expect(await driver.input(target, capture.captureId, { kind: 'drag', fromX: 10, fromY: 10, toX: 50, toY: 20 })).toEqual({ status: 'dispatched' });
      expect(native.tools.find(tool => tool.name === 'drag')?.arguments).toMatchObject({ from_x: 20, from_y: 30, to_x: 100, to_y: 60, coordinate_frame: 'window' });
      const next = await driver.capture(target);
      expect(await driver.input(target, next.captureId, { kind: 'wheel', x: 50, y: 20, deltaX: -2, deltaY: 3 })).toEqual({ status: 'dispatched' });
      expect(native.tools.filter(tool => tool.name === 'scroll').map(tool => tool.arguments)).toMatchObject([
        { x: 100, y: 60, direction: 'left', amount: 2 }, { x: 100, y: 60, direction: 'up', amount: 3 },
      ]);
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
