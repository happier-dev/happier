import { ActionIdSchema, type ActionId } from './actionIds.js';
import { isActionEnabledByActionsSettings, type ActionsSettingsV1 } from './actionSettings.js';
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

export const AGENT_DIRECT_ACTION_TOOL_ALLOW_LIST = [
  'action.spec.search',
  'action.spec.get',
  'action.options.resolve',
  'execution.run.list',
  'execution.run.get',
  'execution.run.wait',
  'plugins.reload',
  // The current-viewer presentation command is a first-class Agent tool: its
  // exact Session target, principal, binding, currentness, acknowledgement and
  // idempotency are all host-stamped below the generic Action boundary.
  'session.presentation.apply',
  // Board authoring is a first-class Session Agent vertical. The exact Home
  // feature decision and Session authority are enforced by the host/executor;
  // this catalog row only makes the already-admitted Actions directly usable.
  'session.board.get',
  'session.board.item.upsert',
  'session.board.item.remove',
  'session.board.layout.update',
  'workflow.run.start',
  'workflow.run.get',
  'workflow.run.wait',
  'workflow.run.cancel',
] as const satisfies readonly ActionId[];

const AGENT_DIRECT_ACTION_TOOL_ALLOW_SET = new Set<ActionId>(AGENT_DIRECT_ACTION_TOOL_ALLOW_LIST);
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
  settings?: ActionsSettingsV1 | null;
  isActionEnabled?: ((id: ActionId) => boolean) | null;
  /** Undefined means an Account host without a bound Session. */
  sessionMemoryEnabled?: boolean;
  requireToolBinding?: boolean | null;
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
  spec: ActionSpec,
  surface: ActionToolExposureSurface,
): ActionToolExposureMode {
  const explicit = spec.toolExposure?.[surface];
  if (explicit) return explicit;
  if (surface === 'agent') {
    return AGENT_DIRECT_ACTION_TOOL_ALLOW_SET.has(spec.id as ActionId) ? 'direct' : 'discoverable_only';
  }
  return 'direct';
}

function getSettingsOverride(
  spec: ActionSpec,
  surface: ActionToolExposureSurface,
  settings?: ActionsSettingsV1 | null,
): ActionToolExposureMode | null {
  return settings?.actions?.[spec.id as ActionId]?.toolExposureModes?.[surface] ?? null;
}

export function resolveActionToolExposureModeForSurface(
  spec: ActionSpec,
  surface: ActionToolExposureSurface,
  settings?: ActionsSettingsV1 | null,
): ActionToolExposureMode {
  return getSettingsOverride(spec, surface, settings) ?? getDefaultActionToolExposureMode(spec, surface);
}

function getAvailableSurfaces(spec: ActionSpec): readonly (keyof ActionSurfaces)[] {
  return Object.entries(spec.surfaces)
    .filter((entry): entry is [keyof ActionSurfaces, true] => entry[1] === true)
    .map(([surface]) => surface);
}

function getSettingsState(
  actionId: ActionId,
  surface: keyof ActionSurfaces,
  settings?: ActionsSettingsV1 | null,
): ActionSurfaceSettingsState {
  if (!settings) return 'unknown';
  const override = settings.actions[actionId];
  if (override?.enabled === false || override?.disabledSurfaces.some((disabledSurface) => disabledSurface === surface)) {
    return 'disabled';
  }
  if (isApprovalRequiredByActionsSettings(actionId, settings, { surface })) {
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
  if (!parsedActionId.success) return unknownAvailability(actionId, params.surface);

  let spec: ActionSpec;
  try {
    spec = getActionSpec(parsedActionId.data);
  } catch {
    return unknownAvailability(actionId, params.surface);
  }

  const availableSurfaces = getAvailableSurfaces(spec);
  const toolExposure = isActionToolExposureSurface(params.surface)
    ? {
        defaultToolExposureMode: getDefaultActionToolExposureMode(spec, params.surface),
        effectiveToolExposureMode: resolveActionToolExposureModeForSurface(spec, params.surface, params.settings),
      }
    : {};

  if (spec.surfaces[params.surface] !== true) {
    return {
      available: false,
      reason: 'unsupported_surface',
      actionId,
      surface: params.surface,
      availableSurfaces,
      ...toolExposure,
    };
  }

  const settingsState = getSettingsState(parsedActionId.data, params.surface, params.settings);
  if (
    params.settings
    && !isActionEnabledByActionsSettings(parsedActionId.data, params.settings, { surface: params.surface })
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
    || (params.isActionEnabled && !params.isActionEnabled(parsedActionId.data))
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
