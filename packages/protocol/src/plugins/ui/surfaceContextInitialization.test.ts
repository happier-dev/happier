import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from '../contributions/v2.js';
import { PluginUiHostApiRequestEnvelopeV1Schema } from './hostApiRequests.js';

/**
 * The host-API request and semantic contribution schemas must initialize as
 * ordinary static ESM imports. Session header actions are a direct V2 family,
 * not entries in a separate surface registry.
 */
describe('plugin UI surface-context module initialization', () => {
  it('initializes the host request envelope and session action descriptor together', () => {
    expect(PluginUiHostApiRequestEnvelopeV1Schema).toBeDefined();
    expect(PluginContributesV2Schema).toBeDefined();

    const contribution = PluginContributesV2Schema.safeParse({
      sessionHeaderActions: [{
        id: 'open-preview',
        title: { key: 'openPreview', fallback: 'Open preview' },
        command: { kind: 'openSurface', destination: 'preview' },
      }],
    });

    expect(contribution.success).toBe(true);
  });
});
