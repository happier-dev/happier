import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ArtifactTeamResourceKindV1Schema } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// Load the real Action graph before test/render progress waits start.
await import('@/sync/ops/actions/defaultActionExecutor');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
beforeEach(async () => { resetTeamActionClientForTests(); await home.reset(); });
afterEach(async () => { standardCleanup(); await home.reset(); });

it.each(ArtifactTeamResourceKindV1Schema.options)('reads only the selected Team %s page and retains locked rows', async teamResourceKind => {
    const { encodeArtifactListCursor } = await import('@/sync/api/artifacts/apiArtifacts');
    const { useTeamSharedArtifacts } = await import('./useTeamSharedArtifacts');
    const serverId = await home.addHome({ name: 'Artifacts', serverUrl: 'https://team-artifacts.test',
        accountId: 'reader', currentAccount: true, teamsEnabled: true });
    const urls: URL[] = [];
    const cursor = encodeArtifactListCursor({ artifactId: 'locked', updatedAt: 1 });
    home.answer(serverId, '/v1/artifacts', { select: (_input, request) => {
        const url = new URL(request.url);
        urls.push(url);
        const locked = { id: 'locked', ownerAccountId: 'another-account', access: 'view', encryptionMode: 'e2ee',
            kind: 'other', kindHint: null, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            publicAudience: 'retained', sharedWithTeamScope: 'group',
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } };
        const readable = createPlainArtifactHttpFixture({ id: 'readable', title: 'Readable',
            header: { title: 'Readable' }, rawHeader: { title: 'Readable' }, isDecrypted: true,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }, 'reader');
        return { body: { items: url.searchParams.get('cursor') === null ? [locked]
            : url.searchParams.get('cursor') === cursor ? [readable] : [],
            hasUnclassified: false, coverage: { status: 'complete', unclassifiedCount: 0 } } };
    } });
    const list = await renderHook(() => useTeamSharedArtifacts({ scope: { serverId, accountId: 'reader' },
        address: { serverId, teamId: 'selected-team' }, teamResourceKind, enabled: true, pageSize: 1 }));
    await waitForHomeGovernance(() => expect(list.getCurrent().status).toBe('ready'));
    expect(list.getCurrent().rows).toMatchObject([{ artifactId: 'locked', header: {},
        availability: { kind: 'locked', reason: 'encryption_material_unavailable' } }]);
    expect(list.getCurrent().hasMore).toBe(true);
    await act(async () => list.getCurrent().loadMore());
    expect(list.getCurrent().rows.map(row => row.artifactId)).toEqual(['locked', 'readable']);
    expect(urls.map(url => [url.searchParams.get('sharedWithTeamId'), url.searchParams.get('teamResourceKind'),
        url.searchParams.get('cursor')])).toEqual([
        ['selected-team', teamResourceKind, null], ['selected-team', teamResourceKind, cursor],
    ]);
    if (teamResourceKind === 'projectDocuments') {
        await act(async () => publishHomeAccountChange(serverId, ['settings'], { teamSharedResourcesAffect: false }));
        expect(urls).toHaveLength(2);
        // The owner can report a Source-reference change with no Artifact kind changes.
        await act(async () => publishHomeAccountChange(serverId, ['source'], {
            teamSharedResourcesAffect: true, artifactKinds: [],
        }));
        await waitForHomeGovernance(() => expect(urls).toHaveLength(4));
        await waitForHomeGovernance(() => expect(list.getCurrent().status).toBe('ready'));
        expect(list.getCurrent().rows.map(row => row.artifactId)).toEqual(['locked', 'readable']);
    }
    expect(urls.every(url => url.searchParams.get('includeBody') !== 'true')).toBe(true);
    expect(home.requests.filter(request => request.path.split('?')[0]!.startsWith('/v1/artifacts/'))).toHaveLength(0);
});
