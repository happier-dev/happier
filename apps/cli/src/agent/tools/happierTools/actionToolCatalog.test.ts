import { describe, expect, it } from 'vitest';

import { HAPPIER_BUILT_IN_TOOLS } from './catalog';
import { filterBuiltInToolsForSurface } from './actionToolCatalog';

describe('filterBuiltInToolsForSurface', () => {
  it('uses the session-Agent surface when guidance requires a direct action and no surface is specified', () => {
    const names = filterBuiltInToolsForSurface(HAPPIER_BUILT_IN_TOOLS, {
      requiredDirectActionIds: ['memory.search'],
    }).map((tool) => tool.name);

    expect(names).toContain('memory_search');
  });
});
