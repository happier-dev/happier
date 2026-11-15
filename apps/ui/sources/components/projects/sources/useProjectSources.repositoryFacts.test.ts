import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { applyProjectAccountRowsFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
const { storage } = await import('@/sync/domains/state/storage');
const { useProjectSources } = await import('./useProjectSources');
const { buildProjectAccountRowPhysicalKeyV1 } = await import('@happier-dev/protocol/projects/projectAccountRowsV1');
const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');

afterEach(standardCleanup);

it('joins last observed private checkout facts once for Sources without per-row inspection, and withdraws another Account', async () => {
    const paths: string[] = [];
    const source = { id: 'source-a', revision: 3, name: 'App', audience: [], createdByAccountId: 'alice' };
    const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://source-repository-facts.test',
        { key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [] } }, 'updated', {
            handleRequest: async path => {
                paths.push(path);
                return path.startsWith('/v1/projects/sources')
                    ? Response.json({ ok: true, sources: [source], coverage: { complete: true, nextCursor: null } }) : null;
            },
        });
    await setServerProfileIdentityForUrl('https://source-repository-facts.test', 'srv_source_repository_facts');
    const scope = storage.getState().profileScope!;
    const observation = { source: { sourceId: source.id, revision: source.revision }, observedAtMs: 20, coverage: 'complete' as const,
        rootFiles: { dockerfile: 'present' as const, compose: 'absent' as const },
        applications: [{ file: 'package.json', framework: 'next', runtime: { name: 'node', version: '22' } }] };
    const ref = { id: 'workspace-a', serverId: 'srv_source_repository_facts', machineId: 'machine-a', rootPath: '/work/app', createdAtMs: 1,
        source: { sourceId: source.id, revision: source.revision }, repositoryObservation: observation };
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref, { ...ref, id: 'older', repositoryObservation: { ...observation, observedAtMs: 10 } },
        { ...ref, id: 'wrong-revision', source: { ...ref.source, revision: 2 }, repositoryObservation: { ...observation, observedAtMs: 30 } }] });
    const hook = await renderHook(() => useProjectSources(scope, { repositoryFacts: true }));
    try {
        await vi.waitFor(() => expect(hook.getCurrent().state.rows).toHaveLength(1));
        expect(hook.getCurrent().repositoryFacts?.get(source.id)).toMatchObject({ status: 'observed', observation });
        expect(paths.filter(path => path.startsWith('/v1/projects/sources'))).toHaveLength(1);
        expect(paths.filter(path => path.includes('projects.inspect'))).toEqual([]);
        await act(async () => applyProjectAccountRowsFixture(storage, {
            workspaceRefs: [{ ...ref, source: { ...ref.source, revision: 2 } }],
            // The row owner retains omitted rows without a tombstone; withdraw the other checkout observations explicitly.
            revisionsByPhysicalKey: Object.fromEntries([ref.id, 'older', 'wrong-revision'].map(id => [
                buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: ref.serverId, id }), 1,
            ])),
        }));
        expect(hook.getCurrent().repositoryFacts?.get(source.id)).toEqual({ status: 'unknown' });
        await act(async () => storage.setState({ profileScope: { ...scope, accountId: 'another-account' } }));
        expect(hook.getCurrent().repositoryFacts?.get(source.id)).toEqual({ status: 'unknown' });
    } finally {
        await hook.unmount();
        await fixture.dispose();
    }
});
