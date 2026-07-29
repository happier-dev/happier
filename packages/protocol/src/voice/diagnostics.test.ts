import { describe, expect, it } from 'vitest';

import {
  VoiceSpeechDiagnosticArtifactDownloadInitRequestV1Schema,
  VoiceSpeechDiagnosticArtifactSummaryV1Schema,
  VoiceSpeechDiagnosticsBackupPolicyV1Schema,
  VoiceSpeechDiagnosticsCaptureContextV1Schema,
  VoiceSpeechDiagnosticsHealthV1Schema,
  resolveVoiceSpeechDiagnosticsHealthPresentation,
  VoiceSpeechDiagnosticsSettingsV1Schema,
  VoiceSpeechDiagnosticsStatusResponseV1Schema,
  resolveVoiceSpeechDiagnosticsStoragePolicy,
} from './diagnostics.js';

describe('VoiceSpeechDiagnosticsSettingsV1Schema', () => {
  it('defaults fail closed and bounds retention independently', () => {
    expect(VoiceSpeechDiagnosticsSettingsV1Schema.parse({})).toEqual({
      v: 1,
      enabled: false,
      consentVersion: null,
      captureSttInput: false,
      captureTtsOutput: false,
      maxAgeMs: 86_400_000,
      maxFiles: 20,
      maxBytes: 104_857_600,
      maxDurationMs: 300_000,
    });
    expect(VoiceSpeechDiagnosticsSettingsV1Schema.safeParse({ enabled: true, consentVersion: null }).success).toBe(false);
    expect(VoiceSpeechDiagnosticsSettingsV1Schema.safeParse({ enabled: true, consentVersion: 1, maxFiles: 0 }).success).toBe(false);
  });

  it('keeps request-scoped capture fail closed and preserves honest unknown durations', () => {
    const authorized = {
      sessionId: 'session-1',
      captureAllowed: true,
      durationMs: null,
      authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
    };
    expect(VoiceSpeechDiagnosticsCaptureContextV1Schema.parse(authorized)).toEqual(authorized);
    expect(VoiceSpeechDiagnosticsCaptureContextV1Schema.parse({
      sessionId: 'session-1',
      captureAllowed: true,
      durationMs: null,
    })).toEqual({ sessionId: 'session-1', captureAllowed: true, durationMs: null });
    expect(VoiceSpeechDiagnosticsCaptureContextV1Schema.safeParse({
      sessionId: '../session',
      captureAllowed: false,
      durationMs: null,
      authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
    }).success).toBe(true);
    expect(VoiceSpeechDiagnosticArtifactSummaryV1Schema.parse({
      id: 'artifact-1',
      createdAtMs: 1,
      direction: 'stt_input',
      format: 'webm',
      durationMs: null,
      byteLength: 42,
    })).toMatchObject({ format: 'webm', durationMs: null });
  });

  it('requires explicit artifact-export intent and reports platform storage protection without overstating guarantees', () => {
    expect(VoiceSpeechDiagnosticArtifactDownloadInitRequestV1Schema.parse({
      artifactId: 'abcdef12-dead-beef',
      intent: 'user_confirmed_export',
      recipientPublicKeyBase64: 'a'.repeat(44),
    })).toMatchObject({ intent: 'user_confirmed_export' });
    expect(VoiceSpeechDiagnosticArtifactDownloadInitRequestV1Schema.safeParse({
      artifactId: '../../secret',
      intent: 'user_confirmed_export',
      recipientPublicKeyBase64: 'a'.repeat(44),
    }).success).toBe(false);
    expect(VoiceSpeechDiagnosticArtifactDownloadInitRequestV1Schema.safeParse({
      artifactId: 'abcdef12-dead-beef',
      recipientPublicKeyBase64: 'a'.repeat(44),
    }).success).toBe(false);

    expect(resolveVoiceSpeechDiagnosticsStoragePolicy('daemon_desktop')).toEqual({
      status: 'best_effort',
      storage: 'private_cache',
      mechanism: 'cachedir_tag',
      automaticSync: 'not_implemented',
    });
    expect(resolveVoiceSpeechDiagnosticsStoragePolicy('android')).toEqual({
      status: 'unavailable',
      storage: 'none',
      mechanism: 'no_native_storage_owner',
      automaticSync: 'not_implemented',
    });
    expect(resolveVoiceSpeechDiagnosticsStoragePolicy('ios')).toEqual({
      status: 'unavailable',
      storage: 'none',
      mechanism: 'no_native_storage_owner',
      automaticSync: 'not_implemented',
    });
    expect(resolveVoiceSpeechDiagnosticsStoragePolicy('web')).toEqual({
      status: 'unavailable',
      storage: 'none',
      mechanism: 'no_browser_storage_owner',
      automaticSync: 'not_implemented',
    });
    expect(VoiceSpeechDiagnosticsBackupPolicyV1Schema.safeParse({
      status: 'enforced',
      storage: 'private_cache',
      mechanism: 'cachedir_tag',
      automaticSync: 'not_implemented',
    }).success).toBe(false);
  });

  it('projects independent capture and cleanup obligations without losing either recovery action', () => {
    const health = VoiceSpeechDiagnosticsHealthV1Schema.parse({
      captureFailure: true,
      cleanup: {
        status: 'required',
        code: 'cleanup_failed',
        ownedEntryCount: null,
      },
    });
    expect(resolveVoiceSpeechDiagnosticsHealthPresentation(health)).toEqual({
      severity: 'degraded',
      primaryCode: 'cleanup_failed',
      cleanupRequired: true,
      ownedEntryCount: null,
      actions: {
        retryCleanup: true,
        deleteOwnedEntries: true,
        awaitNextEligibleCapture: true,
      },
    });
    expect(VoiceSpeechDiagnosticsHealthV1Schema.safeParse({
      captureFailure: false,
      cleanup: {
        status: 'required',
        code: 'catalog_unreadable',
        ownedEntryCount: 1,
      },
    }).success).toBe(false);
    expect(VoiceSpeechDiagnosticsStatusResponseV1Schema.safeParse({
      ok: true,
      root: '/private/root',
      settings: VoiceSpeechDiagnosticsSettingsV1Schema.parse({}),
      artifacts: [],
      backupPolicy: resolveVoiceSpeechDiagnosticsStoragePolicy('daemon_desktop'),
    }).success).toBe(false);
  });
});
