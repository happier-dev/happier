import { describe, expect, it, vi } from 'vitest';

import {
  createPluginUiResourceStore,
  type PluginUiResourceClient,
} from './resourceStore.js';

describe('plugin UI Resource store read failures', () => {
  it('preserves the mounted Resource failure discriminator instead of collapsing unavailable branches', async () => {
    const readResource = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Resource is not declared for this plugin'), {
        code: 'unavailable',
        // Hosted-web requests arrive through the SDK client transport, whose
        // typed wire diagnostics carry the machine-readable branch in `code`.
        diagnostics: [{ code: 'plugin_resource_not_found', severity: 'error' }],
      }))
      .mockRejectedValueOnce(Object.assign(new Error('The daemon transport is unavailable'), {
        code: 'unavailable',
        diagnostics: [{ code: 'plugin_resource_transport_error', severity: 'error' }],
      }));
    const client: PluginUiResourceClient = { readResource };
    const store = createPluginUiResourceStore({ client, pluginId: 'acme.preview' });
    const entry = store.getEntry('live-activity');
    const unsubscribe = entry.subscribe(() => undefined, false);

    await vi.waitFor(() => {
      expect(entry.getSnapshot().error).toEqual({
        code: 'unavailable',
        diagnostics: ['plugin_resource_not_found'],
        message: 'Resource is not declared for this plugin',
      });
    });

    entry.refresh();
    await vi.waitFor(() => {
      // Both mounted failures use the public `unavailable` envelope. The
      // author-facing store must retain the exact protocol diagnostic so a
      // declaration failure cannot be presented as an offline transport error.
      expect(entry.getSnapshot().error).toEqual({
        code: 'unavailable',
        diagnostics: ['plugin_resource_transport_error'],
        message: 'The daemon transport is unavailable',
      });
    });

    unsubscribe();
    store.dispose();
  });
});
