import { ACTION_ID_FAMILIES_V1, type RuntimeActionIdV1 } from './actionIds.js';
import type { ActionSurfaces } from './actionSpecs.js';
import {
  classifySimulatorRuntimeActionBackingV1,
  isSimulatorRuntimeActionIdV1,
} from '../devices/simulator/runtimeActionBacking.js';

const RUNTIME_ACTION_DISABLED_SURFACES = Object.freeze({
  ui: false,
  voice: false,
  agent: false,
  mcp: false,
  cli: false,
  rpc: false,
  sdk: false,
} satisfies ActionSurfaces);

const RUNTIME_ACTION_ENABLED_SURFACES = Object.freeze({
  ...RUNTIME_ACTION_DISABLED_SURFACES,
  ui: true,
  agent: true,
} satisfies ActionSurfaces);

// Per-family/per-action runtime-action surface enablement. Runtime specs are otherwise fail-closed
// projection contracts; a runtime action is surfaced only where a real executor routes through the
// ActionExecutor front door.
const RUNTIME_ACTION_REAL_EXECUTOR_FAMILY_IDS: readonly RuntimeActionIdV1[] = [
  ...ACTION_ID_FAMILIES_V1.local_services_launcher,
  ...ACTION_ID_FAMILIES_V1.local_services_actions,
  ...ACTION_ID_FAMILIES_V1.local_services_public_preview,
  ...ACTION_ID_FAMILIES_V1.browser_control,
  ...ACTION_ID_FAMILIES_V1.browser_automation,
  ...ACTION_ID_FAMILIES_V1.peer_mediation_observability,
];

// Individually-backed runtime actions inside families whose other members have no executor yet.
// Enabling a whole family would surface inert actions.
const RUNTIME_ACTION_REAL_EXECUTOR_ACTION_IDS: readonly RuntimeActionIdV1[] = [
  'browser.context.capturePage',
  'browser.context.captureScreenshot',
  'browser.context.captureSelectedElement',
  'browser.context.captureNetworkSummary',
  'browser.context.captureConsoleSummary',
  'browser.context.annotation.start',
  'browser.context.annotation.cancel',
  'browser.context.annotation.captureRegion',
  'browser.context.annotation.captureElement',
  'browser.context.annotation.attachComment',
  'browser.context.annotation.attachStroke',
  'browser.context.annotation.attachStyleIntent',
  'browser.context.attachToComposer',
  'browser.context.attachToAgentTurn',
  'browser.context.clear',
  'browser.recording.start',
  'browser.recording.stop',
  'browser.recording.cancel',
  'browser.recording.status',
  'browser.recording.listForView',
  'browser.recording.discard',
  'browser.recording.cleanupExpired',
  'browser.recording.attachToComposer',
  'browser.diagnostics.snapshot',
  'browser.diagnostics.clear',
  'browser.diagnostics.pause',
  'browser.diagnostics.resume',
  'browser.diagnostics.eval',
  'browser.diagnostics.getProperties',
  'browser.diagnostics.releaseObjectGroup',
  'browser.diagnostics.elementPicker.start',
  'browser.diagnostics.elementPicker.cancel',
  'localServices.preview.openOrCreate',
  'localServices.preview.status',
  'localServices.preview.revoke',
];

export const RUNTIME_ACTION_REAL_EXECUTOR_SET: ReadonlySet<RuntimeActionIdV1> = new Set<RuntimeActionIdV1>([
  ...RUNTIME_ACTION_REAL_EXECUTOR_FAMILY_IDS,
  ...RUNTIME_ACTION_REAL_EXECUTOR_ACTION_IDS,
]);

export function isRuntimeActionExecutorReal(actionId: RuntimeActionIdV1): boolean {
  if (RUNTIME_ACTION_REAL_EXECUTOR_SET.has(actionId)) return true;
  if (isSimulatorRuntimeActionIdV1(actionId)) {
    return classifySimulatorRuntimeActionBackingV1(actionId) !== 'statically-unbacked';
  }
  return false;
}

export function resolveRuntimeActionSurfaces(actionId: RuntimeActionIdV1): ActionSurfaces {
  return isRuntimeActionExecutorReal(actionId)
    ? RUNTIME_ACTION_ENABLED_SURFACES
    : RUNTIME_ACTION_DISABLED_SURFACES;
}
