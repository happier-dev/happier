import { describe, expect, it } from 'vitest';
import { BUILT_IN_ROLE_IDS_V1, BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';

import { t } from '@/text';

import { buildRoleCatalog, describeRolePurpose, parseRolesListOutput, resolvedRoleToArtifact } from './roleCatalog';
import { RoleArtifactV1Schema } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';

describe('what a role is for', () => {
  it('keeps the admitted plugin display name through the catalog and exports only the executable Artifact body', () => {
    const items = parseRolesListOutput({ items: [{ roleId: 'plugin:example/reviewer', role: BUILT_IN_ROLES_V1.reviewer,
      pluginDisplayName: 'Example tools', shared: false, viewOnly: true, migratedFromV0_2: false }] });
    expect(items).toHaveLength(1);
    const [entry] = buildRoleCatalog({ items: items ?? [], overrides: {} });
    expect(entry?.pluginDisplayName).toBe('Example tools');
    if (!entry) throw new Error('Expected plugin role catalog entry');
    expect(RoleArtifactV1Schema.parse(resolvedRoleToArtifact(entry.role))).toEqual(BUILT_IN_ROLES_V1.reviewer);
  });
  it('describes each built-in role by what it does for the person, never by its first instruction line', () => {
    const purposes = BUILT_IN_ROLE_IDS_V1.map((roleId) => describeRolePurpose({ roleId, instructions: BUILT_IN_ROLES_V1[roleId].instructions }));
    expect(purposes).toEqual(BUILT_IN_ROLE_IDS_V1.map((roleId) => t(`roles.builtIn.${roleId}`)));
    for (const [index, roleId] of BUILT_IN_ROLE_IDS_V1.entries()) {
      expect(BUILT_IN_ROLES_V1[roleId].instructions.startsWith(purposes[index]!)).toBe(false);
    }
    // Sibling cards each say something different.
    expect(new Set(purposes).size).toBe(BUILT_IN_ROLE_IDS_V1.length);
  });

  it('follows the instructions once the reader rewrote a built-in, and for every other role', () => {
    expect(describeRolePurpose({ roleId: 'reviewer', instructions: 'Check accessibility only. Report by screen.' }))
      .toBe('Check accessibility only.');
    expect(describeRolePurpose({ roleId: 'my-role', instructions: BUILT_IN_ROLES_V1.scout.instructions }))
      .toBe('Read and search only.');
  });
});
