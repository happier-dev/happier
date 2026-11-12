import { describe, expect, it } from 'vitest';

import { searchSerializedActionSpecsForSurface } from './actionCatalog.js';

describe('Action catalog protected firewall schemas', () => {
  it('serializes the protected Caddy firewall schema during complete Voice Action discovery', () => {
    const summaries = searchSerializedActionSpecsForSurface({
      surface: 'voice', query: 'spawn session', limit: 5, includeOutputSchema: true,
    });
    expect(summaries.some(spec => spec.id === 'session.spawn_new')).toBe(true);
    expect(() => JSON.stringify(summaries)).not.toThrow();
  });

});
