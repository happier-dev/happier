import { describe, expect, it } from 'vitest';

import {
  EXTENSION_HOOK_CATALOG_V1,
  ExtensionHookAggregationKindV1Schema,
  ExtensionHookScopeV1Schema,
  getExtensionHookDefinitionV1,
  PLUGIN_HOOK_IDS_V1,
} from '../../index.js';

describe('extension hook catalog v1', () => {
  it('aliases extension hook exports to the final plugin hook catalog', () => {
    expect(typeof getExtensionHookDefinitionV1).toBe('function');
    expect(EXTENSION_HOOK_CATALOG_V1.map((entry) => entry.id)).toEqual([...PLUGIN_HOOK_IDS_V1]);

    const spawnEnv = getExtensionHookDefinitionV1('agent.spawnEnv.augment');
    expect(spawnEnv).toMatchObject({
      id: 'agent.spawnEnv.augment',
      category: 'augmentation',
      scope: 'daemon',
      executionKind: 'augment',
      aggregation: 'mergeObject',
      failureMode: 'bestEffort',
    });

    expect(getExtensionHookDefinitionV1('provider.request.before')).toBe(null);

    expect(ExtensionHookAggregationKindV1Schema.parse('orderedList')).toBe('orderedList');
    expect(ExtensionHookScopeV1Schema.parse('agent')).toBe('agent');
    expect(EXTENSION_HOOK_CATALOG_V1.map((entry) => entry.id)).toContain('plugin.reload.after');
  });

  it('returns null for unknown hook ids instead of inventing string conventions', () => {
    expect(getExtensionHookDefinitionV1('provider.request.maybe')).toBe(null);
  });
});
