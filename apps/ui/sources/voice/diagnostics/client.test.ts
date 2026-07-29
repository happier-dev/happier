import { describe, expect, it, vi } from 'vitest';

import { createVoiceDiagnosticsClient } from './client';

describe('voice diagnostics client', () => {
  it('routes configure/status/delete through the selected voice machine and validates responses', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method.endsWith('.deleteAll')) return { ok: true };
      return {
        ok: true,
        root: '/private/happier/voice/diagnostics/v1',
        settings: {
          v: 1,
          enabled: false,
          consentVersion: null,
          captureSttInput: false,
          captureTtsOutput: false,
          maxAgeMs: 86_400_000,
          maxFiles: 20,
          maxBytes: 104_857_600,
          maxDurationMs: 300_000,
        },
        artifacts: [],
        health: {
          captureFailure: false,
          cleanup: { status: 'healthy', code: null, ownedEntryCount: 0 },
        },
        backupPolicy: { status: 'best_effort', storage: 'private_cache', mechanism: 'cachedir_tag', automaticSync: 'not_implemented' },
      };
    });
    const client = createVoiceDiagnosticsClient({ invoke });

    await expect(client.status()).resolves.toMatchObject({ root: expect.stringContaining('diagnostics') });
    await expect(client.configure({
      v: 1,
      enabled: false,
      consentVersion: null,
      captureSttInput: false,
      captureTtsOutput: false,
      maxAgeMs: 86_400_000,
      maxFiles: 20,
      maxBytes: 104_857_600,
      maxDurationMs: 300_000,
    })).resolves.toMatchObject({ settings: { enabled: false } });
    await expect(client.deleteAll()).resolves.toBeUndefined();
    expect(invoke.mock.calls.map(([method]) => method)).toEqual([
      'daemon.voiceDiagnostics.status',
      'daemon.voiceDiagnostics.configure',
      'daemon.voiceDiagnostics.deleteAll',
    ]);
  });

  it('starts artifact export only with explicit confirmation intent and the selected artifact id', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method.endsWith('.init')) return { success: false, error: 'transfer_not_found', errorCode: 'transfer_not_found' };
      throw new Error(`unexpected ${method}`);
    });
    const destination = { writeBytes: vi.fn(), close: vi.fn(), cleanup: vi.fn() };

    await expect(createVoiceDiagnosticsClient({ invoke }).downloadArtifact({
      artifactId: 'abcdef12-dead-beef',
      destination,
    })).resolves.toMatchObject({ ok: false, errorCode: 'transfer_not_found' });
    expect(invoke).toHaveBeenCalledWith(
      'daemon.voiceDiagnostics.artifact.download.init',
      expect.objectContaining({
        artifactId: 'abcdef12-dead-beef',
        intent: 'user_confirmed_export',
        recipientPublicKeyBase64: expect.any(String),
      }),
      undefined,
    );
  });

  it('fails closed on malformed or daemon-error responses', async () => {
    await expect(createVoiceDiagnosticsClient({ invoke: async () => ({ ok: true, root: '/tmp' }) }).status())
      .rejects.toMatchObject({ code: 'invalid_response' });
    await expect(createVoiceDiagnosticsClient({ invoke: async () => ({ ok: false, errorCode: 'machine_unavailable' }) }).status())
      .rejects.toMatchObject({ code: 'machine_unavailable' });
  });
});
