import { describe, expect, it } from 'vitest';
import type { PluginUiDataClient } from '@happier-dev/plugin-ui/data';

import { bindTriageDurableAccountV1 } from './accountDurableState.js';

/**
 * Pins, saved views, actions, configured sources and the detail all reach the Account through this one binding.
 * Every hook used to bind its own Collection and KV handles for the same client; one client is one binding.
 */
describe('the durable Account binding', () => {
  it('is one binding per Account client, shared by every reader on the page', () => {
    const collections: string[] = [];
    const client = {
      collection(definition: Readonly<{ id: string }>) { collections.push(definition.id); return {}; },
      async openCollectionQuery() { throw new Error('no queries'); },
      accountKv: { get: async () => null, set: async () => undefined },
    } as unknown as PluginUiDataClient;

    const first = bindTriageDurableAccountV1(client);
    const second = bindTriageDurableAccountV1(client);
    expect(second).toBe(first);
    expect(new Set(collections).size).toBe(collections.length);
    expect(bindTriageDurableAccountV1(null)).toBe(bindTriageDurableAccountV1(null));
  });
});
