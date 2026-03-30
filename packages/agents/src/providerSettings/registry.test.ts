import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { SettingDefinitionMap } from '@happier-dev/protocol';

import { assertProviderSettingsRegistryValid, getProviderSettingsDefinition } from './registry.js';
import type { ProviderSettingsDefinition } from './types.js';

function makeDefinition(overrides: Partial<ProviderSettingsDefinition>): ProviderSettingsDefinition {
  const baseFields = {
    foo: {
      schema: z.string(),
      default: '',
      description: 'Foo',
      storageScope: 'account',
    },
  } satisfies SettingDefinitionMap;

  return {
    providerId: 'claude',
    fields: baseFields,
    ...overrides,
  };
}

describe('provider settings registry', () => {
  it('rejects duplicate setting keys across provider field maps', () => {
    const a = makeDefinition({ providerId: 'claude' as any });
    const b = makeDefinition({ providerId: 'codex' as any });

    expect(() => assertProviderSettingsRegistryValid([a, b])).toThrow(/defined more than once/i);
  });

  it('exposes field defaults from the canonical provider definition', () => {
    const codexDefinition = getProviderSettingsDefinition('codex');
    expect(codexDefinition).not.toBeNull();
    expect(codexDefinition?.fields.codexBackendMode?.default).toBe('appServer');
  });
});
