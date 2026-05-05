import { describe, expect, it } from 'vitest';

import {
  EXTENSION_HOOK_CATALOG_V1,
  ExtensionHookAggregationKindV1Schema,
  ExtensionHookScopeV1Schema,
  getExtensionHookDefinitionV1,
} from '../../index.js';

describe('extension hook catalog v1', () => {
  it('catalogs event ids with category, scope, execution kind, and aggregation semantics', () => {
    expect(typeof getExtensionHookDefinitionV1).toBe('function');

    const spawnEnv = getExtensionHookDefinitionV1('spawn.augmentEnv');
    expect(spawnEnv).toMatchObject({
      id: 'spawn.augmentEnv',
      category: 'augmentation',
      scope: 'daemon',
      executionKind: 'augment',
      aggregation: 'mergeObject',
      failureMode: 'bestEffort',
    });

    const providerDecision = getExtensionHookDefinitionV1('provider.request.before');
    expect(providerDecision).toMatchObject({
      id: 'provider.request.before',
      category: 'decision',
      scope: 'provider',
      executionKind: 'decide',
      aggregation: 'firstDecision',
      failureMode: 'failClosed',
    });

    expect(ExtensionHookAggregationKindV1Schema.parse('orderedList')).toBe('orderedList');
    expect(ExtensionHookScopeV1Schema.parse('agent')).toBe('agent');
    expect(EXTENSION_HOOK_CATALOG_V1.map((entry) => entry.id)).toContain('plugin.reload.after');
  });

  it('returns null for unknown hook ids instead of inventing string conventions', () => {
    expect(getExtensionHookDefinitionV1('provider.request.maybe')).toBe(null);
  });
});
