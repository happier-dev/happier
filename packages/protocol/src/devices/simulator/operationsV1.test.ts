import { describe, expect, it } from 'vitest';

import { SIMULATOR_RUNTIME_ACTION_INPUT_SCHEMAS, SIMULATOR_RUNTIME_ACTION_OUTPUT_SCHEMAS } from '../../actions/specs/simulator.js';
import { SimulatorDeviceResourceV1Schema } from './v1.js';
import { getActionSpec } from '../../actions/actionSpecs.js';
import { SimulatorDeviceOperationV1Schema } from './operationsV1.js';

describe('simulator device operation contracts', () => {
  it('retains the agent consent floor for device mutations', () => {
    expect(getActionSpec('devices.simulator.device.powerOff').safety).toBe('danger');
    expect(getActionSpec('devices.simulator.screenshot.capture').sideEffectClass).toBe('read');
  });
  it('retains stopped Android AVD identity and its backed operations in device discovery', () => {
    expect(SimulatorDeviceResourceV1Schema.safeParse({
      v: 1, simulatorId: 'android:Pixel', platform: 'android', deviceId: 'Pixel', displayName: 'Pixel',
      state: 'stopped', avdName: 'Pixel', supportedDeviceOperations: ['boot'],
      capture: { status: 'unavailable', reasonCode: 'device_stopped' },
    }).success).toBe(true);
  });

  it('requires a Session media target for screenshots instead of accepting frame-refresh events', () => {
    const schema = SIMULATOR_RUNTIME_ACTION_INPUT_SCHEMAS['devices.simulator.stream.snapshot'];
    expect(schema.safeParse({ operation: 'screenshot', platform: 'ios', deviceId: 'ios-device', sessionId: 'session-1' }).success).toBe(true);
    expect(schema.safeParse({ operation: 'screenshot', platform: 'ios', deviceId: 'ios-device' }).success).toBe(false);
    expect(schema.safeParse({ type: 'simulator.snapshot.request', simulatorId: 'sim-1', streamId: 'stream-1', sourceId: 'source-1', eventId: 'event-1' }).success).toBe(false);
    expect(schema.safeParse({ operation: 'screenshot', platform: 'ios', deviceId: 'ios-device', sessionId: 'session-1', path: '/tmp/image.png' }).success).toBe(false);
  });

  it('accepts iOS push content and rejects a push operation targeting Android', () => {
    const input = { operation: 'push', platform: 'ios', deviceId: 'ios-device', appId: 'dev.app', payload: { aps: { alert: 'Hello' } } };
    expect(SimulatorDeviceOperationV1Schema.safeParse(input).success).toBe(true);
    expect(SimulatorDeviceOperationV1Schema.safeParse({ ...input, platform: 'android' }).success).toBe(false);
  });

  it('returns real image media or a step-specific platform failure for screenshots', () => {
    const schema = SIMULATOR_RUNTIME_ACTION_OUTPUT_SCHEMAS['devices.simulator.stream.snapshot'];
    expect(schema.safeParse({ ok: true, media: { mediaId: 'image-1', mediaKind: 'image', width: 100, height: 200, sizeBytes: 250 } }).success).toBe(true);
    expect(schema.safeParse({ ok: true }).success).toBe(false);
    expect(schema.safeParse({ ok: false, errorCode: 'simctl_failed', step: 'screenshot', exitCode: 1 }).success).toBe(true);
  });
});
