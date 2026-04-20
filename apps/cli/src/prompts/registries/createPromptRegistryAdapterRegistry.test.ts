import { describe, expect, it } from 'vitest';

import { createPromptRegistryAdapterRegistry } from './createPromptRegistryAdapterRegistry';

describe('createPromptRegistryAdapterRegistry', () => {
  it('registers the shipped registry adapters', () => {
    const registry = createPromptRegistryAdapterRegistry();

    expect([...registry.adapters.keys()]).toEqual(expect.arrayContaining([
      'git',
      'skills_sh',
      'claude_marketplace',
    ]));
  });
});
