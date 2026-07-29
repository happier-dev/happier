import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { resolveSpawnBindingContinuity } from './resolveSpawnBindingContinuity';

function binding(overrides: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    connectionId: ProviderConnectionIdSchema.parse('pc_a'),
    contributionKey: 'plugin.gateway/gateway',
    connectionRevision: 1,
    protocol: 'openai-responses' as const,
    materialization: 'engineConfig' as const,
    adapterBindingKey: 'gateway',
    compatibilityFingerprint: 'compatibility-v1',
    bindingSecurityFingerprint: 'security-a',
    displaySnapshot: {
      providerName: 'Gateway', connectionName: 'Gateway', connectionRole: 'default' as const,
      connectionDisplayNameMode: 'automatic' as const,
    },
    ...overrides,
  };
}

describe('resolveSpawnBindingContinuity', () => {
  it('allows initial and benign same-security lifecycle boundaries', () => {
    expect(resolveSpawnBindingContinuity({ sessionId: 'session-1', previous: null, next: binding(), confirmation: null }))
      .toEqual({ ok: true, change: 'initial' });
    expect(resolveSpawnBindingContinuity({
      sessionId: 'session-1', previous: binding(), next: binding({ connectionRevision: 2 }), confirmation: null,
    })).toEqual({ ok: true, change: 'benign_change' });
  });

  it('refuses a same-connection security change until explicitly confirmed', () => {
    const input = { previous: binding(), next: binding({ bindingSecurityFingerprint: 'security-b' }) };
    expect(resolveSpawnBindingContinuity({ sessionId: 'session-1', ...input, confirmation: null })).toMatchObject({
      ok: false,
      error: { code: 'provider_binding_changed', retryable: false, action: 'review_and_restart' },
    });
    expect(resolveSpawnBindingContinuity({
      sessionId: 'session-1',
      ...input,
      confirmation: {
        v: 1,
        sessionId: 'session-1',
        connectionId: ProviderConnectionIdSchema.parse('pc_a'),
        previousBindingSecurityFingerprint: 'security-a',
        nextBindingSecurityFingerprint: 'security-b',
      },
    }))
      .toEqual({ ok: true, change: 'security_change' });
  });

  it('does not let confirmation of A to B authorize an unseen A to C race', () => {
    expect(resolveSpawnBindingContinuity({
      sessionId: 'session-1',
      previous: binding(),
      next: binding({ bindingSecurityFingerprint: 'security-c' }),
      confirmation: {
        v: 1,
        sessionId: 'session-1',
        connectionId: ProviderConnectionIdSchema.parse('pc_a'),
        previousBindingSecurityFingerprint: 'security-a',
        nextBindingSecurityFingerprint: 'security-b',
      },
    })).toMatchObject({ ok: false, error: { code: 'provider_binding_changed' } });
  });

  it('accepts an explicitly selected connection change at the new process boundary', () => {
    expect(resolveSpawnBindingContinuity({
      previous: binding(),
      next: binding({ connectionId: ProviderConnectionIdSchema.parse('pc_b'), bindingSecurityFingerprint: 'security-b' }),
      sessionId: 'session-1',
      confirmation: null,
    })).toEqual({ ok: true, change: 'connection_change' });
  });
});
