import { ActionIdSchema, type ActionId } from './actionIds.js';
import { isActionEnabledByActionsSettings, normalizeActionSettingsActionId, type ActionSettingsActionId, type ActionsSettingsV1 } from './actionSettings.js';
import type { ActionCallerSurfaceV1 } from './actionSettings.js';
import type { ActionUiPlacement } from './actionUiPlacements.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { isMemoryWriteActionV1 } from '../prompts/library/memoryActionsV1.js';
import {
  getActionSpec,
  type ActionSpec,
  type ActionSurfaces,
  type ActionToolExposureMode,
  type ActionToolExposureSurface,
} from './actionSpecs.js';

export const ACTION_TOOL_EXPOSURE_SURFACES = ['agent', 'mcp', 'cli'] as const satisfies readonly ActionToolExposureSurface[];

const ACTION_TOOL_EXPOSURE_SURFACE_SET = new Set<string>(ACTION_TOOL_EXPOSURE_SURFACES);

export type ActionSurfacePolicy = Readonly<{
  surface: keyof ActionSurfaces;
  settingsConfigurable: boolean;
  classification: 'settings_configurable' | 'internal';
}>;

export const ACTION_SURFACE_POLICIES = [
  { surface: 'ui', settingsConfigurable: true, classification: 'settings_configurable' },
  { surface: 'voice', settingsConfigurable: true, classification: 'settings_configurable' },
  { surface: 'agent', settingsConfigurable: true, classification: 'settings_configurable' },
  { surface: 'mcp', settingsConfigurable: true, classification: 'settings_configurable' },
  { surface: 'cli', settingsConfigurable: true, classification: 'settings_configurable' },
  { surface: 'rpc', settingsConfigurable: false, classification: 'internal' },
  { surface: 'api', settingsConfigurable: true, classification: 'settings_configurable' },
  { surface: 'plugin', settingsConfigurable: true, classification: 'settings_configurable' },
] as const satisfies readonly ActionSurfacePolicy[];

export type ActionSurfaceAvailabilityReason =
  | 'available'
  | 'unknown_action'
  | 'missing_tool_binding'
  | 'unsupported_surface'
  | 'disabled_by_settings'
  | 'disabled_by_policy';

export type ActionSurfaceSettingsState = 'enabled' | 'disabled' | 'approval_required' | 'unknown';

export type ActionSurfaceAvailability = Readonly<{
  available: boolean;
  reason: ActionSurfaceAvailabilityReason;
  actionId: string;
  surface: keyof ActionSurfaces;
  availableSurfaces: readonly (keyof ActionSurfaces)[];
  settingsState?: ActionSurfaceSettingsState;
  defaultToolExposureMode?: ActionToolExposureMode;
  effectiveToolExposureMode?: ActionToolExposureMode;
  remedy?: string;
}>;

export type ActionSurfaceAvailabilityContext = Readonly<{
  callerSurface?: ActionCallerSurfaceV1;
  settings?: ActionsSettingsV1 | null;
  isActionEnabled?: ((id: ActionId) => boolean) | null;
  /** Undefined means an Account host without a bound Session. */
  sessionMemoryEnabled?: boolean;
  requireToolBinding?: boolean | null;
  /** Admitted contributed declarations use the same policy as built-in specs. */
  definition?: Readonly<{
    id: string;
    description?: string | null;
    surfaces: ActionSurfaces;
    toolExposure?: ActionSpec['toolExposure'];
    bindings?: ActionSpec['bindings'] | null;
  }>;
  /** Host-selected children retain settings policy without external exposure. */
  hostInternal?: boolean;
  placement?: ActionUiPlacement | null;
}>;

export function isActionEnabledWithSessionMemory(actionId: string, sessionMemoryEnabled?: boolean): boolean {
  return sessionMemoryEnabled !== false || !isMemoryWriteActionV1(actionId);
}

export function listActionSurfacePolicies(): readonly ActionSurfacePolicy[] {
  return ACTION_SURFACE_POLICIES;
}

export function getActionSurfacePolicy(surface: keyof ActionSurfaces): ActionSurfacePolicy {
  return ACTION_SURFACE_POLICIES.find((policy) => policy.surface === surface) ?? {
    surface,
    settingsConfigurable: false,
    classification: 'internal',
  };
}

export function isActionToolExposureSurface(surface: keyof ActionSurfaces): surface is ActionToolExposureSurface {
  return ACTION_TOOL_EXPOSURE_SURFACE_SET.has(surface);
}

export function getDefaultActionToolExposureMode(
  spec: Readonly<{ id: string; toolExposure?: ActionSpec['toolExposure'] }>,
  surface: keyof ActionSurfaces,
): ActionToolExposureMode {
  const explicit = isActionToolExposureSurface(surface) ? spec.toolExposure?.[surface] : undefined;
  if (explicit) return explicit;
  if (surface === 'agent' || surface === 'mcp') {
    return 'discoverable_only';
  }
  return 'direct';
}

function getSettingsOverride(
  spec: Readonly<{ id: string; toolExposure?: ActionSpec['toolExposure'] }>,
  surface: keyof ActionSurfaces,
  settings?: ActionsSettingsV1 | null,
): ActionToolExposureMode | null {
  return isActionToolExposureSurface(surface)
    ? settings?.actions?.[spec.id as ActionId]?.toolExposureModes?.[surface] ?? null
    : null;
}

export function resolveActionToolExposureModeForSurface(
  spec: Readonly<{ id: string; toolExposure?: ActionSpec['toolExposure'] }>,
  surface: keyof ActionSurfaces,
  settings?: ActionsSettingsV1 | null,
): ActionToolExposureMode {
  return getSettingsOverride(spec, surface, settings) ?? getDefaultActionToolExposureMode(spec, surface);
}

function getAvailableSurfaces(spec: Readonly<{ surfaces: ActionSurfaces }>): readonly (keyof ActionSurfaces)[] {
  return Object.entries(spec.surfaces)
    .filter((entry): entry is [keyof ActionSurfaces, true] => entry[1] === true)
    .map(([surface]) => surface);
}

function getSettingsState(
  actionId: ActionSettingsActionId,
  surface: keyof ActionSurfaces,
  settings?: ActionsSettingsV1 | null,
  callerSurface?: ActionCallerSurfaceV1,
): ActionSurfaceSettingsState {
  if (!settings && !callerSurface) return 'unknown';
  const effectiveSettings: ActionsSettingsV1 = settings ?? { v: 1, actions: {} };
  const context = { surface, callerSurface };
  if (!isActionEnabledByActionsSettings(actionId, effectiveSettings, context)) {
    return 'disabled';
  }
  if (isApprovalRequiredByActionsSettings(actionId, effectiveSettings, context)) {
    return 'approval_required';
  }
  return 'enabled';
}

function unknownAvailability(
  actionId: string,
  surface: keyof ActionSurfaces,
): ActionSurfaceAvailability {
  return {
    available: false,
    reason: 'unknown_action',
    actionId,
    surface,
    availableSurfaces: [],
  };
}

export function resolveActionSurfaceAvailability(params: Readonly<{
  actionId: ActionId | string;
  surface: keyof ActionSurfaces;
}> & ActionSurfaceAvailabilityContext): ActionSurfaceAvailability {
  const actionId = String(params.actionId);
  const parsedActionId = ActionIdSchema.safeParse(actionId);
  const settingsActionId = parsedActionId.success ? parsedActionId.data : normalizeActionSettingsActionId(actionId);
  if (!settingsActionId) return unknownAvailability(actionId, params.surface);

  let spec = params.definition;
  try {
    spec ??= parsedActionId.success ? getActionSpec(parsedActionId.data) : undefined;
  } catch {
    return unknownAvailability(actionId, params.surface);
  }
  if (!spec || spec.id !== actionId) return unknownAvailability(actionId, params.surface);

  const availableSurfaces = getAvailableSurfaces(spec);
  const toolExposure = isActionToolExposureSurface(params.surface)
    ? {
        defaultToolExposureMode: getDefaultActionToolExposureMode(spec, params.surface),
        effectiveToolExposureMode: resolveActionToolExposureModeForSurface(spec, params.surface, params.settings),
      }
    : {};

  if (!params.hostInternal && spec.surfaces[params.surface] !== true) {
    return {
      available: false,
      reason: 'unsupported_surface',
      actionId,
      surface: params.surface,
      availableSurfaces,
      ...(spec.description ? { remedy: spec.description } : {}),
      ...toolExposure,
    };
  }

  const settingsState = getSettingsState(settingsActionId, params.surface, params.settings, params.callerSurface);
  if (
    (params.settings || params.callerSurface)
    && !isActionEnabledByActionsSettings(settingsActionId, params.settings ?? { v: 1, actions: {} }, {
      surface: params.surface, placement: params.placement, callerSurface: params.callerSurface,
    })
  ) {
    return {
      available: false,
      reason: 'disabled_by_settings',
      actionId,
      surface: params.surface,
      availableSurfaces,
      settingsState,
      ...toolExposure,
    };
  }

  if (
    !isActionEnabledWithSessionMemory(actionId, params.sessionMemoryEnabled)
    || (params.isActionEnabled && parsedActionId.success && !params.isActionEnabled(parsedActionId.data))
  ) {
    return {
      available: false,
      reason: 'disabled_by_policy',
      actionId,
      surface: params.surface,
      availableSurfaces,
      settingsState,
      ...toolExposure,
    };
  }

  if (params.requireToolBinding && !spec.bindings?.mcpToolName) {
    return {
      available: false,
      reason: 'missing_tool_binding',
      actionId,
      surface: params.surface,
      availableSurfaces,
      settingsState,
      ...toolExposure,
    };
  }

  return {
    available: true,
    reason: 'available',
    actionId,
    surface: params.surface,
    availableSurfaces,
    settingsState,
    ...toolExposure,
  };
}
