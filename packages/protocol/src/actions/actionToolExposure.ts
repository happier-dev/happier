import type { ActionId } from './actionIds.js';
import type { ActionsSettingsV1 } from './actionSettings.js';
import type { ActionSpec, ActionToolExposureMode, ActionToolExposureSurface } from './actionSpecs.js';
import {
  ACTION_TOOL_EXPOSURE_SURFACES,
  getDefaultActionToolExposureMode,
  resolveActionSurfaceAvailability,
  resolveActionToolExposureModeForSurface,
  AGENT_DIRECT_ACTION_TOOL_ALLOW_LIST,
} from './actionSurfaceAvailability.js';

export { ACTION_TOOL_EXPOSURE_SURFACES, AGENT_DIRECT_ACTION_TOOL_ALLOW_LIST };

export type ActionToolExposureResolutionContext = Readonly<{
  settings?: ActionsSettingsV1 | null;
  isActionEnabled?: ((id: ActionId) => boolean) | null;
}>;

export function resolveActionToolExposureMode(
  spec: ActionSpec,
  surface: ActionToolExposureSurface,
  context?: ActionToolExposureResolutionContext | null,
): ActionToolExposureMode {
  return resolveActionToolExposureModeForSurface(spec, surface, context?.settings ?? null);
}

export function isActionDirectToolExposedOn(
  spec: ActionSpec,
  surface: ActionToolExposureSurface,
  context?: ActionToolExposureResolutionContext | null,
): boolean {
  const availability = resolveActionSurfaceAvailability({
    actionId: spec.id as ActionId,
    surface,
    settings: context?.settings ?? null,
    isActionEnabled: context?.isActionEnabled ?? null,
    requireToolBinding: true,
  });
  return availability.available
    && (availability.effectiveToolExposureMode ?? getDefaultActionToolExposureMode(spec, surface)) === 'direct';
}

export function isActionDiscoverableOnToolSurface(
  spec: ActionSpec,
  surface: ActionToolExposureSurface,
  context?: ActionToolExposureResolutionContext | null,
): boolean {
  return resolveActionSurfaceAvailability({
    actionId: spec.id as ActionId,
    surface,
    settings: context?.settings ?? null,
    isActionEnabled: context?.isActionEnabled ?? null,
  }).available;
}
