import type { ActionId } from './actionIds.js';
import { isActionEnabledByActionsSettings, type ActionsSettingsV1 } from './actionSettings.js';
import type { ActionSpec, ActionToolExposureMode, ActionToolExposureSurface } from './actionSpecs.js';

export const ACTION_TOOL_EXPOSURE_SURFACES = ['session_agent', 'mcp', 'cli'] as const satisfies readonly ActionToolExposureSurface[];

export const SESSION_AGENT_DIRECT_ACTION_TOOL_ALLOW_LIST = [
  'action.spec.search',
  'action.spec.get',
  'action.options.resolve',
] as const satisfies readonly ActionId[];

const SESSION_AGENT_DIRECT_ACTION_TOOL_ALLOW_SET = new Set<ActionId>(SESSION_AGENT_DIRECT_ACTION_TOOL_ALLOW_LIST);

export type ActionToolExposureResolutionContext = Readonly<{
  settings?: ActionsSettingsV1 | null;
  isActionEnabled?: ((id: ActionId) => boolean) | null;
}>;

function getSettingsOverride(
  spec: ActionSpec,
  surface: ActionToolExposureSurface,
  context?: ActionToolExposureResolutionContext | null,
): ActionToolExposureMode | null {
  return context?.settings?.actions?.[spec.id as ActionId]?.toolExposureModes?.[surface] ?? null;
}

function getDefaultActionToolExposureMode(spec: ActionSpec, surface: ActionToolExposureSurface): ActionToolExposureMode {
  const explicit = spec.toolExposure?.[surface];
  if (explicit) return explicit;
  if (surface === 'session_agent') {
    return SESSION_AGENT_DIRECT_ACTION_TOOL_ALLOW_SET.has(spec.id as ActionId) ? 'direct' : 'discoverable_only';
  }
  return 'direct';
}

function isActionAvailableOnToolExposureSurface(
  spec: ActionSpec,
  surface: ActionToolExposureSurface,
  context?: ActionToolExposureResolutionContext | null,
): boolean {
  if (spec.surfaces[surface] !== true) return false;

  const actionId = spec.id as ActionId;
  if (context?.settings && !isActionEnabledByActionsSettings(actionId, context.settings, { surface })) {
    return false;
  }
  if (context?.isActionEnabled && !context.isActionEnabled(actionId)) {
    return false;
  }
  return true;
}

export function resolveActionToolExposureMode(
  spec: ActionSpec,
  surface: ActionToolExposureSurface,
  context?: ActionToolExposureResolutionContext | null,
): ActionToolExposureMode {
  return getSettingsOverride(spec, surface, context) ?? getDefaultActionToolExposureMode(spec, surface);
}

export function isActionDirectToolExposedOn(
  spec: ActionSpec,
  surface: ActionToolExposureSurface,
  context?: ActionToolExposureResolutionContext | null,
): boolean {
  return Boolean(spec.bindings?.mcpToolName)
    && isActionAvailableOnToolExposureSurface(spec, surface, context)
    && resolveActionToolExposureMode(spec, surface, context) === 'direct';
}

export function isActionDiscoverableOnToolSurface(
  spec: ActionSpec,
  surface: ActionToolExposureSurface,
  context?: ActionToolExposureResolutionContext | null,
): boolean {
  return Boolean(spec.bindings?.mcpToolName)
    && isActionAvailableOnToolExposureSurface(spec, surface, context);
}
