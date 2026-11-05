import { expect, it } from 'vitest';
import { createStorageDockerPruneForHost } from './dockerPrune';

it('consumes admitted Manage scope across Accounts while refusing Session-scoped Use', async () => {
    const prune = createStorageDockerPruneForHost({
        credentials: { token: 'unused-before-operation-admission', encryption: null },
        serverId: 'home', serverHttpBaseUrl: 'https://home.example.test', machineId: 'machine',
        installationId: 'installation', happyHomeDir: '/unused-before-operation-admission',
        assertInstalledCurrent: async () => {},
    });
    const input = { machineId: 'machine', selection: { kind: 'unusedBuildCacheAndUnreferencedImages' as const } };
    const actor = { accountId: 'manager', custodianAccountId: 'owner', kind: 'person' as const,
        assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
    // Missing operation acceptance stops before native IO; Manage reaches that existing boundary.
    await expect(prune(input, { actor, context: { surface: 'ui', authority: 'present_user' } }))
        .rejects.toMatchObject({ code: 'action_operation_unavailable' });
    await expect(prune(input, { actor: { ...actor, sessionIds: new Set() },
        context: { surface: 'ui', authority: 'present_user' } })).rejects.toMatchObject({ code: 'unauthorized' });
});
