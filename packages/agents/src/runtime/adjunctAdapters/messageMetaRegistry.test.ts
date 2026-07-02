import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  getProviderMessageMetaEnricher,
  resolveProviderOutgoingMessageMetaExtras,
} from './messageMetaRegistry.js';

describe('getProviderMessageMetaEnricher', () => {
  it('keeps provider branching out of the shared message-meta registry', () => {
    const registrySource = readFileSync(
      fileURLToPath(new URL('./messageMetaRegistry.ts', import.meta.url)),
      'utf8',
    );

    expect(registrySource).not.toMatch(/\bswitch\s*\(/);
    expect(registrySource).not.toMatch(/\bcase\s+['"]claude['"]/);
    expect(registrySource).not.toMatch(/['"]claude['"]/);
    expect(registrySource).not.toMatch(/providers\//);
  });

  it('does not implicitly register plugin-owned provider enrichers', () => {
    expect(getProviderMessageMetaEnricher('claude')).toEqual({});
    expect(getProviderMessageMetaEnricher('codex')).toEqual({});
  });

  it('returns empty extras when no provider enricher is registered', () => {
    expect(resolveProviderOutgoingMessageMetaExtras({
      agentId: 'claude',
      settings: {
        claudeRemoteSettingSourcesV2: ['project'],
        claudeRemoteDebugCategories: ['api'],
      },
      session: {},
    })).toEqual({});
  });
});
