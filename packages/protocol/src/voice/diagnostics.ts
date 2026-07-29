import { z } from 'zod';

export const VoiceSpeechDiagnosticsSettingsV1Schema = z.object({
  v: z.literal(1).default(1),
  enabled: z.boolean().default(false),
  consentVersion: z.literal(1).nullable().default(null),
  captureSttInput: z.boolean().default(false),
  captureTtsOutput: z.boolean().default(false),
  maxAgeMs: z.number().int().min(5 * 60 * 1_000).max(30 * 24 * 60 * 60 * 1_000).default(24 * 60 * 60 * 1_000),
  maxFiles: z.number().int().min(1).max(100).default(20),
  maxBytes: z.number().int().min(1024).max(1024 * 1024 * 1024).default(100 * 1024 * 1024),
  maxDurationMs: z.number().int().min(1_000).max(30 * 60 * 1_000).default(5 * 60 * 1_000),
}).strict().superRefine((value, context) => {
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
});

export type VoiceSpeechDiagnosticsSettingsV1 = z.infer<typeof VoiceSpeechDiagnosticsSettingsV1Schema>;

export const VoiceSpeechDiagnosticFormatV1Schema = z.enum([
  'pcm16',
  'wav',
  'webm',
  'ogg',
  'mpeg',
  'mp4',
  'flac',
]);
export type VoiceSpeechDiagnosticFormatV1 = z.infer<typeof VoiceSpeechDiagnosticFormatV1Schema>;

/**
 * Request-local authorization is deliberately separate from the persisted
 * account setting. Both must allow capture; absence is fail-closed and lets a
 * session opt out without mutating the account-wide diagnostics preference.
 */
export const VoiceSpeechDiagnosticsCaptureContextV1Schema = z.object({
  sessionId: z.string().min(1).max(256),
  captureAllowed: z.boolean(),
  durationMs: z.number().nonnegative().nullable(),
  // Optional on the additive wire contract so an older diagnostics-capable UI
  // cannot break the surrounding voice operation. The daemon capture owner
  // treats absence as capture-denied.
  authorizationId: z.string().uuid().optional(),
}).strict();
export type VoiceSpeechDiagnosticsCaptureContextV1 = z.infer<typeof VoiceSpeechDiagnosticsCaptureContextV1Schema>;

export const VoiceSpeechDiagnosticArtifactSummaryV1Schema = z.object({
  id: z.string().min(1).max(128),
  createdAtMs: z.number().int().nonnegative(),
  direction: z.enum(['stt_input', 'tts_output']),
  format: VoiceSpeechDiagnosticFormatV1Schema,
  durationMs: z.number().nonnegative().nullable(),
  byteLength: z.number().int().nonnegative(),
}).strict();
export type VoiceSpeechDiagnosticArtifactSummaryV1 = z.infer<typeof VoiceSpeechDiagnosticArtifactSummaryV1Schema>;

const VoiceSpeechDiagnosticsCleanupHealthV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('healthy'),
    code: z.null(),
    ownedEntryCount: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    status: z.literal('required'),
    code: z.enum(['cleanup_failed', 'catalog_unreadable', 'delete_failed']),
    ownedEntryCount: z.number().int().nonnegative().nullable(),
  }).strict().superRefine((value, context) => {
    if (value.code === 'catalog_unreadable' && value.ownedEntryCount !== null) {
      context.addIssue({
        code: 'custom',
        path: ['ownedEntryCount'],
        message: 'voice_diagnostics_catalog_entry_count_unknown',
      });
    }
  }),
]);

/**
 * Capture readiness and retained-data cleanup are independent obligations.
 * Keeping them as separate facts prevents recovery at one boundary from
 * silently clearing a still-unverified failure at the other boundary.
 */
export const VoiceSpeechDiagnosticsHealthV1Schema = z.object({
  captureFailure: z.boolean(),
  cleanup: VoiceSpeechDiagnosticsCleanupHealthV1Schema,
}).strict();
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
export const VoiceSpeechDiagnosticsStorageTargetV1Schema = z.enum([
  'daemon_desktop',
  'android',
  'ios',
  'web',
]);
export type VoiceSpeechDiagnosticsStorageTargetV1 = z.infer<typeof VoiceSpeechDiagnosticsStorageTargetV1Schema>;

const VoiceSpeechDiagnosticsNoAutomaticSyncV1Schema = z.object({
  // Local diagnostics have no sync/upload implementation. This is distinct
  // from a platform's backup behavior and must not be presented as an OS
  // exclusion guarantee.
  automaticSync: z.literal('not_implemented'),
});

export const VoiceSpeechDiagnosticsBackupPolicyV1Schema = z.discriminatedUnion('status', [
  VoiceSpeechDiagnosticsNoAutomaticSyncV1Schema.extend({
    status: z.literal('enforced'),
    storage: z.literal('private_cache'),
    mechanism: z.literal('platform_backup_exclusion'),
  }).strict(),
  VoiceSpeechDiagnosticsNoAutomaticSyncV1Schema.extend({
    status: z.literal('best_effort'),
    storage: z.literal('private_cache'),
    mechanism: z.literal('cachedir_tag'),
  }).strict(),
  VoiceSpeechDiagnosticsNoAutomaticSyncV1Schema.extend({
    status: z.literal('unavailable'),
    storage: z.literal('none'),
    mechanism: z.enum(['no_native_storage_owner', 'no_browser_storage_owner']),
  }).strict(),
]);
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

const VoiceSpeechDiagnosticArtifactIdV1Schema = z.string()
  .min(8)
  .max(96)
  .regex(/^[a-f0-9-]+$/);

export const VoiceSpeechDiagnosticArtifactDownloadInitRequestV1Schema = z.object({
  artifactId: VoiceSpeechDiagnosticArtifactIdV1Schema,
  intent: z.literal('user_confirmed_export'),
  recipientPublicKeyBase64: z.string().min(32).max(1024),
}).strict();
export const VoiceSpeechDiagnosticArtifactDownloadInitResponseV1Schema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    downloadId: z.string().uuid(),
    chunkSizeBytes: z.number().int().positive(),
    sizeBytes: z.number().int().nonnegative(),
    name: z.string().min(1).max(256),
  }).strict(),
  z.object({ success: z.literal(false), error: z.string(), errorCode: z.string().optional() }).strict(),
]);
export const VoiceSpeechDiagnosticArtifactDownloadChunkRequestV1Schema = z.object({
  downloadId: z.string().uuid(),
  index: z.number().int().nonnegative(),
}).strict();
export const VoiceSpeechDiagnosticArtifactDownloadChunkResponseV1Schema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    payloadBase64: z.string(),
    encryptedDataKeyEnvelopeBase64: z.string(),
    isLast: z.boolean(),
  }).strict(),
  z.object({ success: z.literal(false), error: z.string(), errorCode: z.string().optional() }).strict(),
]);
export const VoiceSpeechDiagnosticArtifactDownloadCloseRequestV1Schema = z.object({
  downloadId: z.string().uuid(),
}).strict();
export const VoiceSpeechDiagnosticArtifactDownloadCloseResponseV1Schema = z.object({
  success: z.literal(true),
}).strict();

export const VoiceSpeechDiagnosticsConfigureRequestV1Schema = z.object({
  settings: VoiceSpeechDiagnosticsSettingsV1Schema,
}).strict();
export const VoiceSpeechDiagnosticsStatusResponseV1Schema = z.object({
  ok: z.literal(true),
  root: z.string().min(1),
  settings: VoiceSpeechDiagnosticsSettingsV1Schema,
  artifacts: z.array(VoiceSpeechDiagnosticArtifactSummaryV1Schema).max(100),
  health: VoiceSpeechDiagnosticsHealthV1Schema,
  backupPolicy: VoiceSpeechDiagnosticsBackupPolicyV1Schema,
}).strict();
export const VoiceSpeechDiagnosticsDeleteAllResponseV1Schema = z.object({ ok: z.literal(true) }).strict();
export const VoiceSpeechDiagnosticsRevokeCaptureRequestV1Schema = z.object({
  authorizationId: z.string().uuid(),
}).strict();
export const VoiceSpeechDiagnosticsRevokeCaptureResponseV1Schema = z.object({ ok: z.literal(true) }).strict();
