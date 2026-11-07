import { expect, it, vi } from 'vitest';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createProjectAccountRowsSync } from '@/sync/engine/projects/projectAccountRowsSync';
import { mutateProjectAtmosphereSetting } from './projectAtmosphereSettings';

it('resets to literal Home through the real row owner without reading Home Settings', async () => {
    const scope = { serverId: 'atmosphere-reset', accountId: 'owner' };
    const target = { serverId: scope.serverId, projectKey: 'project' };
    const key = { kind: 'project-organization' as const, ...target };
    const listed = createPlainProjectAccountRowListFixture({ organizations: [{ key, revision: 1,
        value: { label: 'Keep this label', pinned: true, atmosphere: DEFAULT_HOME_ATMOSPHERE } }] });
    if (listed.status !== 'listed') throw new Error('Expected listed fixture');
    let rows = listed.rows;
    const sync = createProjectAccountRowsSync({ scope, isCurrent: () => true, apply() {},
        cipher: createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: () => { throw new Error('No keys in a plain Account'); } }),
        transport: {
            read: async () => { throw new Error('Atmosphere mutation uses its census'); },
            list: async () => ({ ...listed, rows }),
            mutate: async request => {
                const updated = request.mutations.map(mutation => ({ key: mutation.key,
                    revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content }));
                rows = [...rows.filter(row => row.key.kind !== 'project-organization'), ...updated];
                return { status: 'updated', rows: updated, cursor: 1 };
            },
        },
    });
    // Only the remote Settings HTTP port is replaced; row/CAS and atmosphere intent stay real.
    const settingsHttp = vi.fn(async () => Response.json(DEFAULT_HOME_ATMOSPHERE));
    const result = await mutateProjectAtmosphereSetting({ scope, target, isCurrent: () => true, edit: 'home',
        rows: { read: sync.refresh, mutateOrganization: sync.mutateOrganizationAtRevision },
        readHome: async () => (await settingsHttp()).json(),
    });
    expect(result).toMatchObject({ status: 'updated', value: 'home' });
    const snapshot = await sync.refresh();
    expect(snapshot.organizations[0]?.value).toMatchObject({ atmosphere: 'home', label: 'Keep this label', pinned: true });
    expect(settingsHttp).not.toHaveBeenCalled();
});
