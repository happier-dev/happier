import { describe, expect, it } from 'vitest';

import { getActionSpec } from '../../actions/actionSpecs.js';
import { SimulatorDeviceOperationV1Schema } from './operationsV1.js';

const snapshot = { nodes: [
  { index: 0, type: 'Application', label: 'Fixture', frame: { x: 0, y: 0, width: 393, height: 852 } },
  { index: 1, parentIndex: 0, type: 'Button', identifier: 'increment', label: 'Increment',
    frame: { x: 20, y: 300, width: 350, height: 100 }, enabled: true },
], truncated: false, viewport: { width: 393, height: 852 } };

describe('simulator accessibility Actions', () => {
  it('accepts explicit device snapshot and identifier press inputs, rejecting missing selectors', () => {
    expect(SimulatorDeviceOperationV1Schema.safeParse({ operation: 'accessibility_snapshot', platform: 'ios', deviceId: 'owned' }).success).toBe(true);
    expect(SimulatorDeviceOperationV1Schema.safeParse({ operation: 'accessibility_press', platform: 'ios', deviceId: 'owned', identifier: 'increment' }).success).toBe(true);
    expect(SimulatorDeviceOperationV1Schema.safeParse({ operation: 'accessibility_press', platform: 'ios', deviceId: 'owned' }).success).toBe(false);
    expect(SimulatorDeviceOperationV1Schema.safeParse({ operation: 'accessibility_press', platform: 'ios', deviceId: 'owned', identifier: ' ' }).success).toBe(false);
  });

  it('returns an inspectable tree or the exact unsupported boundary failure, never an empty success', () => {
    const spec = getActionSpec('devices.simulator.accessibility.snapshot');
    expect(spec.outputSchema.safeParse({ ok: true, snapshot }).success).toBe(true);
    expect(spec.outputSchema.safeParse({ ok: true }).success).toBe(false);
    expect(spec.outputSchema.safeParse({ ok: false, errorCode: 'simulator_accessibility_unavailable', step: 'accessibility_snapshot' }).success).toBe(true);
    expect(spec.sideEffectClass).toBe('read');
  });

  it('requires actual identifier-press success and retains the mutation consent floor', () => {
    const spec = getActionSpec('devices.simulator.accessibility.press');
    expect(spec.outputSchema.safeParse({ ok: true, pressedIdentifier: 'increment' }).success).toBe(true);
    expect(spec.outputSchema.safeParse({ ok: true }).success).toBe(false);
    expect(spec.safety).toBe('danger');
  });
});
