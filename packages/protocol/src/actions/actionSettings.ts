import { z } from 'zod';

import { ActionIdSchema, normalizeLegacyActionId, type ActionId } from './actionIds.js';
import {
  formatQualifiedPluginActionId,
  parseQualifiedPluginActionId,
  type QualifiedPluginActionId,
} from '../plugins/actions/invocation.js';
import {
  ActionSurfaceSchema,
  ActionToolExposureModeSchema,
  type ActionSurfaces,
  type ActionToolExposureMode,
  type ActionToolExposureSurface,
} from './actionSpecs.js';
import { ActionUiPlacementSchema, type ActionUiPlacement } from './actionUiPlacements.js';

const ActionSurfaceKeySchema = ActionSurfaceSchema.keyof();
export type ActionSurfaceKey = z.infer<typeof ActionSurfaceKeySchema>;
export const ACTION_SETTINGS_OPT_IN_PLACEMENTS = ['agent_input_chips'] as const satisfies readonly ActionUiPlacement[];
const ACTION_SETTINGS_OPT_IN_PLACEMENT_SET = new Set<ActionUiPlacement>(ACTION_SETTINGS_OPT_IN_PLACEMENTS);
const ACTION_TOOL_EXPOSURE_MODE_KEYS = ['agent', 'mcp', 'cli'] as const satisfies readonly ActionToolExposureSurface[];
const ACTION_TOOL_EXPOSURE_MODE_KEY_SET = new Set<string>(ACTION_TOOL_EXPOSURE_MODE_KEYS);
const BROAD_ACTION_SURFACE_KEYS = new Set<ActionSurfaceKey>(ActionSurfaceKeySchema.options);
// A.6 tolerant read-on-load shim for pre-broad-surface persisted settings.
// Keep the legacy spellings constructed below so the final source fence still
// proves new code does not author those surface keys directly.
const LEGACY_UI_BUTTON_SURFACE = `ui_${'button'}`;
const LEGACY_UI_SLASH_COMMAND_SURFACE = `ui_${'slash_command'}`;
const LEGACY_VOICE_TOOL_SURFACE = `voice_${'tool'}`;
const LEGACY_VOICE_ACTION_BLOCK_SURFACE = `voice_${'action_block'}`;
const LEGACY_ACTION_SURFACE_ALIASES = new Map<string, ActionSurfaceKey>([
  [LEGACY_UI_BUTTON_SURFACE, 'ui'],
  [LEGACY_UI_SLASH_COMMAND_SURFACE, 'ui'],
  [LEGACY_VOICE_TOOL_SURFACE, 'voice'],
  [LEGACY_VOICE_ACTION_BLOCK_SURFACE, 'voice'],
]);

function normalizeActionSurfaceList(raw: unknown): readonly ActionSurfaceKey[] {
  if (!Array.isArray(raw)) return [];
  const next: ActionSurfaceKey[] = [];
  const seen = new Set<ActionSurfaceKey>();
  for (const surface of raw) {
    if (typeof surface !== 'string') continue;
    const normalized = LEGACY_ACTION_SURFACE_ALIASES.get(surface) ?? surface;
    if (!BROAD_ACTION_SURFACE_KEYS.has(normalized as ActionSurfaceKey)) continue;
    const surfaceKey = normalized as ActionSurfaceKey;
    if (seen.has(surfaceKey)) continue;
    seen.add(surfaceKey);
    next.push(surfaceKey);
  }
  return next;
}

function normalizeActionToolExposureModes(raw: unknown): Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const next: Partial<Record<ActionToolExposureSurface, ActionToolExposureMode>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ACTION_TOOL_EXPOSURE_MODE_KEY_SET.has(key)) continue;
    const parsed = ActionToolExposureModeSchema.safeParse(value);
    if (!parsed.success) continue;
    next[key as ActionToolExposureSurface] = parsed.data;
  }
  return next;
}

const ActionSettingsToolExposureModesSchema = z.preprocess(
  normalizeActionToolExposureModes,
  z
    .object({
      agent: ActionToolExposureModeSchema.optional(),
      mcp: ActionToolExposureModeSchema.optional(),
      cli: ActionToolExposureModeSchema.optional(),
    })
    .default({}),
);

function normalizeLegacyActionSettingsOverride(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }

  const next = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(next.disabledSurfaces)) {
    next.disabledSurfaces = normalizeActionSurfaceList(next.disabledSurfaces);
  }
  if (Array.isArray(next.approvalRequiredSurfaces)) {
    next.approvalRequiredSurfaces = normalizeActionSurfaceList(next.approvalRequiredSurfaces);
  }
  return next;
}

const ActionSettingsOverrideSchema = z.preprocess(
  normalizeLegacyActionSettingsOverride,
  z
    .object({
      enabled: z.boolean().optional(),
      enabledPlacements: z.array(ActionUiPlacementSchema).default([]),
      disabledSurfaces: z.array(ActionSurfaceKeySchema).default([]),
      disabledPlacements: z.array(ActionUiPlacementSchema).default([]),
      approvalRequiredSurfaces: z.array(ActionSurfaceKeySchema).default([]),
      toolExposureModes: ActionSettingsToolExposureModesSchema,
    })
    // Preserve fields introduced by newer clients so older clients can
    // round-trip an unknown Action policy without erasing it.
    .passthrough(),
);
export type ActionSettingsOverride = z.infer<typeof ActionSettingsOverrideSchema>;

/** A host Action id or the canonical qualified contributed-Action identity. */
export type ActionSettingsActionId = ActionId | QualifiedPluginActionId;

function normalizeActionSettingsActionId(rawId: string): ActionSettingsActionId | null {
  const hostAction = ActionIdSchema.safeParse(normalizeLegacyActionId(rawId));
  if (hostAction.success) return hostAction.data;
  const contributedAction = parseQualifiedPluginActionId(rawId);
  return contributedAction ? formatQualifiedPluginActionId(contributedAction) : null;
}

function projectKnownActionSettings(
  actions: Record<string, ActionSettingsOverride>,
): Record<string, ActionSettingsOverride> {
  // Keep well-formed unknown rows losslessly. Older clients must be able to
  // round-trip settings authored by newer clients without re-enabling them.
  const next: Record<string, ActionSettingsOverride> = {};
  for (const [rawId, override] of Object.entries(actions)) {
    const actionId = normalizeActionSettingsActionId(rawId);
    next[actionId ?? rawId] = override;
  }
  return next;
}

export const ActionsSettingsV1Schema = z
  .object({
    v: z.literal(1),
    // Accept unknown Action ids so older clients can round-trip newer policy rows.
    actions: z.record(z.string(), ActionSettingsOverrideSchema).default({}),
  })
  .passthrough()
  .transform((value) => ({
    v: 1 as const,
    actions: projectKnownActionSettings(value.actions ?? {}),
  }));

export type ActionsSettingsV1 = Readonly<{
  v: 1;
  actions: Record<string, ActionSettingsOverride>;
}>;

const EMPTY_ACTIONS_SETTINGS_V1 = Object.freeze({
  v: 1 as const,
  actions: {},
}) as ActionsSettingsV1;

const MALFORMED_ACTION_SETTINGS_OVERRIDE = ActionSettingsOverrideSchema.parse({ enabled: false });

/**
 * Normalizes persisted/settings transport values without allowing one malformed
 * row to erase unrelated Action policy. Unknown well-formed Actions are kept
 * for lossless round-tripping; malformed known overrides fail closed while
 * valid sibling policy is preserved.
 */
function isActionsSettingsV1Document(value: unknown): value is Readonly<{ v: 1; actions?: Record<string, unknown> }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.v === 1 && (
    record.actions === undefined
    || (typeof record.actions === 'object' && record.actions !== null && !Array.isArray(record.actions))
  );
}

/** Returns null only when the root document cannot be interpreted as v1. */
export function tryNormalizeActionsSettingsV1(value: unknown): ActionsSettingsV1 | null {
  const parsed = ActionsSettingsV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!isActionsSettingsV1Document(value)) return null;

  const actions: Record<string, ActionSettingsOverride> = {};
  for (const [rawId, rawOverride] of Object.entries(value.actions ?? {})) {
    const actionId = normalizeActionSettingsActionId(rawId);
    const override = ActionSettingsOverrideSchema.safeParse(rawOverride);
    const key = actionId ?? rawId;
    actions[key] = override.success ? override.data : MALFORMED_ACTION_SETTINGS_OVERRIDE;
  }
  return { v: 1, actions };
}

export function normalizeActionsSettingsV1(value: unknown): ActionsSettingsV1 {
  return tryNormalizeActionsSettingsV1(value) ?? EMPTY_ACTIONS_SETTINGS_V1;
}

export type ActionEnablementContext = Readonly<{
  surface?: keyof ActionSurfaces | null;
  placement?: ActionUiPlacement | null;
}>;

export function isActionSettingsOptInPlacement(placement: ActionUiPlacement): boolean {
  return ACTION_SETTINGS_OPT_IN_PLACEMENT_SET.has(placement);
}

export function isActionEnabledByActionsSettings(
  actionId: ActionSettingsActionId,
  settings: ActionsSettingsV1,
  ctx?: ActionEnablementContext,
): boolean {
  const override = settings.actions[actionId];
  if (override?.enabled === false) return false;
  const surface = ctx?.surface ?? null;
  if (surface && override?.disabledSurfaces?.includes(surface)) return false;
  const placement = ctx?.placement ?? null;
  if (placement && isActionSettingsOptInPlacement(placement)) {
    if (override?.disabledPlacements?.includes(placement)) return false;
    if (override?.enabledPlacements?.includes(placement)) return true;
    return false;
  }
  if (placement && override?.disabledPlacements?.includes(placement)) return false;
  return true;
}
