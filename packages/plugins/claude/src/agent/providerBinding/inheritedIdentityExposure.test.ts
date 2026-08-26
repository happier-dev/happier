import { describe, expect, it } from 'vitest';

import type { AgentSessionProviderBinding } from '@happier-dev/plugin-sdk/agents/runtime';

import { claudeProviderBindingExposesInheritedIdentity } from './inheritedIdentityExposure.js';

function binding(
  upstream: AgentSessionProviderBinding['upstream'],
): AgentSessionProviderBinding {
  return {
    connectionId: 'pc_binding',
    model: { id: 'claude-sonnet-4-6', name: 'Sonnet' },
    upstream,
    materialization: { v: 1, kind: 'spawnEnv' },
  };
}

describe('claudeProviderBindingExposesInheritedIdentity', () => {
  it('exposes the inherited login for every credential-less Provider binding, including Anthropic', () => {
    expect(claudeProviderBindingExposesInheritedIdentity(binding({
      protocol: 'anthropic',
      normalizedUrl: 'http://localhost:1234',
      credential: 'none',
    }))).toBe(true);
    expect(claudeProviderBindingExposesInheritedIdentity(binding({
      protocol: 'anthropic',
      normalizedUrl: 'https://gateway.example.test/anthropic',
      credential: 'none',
    }))).toBe(true);
    for (const normalizedUrl of [
      'https://api.anthropic.com',
      'https://api.anthropic.com/v1',
      'https://API.Anthropic.com/v1',
      null,
    ]) {
      expect(claudeProviderBindingExposesInheritedIdentity(binding({
        protocol: 'anthropic',
        normalizedUrl,
        credential: 'none',
      }))).toBe(true);
    }
  });

  it('does not expose it when the binding carries its own credential', () => {
    expect(claudeProviderBindingExposesInheritedIdentity(binding({
      protocol: 'anthropic',
      normalizedUrl: 'https://gateway.example.test/anthropic',
      credential: 'apiKey',
    }))).toBe(false);
  });

  it('keeps the endpoint out of the credential-isolation decision', () => {
    for (const normalizedUrl of [
      'https://api.anthropic.com.evil.test/v1',
      'https://evil.test/https://api.anthropic.com',
      'http://api.anthropic.com/v1',
      'https://api.anthropic.com:8443/v1',
    ]) {
      expect(claudeProviderBindingExposesInheritedIdentity(binding({
        protocol: 'anthropic',
        normalizedUrl,
        credential: 'none',
      }))).toBe(true);
    }
  });

  it('does not expose it for a managed-local binding, which mints its own credential', () => {
    expect(claudeProviderBindingExposesInheritedIdentity(binding({
      protocol: 'anthropic',
      normalizedUrl: null,
      credential: 'apiKey',
    }))).toBe(false);
  });
});
