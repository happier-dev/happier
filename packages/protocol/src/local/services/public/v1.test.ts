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

  it('rejects unsafe public exposure policy diagnostics recursively', async () => {
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
      auditEventIds: [],
      rateLimitProfileId: 'default',
      policyDiagnostics: {
        reasonCode: 'policy_denied',
        nested: {
          headers: {
            Authorization: 'Bearer secret',
          },
          previewToken: 'secret',
          responseBody: 'secret',
        },
      },
    });

    expect(result?.success).toBe(false);
  });

  it('accepts denied public access audit events with a stable reason code', async () => {
    const mod = await loadPublicModule();

    const result = mod?.LocalServicePublicAuditEventV1Schema.safeParse({
      eventId: 'audit_denied_1',
      exposureId: 'public_preview_123',
      action: 'access_denied',
      reasonCode: 'public_token_mismatch',
      occurredAt: 2_000,
    });

    expect(result?.success).toBe(true);
  });

  it('rejects denied public access audit events without a reason code', async () => {
    const mod = await loadPublicModule();

    const result = mod?.LocalServicePublicAuditEventV1Schema.safeParse({
      eventId: 'audit_denied_1',
      exposureId: 'public_preview_123',
      action: 'access_denied',
      occurredAt: 2_000,
    });

    expect(result?.success).toBe(false);
  });

  it('parses daemon public preview status snapshots with explicit policy and exposure state', async () => {
    const mod = await loadPublicModule();

    const result = mod?.DaemonLocalServicePublicPreviewStatusResponseV1Schema.safeParse({
      protocolVersion: 1,
      snapshot: {
        v: 1,
        machineId: 'machine_123',
        sessionId: 'session_123',
        previewId: 'preview_123',
        generatedAt: 7_000,
        refreshState: 'idle',
        policy: {
          enabled: true,
          allowedModes: ['secret_link'],
          maxTtlMs: 600_000,
          maxConcurrentExposures: 2,
          dnsTlsRequired: true,
          auditRequired: true,
          rateLimitProfileIds: ['default'],
        },
        exposures: [{
          exposureId: 'public_preview_123',
          previewId: 'preview_123',
          sessionId: 'session_123',
          machineId: 'machine_123',
          mode: 'secret_link',
          state: 'active',
          publicUrl: 'https://preview.example.test/s/public_preview_123',
          issuedAt: 1_000,
          expiresAt: 601_000,
          auditEventIds: ['audit_1'],
          rateLimitProfileId: 'default',
        }],
        diagnostics: [{
          v: 1,
          code: 'dns_tls_not_ready',
          severity: 'warning',
          scope: 'publicPreview',
          previewId: 'preview_123',
          publicExposureId: 'public_preview_123',
          emittedAtMs: 6_500,
          details: { provider: 'dev-relay' },
        }],
      },
    });

    expect(result?.success).toBe(true);
  });

  it('redacts public URLs from status snapshots before agent-surface egress', async () => {
    const mod = await loadPublicModule();
    expect(mod?.redactLocalServicePublicPreviewSnapshotForAgentEgress).toBeTypeOf('function');
    if (!mod?.redactLocalServicePublicPreviewSnapshotForAgentEgress) return;

    const snapshot = mod.LocalServicePublicPreviewSnapshotV1Schema.parse({
      v: 1,
      machineId: 'machine_123',
      sessionId: 'session_123',
      previewId: 'preview_123',
      generatedAt: 7_000,
      refreshState: 'idle',
      policy: { enabled: true, allowedModes: ['secret_link'] },
      exposures: [{
        exposureId: 'public_preview_123',
        previewId: 'preview_123',
        sessionId: 'session_123',
        machineId: 'machine_123',
        mode: 'secret_link',
        state: 'active',
        publicUrl: 'https://preview.example.test/s/public_preview_123',
        issuedAt: 1_000,
        expiresAt: 601_000,
        auditEventIds: [],
        rateLimitProfileId: 'default',
      }],
      diagnostics: [],
    });

    const redacted = mod.redactLocalServicePublicPreviewSnapshotForAgentEgress(snapshot);

    expect(redacted.exposures[0]?.publicUrl).toBe(mod.REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);
    expect(snapshot.exposures[0]?.publicUrl).toBe('https://preview.example.test/s/public_preview_123');
    expect(mod.LocalServicePublicPreviewSnapshotV1Schema.safeParse(redacted).success).toBe(true);
  });

  it('redacts public URLs from create and revoke responses before agent-surface egress', async () => {
    const mod = await loadPublicModule();
    expect(mod?.redactLocalServicePublicPreviewCreateResponseForAgentEgress).toBeTypeOf('function');
    expect(mod?.redactLocalServicePublicPreviewRevokeResponseForAgentEgress).toBeTypeOf('function');
    if (
      !mod?.redactLocalServicePublicPreviewCreateResponseForAgentEgress
      || !mod?.redactLocalServicePublicPreviewRevokeResponseForAgentEgress
    ) return;

    const snapshot = mod.LocalServicePublicPreviewSnapshotV1Schema.parse({
      v: 1,
      machineId: 'machine_123',
      sessionId: 'session_123',
      previewId: 'preview_123',
      generatedAt: 7_000,
      refreshState: 'idle',
      policy: { enabled: true, allowedModes: ['secret_link'] },
      exposures: [{
        exposureId: 'public_preview_123',
        previewId: 'preview_123',
        sessionId: 'session_123',
        machineId: 'machine_123',
        mode: 'secret_link',
        state: 'active',
        publicUrl: 'https://preview.example.test/s/public_preview_123',
        issuedAt: 1_000,
        expiresAt: 601_000,
        auditEventIds: [],
        rateLimitProfileId: 'default',
      }],
      diagnostics: [],
    });
    const createResponse = mod.DaemonLocalServicePublicPreviewCreateResponseV1Schema.parse({
      protocolVersion: 1,
      exposure: snapshot.exposures[0],
      snapshot,
    });
    const revokeResponse = mod.DaemonLocalServicePublicPreviewRevokeResponseV1Schema.parse({
      protocolVersion: 1,
      exposureId: 'public_preview_123',
      revokedAt: 8_000,
      snapshot,
    });

    const redactedCreate = mod.redactLocalServicePublicPreviewCreateResponseForAgentEgress(createResponse);
    const redactedRevoke = mod.redactLocalServicePublicPreviewRevokeResponseForAgentEgress(revokeResponse);

    expect(redactedCreate.exposure.publicUrl).toBe(mod.REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);
    expect(redactedCreate.snapshot?.exposures[0]?.publicUrl).toBe(mod.REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);
    expect(redactedRevoke.snapshot.exposures[0]?.publicUrl).toBe(mod.REDACTED_LOCAL_SERVICE_PUBLIC_PREVIEW_URL);
    expect(createResponse.exposure.publicUrl).toBe('https://preview.example.test/s/public_preview_123');
  });

  it('rejects public preview snapshots whose exposure binding drifts from the requested scope', async () => {
    const mod = await loadPublicModule();

    const result = mod?.LocalServicePublicPreviewSnapshotV1Schema.safeParse({
      v: 1,
      machineId: 'machine_123',
      sessionId: 'session_123',
      previewId: 'preview_123',
      generatedAt: 7_000,
      refreshState: 'idle',
      policy: { enabled: true, allowedModes: ['secret_link'] },
      exposures: [{
        exposureId: 'public_preview_123',
        previewId: 'other_preview',
        sessionId: 'session_123',
        machineId: 'machine_123',
        mode: 'secret_link',
        state: 'active',
        publicUrl: 'https://preview.example.test/s/public_preview_123',
        issuedAt: 1_000,
        expiresAt: 601_000,
        auditEventIds: [],
        rateLimitProfileId: 'default',
      }],
      diagnostics: [],
    });

    expect(result?.success).toBe(false);
  });

  it('parses daemon public preview create, revoke, and copy-url envelopes', async () => {
    const mod = await loadPublicModule();

    expect(mod?.DaemonLocalServicePublicPreviewCreateRequestV1Schema.parse({
      machineId: 'machine_123',
      sessionId: 'session_123',
      previewId: 'preview_123',
      mode: 'secret_link',
      ttlMs: 600_000,
      rateLimitProfileId: 'default',
    })).toEqual({
      machineId: 'machine_123',
      sessionId: 'session_123',
      previewId: 'preview_123',
      mode: 'secret_link',
      ttlMs: 600_000,
      rateLimitProfileId: 'default',
    });

    expect(mod?.DaemonLocalServicePublicPreviewRevokeRequestV1Schema.parse({
      machineId: 'machine_123',
      sessionId: 'session_123',
      previewId: 'preview_123',
      exposureId: 'public_preview_123',
    })).toEqual({
      machineId: 'machine_123',
      sessionId: 'session_123',
      previewId: 'preview_123',
      exposureId: 'public_preview_123',
    });

    expect(mod?.DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema.parse({
      protocolVersion: 1,
      machineId: 'machine_123',
      sessionId: 'session_123',
      previewId: 'preview_123',
      exposureId: 'public_preview_123',
      publicUrl: 'https://preview.example.test/s/public_preview_123',
    }).publicUrl).toBe('https://preview.example.test/s/public_preview_123');
  });

  it('carries and validates the UX-5 create confirmation acknowledgement', async () => {
    const mod = await loadPublicModule();

    // The confirmation is additive on the wire (absent is valid for back-compat) ...
    expect(mod?.isLocalServicePublicPreviewCreateConfirmed({ confirmation: undefined })).toBe(false);

    // ... but a present confirmation must be a strict `{ acknowledged: true }` shape.
    const confirmed = mod?.DaemonLocalServicePublicPreviewCreateRequestV1Schema.parse({
      machineId: 'machine_123',
      sessionId: 'session_123',
      previewId: 'preview_123',
      mode: 'secret_link',
      ttlMs: 600_000,
      confirmation: { acknowledged: true },
    });
    expect(confirmed?.confirmation?.acknowledged).toBe(true);
    expect(mod?.isLocalServicePublicPreviewCreateConfirmed(confirmed!)).toBe(true);

    // `acknowledged: false` is not a valid acknowledgement (literal true required).
    expect(mod?.DaemonLocalServicePublicPreviewCreateRequestV1Schema.safeParse({
      machineId: 'machine_123',
      sessionId: 'session_123',
      previewId: 'preview_123',
      mode: 'secret_link',
      ttlMs: 600_000,
      confirmation: { acknowledged: false },
    }).success).toBe(false);
  });

  it('round-trips the one-time public token exchange envelope', async () => {
    const mod = await loadPublicModule();

    expect(mod?.LocalServicePublicPreviewExchangeRequestV1Schema.parse({
      publicToken: 'secret_token_1',
    })).toEqual({ publicToken: 'secret_token_1' });

    expect(mod?.LocalServicePublicPreviewExchangeRequestV1Schema.safeParse({}).success).toBe(false);

    expect(mod?.LocalServicePublicPreviewExchangeResponseV1Schema.parse({
      protocolVersion: 1,
      exposureId: 'public_preview_123',
      publicToken: 'secret_token_2',
      expiresAt: 61_000,
    })).toEqual({
      protocolVersion: 1,
      exposureId: 'public_preview_123',
      publicToken: 'secret_token_2',
      expiresAt: 61_000,
    });
  });
});
