import { describe, expect, it } from 'vitest';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import { sessionOrganizationTupleKeyBelongsToServer } from '@/sync/domains/session/organization/keys';
import { createDeferred } from '@/dev/testkit';
import { fetchAndApplySessionOrganizationSnapshot } from '@/sync/ops/sessionOrganization/fetchSessionOrganizationSnapshot';
import { fetchAndApplySessionFolderAssignments } from '@/sync/ops/sessionOrganization/fetchSessionFolderAssignments';
import { setSessionPin } from '@/sync/ops/sessionOrganization/setSessionPin';
import { setSessionFolderAssignment } from '@/sync/ops/sessionOrganization/setSessionFolderAssignment';
import { setSessionTagAssignments } from '@/sync/ops/sessionOrganization/setSessionTagAssignments';
import { upsertSessionFolder } from '@/sync/ops/sessionOrganization/upsertSessionFolder';
import { upsertSessionTag } from '@/sync/ops/sessionOrganization/upsertSessionTag';

function organization(version: number, folderId: string) {
    return {
        schemaVersion: 1 as const, version, pins: [],
        folders: [{ folderId, folderKey: `${folderId}-key`, parentFolderId: null, parentFolderKey: null, sortKey: null, archivedAt: null,
            createdAt: 1, updatedAt: 1, display: { t: 'plain' as const, v: { name: folderId } } }],
        folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
    };
}

/** Folder names, pins and labels are one Account's private organization, and their version is per Account. */
describe('Session Organization across an Account change on one Home', () => {
    const readFolderIds = (serverId: string) => Object.entries(storage.getState().sessionOrganizationFoldersByFolderKey)
        .filter(([key]) => sessionOrganizationTupleKeyBelongsToServer(key, serverId)).map(([, folder]) => folder?.folderId);

    it.each(['signed-out', 'switched'] as const)('withdraws the previous Account organization once the Home has %s, and admits the next Account at its own version', async change => {
        const network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome('https://account-change-organization', 'organization-account-a');
        await loadSyncSingletonForTests();
        const apply = (snapshot: ReturnType<typeof organization>) => storage.getState().applySessionOrganizationSnapshot(home.id, snapshot as never);
        apply(organization(50, 'a-private-folder'));
        expect(readFolderIds(home.id)).toEqual(['a-private-folder']);

        if (change === 'signed-out') await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id },
            { token: createAccountTokenForTests('organization-account-b') })).toBe(true);
        expect(readFolderIds(home.id)).toEqual([]);

        apply(organization(0, 'b-own-folder'));
        expect(readFolderIds(home.id)).toEqual(['b-own-folder']);
    });

    async function homeWithAccountA(suffix: string) {
        const network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome(`https://account-change-organization-${suffix}`, `organization-race-a-${suffix}`);
        await loadSyncSingletonForTests();
        const credentials = (await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id }))!;
        const admitAccountB = async () => expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id },
            { token: createAccountTokenForTests(`organization-race-b-${suffix}`) })).toBe(true);
        return { home, credentials, admitAccountB, network };
    }
    const organizationContent = () => JSON.stringify([
        storage.getState().sessionOrganizationFoldersByFolderKey, storage.getState().sessionOrganizationTagsByTagKey,
        storage.getState().sessionOrganizationPinsBySessionKey, storage.getState().sessionOrganizationFolderAssignmentsBySessionKey,
        storage.getState().sessionOrganizationTagAssignmentsBySessionKey,
    ]);

    it('drops the previous Account snapshot landing after the next Account was admitted, and does not block that Account', async () => {
        const { home, credentials, admitAccountB } = await homeWithAccountA('snapshot');
        const held = createDeferred<Response>();
        const issued = fetchAndApplySessionOrganizationSnapshot({ credentials, serverId: home.id, serverUrl: home.serverUrl, requestAtEndpoint: () => held.promise });
        await admitAccountB();
        held.resolve(Response.json({ snapshot: organization(50, 'a-late-folder') }));
        await issued;
        expect(readFolderIds(home.id)).toEqual([]);
        storage.getState().applySessionOrganizationSnapshot(home.id, organization(0, 'b-own-folder') as never);
        expect(readFolderIds(home.id)).toEqual(['b-own-folder']);
    });

    it('drops the previous Account folder assignments landing after the change', async () => {
        const { home, credentials, admitAccountB, network } = await homeWithAccountA('assignment-list');
        const held = createDeferred<Response>();
        network.setHttpResponder(async (input) => new URL(String(input)).pathname.includes('organization') ? await held.promise : null);
        const issued = fetchAndApplySessionFolderAssignments({ credentials, serverId: home.id, serverUrl: home.serverUrl, sessionIds: ['s-a'] });
        await new Promise(resolve => setTimeout(resolve, 20));
        await admitAccountB();
        held.resolve(Response.json({ snapshot: { ...organization(50, 'unused'), folders: [], folderAssignments: [{ sessionId: 's-a', folderId: 'a-late-folder' }] } }));
        await issued;
        expect(organizationContent()).not.toContain('a-late-folder');
    });

    const folderBody = { folderId: 'a-late-folder', folderKey: 'a-late-folder-key', parentFolderId: null, parentFolderKey: null, sortKey: null,
        archivedAt: null, createdAt: 1, updatedAt: 1, display: { t: 'plain', v: { name: 'a-late-folder' } } };
    const tagBody = { tagId: 'a-late-tag', tagKey: 'a-late-tag-key', sortKey: null, archivedAt: null, createdAt: 1, updatedAt: 1,
        display: { t: 'plain', v: { name: 'a-late-tag' } } };
    it.each([
        ['pin', { pin: { sessionId: 'a-late-session', sortKey: null, pinnedAt: 1, listPinned: true, railPinned: false } }, (scope: any) => setSessionPin({ ...scope, sessionId: 'a-late-session', pinned: true })],
        ['tag assignment', { sessionId: 'a-late-session', tagIds: ['a-late-tag'] }, (scope: any) => setSessionTagAssignments({ ...scope, sessionId: 'a-late-session', request: { tagIds: ['a-late-tag'] } })],
        ['folder assignment', { sessionId: 'a-late-session', folderId: 'a-late-folder' }, (scope: any) => setSessionFolderAssignment({ ...scope, sessionId: 'a-late-session', folderId: 'a-late-folder' })],
        ['folder', { folder: folderBody }, (scope: any) => upsertSessionFolder({ ...scope, request: { folderId: 'a-late-folder', folderKey: 'a-late-folder-key', display: { t: 'plain', v: { name: 'a-late-folder' } } } })],
        ['tag', { tag: tagBody }, (scope: any) => upsertSessionTag({ ...scope, request: { tagId: 'a-late-tag', tagKey: 'a-late-tag-key', display: { t: 'plain', v: { name: 'a-late-tag' } } } })],
    ] as const)('keeps a %s reply for the previous Account out of the store once the next Account was admitted', async (name, body, run) => {
        const { home, credentials, admitAccountB } = await homeWithAccountA(name.replace(' ', '-'));
        const held = createDeferred<Response>();
        // The write's own display preparation may read first; only its route is held.
        const requestAtEndpoint = async (path: string) => path.includes('/account/encryption')
            ? Response.json({ mode: 'plain', updatedAt: 0 }) : await held.promise;
        const issued = run({ credentials, serverId: home.id, serverUrl: home.serverUrl, requestAtEndpoint });
        await new Promise(resolve => setTimeout(resolve, 20));
        await admitAccountB();
        held.resolve(Response.json(body));
        await issued.catch(() => {});
        expect(organizationContent()).not.toContain('a-late');
    });
});
