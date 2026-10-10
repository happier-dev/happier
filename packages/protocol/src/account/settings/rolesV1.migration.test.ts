import { describe, expect, it } from 'vitest';

import { ACCOUNT_SETTING_DEFINITIONS, accountSettingsParse } from './accountSettings.js';
import { readLegacyRoleInventoryV1, readLegacyRolesV1, retainLegacyRolesV1 } from './rolesV1Migration.js';
import { ACCOUNT_SETTING_MAX_COLLECTION_ENTRIES, ACCOUNT_SETTING_MAX_STRING_BYTES } from './catalog/accountSettingBounds.js';
import { RolesV1Schema } from './rolesV1.js';
import { projectAccountRoleActionRefusalV1, retainLegacyRoleArtifactsV1, type RoleArtifactStoreV1 } from '../../prompts/roles/accountRoleActions.js';
import { emptyPromptLibraryRecordV1, loadPromptLibraryCatalogV1 } from '../../prompts/library/promptLibraryCatalogV1.js';
import { PromptLibraryCatalogKeyV1Schema } from '../../prompts/library/promptLibraryRowsV1.js';

// V1 vectors copied from ../0.2 packages/protocol/src/prompts/executionRunsGuidanceV1.test.ts
// at 17ba05df68d4d3d4cad1c1241b58e63805db37ed; the entry carrier is declared by
// apps/ui/sources/sync/domains/settings/registry/account/accountRuntimeSettingDefinitions.ts.
const predecessorSettings = {
  executionRunsGuidanceEntries: [{
    id: '1', description: 'Prefer Claude for UI work',
    suggestedBackendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    suggestedModelId: 'claude-sonnet-4-5',
    suggestedIntent: 'review',
    exampleToolCalls: ['mcp.execution.run', 'mcp.execution.list'],
  }],
};

describe('rolesV1 Account settings', () => {
  it.each(['malformed', 'shared', 'owned-edited', 'conflict-malformed', 'acknowledged-malformed'] as const)(
    'contracts guidance only after readable Account-owned Artifact retention (%s)', async target => {
      const [entry] = readLegacyRoleInventoryV1(predecessorSettings, 'account-one').entries;
      if (!entry) throw new Error('Expected canonical predecessor Role');
      const body = target.includes('malformed') ? '{' : JSON.stringify({ ...entry.role, instructions: 'EDITED_RETAINED_ROLE', future: true });
      const existing = { artifactId: entry.artifactId, header: { kind: 'role.v1' }, body,
        revision: { headerVersion: 3, bodyVersion: 7 }, ownerAccountId: target === 'shared' ? 'another-account' : 'account-one',
        access: target === 'shared' ? 'view' as const : 'owner' as const };
      let reads = 0;
      const artifactStore: RoleArtifactStoreV1 = {
        read: async id => {
          reads += 1;
          return id !== existing.artifactId || reads === 1 && (target === 'conflict-malformed' || target === 'acknowledged-malformed') ? null : existing;
        },
        list: async () => ({ items: [] }),
        create: async () => {
          if (target === 'conflict-malformed') throw Object.assign(new Error('Concurrent target'), { code: 'conflict' });
          if (target === 'acknowledged-malformed') return { artifactId: existing.artifactId, revision: existing.revision };
          throw new Error('Existing target must not be overwritten');
        },
        update: async () => { throw new Error('Existing target must not be overwritten'); },
        delete: async () => { throw new Error('Existing target must not be deleted'); },
      };
      let raw: Readonly<Record<string, unknown>> = predecessorSettings;
      let retained: unknown;
      // Settings and Artifact persistence are genuine boundaries; conversion, admission and cleanup stay real.
      const catalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
        readRows: async () => ({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 2,
          content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) }),
        transfer: { readSourceSnapshot: async () => ({ raw, version: 7 }),
          initializeRecord: async () => { throw new Error('Actual destination rows already exist'); },
          retainLegacyRoleArtifacts: async source => { retained = await retainLegacyRoleArtifactsV1({ rawSettings: source, accountId: 'account-one', artifactStore }); },
          replaceSource: async input => { expect(input.expectedVersion).toBe(7); raw = input.raw; return { status: 'applied', settingsVersion: 8 }; },
          normalizeHistory: async () => ({ status: 'complete' }),
        },
      });
      expect(existing.body).toBe(body);
      if (target === 'owned-edited') expect(retained).toEqual([{ artifactId: entry.artifactId, expectedRevision: existing.revision }]);
      expect(catalog).toMatchObject({ status: 'ready', cleanup: target === 'owned-edited' ? { status: 'complete' }
        : { status: 'cleanup-pending', reason: 'artifacts-unavailable' } });
      if (target === 'owned-edited') expect(raw).not.toHaveProperty('executionRunsGuidanceEntries');
      else expect(raw.executionRunsGuidanceEntries).toEqual(predecessorSettings.executionRunsGuidanceEntries);
    },
  );

  it('owns only role overrides and rejects a second role-content store', () => {
    expect(accountSettingsParse({}).rolesV1).toEqual({ overrides: {} });
    expect(ACCOUNT_SETTING_DEFINITIONS.rolesV1.parseMutationValue({
      overrides: {}, roles: [{ name: 'Another store', instructions: 'Do work' }],
    }).success).toBe(false);
  });

  it('uses the canonical Account collection and UTF-8 bounds for override writes', () => {
    const overrides = Object.fromEntries(Array.from({ length: ACCOUNT_SETTING_MAX_COLLECTION_ENTRIES }, (_, i) => [`role-${i}`, { roleId: `role-${i}` }]));
    expect(RolesV1Schema.safeParse({ overrides }).success).toBe(true);
    expect(RolesV1Schema.safeParse({ overrides: { ...overrides, extra: { roleId: 'extra' } } }).success).toBe(false);
    expect(RolesV1Schema.safeParse({ overrides: { builder: { roleId: 'builder', instructionsOverride: 'x'.repeat(ACCOUNT_SETTING_MAX_STRING_BYTES) } } }).success).toBe(true);
    expect(RolesV1Schema.safeParse({ overrides: { builder: { roleId: 'builder', instructionsOverride: 'é'.repeat(ACCOUNT_SETTING_MAX_STRING_BYTES) } } }).success).toBe(false);
    expect(RolesV1Schema.safeParse({ overrides: { builder: { roleId: 'another-role' } } }).success).toBe(false);
  });

  it('reads predecessor V1 refs and development V2 refs through one role normalizer', () => {
    const entries = readLegacyRolesV1({
      ...predecessorSettings,
      executionRunsGuidanceMaxChars: 1,
      executionRunsGuidanceEntries: [...predecessorSettings.executionRunsGuidanceEntries, {
        id: 'v2', title: 'Scout', description: 'Look around. Report paths.', enabled: false,
        suggestedBackendTarget: { kind: 'backend', backendId: 'codex' },
      }, { id: 'no-engine', description: 'Investigate failures. Read the logs.' }],
    }, 'account-one');
    expect(entries).toHaveLength(3);
    expect(entries[0]?.role).toMatchObject({
      name: 'Prefer Claude for UI work',
      runsAs: { kind: 'background_run', intent: 'review' },
      engine: { agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'claude-sonnet-4-5' },
      enabled: true, workspaceWrites: 'allow', secondOpinion: 'off',
    });
    expect(entries[0]?.role.instructions).toContain('Suggested intent: review');
    expect(entries[0]?.role.instructions).toContain('Examples');
    expect(entries[0]?.role.instructions).toContain('mcp.execution.list');
    expect(entries[1]?.role).toMatchObject({
      name: 'Scout', enabled: false, runsAs: { kind: 'session' },
      engine: { agentTargetKey: 'agent:happier.agent.codex/codex' },
    });
    expect(entries[2]?.role).toMatchObject({ name: 'Investigate failures.', runsAs: { kind: 'session' } });
    expect(entries[2]?.role.engine).toBeUndefined();
    expect(entries[2]?.role.instructions).toContain('Choose an engine');
    expect(entries[0]?.artifactId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(readLegacyRolesV1(predecessorSettings, 'account-two')[0]?.artifactId).not.toBe(entries[0]?.artifactId);
  });

  it('disables all migrated roles when the Account legacy guidance switch is off', () => {
    expect(readLegacyRolesV1({ ...predecessorSettings, executionRunsGuidanceEnabled: false }, 'account-one')[0]?.role.enabled).toBe(false);
  });

  it('does not suppress unretained guidance because an override root exists', () => {
    expect(readLegacyRolesV1({ ...predecessorSettings, rolesV1: { overrides: {} } }, 'account-one')).toHaveLength(1);
    expect(readLegacyRolesV1({ ...predecessorSettings, rolesV1: null }, 'account-one')).toHaveLength(1);
    expect(readLegacyRolesV1(predecessorSettings, 'account-one')).toHaveLength(1);
  });

  it.each([
    { executionRunsGuidanceEnabled: 'invalid' },
    { executionRunsGuidanceEntries: { v: 2, entries: [] } },
    { executionRunsGuidanceEntries: [...predecessorSettings.executionRunsGuidanceEntries, { id: 'broken', description: '' }] },
    { executionRunsGuidanceEntries: [...predecessorSettings.executionRunsGuidanceEntries, { ...predecessorSettings.executionRunsGuidanceEntries[0], description: 'Different content' }] },
    { executionRunsGuidanceEntries: [{ id: 'examples', description: 'Keep every example', exampleToolCalls: ['valid', 4] }] },
  ])('preserves an incomplete guidance source before any retention', async (rawSettings) => {
    const effects: string[] = [];
    await expect(retainLegacyRolesV1({
      rawSettings, accountId: 'account-one',
      ensureRoleArtifact: async () => { effects.push('artifact'); },
    })).rejects.toMatchObject({ code: 'legacy_roles_inventory_incomplete' });
    expect(effects).toEqual([]);
  });

  it('reports incomplete entries while retaining valid neighbors for repair and every historical item without a count cap', () => {
    const guidance = Array.from({ length: 257 }, (_, index) => ({ id: `guidance-${index}`, description: `Keep item ${index}` }));
    const inventory = readLegacyRoleInventoryV1({ executionRunsGuidanceEntries: [...guidance, { id: 'broken', description: '' }] }, 'account-one');
    expect(inventory.status).toBe('partial');
    expect(inventory.entries).toHaveLength(257);
    expect(inventory.entries[256]?.role.instructions).toContain('Keep item 256');
    expect(inventory.diagnostics).toEqual([{ index: 257, entryId: 'broken', reason: 'invalid_entry' }]);
    expect(readLegacyRoleInventoryV1({ executionRunsGuidanceEntries: [] }, 'account-one')).toEqual({ status: 'ready', entries: [], diagnostics: [], sourceArtifactIds: [], sourceIdentitiesComplete: true });
  });

  it('keeps complete guidance identities despite malformed payloads, but reports uncharacterizable roots or ids', () => {
    const entries = [{ id: 'retained', description: 'Keep retained guidance' }];
    const complete = readLegacyRoleInventoryV1({ executionRunsGuidanceEntries: entries }, 'account-one');
    const artifactId = complete.entries[0]?.artifactId;
    if (!artifactId) throw new Error('Expected retained guidance identity');
    const identities = (raw: Readonly<Record<string, unknown>>) => {
      const inventory = readLegacyRoleInventoryV1(raw, 'account-one');
      return { artifactIds: inventory.sourceArtifactIds, complete: inventory.sourceIdentitiesComplete };
    };
    expect(identities({ executionRunsGuidanceEntries: [{ id: 'retained', description: null }] })).toEqual({ artifactIds: [artifactId], complete: true });
    expect(identities({ executionRunsGuidanceEntries: [...entries, { id: 'retained', description: 'Duplicate content' }] })).toEqual({ artifactIds: [artifactId], complete: true });
    expect(identities({ executionRunsGuidanceEnabled: 'invalid', executionRunsGuidanceEntries: entries })).toEqual({ artifactIds: [artifactId], complete: true });
    expect(identities({ executionRunsGuidanceEnabled: 'invalid' })).toEqual({ artifactIds: [], complete: true });
    expect(identities({ executionRunsGuidanceEntries: null })).toEqual({ artifactIds: [], complete: false });
    expect(identities({ executionRunsGuidanceEntries: [...entries, { description: 'Missing identity' }] })).toEqual({ artifactIds: [artifactId], complete: false });
    expect(identities({ executionRunsGuidanceEntries: [{ id: '  ', description: 'Blank identity' }] })).toEqual({ artifactIds: [], complete: false });
  });

  it('preserves the migration refusal code at the Role Action failure boundary', async () => {
    try {
      await retainLegacyRolesV1({ rawSettings: { executionRunsGuidanceEntries: null }, accountId: 'account-one',
        ensureRoleArtifact: async () => { throw new Error('Unexpected Artifact effect'); },
      });
      throw new Error('Incomplete guidance must refuse');
    } catch (error) {
      expect(projectAccountRoleActionRefusalV1(error)).toMatchObject({ ok: false, errorCode: 'legacy_roles_inventory_incomplete' });
    }
  });
});
