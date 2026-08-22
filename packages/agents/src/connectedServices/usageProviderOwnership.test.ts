import { describe, expect, it } from 'vitest';

import { AGENTS_CORE } from '../manifest.js';
import { isConnectedServiceUsageProviderCompatible } from './usageProviderOwnership.js';

const CLAUDE_SERVICE_ID = AGENTS_CORE.claude.connectedServices?.supportedServiceIds[0] ?? null;

describe('isConnectedServiceUsageProviderCompatible', () => {
  it('accepts a provider that IS the connected service', () => {
    expect(isConnectedServiceUsageProviderCompatible({
      providerId: 'anthropic-claude',
      serviceId: 'anthropic-claude',
    })).toBe(true);
  });

  it('accepts a bundled Agent that declares the connected service', () => {
    expect(CLAUDE_SERVICE_ID).not.toBeNull();
    expect(isConnectedServiceUsageProviderCompatible({
      providerId: 'claude',
      serviceId: String(CLAUDE_SERVICE_ID),
    })).toBe(true);
  });

  it('rejects a bundled Agent that does not declare the connected service', () => {
    expect(isConnectedServiceUsageProviderCompatible({
      providerId: 'claude',
      serviceId: 'a-service-claude-does-not-declare',
    })).toBe(false);
  });

  it('reports no established ownership for an externally installed Agent id', () => {
    // An open Agent id has no bundled fact. The host cannot establish which connected
    // services it consumes, so it must not inherit another Agent's declared services —
    // and must not be silently trusted with them either.
    expect(CLAUDE_SERVICE_ID).not.toBeNull();
    expect(isConnectedServiceUsageProviderCompatible({
      providerId: 'acme-agent',
      serviceId: String(CLAUDE_SERVICE_ID),
    })).toBe(false);
  });

  it('rejects blank provider or service ids instead of matching them to each other', () => {
    expect(isConnectedServiceUsageProviderCompatible({ providerId: '', serviceId: '' })).toBe(false);
    expect(isConnectedServiceUsageProviderCompatible({ providerId: '  ', serviceId: '  ' })).toBe(false);
    expect(isConnectedServiceUsageProviderCompatible({
      providerId: '',
      serviceId: String(CLAUDE_SERVICE_ID),
    })).toBe(false);
  });
});
