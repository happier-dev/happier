import { afterEach, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { storage } = await import('@/sync/domains/state/storage');
const { useProjectContext } = await import('./useProjectContext');

afterEach(standardCleanup);

it('reads a managed Project Context Source once without loading the Source catalog', async () => {
    const paths: string[] = [];
    const source = { id: 'source-a', revision: 3, name: 'Guest source', audience: [], createdByAccountId: 'alice' };
    const url = 'https://project-context-source-demand.test';
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(url,
        { key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [] } }, 'updated', {
            handleRequest: async path => {
                const pathname = new URL(path, url).pathname;
                paths.push(pathname);
                if (pathname === '/v1/projects/sources/source-a') return Response.json({ ok: true, source, canManage: true });
                if (pathname === '/v1/projects/sources') return Response.json({ ok: true, sources: [source], coverage: { complete: true, nextCursor: null } });
                return null;
            },
        });
    await setServerProfileIdentityForUrl(url, 'srv_project_context_source_demand');
    const serverId = storage.getState().profileScope!.serverId;
    const checkout = { v: 2 as const, kind: 'managed' as const, id: 'guest-checkout', serverId,
        managedId: 'guest', controller: { machineId: 'controller', installationId: 'installation' },
        rootPath: '/repo', createdAtMs: 1, source: { sourceId: source.id, revision: source.revision } };
    const hook = await renderHook(() => useProjectContext({ serverId, projectRef: checkout, activeCheckout: checkout }));
    try {
        await vi.waitFor(() => expect(hook.getCurrent().target?.source?.source.id).toBe(source.id));
        expect(paths.filter(path => path === '/v1/projects/sources')).toHaveLength(0);
        expect(paths.filter(path => path === '/v1/projects/sources/source-a')).toHaveLength(1);
    } finally {
        await hook.unmount();
        await fixture.dispose();
    }
});
