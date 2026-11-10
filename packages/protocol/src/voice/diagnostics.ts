import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const VoiceSpeechDiagnosticsSettingsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z._default(z.literal(1), 1),
  enabled: z._default(z.boolean(), false),
  consentVersion: z._default(z.nullable(z.literal(1)), null),
  captureSttInput: z._default(z.boolean(), false),
  captureTtsOutput: z._default(z.boolean(), false),
  maxAgeMs: z._default(z.number().check(z.int(), z.minimum(5 * 60 * 1_000), z.maximum(30 * 24 * 60 * 60 * 1_000)), 24 * 60 * 60 * 1_000),
  maxFiles: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(100)), 20),
  maxBytes: z._default(z.number().check(z.int(), z.minimum(1024), z.maximum(1024 * 1024 * 1024)), 100 * 1024 * 1024),
  maxDurationMs: z._default(z.number().check(z.int(), z.minimum(1_000), z.maximum(30 * 60 * 1_000)), 5 * 60 * 1_000),
}).check(z.superRefine((value, context) => {
  if (value.enabled && value.consentVersion !== 1) {
    context.addIssue({
      code: 'custom',
      path: ['consentVersion'],
      message: 'voice_diagnostics_consent_required',
    });
  }
  if (value.enabled && !value.captureSttInput && !value.captureTtsOutput) {
    context.addIssue({
      code: 'custom',
      path: ['enabled'],
      message: 'voice_diagnostics_capture_kind_required',
    });
  }
})));

export type VoiceSpeechDiagnosticsSettingsV1 = z.infer<typeof VoiceSpeechDiagnosticsSettingsV1Schema>;

export const VoiceSpeechDiagnosticFormatV1Schema = lazyZodSchema(() => z.enum([
  'pcm16',
  'wav',
  'webm',
  'ogg',
  'mpeg',
  'mp4',
  'flac',
]));
export type VoiceSpeechDiagnosticFormatV1 = z.infer<typeof VoiceSpeechDiagnosticFormatV1Schema>;

/**
 * Request-local authorization is deliberately separate from the persisted
 * account setting. Both must allow capture; absence is fail-closed and lets a
 * session opt out without mutating the account-wide diagnostics preference.
 */
export const VoiceSpeechDiagnosticsCaptureContextV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1), z.maxLength(256)),
  captureAllowed: z.boolean(),
  durationMs: z.nullable(z.number().check(z.nonnegative())),
  // Optional on the additive wire contract so an older diagnostics-capable UI
  // cannot break the surrounding voice operation. The daemon capture owner
  // treats absence as capture-denied.
  authorizationId: z.optional(z.string().check(z.uuid())),
}));
export type VoiceSpeechDiagnosticsCaptureContextV1 = z.infer<typeof VoiceSpeechDiagnosticsCaptureContextV1Schema>;

export const VoiceSpeechDiagnosticArtifactSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1), z.maxLength(128)),
  createdAtMs: z.number().check(z.int(), z.nonnegative()),
  direction: z.enum(['stt_input', 'tts_output']),
  format: VoiceSpeechDiagnosticFormatV1Schema,
  durationMs: z.nullable(z.number().check(z.nonnegative())),
  byteLength: z.number().check(z.int(), z.nonnegative()),
}));
export type VoiceSpeechDiagnosticArtifactSummaryV1 = z.infer<typeof VoiceSpeechDiagnosticArtifactSummaryV1Schema>;

const VoiceSpeechDiagnosticsCleanupHealthV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('healthy'),
    code: z.null(),
    ownedEntryCount: z.number().check(z.int(), z.nonnegative()),
  }),
  z.strictObject({
    status: z.literal('required'),
    code: z.enum(['cleanup_failed', 'catalog_unreadable', 'delete_failed']),
    ownedEntryCount: z.nullable(z.number().check(z.int(), z.nonnegative())),
  }).check(z.superRefine((value, context) => {
    if (value.code === 'catalog_unreadable' && value.ownedEntryCount !== null) {
      context.addIssue({
        code: 'custom',
        path: ['ownedEntryCount'],
        message: 'voice_diagnostics_catalog_entry_count_unknown',
      });
    }
  })),
]));

/**
 * Capture readiness and retained-data cleanup are independent obligations.
 * Keeping them as separate facts prevents recovery at one boundary from
 * silently clearing a still-unverified failure at the other boundary.
 */
export const VoiceSpeechDiagnosticsHealthV1Schema = lazyZodSchema(() => z.strictObject({
  captureFailure: z.boolean(),
  cleanup: VoiceSpeechDiagnosticsCleanupHealthV1Schema,
}));
export type VoiceSpeechDiagnosticsHealthV1 = z.infer<typeof VoiceSpeechDiagnosticsHealthV1Schema>;

export type VoiceSpeechDiagnosticsHealthPresentation = Readonly<{
  severity: 'healthy' | 'degraded';
  primaryCode: 'cleanup_failed' | 'catalog_unreadable' | 'delete_failed' | 'capture_failed' | null;
  cleanupRequired: boolean;
  ownedEntryCount: number | null;
  actions: Readonly<{
    retryCleanup: boolean;
    deleteOwnedEntries: boolean;
    awaitNextEligibleCapture: boolean;
  }>;
}>;

export function resolveVoiceSpeechDiagnosticsHealthPresentation(
  health: VoiceSpeechDiagnosticsHealthV1,
): VoiceSpeechDiagnosticsHealthPresentation {
  const cleanupRequired = health.cleanup.status === 'required';
  return {
    severity: cleanupRequired || health.captureFailure ? 'degraded' : 'healthy',
    primaryCode: cleanupRequired
      ? health.cleanup.code
      : health.captureFailure
        ? 'capture_failed'
        : null,
    cleanupRequired,
    ownedEntryCount: health.cleanup.ownedEntryCount,
    actions: {
      retryCleanup: cleanupRequired,
      deleteOwnedEntries: cleanupRequired,
      awaitNextEligibleCapture: health.captureFailure,
    },
  };
}

/**
 * The only supported persisted-audio writer is currently the selected Node
 * daemon. Native and browser capture still travel to that writer; they must
 * not silently grow their own on-device/browser stores.
 */
export const VoiceSpeechDiagnosticsStorageTargetV1Schema = lazyZodSchema(() => z.enum([
  'daemon_desktop',
  'android',
  'ios',
  'web',
]));
export type VoiceSpeechDiagnosticsStorageTargetV1 = z.infer<typeof VoiceSpeechDiagnosticsStorageTargetV1Schema>;

const VoiceSpeechDiagnosticsNoAutomaticSyncV1Schema = lazyZodSchema(() => z.object({
  // Local diagnostics have no sync/upload implementation. This is distinct
  // from a platform's backup behavior and must not be presented as an OS
  // exclusion guarantee.
  automaticSync: z.literal('not_implemented'),
}));

export const VoiceSpeechDiagnosticsBackupPolicyV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceSpeechDiagnosticsNoAutomaticSyncV1Schema, {
    status: z.literal('enforced'),
    storage: z.literal('private_cache'),
    mechanism: z.literal('platform_backup_exclusion'),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceSpeechDiagnosticsNoAutomaticSyncV1Schema, {
    status: z.literal('best_effort'),
    storage: z.literal('private_cache'),
    mechanism: z.literal('cachedir_tag'),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(VoiceSpeechDiagnosticsNoAutomaticSyncV1Schema, {
    status: z.literal('unavailable'),
    storage: z.literal('none'),
    mechanism: z.enum(['no_native_storage_owner', 'no_browser_storage_owner']),
  })),
]));
export type VoiceSpeechDiagnosticsBackupPolicyV1 = z.infer<typeof VoiceSpeechDiagnosticsBackupPolicyV1Schema>;

export function resolveVoiceSpeechDiagnosticsStoragePolicy(
  target: VoiceSpeechDiagnosticsStorageTargetV1,
): VoiceSpeechDiagnosticsBackupPolicyV1 {
  switch (target) {
    case 'daemon_desktop':
      return {
        status: 'best_effort',
        storage: 'private_cache',
        mechanism: 'cachedir_tag',
        automaticSync: 'not_implemented',
      };
    case 'android':
    case 'ios':
      return {
        status: 'unavailable',
        storage: 'none',
        mechanism: 'no_native_storage_owner',
        automaticSync: 'not_implemented',
      };
    case 'web':
      return {
        status: 'unavailable',
        storage: 'none',
        mechanism: 'no_browser_storage_owner',
        automaticSync: 'not_implemented',
      };
  }
}

const VoiceSpeechDiagnosticArtifactIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(8), z.maxLength(96), z.regex(/^[a-f0-9-]+$/)));

export const VoiceSpeechDiagnosticArtifactDownloadInitRequestV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: VoiceSpeechDiagnosticArtifactIdV1Schema,
  intent: z.literal('user_confirmed_export'),
  recipientPublicKeyBase64: z.string().check(z.minLength(32), z.maxLength(1024)),
}));
export const VoiceSpeechDiagnosticArtifactDownloadInitResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('success', [
  z.strictObject({
    success: z.literal(true),
    downloadId: z.string().check(z.uuid()),
    chunkSizeBytes: z.number().check(z.int(), z.positive()),
    sizeBytes: z.number().check(z.int(), z.nonnegative()),
    name: z.string().check(z.minLength(1), z.maxLength(256)),
  }),
  z.strictObject({ success: z.literal(false), error: z.string(), errorCode: z.optional(z.string()) }),
]));
export const VoiceSpeechDiagnosticArtifactDownloadChunkRequestV1Schema = lazyZodSchema(() => z.strictObject({
  downloadId: z.string().check(z.uuid()),
  index: z.number().check(z.int(), z.nonnegative()),
}));
export const VoiceSpeechDiagnosticArtifactDownloadChunkResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('success', [
  z.strictObject({
    success: z.literal(true),
    payloadBase64: z.string(),
    encryptedDataKeyEnvelopeBase64: z.string(),
    isLast: z.boolean(),
  }),
  z.strictObject({ success: z.literal(false), error: z.string(), errorCode: z.optional(z.string()) }),
]));
export const VoiceSpeechDiagnosticArtifactDownloadCloseRequestV1Schema = lazyZodSchema(() => z.strictObject({
  downloadId: z.string().check(z.uuid()),
}));
export const VoiceSpeechDiagnosticArtifactDownloadCloseResponseV1Schema = lazyZodSchema(() => z.strictObject({
  success: z.literal(true),
}));

export const VoiceSpeechDiagnosticsConfigureRequestV1Schema = lazyZodSchema(() => z.strictObject({
  settings: VoiceSpeechDiagnosticsSettingsV1Schema,
}));
export const VoiceSpeechDiagnosticsStatusResponseV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  root: z.string().check(z.minLength(1)),
  settings: VoiceSpeechDiagnosticsSettingsV1Schema,
  artifacts: z.array(VoiceSpeechDiagnosticArtifactSummaryV1Schema).check(z.maxLength(100)),
  health: VoiceSpeechDiagnosticsHealthV1Schema,
  backupPolicy: VoiceSpeechDiagnosticsBackupPolicyV1Schema,
}));
export const VoiceSpeechDiagnosticsDeleteAllResponseV1Schema = lazyZodSchema(() => z.strictObject({ ok: z.literal(true) }));
export const VoiceSpeechDiagnosticsRevokeCaptureRequestV1Schema = lazyZodSchema(() => z.strictObject({
  authorizationId: z.string().check(z.uuid()),
}));
export const VoiceSpeechDiagnosticsRevokeCaptureResponseV1Schema = lazyZodSchema(() => z.strictObject({ ok: z.literal(true) }));
