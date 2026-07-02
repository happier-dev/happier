import { describe, expect, it } from 'vitest';

type PublicModule = typeof import('./v1.js');

async function loadPublicModule(): Promise<PublicModule | null> {
  return import('./v1.js').catch(() => null);
}

describe('local service public exposure v1 protocol', () => {
  it('defaults public exposure policy to fail closed', async () => {
    const mod = await loadPublicModule();

    const result = mod?.LocalServicePublicPolicyV1Schema.safeParse({});

    expect(result?.success).toBe(true);
    if (result?.success) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.allowedModes).toEqual([]);
    }
  });

  it('binds public exposure to an existing private preview resource', async () => {
    const mod = await loadPublicModule();

    const result = mod?.LocalServicePublicExposureV1Schema.safeParse({
      exposureId: 'public_preview_123',
      previewId: 'preview_123',
      sessionId: 'session_123',
      machineId: 'machine_123',
      mode: 'secret_link',
      state: 'active',
      publicUrl: 'https://preview.example.test/s/public_preview_123',
      issuedAt: 1_000,
      expiresAt: 61_000,
      auditEventIds: ['audit_1'],
      rateLimitProfileId: 'default',
    });

    expect(result?.success).toBe(true);
  });

  it('rejects non-http public exposure URLs', async () => {
    const mod = await loadPublicModule();

    const result = mod?.LocalServicePublicExposureV1Schema.safeParse({
      exposureId: 'public_preview_123',
      previewId: 'preview_123',
      sessionId: 'session_123',
      machineId: 'machine_123',
      mode: 'secret_link',
      state: 'active',
      publicUrl: 'javascript:alert(1)',
      issuedAt: 1_000,
      expiresAt: 61_000,
      auditEventIds: [],
      rateLimitProfileId: 'default',
    });

    expect(result?.success).toBe(false);
  });

  it('rejects exposures whose expiry does not follow issuance', async () => {
    const mod = await loadPublicModule();

    const result = mod?.LocalServicePublicExposureV1Schema.safeParse({
      exposureId: 'public_preview_123',
      previewId: 'preview_123',
      sessionId: 'session_123',
      machineId: 'machine_123',
      mode: 'secret_link',
      state: 'active',
      publicUrl: 'https://preview.example.test/s/public_preview_123',
      issuedAt: 61_000,
      expiresAt: 61_000,
      auditEventIds: [],
      rateLimitProfileId: 'default',
    });

    expect(result?.success).toBe(false);
  });

  it('rejects private preview tokens as public exposure state', async () => {
    const mod = await loadPublicModule();

    const result = mod?.LocalServicePublicExposureV1Schema.safeParse({
      exposureId: 'public_preview_123',
      previewId: 'preview_123',
      sessionId: 'session_123',
      machineId: 'machine_123',
      mode: 'private_preview',
      state: 'active',
      publicUrl: 'https://preview.example.test/s/public_preview_123',
      issuedAt: 1_000,
      expiresAt: 61_000,
      auditEventIds: [],
      rateLimitProfileId: 'default',
    });

    expect(result?.success).toBe(false);
  });
});
