import { describe, expect, it } from 'vitest';
import { importAuthoringMemoryRowAbsent, importLegacyAuthoringMemorySetting } from './authoringMemoryImport.js';
import { LegacyLastUsedProfileSchema, LegacyRecentMachinePathsSchema } from './settings/legacyAuthoringMemorySettingsV1.js';
import { AIBackendProfileSchema } from '../profiles/backendProfileSchema.js';

describe('authoring memory destination-first import', () => {
  it('preserves valid legacy authoring values beyond generic Settings budgets during import', async () => {
    // Legacy Profiles accept nonempty ids; this does not change Launch Profile
    // V2's separate id grammar. Windows extended paths can exceed 16 KiB.
    const profileId = 'profile-'.repeat(160);
    expect(AIBackendProfileSchema.safeParse({ id: profileId, name: 'Legacy profile' }).success).toBe(true);
    expect.soft(LegacyLastUsedProfileSchema.safeParse(profileId)).toMatchObject({ success: true, data: profileId });
    const longPath = { machineId: `machine-${'a'.repeat(1024)}`,
      path: ['\\\\?\\C:', ...Array<string>(2600).fill('folder'), 'repo'].join('\\') };
    expect.soft(LegacyRecentMachinePathsSchema.parse([longPath])).toEqual([longPath]);
    const paths = Array.from({ length: 257 }, (_, index) => ({ machineId: `machine-${index}`, path: `/repo-${index}` }));
    // Model the Settings and KV persistence boundaries; preserve all source
    // values, independently of the recent-path UI owner's top-ten policy.
    let raw: Record<string, unknown> = { recentMachinePaths: paths, keep: true };
    let destination: unknown;
    await importLegacyAuthoringMemorySetting({
      key: 'recentMachinePaths', assertCurrent: () => {},
      read: async () => ({ raw, version: 1 }),
      transfer: async (value) => { destination = LegacyRecentMachinePathsSchema.parse(value); },
      remove: async () => { raw = { keep: true }; return 'applied'; },
    });
    expect(destination).toEqual(paths);
    expect(raw).toEqual({ keep: true });
  });

  it('preserves an existing tombstone and observes the CAS winner after a competing creation', async () => {
    const tombstone = { status: 'deleted', revision: 2 } as const;
    const deleted = await importAuthoringMemoryRowAbsent({
      key: 'lastUsedProfile', value: 'legacy',
      read: async () => tombstone,
      seal: (_key, value) => ({ t: 'plain', v: value }),
      mutate: async () => { throw new Error('Existing tombstone must not be overwritten'); },
    });
    expect(deleted).toEqual(tombstone);
    let reads = 0;
    const winner = { status: 'present', revision: 1, content: { t: 'plain', v: 'other-device' } } as const;
    const created = await importAuthoringMemoryRowAbsent({
      key: 'lastUsedProfile', value: 'legacy',
      read: async () => ++reads === 1 ? { status: 'absent' } : winner,
      seal: (_key, value) => ({ t: 'plain', v: value }),
      mutate: async () => ({ status: 'conflict', revision: 1 }),
    });
    expect(created).toEqual(winner);
  });

  it('reconciles an interrupted exact-CAS removal without overwriting committed memory or unrelated keys', async () => {
    let raw: Record<string, unknown> = { lastUsedProfile: 'legacy', keep: true };
    let version = 1;
    let destination: unknown;
    let attempts = 0;
    await importLegacyAuthoringMemorySetting({
      key: 'lastUsedProfile', assertCurrent: () => {},
      read: async () => ({ raw: { ...raw }, version }),
      transfer: async (value) => { destination ??= value; },
      remove: async (_key, expectedVersion) => {
        expect(expectedVersion).toBe(version);
        if (++attempts === 1) { raw.lastUsedProfile = 'new-legacy'; version += 1; return 'conflict'; }
        delete raw.lastUsedProfile;
        return 'applied';
      },
    });
    expect(destination).toBe('legacy');
    expect(raw).toEqual({ keep: true });
  });
});
