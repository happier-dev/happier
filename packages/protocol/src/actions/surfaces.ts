import { ACTION_ID_FAMILIES_V1, type RuntimeActionIdV1 } from './actionIds.js';
import type { PreNormalizedActionSurfaces } from './actionSpecs.js';
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
} satisfies PreNormalizedActionSurfaces);

const RUNTIME_ACTION_ENABLED_SURFACES = Object.freeze({
  ...RUNTIME_ACTION_DISABLED_SURFACES,
  ui: true,
  agent: true,
  mcp: true,
} satisfies PreNormalizedActionSurfaces);

// Per-family/per-action runtime-action surface enablement. Runtime specs are otherwise fail-closed
// projection contracts; a runtime action is surfaced only where a real executor routes through the
// ActionExecutor front door.
export const RUNTIME_ACTION_REAL_EXECUTOR_SET: ReadonlySet<RuntimeActionIdV1> = new Set<RuntimeActionIdV1>([
  // Native confidential fill is deferred beyond 0.3. Keep its Protocol shape
  // readable without advertising or routing an executable implementation.
  ...ACTION_ID_FAMILIES_V1.computer.filter(actionId => actionId !== 'computer.secret.fill'),
  ...ACTION_ID_FAMILIES_V1.local_services_inventory,
  ...ACTION_ID_FAMILIES_V1.local_services_launcher,
  // The daemon runtime executor registers this whole native/source-bound family, including relocation.
  ...ACTION_ID_FAMILIES_V1.local_services_actions,
  ...ACTION_ID_FAMILIES_V1.local_services_public_preview,
  ...ACTION_ID_FAMILIES_V1.browser_control,
  ...ACTION_ID_FAMILIES_V1.browser_automation,
  ...ACTION_ID_FAMILIES_V1.peer_mediation_observability,
  ...ACTION_ID_FAMILIES_V1.browser_context,
  ...ACTION_ID_FAMILIES_V1.browser_recording,
  ...ACTION_ID_FAMILIES_V1.browser_diagnostics,
  ...ACTION_ID_FAMILIES_V1.local_services_preview,
]);

export function isRuntimeActionExecutorReal(actionId: RuntimeActionIdV1): boolean {
  if (RUNTIME_ACTION_REAL_EXECUTOR_SET.has(actionId)) return true;
  if (isSimulatorRuntimeActionIdV1(actionId)) {
    return classifySimulatorRuntimeActionBackingV1(actionId) !== 'statically-unbacked';
  }
  return false;
}

export function resolveRuntimeActionSurfaces(actionId: RuntimeActionIdV1): PreNormalizedActionSurfaces {
  if (ACTION_ID_FAMILIES_V1.browser_diagnostics.some((id) => id === actionId)) {
    return { ...RUNTIME_ACTION_ENABLED_SURFACES, cli: true };
  }
  if (actionId === 'projects.service.relocate' && isRuntimeActionExecutorReal(actionId)) {
    return { ...RUNTIME_ACTION_ENABLED_SURFACES, voice: true };
  }
  return isRuntimeActionExecutorReal(actionId)
    ? RUNTIME_ACTION_ENABLED_SURFACES
    : RUNTIME_ACTION_DISABLED_SURFACES;
}
