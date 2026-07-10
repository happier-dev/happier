import { describe, expect, it } from 'vitest';

import {
  DaemonVoiceCredentialDeleteRequestSchema,
  DaemonVoiceClientAuthArtifactSchema,
  DaemonVoiceCredentialMintClientAuthResponseSchema,
  DaemonVoiceCredentialStatusResponseSchema,
  DaemonVoiceCredentialStoreRequestSchema,
  DaemonVoiceProviderCatalogResponseSchema,
} from './voiceCredentials.js';

describe('daemon voice credential RPC contract', () => {
  it('supports short-lived provider SDK tokens without mislabeling their placement as an HTTP header', () => {
    expect(DaemonVoiceClientAuthArtifactSchema.parse({
      kind: 'sdk_token',
      value: 'short-lived',
      expiresAtMs: Date.now() + 60_000,
      placement: 'provider_sdk_parameter',
    })).toMatchObject({ kind: 'sdk_token', placement: 'provider_sdk_parameter' });
  });
  it('accepts bounded provider and credential identities and rejects secret-shaped extras', () => {
    expect(DaemonVoiceCredentialStoreRequestSchema.parse({
      providerId: 'openai_compat',
      credentialKind: 'api_key',
      secret: 'sk-test-value',
    })).toEqual({
      providerId: 'openai_compat',
      credentialKind: 'api_key',
      secret: 'sk-test-value',
    });

    expect(() => DaemonVoiceCredentialStoreRequestSchema.parse({
      providerId: 'openai_compat',
      credentialKind: 'api_key',
      secret: 'x'.repeat(16_385),
    })).toThrow();
    expect(() => DaemonVoiceCredentialDeleteRequestSchema.parse({
      providerId: '../escape',
      credentialKind: 'api_key',
    })).toThrow();
    expect(() => DaemonVoiceCredentialStoreRequestSchema.parse({
      providerId: 'openai_compat',
      credentialKind: 'api_key',
      secret: 'secret',
      rawSecret: 'must-not-pass',
    })).toThrow();
  });

  it('projects truthful protection without ever carrying a long-lived value in status', () => {
    const parsed = DaemonVoiceCredentialStatusResponseSchema.parse({
      ok: true,
      exists: true,
      protection: 'file_permissions',
    });
    expect(parsed).toEqual({ ok: true, exists: true, protection: 'file_permissions' });
    expect(JSON.stringify(parsed)).not.toContain('secret');
    expect(() => DaemonVoiceCredentialStatusResponseSchema.parse({
      ok: true,
      exists: true,
      protection: 'keychain',
    })).toThrow();
  });

  it('allows only typed ephemeral auth artifacts and bounded sanitized catalog rows', () => {
    expect(DaemonVoiceCredentialMintClientAuthResponseSchema.parse({
      ok: true,
      artifact: {
        kind: 'subprotocol_token',
        value: 'ephemeral-value',
        expiresAtMs: Date.now() + 30_000,
        placement: 'websocket_subprotocol',
      },
    })).toMatchObject({ ok: true, artifact: { kind: 'subprotocol_token' } });
    expect(() => DaemonVoiceCredentialMintClientAuthResponseSchema.parse({
      ok: true,
      artifact: {
        kind: 'api_key',
        value: 'long-lived',
        expiresAtMs: Date.now() + 30_000,
        placement: 'header',
      },
    })).toThrow();

    expect(DaemonVoiceProviderCatalogResponseSchema.parse({
      ok: true,
      items: [{ id: 'voice-1', name: 'Voice One', metadata: { language: 'en' } }],
    })).toMatchObject({ ok: true, items: [{ id: 'voice-1' }] });
    expect(() => DaemonVoiceProviderCatalogResponseSchema.parse({
      ok: true,
      items: Array.from({ length: 501 }, (_, index) => ({ id: `v-${index}`, name: 'voice' })),
    })).toThrow();
  });
});
