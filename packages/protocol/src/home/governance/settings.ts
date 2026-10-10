import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { FeatureDecisionSchema } from '../../features/decision.js';

/**
 * Home settings: the persisted, owner-editable values of the server configuration registry
 * (plan `2026-09-26-home-owner-console` §3.14 "Effective value and write path").
 *
 * Every row is keyed by its registry env name. The server resolves one effective value per key
 * (`deployment` env lock → persisted Home value → registry default) and projects it here; a secret
 * never carries a value, only whether one is set. Writes name registry keys and are validated by
 * the registry on the server, so this contract stays generic instead of repeating each key's type.
 */
export const HomeSettingSourceV1Schema = lazyZodSchema(() => z.enum(['deployment', 'home', 'default']));
export type HomeSettingSourceV1 = z.infer<typeof HomeSettingSourceV1Schema>;

export const HomeSettingEditableV1Schema = lazyZodSchema(() => z.enum(['home', 'bootstrap']));
export type HomeSettingEditableV1 = z.infer<typeof HomeSettingEditableV1Schema>;

export const HomeSettingApplyV1Schema = lazyZodSchema(() => z.enum(['live', 'restart']));
export type HomeSettingApplyV1 = z.infer<typeof HomeSettingApplyV1Schema>;

/** Why a stored `apply: 'restart'` value was not applied at the last start. */
export const HomeSettingIgnoredReasonV1Schema = lazyZodSchema(() => z.enum(['invalid_type', 'out_of_bounds', 'secret_unreadable']));
export type HomeSettingIgnoredReasonV1 = z.infer<typeof HomeSettingIgnoredReasonV1Schema>;

/** A registry value in its typed (not env-text) form: boolean, number, string, list or JSON. */
export const HomeSettingValueV1Schema = lazyZodSchema(() => z.unknown());

/**
 * The registry facts a client needs to render an entry as a setting (plan §3.14 "Console
 * rendering"): its type and bounds for the field and validation, its default, and where it sits
 * (section, group, family, feature). Families the server derives from its own owners (feature
 * keys, rate limits, retention domains) are known to clients only through this projection.
 */
export const HomeSettingDeclarationV1Schema = lazyZodSchema(() => z.object({
  type: z.enum(['boolean', 'int', 'float', 'string', 'enum', 'url', 'email', 'list', 'json']),
  section: z.enum(['reach', 'email', 'policies', 'features', 'data', 'runtime', 'server']),
  group: z.string().min(1).optional(),
  family: z.string().min(1).optional(),
  featureId: z.string().min(1).optional(),
  /** Never present for a secret. */
  default: HomeSettingValueV1Schema.optional(),
  bounds: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
    maxUtf8Bytes: z.number().optional(),
    noControlChars: z.literal(true).optional(),
    values: z.array(z.string()).optional(),
    scheme: z.literal('https').optional(),
  }).strict().optional(),
  /**
   * Present for read-only (`bootstrap`) entries: which technical constraint keeps the key out of
   * the console (§3.14, r4), so a client can say why in its own language. Additive.
   */
  readOnlyReason: z.enum(['before_database', 'per_process_identity', 'invariant']).optional(),
}).strict());

export type HomeSettingDeclarationV1 = z.infer<typeof HomeSettingDeclarationV1Schema>;

export const HomeSettingEntryV1Schema = lazyZodSchema(() => z.object({
  key: z.string().min(1),
  /** Always `null` for a secret: secrets are write-only. */
  value: HomeSettingValueV1Schema.nullable(),
  source: HomeSettingSourceV1Schema,
  /** An explicitly set deployment env value locks the key. */
  fixed: z.boolean(),
  editable: HomeSettingEditableV1Schema,
  apply: HomeSettingApplyV1Schema,
  /** Present for secret entries only. */
  secretSet: z.boolean().optional(),
  /** Present for read-only (`bootstrap`) entries: why the console cannot change the key. */
  readOnlyReason: z.string().min(1).optional(),
  /** The entry's registry declaration (additive; always sent by current servers). */
  declaration: HomeSettingDeclarationV1Schema.optional(),
  /** Present for `apply: 'restart'` entries: what the running process started with. */
  applied: z.object({
    value: HomeSettingValueV1Schema.nullable(),
    pending: z.boolean(),
    ignoredReason: HomeSettingIgnoredReasonV1Schema.optional(),
  }).strict().optional(),
}).strict());

export type HomeSettingEntryV1 = z.infer<typeof HomeSettingEntryV1Schema>;

export const HomeSettingsGetInputV1Schema = lazyZodSchema(() => z.object({}).strict());
export type HomeSettingsGetInputV1 = z.infer<typeof HomeSettingsGetInputV1Schema>;

export const HomeSettingsProjectionV1Schema = lazyZodSchema(() => z.object({
  /** `0` while nothing has been stored; the first stored revision is `1`. */
  revision: z.number().int().min(0),
  /** When the running server process applied its startup configuration (ISO time), if known. */
  startedAt: z.string().min(1).nullable(),
  entries: z.array(HomeSettingEntryV1Schema),
  /**
   * Why each server feature is on or off right now (§3.8): one decision per server-represented
   * feature, computed by the canonical engine from the Home's effective configuration — build
   * policy, the feature's own switch, then dependency closure with a typed
   * `blockingDependencyId`. The same decisions close `/v1/features`. Additive.
   */
  featureDecisions: z.array(FeatureDecisionSchema).optional(),
}).strict());

export type HomeSettingsProjectionV1 = z.infer<typeof HomeSettingsProjectionV1Schema>;

export const HomeSettingSecretWriteV1Schema = lazyZodSchema(() => z.union([
  z.object({ replace: z.string().min(1) }).strict(),
  z.object({ clear: z.literal(true) }).strict(),
]));
export type HomeSettingSecretWriteV1 = z.infer<typeof HomeSettingSecretWriteV1Schema>;

/**
 * A partial write against the revision the caller last read. `values[key] = null` clears the
 * stored value (the key falls back to its default); secrets travel only in `secrets`.
 */
export const HomeSettingsSetInputV1Schema = lazyZodSchema(() => z.object({
  expectedRevision: z.number().int().min(0),
  values: z.record(z.string().min(1), HomeSettingValueV1Schema.nullable()),
  secrets: z.record(z.string().min(1), HomeSettingSecretWriteV1Schema).optional(),
  /**
   * Discard (§3.14 r3): every stored `apply: 'restart'` value the running server has not applied
   * goes back to what this process started with — the value it applied, or cleared when it ran on
   * its env or default. The server derives the write from its own startup snapshot (a client
   * cannot restore a secret it never sees) and records each key as `home.settings.discard`. It
   * cannot be combined with `values` or `secrets`. Additive.
   */
  discardPendingRestart: z.literal(true).optional(),
}).strict());

export type HomeSettingsSetInputV1 = z.infer<typeof HomeSettingsSetInputV1Schema>;

export const HomeSettingsInvalidReasonV1Schema = lazyZodSchema(() => z.enum([
  'invalid_type',
  'out_of_bounds',
  'unknown_key',
  'not_home_editable',
  'secret_in_values',
  'not_secret',
  /** The value is required by another stored value (e.g. a retention domain's days once it deletes). */
  'required',
]));
export type HomeSettingsInvalidReasonV1 = z.infer<typeof HomeSettingsInvalidReasonV1Schema>;

/** The one typed refusal of a settings write: the first failing key and why. */
export const HomeSettingsInvalidErrorV1Schema = lazyZodSchema(() => z.object({
  error: z.literal('home_settings_invalid'),
  key: z.string().min(1),
  reason: HomeSettingsInvalidReasonV1Schema,
}).strict());

export type HomeSettingsInvalidErrorV1 = z.infer<typeof HomeSettingsInvalidErrorV1Schema>;

/**
 * Mail delivery readiness (§3.3). Field values and their sources are the `email` section of
 * `home.settings.get`; this read adds what only the mail owner can answer: whether a transport is
 * configured, whether the link a mail must carry can be built, and whether the stored password can
 * still be opened. Ready means both transport and link.
 */
export const HomeMailDeliveryGetInputV1Schema = lazyZodSchema(() => z.object({}).strict());
export type HomeMailDeliveryGetInputV1 = z.infer<typeof HomeMailDeliveryGetInputV1Schema>;

export const HomeMailDeliveryReadinessV1Schema = lazyZodSchema(() => z.object({
  transportConfigured: z.boolean(),
  linkTargetBuildable: z.boolean(),
  /** Where links in emails open (the application origin), when one is configured. */
  linkOrigin: z.string().min(1).nullable(),
  ready: z.boolean(),
  /** The stored SMTP password exists but the server can no longer open it. */
  passwordUnreadable: z.boolean(),
}).strict());

export type HomeMailDeliveryReadinessV1 = z.infer<typeof HomeMailDeliveryReadinessV1Schema>;

export const HomeMailDeliveryTestInputV1Schema = lazyZodSchema(() => z.object({
  to: z.string().trim().min(3).max(320).email(),
}).strict());

export type HomeMailDeliveryTestInputV1 = z.infer<typeof HomeMailDeliveryTestInputV1Schema>;

/** A failure carries its class only, never transport detail or credentials. */
export const HomeMailDeliveryTestResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('sent') }).strict(),
  z.object({
    status: z.literal('failed'),
    reason: z.enum(['not_configured', 'password_unreadable', 'render_failed', 'transport_failed']),
  }).strict(),
]));

export type HomeMailDeliveryTestResultV1 = z.infer<typeof HomeMailDeliveryTestResultV1Schema>;
