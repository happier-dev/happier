import { BUILT_IN_ROLES_V1, BUILT_IN_ROLE_IDS_V1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { resolveHappierRoleGlyph } from '@happier-dev/plugin-ui/presentation';

describe('the portable role glyph owner', () => {
  it('gives every built-in role a mark no other built-in role or made role shares', () => {
    const builtIn = BUILT_IN_ROLE_IDS_V1.map((roleId) =>
      resolveHappierRoleGlyph(roleId, BUILT_IN_ROLES_V1[roleId].runsAs.kind),
    );
    const made = [
      resolveHappierRoleGlyph('role_made_by_someone', 'session'),
      resolveHappierRoleGlyph(undefined, 'background_run'),
    ];

    expect(new Set(builtIn).size).toBe(BUILT_IN_ROLE_IDS_V1.length);
    expect(new Set(made).size).toBe(2);
    expect(builtIn.filter((glyph) => made.includes(glyph))).toEqual([]);
  });
});
