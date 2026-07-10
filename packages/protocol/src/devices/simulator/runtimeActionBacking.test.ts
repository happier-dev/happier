import { describe, expect, it } from 'vitest';

import { ACTION_ID_FAMILIES_V1 } from '../../actions/actionIds.js';
import {
  BACKABLE_SIMULATOR_STREAM_CONTROLS_V1,
  RESOURCE_GATED_SIMULATOR_RUNTIME_ACTION_IDS_V1,
  STATICALLY_BACKED_SIMULATOR_RUNTIME_ACTION_IDS_V1,
  STATICALLY_UNBACKED_SIMULATOR_RUNTIME_ACTION_IDS_V1,
  classifySimulatorRuntimeActionBackingV1,
} from './runtimeActionBacking.js';

describe('simulator runtime action backing classifier', () => {
  it('classifies every devices.simulator action id exactly once', () => {
    const ids = ACTION_ID_FAMILIES_V1.devices_simulator;
    const classifications = new Map<string, string>();
    for (const id of ids) {
      classifications.set(id, classifySimulatorRuntimeActionBackingV1(id));
    }
    // every id classified
    expect(classifications.size).toBe(ids.length);

    const inStatic = (id: string): number =>
      (STATICALLY_BACKED_SIMULATOR_RUNTIME_ACTION_IDS_V1.has(id as never) ? 1 : 0)
      + (STATICALLY_UNBACKED_SIMULATOR_RUNTIME_ACTION_IDS_V1.has(id as never) ? 1 : 0)
      + (RESOURCE_GATED_SIMULATOR_RUNTIME_ACTION_IDS_V1.has(id as never) ? 1 : 0);

    for (const id of ids) {
      // exactly one of the three sets owns each id
      expect(inStatic(id)).toBe(1);
    }
  });

  it('treats daemon-routable ids as statically backed', () => {
    for (const id of [
      'devices.simulator.list',
      'devices.simulator.lease.acquire',
      'devices.simulator.lease.renew',
      'devices.simulator.lease.release',
      'devices.simulator.input.tap',
      'devices.simulator.input.swipe',
      'devices.simulator.input.text',
      'devices.simulator.input.key',
      'devices.simulator.input.button',
      'devices.simulator.sideband.request',
    ] as const) {
      expect(classifySimulatorRuntimeActionBackingV1(id)).toBe('statically-backed');
    }
  });

  it('treats encoder-reconfiguration stream controls as resource-gated against the live snapshot', () => {
    // The Android scrcpy server-restart producer backs these (set_quality / request_keyframe /
    // snapshot via a clean encoder restart). They are resource-gated: backed only when the live
    // resource advertises the control (Android scrcpy), forced-false otherwise (iOS today).
    for (const id of [
      'devices.simulator.stream.keyframe',
      'devices.simulator.stream.snapshot',
      'devices.simulator.stream.quality.set',
      'devices.simulator.stream.fps.set',
      'devices.simulator.stream.scale.set',
    ] as const) {
      expect(classifySimulatorRuntimeActionBackingV1(id)).toBe('resource-gated');
    }
  });

  it('keeps absolute orientation statically unbacked (stock scrcpy cannot service it)', () => {
    expect(classifySimulatorRuntimeActionBackingV1('devices.simulator.input.orientation')).toBe('statically-unbacked');
  });

  it('keeps scrcpy gesture controls resource-gated against the live snapshot', () => {
    expect(classifySimulatorRuntimeActionBackingV1('devices.simulator.input.pinch')).toBe('resource-gated');
    expect(classifySimulatorRuntimeActionBackingV1('devices.simulator.input.rotate')).toBe('resource-gated');
  });

  it('backs every stream control via the server-restart producer capability-flip gate', () => {
    // The Android scrcpy server-restart producer provides a verified path for every stream control,
    // so all five flip on. Per-resource advertisement still gates actual visibility (iOS omits them).
    expect([...BACKABLE_SIMULATOR_STREAM_CONTROLS_V1].sort()).toEqual(
      ['requestKeyframe', 'setFps', 'setQuality', 'setScale', 'snapshot'].sort(),
    );
  });
});
