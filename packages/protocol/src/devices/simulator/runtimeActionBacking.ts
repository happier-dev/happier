import { ACTION_ID_FAMILIES_V1, SIMULATOR_STATICALLY_BACKED_ACTION_IDS_V1, SIMULATOR_STATICALLY_UNBACKED_ACTION_IDS_V1, SIMULATOR_RESOURCE_GATED_ACTION_IDS_V1, type RuntimeActionIdV1 } from '../../actions/actionIds.js';
import type { SimulatorStreamControlsV1 } from './v1.js';

/**
 * Canonical backed-set source-of-truth for `devices.simulator.*` runtime action ids.
 *
 * Both the UI runtime-action executor and the daemon runtime-action executor consume this
 * classifier so the two can never silently disagree on which ids are backed (M1). The daemon
 * is the platform-adapter authority, so this classification is seeded from daemon truth:
 *
 * - `statically-backed`   — the daemon always routes these (snapshot/dispatch) and the UI may
 *                           forward them. Payload-level gating (e.g. sideband kind, lease) still
 *                           applies inside the executors; the *id* itself is backed.
 * - `statically-unbacked` — no producer path exists; always fail-closed (forced false). This is
 *                           the interim posture for not-yet-backed stream controls and the
 *                           absolute-orientation control stock scrcpy cannot service.
 * - `resource-gated`      — backed iff the live resource/producer snapshot advertises the control
 *                           (scrcpy gesture controls). The daemon evaluates this against its live
 *                           capability snapshot; the UI defers to the daemon so its verdict is a
 *                           strict subset of (never a contradiction with) the daemon's.
 */
export type SimulatorRuntimeActionBackingV1 =
  | 'statically-backed'
  | 'statically-unbacked'
  | 'resource-gated';

export type SimulatorRuntimeActionIdV1 = typeof ACTION_ID_FAMILIES_V1.devices_simulator[number];

export const STATICALLY_BACKED_SIMULATOR_RUNTIME_ACTION_IDS_V1: ReadonlySet<SimulatorRuntimeActionIdV1> =
  new Set(SIMULATOR_STATICALLY_BACKED_ACTION_IDS_V1);

export const STATICALLY_UNBACKED_SIMULATOR_RUNTIME_ACTION_IDS_V1: ReadonlySet<SimulatorRuntimeActionIdV1> =
  new Set(SIMULATOR_STATICALLY_UNBACKED_ACTION_IDS_V1);

export const RESOURCE_GATED_SIMULATOR_RUNTIME_ACTION_IDS_V1: ReadonlySet<SimulatorRuntimeActionIdV1> =
  new Set(SIMULATOR_RESOURCE_GATED_ACTION_IDS_V1);

/**
 * The single capability-flip gate for stream controls (§B). A control name appears here ONLY
 * after a real Android producer/server-restart path backs it. The protocol normalizer (`v1.ts`)
 * projects a control's bit from the resource iff the control is in this set; controls outside it
 * stay forced-false (capability-truth).
 *
 * All five flip on: the Android scrcpy server-restart producer
 * (`apps/cli/src/daemon/devices/simulator/android/restartProducer.ts`) provides a verified path. The
 * producer exposes exactly ONE encoder-reconfiguration sink — `setQuality` (implemented by
 * `mergeEncoder`), which carries bitrate, fps, AND a longest-edge resolution cap; there is no
 * separate `setFps`/`setScale` producer method. The `setFps`/`setScale` entries here are CAPABILITY
 * signals (this producer can adjust fps / scale), not distinct sinks: the daemon folds the
 * `fps.set`/`scale.set` SCALAR runtime actions into a single `set_quality` sideband
 * (`actions/qualityScalarTranslator.ts`; fps → `maxFramesPerSecond`, scale → `maxWidth`/`maxHeight`).
 * `requestKeyframe` remains an encoder-refresh control. `snapshot` is the presentation capability
 * for the separate Session-media screenshot Action; its producer is the platform device-operation
 * owner. Per-resource advertisement still gates visibility on the paths that expose these controls.
 */
export const BACKABLE_SIMULATOR_STREAM_CONTROLS_V1: ReadonlySet<keyof SimulatorStreamControlsV1> =
  new Set<keyof SimulatorStreamControlsV1>([
    'requestKeyframe',
    'snapshot',
    'setQuality',
    'setFps',
    'setScale',
  ]);

export function isSimulatorRuntimeActionIdV1(
  actionId: RuntimeActionIdV1,
): actionId is SimulatorRuntimeActionIdV1 {
  return STATICALLY_BACKED_SIMULATOR_RUNTIME_ACTION_IDS_V1.has(actionId as SimulatorRuntimeActionIdV1)
    || STATICALLY_UNBACKED_SIMULATOR_RUNTIME_ACTION_IDS_V1.has(actionId as SimulatorRuntimeActionIdV1)
    || RESOURCE_GATED_SIMULATOR_RUNTIME_ACTION_IDS_V1.has(actionId as SimulatorRuntimeActionIdV1);
}

export function classifySimulatorRuntimeActionBackingV1(
  actionId: SimulatorRuntimeActionIdV1,
): SimulatorRuntimeActionBackingV1 {
  if (STATICALLY_UNBACKED_SIMULATOR_RUNTIME_ACTION_IDS_V1.has(actionId)) return 'statically-unbacked';
  if (RESOURCE_GATED_SIMULATOR_RUNTIME_ACTION_IDS_V1.has(actionId)) return 'resource-gated';
  return 'statically-backed';
}
