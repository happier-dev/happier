import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { ActionIdSchema, normalizeLegacyActionId, type ActionId } from './actionIds.js';
import {
  formatQualifiedPluginActionId,
  parseQualifiedPluginActionId,
  type QualifiedPluginActionId,
} from '../plugins/actions/qualifiedActionId.js';
import {
  ActionSurfaceSchema,
  ActionToolExposureModeSchema,
  type ActionSurfaces,
  type ActionToolExposureMode,
  type ActionToolExposureSurface,
} from './metadata.js';
import { ActionUiPlacementSchema, type ActionUiPlacement } from './actionUiPlacements.js';

const ActionSurfaceKeySchema = lazyZodSchema(() => z.keyof(ActionSurfaceSchema));
export type ActionSurfaceKey = z.infer<typeof ActionSurfaceKeySchema>;
/** Host-stamped caller class; it is not a new transport or plugin invocation surface. */
export const ActionCallerSurfaceV1Schema = lazyZodSchema(() => z.literal('foreign_session_html'));
export type ActionCallerSurfaceV1 = z.infer<typeof ActionCallerSurfaceV1Schema>;
export const ActionPolicyAudienceV1Schema = lazyZodSchema(() => z.union([ActionSurfaceKeySchema, ActionCallerSurfaceV1Schema]));
export type ActionPolicyAudienceV1 = z.infer<typeof ActionPolicyAudienceV1Schema>;
const CallerSurfacePoliciesV1Schema = lazyZodSchema(() => z.looseObject({
  foreign_session_html: z.optional(z.record(z.string(), z.catch(z.enum(['allowed', 'ask_first', 'off']), 'off'))),
}));


export const ActionApprovalScopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('machine'), machineId: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('environment'), environmentId: z.string().check(z.minLength(1)) }),
]));
export type ActionApprovalScopeV1 = z.infer<typeof ActionApprovalScopeV1Schema>;
export const ActionScopedApprovalPreferenceV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: z.string().check(z.minLength(1)),
  scope: ActionApprovalScopeV1Schema,
  approvalRequiredSurfaces: z.array(ActionSurfaceKeySchema),
  approvalWaivedSurfaces: z.array(ActionSurfaceKeySchema),
}));
export type ActionScopedApprovalPreferenceV1 = z.infer<typeof ActionScopedApprovalPreferenceV1Schema>;

/** Identity is independent of delimiter characters in either id. */
export function actionScopedApprovalPreferenceKey(actionId: string, scope: ActionApprovalScopeV1): string {
  return JSON.stringify([actionId, scope.kind, scope.kind === 'machine' ? scope.machineId : scope.environmentId]);
}

function normalizeScopedApprovalRows(rows: readonly ActionScopedApprovalPreferenceV1[]): ActionScopedApprovalPreferenceV1[] {
  const keyed = new Map<string, ActionScopedApprovalPreferenceV1>();
  for (const row of rows) {
    const actionId = normalizeActionSettingsActionId(row.actionId) ?? row.actionId;
    const key = actionScopedApprovalPreferenceKey(actionId, row.scope);
    const prior = keyed.get(key);
    const required = [...new Set([...(prior?.approvalRequiredSurfaces ?? []), ...row.approvalRequiredSurfaces])].sort();
    const waived = [...new Set([...(prior?.approvalWaivedSurfaces ?? []), ...row.approvalWaivedSurfaces])]
      .filter(surface => !required.includes(surface)).sort();
    keyed.set(key, { actionId, scope: row.scope, approvalRequiredSurfaces: required, approvalWaivedSurfaces: waived });
  }
  return [...keyed.values()];
}

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
const LEGACY_SESSION_AGENT_SURFACE = `session_${'agent'}`;
const LEGACY_ACTION_SURFACE_ALIASES = new Map<string, ActionSurfaceKey>([
  [LEGACY_UI_BUTTON_SURFACE, 'ui'],
  [LEGACY_UI_SLASH_COMMAND_SURFACE, 'ui'],
  [LEGACY_VOICE_TOOL_SURFACE, 'voice'],
  [LEGACY_VOICE_ACTION_BLOCK_SURFACE, 'voice'],
  [LEGACY_SESSION_AGENT_SURFACE, 'agent'],
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
    const normalizedKey = LEGACY_ACTION_SURFACE_ALIASES.get(key) ?? key;
    if (!ACTION_TOOL_EXPOSURE_MODE_KEY_SET.has(normalizedKey)) continue;
    const surface = normalizedKey as ActionToolExposureSurface;
    // A valid current spelling wins regardless of persisted property order.
    if (key !== normalizedKey && next[surface] !== undefined) continue;
    const parsed = ActionToolExposureModeSchema.safeParse(value);
    if (!parsed.success) continue;
    next[surface] = parsed.data;
  }
  return next;
}

const ActionSettingsToolExposureModesSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeActionToolExposureModes), z._default(z
    .object({
      agent: z.optional(ActionToolExposureModeSchema),
      mcp: z.optional(ActionToolExposureModeSchema),
      cli: z.optional(ActionToolExposureModeSchema),
    }), {})));

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

const ActionSettingsOverrideSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeLegacyActionSettingsOverride), z.looseObject({
      enabled: z.optional(z.boolean()),
      enabledPlacements: z._default(z.array(ActionUiPlacementSchema), []),
      disabledSurfaces: z._default(z.array(ActionSurfaceKeySchema), []),
      disabledPlacements: z._default(z.array(ActionUiPlacementSchema), []),
      approvalRequiredSurfaces: z._default(z.array(ActionSurfaceKeySchema), []),
      toolExposureModes: ActionSettingsToolExposureModesSchema,
    })));
export type ActionSettingsOverride = z.infer<typeof ActionSettingsOverrideSchema>;

/** A host Action id or the canonical qualified contributed-Action identity. */
export type ActionSettingsActionId = ActionId | QualifiedPluginActionId;

export function normalizeActionSettingsActionId(rawId: string): ActionSettingsActionId | null {
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

export const ActionsSettingsV1Schema = lazyZodSchema(() => z.pipe(z.looseObject({
    v: z.literal(1),
    // Accept unknown Action ids so older clients can round-trip newer policy rows.
    actions: z._default(z.record(z.string(), ActionSettingsOverrideSchema), {}),
    // The 0.2 predecessor has strict Action rows but an open document root.
    // Keep this new choice outside those rows so old readers retain disable/require
    // policy. They ignore the waiver and continue requiring default confirmation.
    approvalWaivedSurfaces: z.catch(z.optional(z.record(z.string(), z.array(ActionSurfaceKeySchema))), undefined),
    /** One viewing Action waiver per plugin, never a retained source grant. */
    pluginHostCaptureApprovalWaived: z.catch(z.optional(z.array(z.string().check(z.minLength(1)))), undefined),
    scopedApprovalPreferences: z.optional(z.array(ActionScopedApprovalPreferenceV1Schema)),
    callerSurfacePolicies: z.catch(z.optional(CallerSurfacePoliciesV1Schema), undefined),
  }), z.transform((value) => ({
    v: 1 as const,
    actions: projectKnownActionSettings(value.actions ?? {}),
    ...(value.approvalWaivedSurfaces ? { approvalWaivedSurfaces: value.approvalWaivedSurfaces } : {}),
    ...(value.pluginHostCaptureApprovalWaived ? { pluginHostCaptureApprovalWaived: value.pluginHostCaptureApprovalWaived } : {}),
    ...(value.scopedApprovalPreferences ? { scopedApprovalPreferences: normalizeScopedApprovalRows(value.scopedApprovalPreferences) } : {}),
    ...(value.callerSurfacePolicies ? { callerSurfacePolicies: value.callerSurfacePolicies } : {}),
  }))));

export type ActionsSettingsV1 = Readonly<{
  v: 1;
  actions: Record<string, ActionSettingsOverride>;
  approvalWaivedSurfaces?: Record<string, ActionSurfaceKey[]>;
  pluginHostCaptureApprovalWaived?: string[];
  scopedApprovalPreferences?: ActionScopedApprovalPreferenceV1[];
  callerSurfacePolicies?: z.infer<typeof CallerSurfacePoliciesV1Schema>;
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
function isActionsSettingsV1Document(value: unknown): value is Readonly<{
  v: 1;
  actions?: Record<string, unknown>;
  approvalWaivedSurfaces?: unknown;
  pluginHostCaptureApprovalWaived?: unknown;
  scopedApprovalPreferences?: unknown;
  callerSurfacePolicies?: unknown;
}> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.v === 1 && (
    record.actions === undefined
    || (typeof record.actions === 'object' && record.actions !== null && !Array.isArray(record.actions))
  );
}

/** Returns null only when the root document cannot be interpreted as v1. */
export function tryNormalizeActionsSettingsV1(value: unknown): ActionsSettingsV1 | null {
  // Missing optional settings are the ordinary default-policy path. Avoid
  // constructing a validation error on every catalog enablement check.
  if (value === undefined || value === null) return null;
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
  const waivers = ActionsSettingsV1Schema.parse({
    v: 1,
    approvalWaivedSurfaces: value.approvalWaivedSurfaces,
  }).approvalWaivedSurfaces;
  const pluginWaivers = ActionsSettingsV1Schema.parse({ v: 1,
    pluginHostCaptureApprovalWaived: value.pluginHostCaptureApprovalWaived,
  }).pluginHostCaptureApprovalWaived;
  const callerSurfacePolicies = ActionsSettingsV1Schema.parse({ v: 1, callerSurfacePolicies: value.callerSurfacePolicies }).callerSurfacePolicies;
  const scopedRows: ActionScopedApprovalPreferenceV1[] = [];
  if (Array.isArray(value.scopedApprovalPreferences)) {
    for (const raw of value.scopedApprovalPreferences) {
      const row = ActionScopedApprovalPreferenceV1Schema.safeParse(raw);
      if (row.success) scopedRows.push(row.data);
      else if (raw && typeof raw === 'object' && typeof raw.actionId === 'string') {
        const scope = ActionApprovalScopeV1Schema.safeParse(raw.scope);
        if (scope.success) scopedRows.push({ actionId: raw.actionId, scope: scope.data,
          approvalRequiredSurfaces: ActionSurfaceKeySchema.options, approvalWaivedSurfaces: [] });
        else actions[normalizeActionSettingsActionId(raw.actionId) ?? raw.actionId] = MALFORMED_ACTION_SETTINGS_OVERRIDE;
      }
    }
  }
  return { v: 1, actions, ...(waivers ? { approvalWaivedSurfaces: waivers } : {}),
    ...(pluginWaivers ? { pluginHostCaptureApprovalWaived: pluginWaivers } : {}),
    ...(callerSurfacePolicies ? { callerSurfacePolicies } : {}),
    ...(Array.isArray(value.scopedApprovalPreferences) ? { scopedApprovalPreferences: normalizeScopedApprovalRows(scopedRows) } : {}) };
}

export function normalizeActionsSettingsV1(value: unknown): ActionsSettingsV1 {
  return tryNormalizeActionsSettingsV1(value) ?? EMPTY_ACTIONS_SETTINGS_V1;
}

/** Edits one approval preference without changing Action enablement or other surfaces. */
export function setActionApprovalOverride(params: Readonly<{
  settings: ActionsSettingsV1;
  actionId: ActionSettingsActionId;
  surface: ActionSurfaceKey;
  approvalRequired: boolean | null;
}>): ActionsSettingsV1 {
  const settings = normalizeActionsSettingsV1(params.settings);
  const prior = settings.actions[params.actionId];
  const required = prior?.approvalRequiredSurfaces.filter((surface) => surface !== params.surface) ?? [];
  if (params.approvalRequired === true) required.push(params.surface);
  const actions = { ...settings.actions };
  if (prior || required.length > 0) {
    actions[params.actionId] = ActionSettingsOverrideSchema.parse({ ...prior, approvalRequiredSurfaces: required });
  }
  const waivers = { ...settings.approvalWaivedSurfaces };
  const waived = waivers[params.actionId]?.filter((surface) => surface !== params.surface) ?? [];
  if (params.approvalRequired === false) waived.push(params.surface);
  if (waived.length > 0) waivers[params.actionId] = waived;
  else delete waivers[params.actionId];
  return {
    v: 1,
    actions,
    ...(Object.keys(waivers).length > 0 ? { approvalWaivedSurfaces: waivers } : {}),
    ...(settings.pluginHostCaptureApprovalWaived ? { pluginHostCaptureApprovalWaived: settings.pluginHostCaptureApprovalWaived } : {}),
  };
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

export function readScopedActionApprovalPreference(settings: ActionsSettingsV1, actionId: string,
  scope: ActionApprovalScopeV1): ActionScopedApprovalPreferenceV1 | undefined {
  const key = actionScopedApprovalPreferenceKey(actionId, scope);
  return settings.scopedApprovalPreferences?.find(row => actionScopedApprovalPreferenceKey(row.actionId, row.scope) === key);
}
