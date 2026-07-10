import { z } from 'zod';

import {
  MachineLiveStreamCodecIdV1Schema,
  MachineLiveStreamInputControlKindV1Schema,
  MachineLiveStreamInputModeV1Schema,
  type MachineLiveStreamInputControlKindV1,
} from '../../machines/peer/mediation/stream/index.js';
import { BACKABLE_SIMULATOR_STREAM_CONTROLS_V1 } from './runtimeActionBacking.js';

export const SimulatorPlatformV1Schema = z.enum(['ios', 'android']);

export const SimulatorStreamControlsV1Schema = z
  .object({
    requestKeyframe: z.boolean().optional().default(false),
    snapshot: z.boolean().optional().default(false),
    setQuality: z.boolean().optional().default(false),
    setFps: z.boolean().optional().default(false),
    setScale: z.boolean().optional().default(false),
  })
  .strict();

export const DEFAULT_SIMULATOR_STREAM_CONTROLS_V1 = {
  requestKeyframe: false,
  snapshot: false,
  setQuality: false,
  setFps: false,
  setScale: false,
} as const;

export const SimulatorCaptureCapabilitiesV1Schema = z
  .object({
    status: z.literal('available').optional().default('available'),
    sourceId: z.string().min(1),
    supportedCodecs: z.array(MachineLiveStreamCodecIdV1Schema).min(1),
    inputMode: MachineLiveStreamInputModeV1Schema,
    supportedInputKinds: z.array(MachineLiveStreamInputControlKindV1Schema).optional(),
    streamControls: SimulatorStreamControlsV1Schema.optional(),
  })
  .strict();

export const SimulatorCaptureUnavailableV1Schema = z
  .object({
    status: z.literal('unavailable'),
    sourceId: z.string().min(1).optional(),
    reasonCode: z.string().min(1),
  })
  .strict();

export const SimulatorCaptureV1Schema = z.union([
  SimulatorCaptureCapabilitiesV1Schema,
  SimulatorCaptureUnavailableV1Schema,
]);

export const SimulatorDeviceResourceV1Schema = z
  .object({
    v: z.literal(1),
    simulatorId: z.string().min(1),
    platform: SimulatorPlatformV1Schema,
    deviceId: z.string().min(1),
    displayName: z.string().min(1),
    appId: z.string().min(1).optional(),
    capture: SimulatorCaptureV1Schema,
    unavailableReason: z.string().min(1).optional(),
  })
  .strict();

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
