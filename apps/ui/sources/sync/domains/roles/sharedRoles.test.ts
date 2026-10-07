import { describe, expect, it } from 'vitest';
import { buildRoleCatalog, createRoleCatalogProjection, parseRolesListOutput } from './roleCatalog';

const role = { name: 'Builder', instructions: 'Build carefully', runsAs: { kind: 'session' as const }, workspaceWrites: 'allow' as const, secondOpinion: 'off' as const, enabled: true };
const item = { roleId: 'shared-role', role, shared: true, viewOnly: true, migratedFromV0_2: false, revision: { headerVersion: 1, bodyVersion: 1 } };

describe('shared role Settings layer', () => {
  it('reuses equal projected entries and arrays while updating only a changed role or override', () => {
    const project = createRoleCatalogProjection();
    const first = { items: parseRolesListOutput({ items: [item, { ...item, roleId: 'other-role' }] })!, overrides: {} };
    const before = project(first);
    expect(project(structuredClone(first))).toBe(before);
    const changed = project({ ...first, items: parseRolesListOutput({ items: [item, { ...item, roleId: 'other-role', role: { ...role, instructions: 'Other changed' } }] })! });
    expect(changed[0]).toBe(before[0]);
    expect(changed[1]).not.toBe(before[1]);
    const overridden = project({ ...first, overrides: { 'other-role': { roleId: 'other-role', instructionsOverride: 'Reader override' } } });
    expect(overridden[0]).toBe(before[0]);
    expect(overridden[1]?.role.instructions).toBe('Reader override');
    expect(project({ items: [], overrides: {} })).toEqual([]);
  });
  it('retains shared source and view access while applying only the reader’s local override', () => {
    const parsed = parseRolesListOutput({ items: [item] })!;
    const entry = buildRoleCatalog({ items: parsed, overrides: { 'shared-role': { roleId: 'shared-role', instructionsOverride: 'My instructions', workspaceWrites: 'deny' } } })[0]!;
    expect(entry).toMatchObject({ source: 'shared', viewOnly: true, role: { instructions: 'My instructions', workspaceWrites: 'deny' } });
    expect(parseRolesListOutput({ items: [{ roleId: item.roleId, role: item.role }] })).toEqual([]);
  });

  it('follows the current source revision while retaining local per-field overrides', () => {
    const project = (instructions: string) => buildRoleCatalog({
      items: parseRolesListOutput({ items: [{ ...item, role: { ...role, instructions }, viewOnly: false, revision: { headerVersion: 2, bodyVersion: 2 } }] })!,
      overrides: { 'shared-role': { roleId: 'shared-role', workspaceWrites: 'deny' } },
    });
    expect(project('New owner instructions')[0]).toMatchObject({ source: 'shared', viewOnly: false, role: { instructions: 'New owner instructions', workspaceWrites: 'deny' } });
    expect(buildRoleCatalog({ items: parseRolesListOutput({ items: [] })!, overrides: { 'shared-role': { roleId: 'shared-role', workspaceWrites: 'deny' } } })).toEqual([]);
  });
});
