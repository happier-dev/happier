import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  MachineLiveStreamInputControlKindV1Schema,
  MachineLiveStreamInputModeV1Schema,
  type MachineLiveStreamInputControlKindV1,
} from '../../machines/peer/mediation/stream/controlV1.js';
import {
  MachineLiveStreamCodecIdV1Schema,
} from '../../machines/peer/mediation/stream/codecsV1.js';
import { BACKABLE_SIMULATOR_STREAM_CONTROLS_V1 } from './runtimeActionBacking.js';
import { SimulatorDeviceHardwareButtonV1Schema, SimulatorDeviceOperationKindV1Schema } from './operationsV1.js';

export const SimulatorPlatformV1Schema = lazyZodSchema(() => z.enum(['ios', 'android']));

export const SimulatorStreamControlsV1Schema = lazyZodSchema(() => z.strictObject({
    requestKeyframe: z._default(z.optional(z.boolean()), false),
    snapshot: z._default(z.optional(z.boolean()), false),
    setQuality: z._default(z.optional(z.boolean()), false),
    setFps: z._default(z.optional(z.boolean()), false),
    setScale: z._default(z.optional(z.boolean()), false),
  }));

export const DEFAULT_SIMULATOR_STREAM_CONTROLS_V1 = {
  requestKeyframe: false,
  snapshot: false,
  setQuality: false,
  setFps: false,
  setScale: false,
} as const;

export const SimulatorCaptureCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
    status: z._default(z.optional(z.literal('available')), 'available'),
    sourceId: z.string().check(z.minLength(1)),
    supportedCodecs: z.array(MachineLiveStreamCodecIdV1Schema).check(z.minLength(1)),
    inputMode: MachineLiveStreamInputModeV1Schema,
    supportedInputKinds: z.optional(z.array(MachineLiveStreamInputControlKindV1Schema)),
    streamControls: z.optional(SimulatorStreamControlsV1Schema),
  }));

export const SimulatorCaptureUnavailableV1Schema = lazyZodSchema(() => z.strictObject({
    status: z.literal('unavailable'),
    sourceId: z.optional(z.string().check(z.minLength(1))),
    reasonCode: z.string().check(z.minLength(1)),
  }));

export const SimulatorCaptureV1Schema = lazyZodSchema(() => z.union([
  SimulatorCaptureCapabilitiesV1Schema,
  SimulatorCaptureUnavailableV1Schema,
]));

export const SimulatorDeviceResourceV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    simulatorId: z.string().check(z.minLength(1)),
    platform: SimulatorPlatformV1Schema,
    deviceId: z.string().check(z.minLength(1)),
    displayName: z.string().check(z.minLength(1)),
    state: z.optional(z.enum(['running', 'stopped', 'unavailable'])),
    runtimeId: z.optional(z.string().check(z.minLength(1))),
    avdName: z.optional(z.string().check(z.minLength(1))),
    supportedDeviceOperations: z.optional(z.array(SimulatorDeviceOperationKindV1Schema)),
    supportedHardwareButtons: z.optional(z.array(SimulatorDeviceHardwareButtonV1Schema)),
    appId: z.optional(z.string().check(z.minLength(1))),
    capture: SimulatorCaptureV1Schema,
    unavailableReason: z.optional(z.string().check(z.minLength(1))),
  }));

export type SimulatorPlatformV1 = z.infer<typeof SimulatorPlatformV1Schema>;
export type SimulatorStreamControlsV1 = z.infer<typeof SimulatorStreamControlsV1Schema>;
export type SimulatorCaptureCapabilitiesV1 = z.infer<typeof SimulatorCaptureCapabilitiesV1Schema>;
export type SimulatorCaptureUnavailableV1 = z.infer<typeof SimulatorCaptureUnavailableV1Schema>;
export type SimulatorCaptureV1 = z.infer<typeof SimulatorCaptureV1Schema>;
export type SimulatorDeviceResourceV1 = z.infer<typeof SimulatorDeviceResourceV1Schema>;

const UNBACKED_VISIBLE_INPUT_KINDS_V1 = new Set<MachineLiveStreamInputControlKindV1>([
  'orientation',
]);

function createDisabledSimulatorStreamControlsV1(): SimulatorStreamControlsV1 {
  return {
    requestKeyframe: false,
    snapshot: false,
    setQuality: false,
    setFps: false,
    setScale: false,
  };
}

const SIMULATOR_STREAM_CONTROL_KEYS_V1 = [
  'requestKeyframe',
  'snapshot',
  'setQuality',
  'setFps',
  'setScale',
] as const satisfies readonly (keyof SimulatorStreamControlsV1)[];

/**
 * Project visible stream-control bits per control: a control's advertised bit is preserved iff
 * the control has a verified producer/server-restart backing path (it appears in
 * `BACKABLE_SIMULATOR_STREAM_CONTROLS_V1`). Controls outside the backable set are forced false
 * regardless of what the resource advertises — capability-truth fail-closed for not-yet-backed
 * controls. Returns the original reference when nothing changes to preserve referential stability.
 */
function projectVisibleStreamControlsV1(
  controls: SimulatorStreamControlsV1 | undefined,
): SimulatorStreamControlsV1 {
  if (!controls) return createDisabledSimulatorStreamControlsV1();
  let changed = false;
  const projected: SimulatorStreamControlsV1 = { ...controls };
  for (const key of SIMULATOR_STREAM_CONTROL_KEYS_V1) {
    const backable = BACKABLE_SIMULATOR_STREAM_CONTROLS_V1.has(key);
    const next = backable ? controls[key] === true : false;
    if (next !== controls[key]) changed = true;
    projected[key] = next;
  }
  return changed ? projected : controls;
}

function normalizeVisibleSupportedInputKindsV1(
  kinds: MachineLiveStreamInputControlKindV1[] | undefined,
): MachineLiveStreamInputControlKindV1[] | undefined {
  if (!kinds) return undefined;
  const normalized = kinds.filter((kind) => !UNBACKED_VISIBLE_INPUT_KINDS_V1.has(kind));
  return normalized.length === kinds.length
    && normalized.every((kind, index) => kinds[index] === kind)
    ? kinds
    : normalized;
}

export function normalizeSimulatorDeviceResourceVisibleCapabilitiesV1(
  resource: SimulatorDeviceResourceV1,
): SimulatorDeviceResourceV1 {
  if (resource.capture.status === 'unavailable') return resource;
  const supportedInputKinds = normalizeVisibleSupportedInputKindsV1(resource.capture.supportedInputKinds);
  const streamControls = projectVisibleStreamControlsV1(resource.capture.streamControls);

  if (
    supportedInputKinds === resource.capture.supportedInputKinds
    && streamControls === resource.capture.streamControls
  ) return resource;

  return {
    ...resource,
    capture: {
      ...resource.capture,
      ...(supportedInputKinds ? { supportedInputKinds } : {}),
      streamControls,
    },
  };
}

export function simulatorCaptureStreamFamilyV1(sourceId: string): string | null {
  const normalized = sourceId.trim();
  return normalized.length > 0 ? normalized : null;
}
