import { describe, expect, it } from 'vitest';

import { createSessionStateSyncEngine } from './syncEngine.js';
import { createSessionStateFacetFromHandlers } from './registerHandler.js';

describe('createSessionStateFacetFromHandlers', () => {
  it('reports unsupported when a supported field has no read handler', async () => {
    const facet = createSessionStateFacetFromHandlers({
      'display.title': {
        applyHappierField: async () => {},
      },
    });
    const engine = createSessionStateSyncEngine({
      capabilities: {
        display: {
          title: {
            supported: true,
            providerToHappier: { supported: true, source: 'snapshot' },
          },
        },
      },
      facet,
    });

    await expect(engine.readProviderField({
      ctx: { sessionId: 's1' },
      fieldId: 'display.title',
    })).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
      gate: { supported: false, reason: 'field-unsupported' },
    });
  });
});
