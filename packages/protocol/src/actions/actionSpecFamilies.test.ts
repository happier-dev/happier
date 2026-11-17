import { describe, expect, it } from 'vitest';

import { ACTION_SPEC_FAMILY_IDS, ACTION_SPEC_FAMILY_READERS, ACTION_SPEC_UI_PLACEMENT_IDS } from './actionSpecFamilies.generated.js';
import { getActionSpec, listActionSpecBindingDeclarations, listActionSpecs } from './actionSpecs.js';

const REGENERATE = 'stale: run node packages/protocol/scripts/generateActionSpecFamilies.mjs';

describe('Action spec family routing', () => {
  it('routes every catalog id, in catalog order, to the family that declares it', () => {
    const catalogIds = listActionSpecBindingDeclarations().map((declaration) => declaration.id);
    const routedIds = ACTION_SPEC_FAMILY_READERS.flatMap((read) => read().map((row) => row.id));
    expect(routedIds, REGENERATE).toEqual(catalogIds);
    expect(ACTION_SPEC_FAMILY_IDS, REGENERATE).toEqual(ACTION_SPEC_FAMILY_READERS.map((read) => read().map((row) => row.id)));
  });

  it('resolves each id through its family to the same declaration the catalog lists', () => {
    for (const ids of ACTION_SPEC_FAMILY_IDS) {
      for (const id of ids) expect(getActionSpec(id as Parameters<typeof getActionSpec>[0]).id).toBe(id);
    }
  });

  it('lists UI placement ids exactly as the normalized catalog declares them', () => {
    const expected: Record<string, string[]> = {};
    for (const spec of listActionSpecs()) {
      if (spec.surfaces.ui !== true) continue;
      for (const placement of spec.placements ?? []) (expected[placement] ??= []).push(spec.id);
    }
    expect(ACTION_SPEC_UI_PLACEMENT_IDS, REGENERATE).toEqual(expected);
  });
});
