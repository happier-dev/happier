import { expect, it } from 'vitest';
import { ProjectSourceV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { projectSourceRepositoryFacts } from './projectSourceRepositoryFacts';

it('joins an observed checkout using its registered portable Home identity', async () => {
    const serverUrl = 'https://source-facts-portable-join.test';
    const profile = await upsertServerProfile({ serverUrl });
    await setServerProfileIdentityForUrl(serverUrl, 'srv_source_facts_join');
    expect(profile.id).not.toBe('srv_source_facts_join');
    const source = ProjectSourceV1Schema.parse({ id: 'source', revision: 3, name: 'App', audience: [], createdByAccountId: 'alice' });
    const observation = { source: { sourceId: source.id, revision: source.revision }, observedAtMs: 10, coverage: 'complete',
        rootFiles: { dockerfile: 'absent', compose: 'present' }, applications: [] };
    const ref = WorkspaceRefV1Schema.parse({ id: 'checkout', serverId: 'srv_source_facts_join', machineId: 'machine',
        rootPath: '/repo', createdAtMs: 1, source: observation.source, repositoryObservation: observation });
    expect(projectSourceRepositoryFacts(profile.id, [source], [ref]).get(source.id)).toEqual({ status: 'observed', observation });
});
