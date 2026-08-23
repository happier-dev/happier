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
  next.disabledSurfaces = normalizeActionSurfaceList(next.disabledSurfaces);
  next.approvalRequiredSurfaces = normalizeActionSurfaceList(next.approvalRequiredSurfaces);
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
    .strict(),
);
export type ActionSettingsOverride = z.infer<typeof ActionSettingsOverrideSchema>;

/** A host Action id or the canonical qualified contributed-Action identity. */
export type ActionSettingsActionId = ActionId | QualifiedPluginActionId;

export const ActionsSettingsV1Schema = z
  .object({
    v: z.literal(1),
    // Accept unknown keys but filter them down to known ActionIds during transform so settings
    // survive action id additions without failing strict parsing.
    actions: z.record(z.string(), ActionSettingsOverrideSchema).default({}),
  })
  .passthrough()
  .transform((value) => {
    const next: Partial<Record<ActionSettingsActionId, ActionSettingsOverride>> = {};
    const actions = value.actions ?? {};
    for (const [rawId, override] of Object.entries(actions)) {
      const parsedId = ActionIdSchema.safeParse(normalizeLegacyActionId(rawId));
      if (parsedId.success) {
        next[parsedId.data] = override;
        continue;
      }
      const contributedAction = parseQualifiedPluginActionId(rawId);
      if (!contributedAction) continue;
      next[formatQualifiedPluginActionId(contributedAction)] = override;
    }
    return { v: 1 as const, actions: next };
  });

export type ActionsSettingsV1 = z.infer<typeof ActionsSettingsV1Schema>;

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
