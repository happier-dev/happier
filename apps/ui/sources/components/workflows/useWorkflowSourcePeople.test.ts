import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useWorkflowSourcePeople } from './useWorkflowSourcePeople';

afterEach(standardCleanup);

describe('Workflow source people page', () => {
    it('batches a rendered page once under its captured Home, excluding viewer and agent attribution', async () => {
        const home = await serveAccountHomes({ homes: [
            { key: 'captured', serverUrl: 'https://workflow-source-people.test', accountId: 'viewer' },
            { key: 'focused', serverUrl: 'https://workflow-source-other.test', accountId: 'other-viewer' },
        ], route: request => request.path === '/v1/user/profiles' ? Response.json({ users: [
            { id: 'editor-a', name: 'Ada Chen', firstName: '', lastName: null, username: '', avatar: null, bio: null, status: 'none', publicKey: null },
            { id: 'editor-b', name: 'Bo Lindqvist', firstName: '', lastName: null, username: '', avatar: null, bio: null, status: 'none', publicKey: null },
        ] }) : undefined });
        try {
            const serverId = home.homes.captured!.id;
            const hook = await renderHook(({ copy }) => {
                const bindings = useServerCredentialAccountScopeBindings([serverId]);
                return useWorkflowSourcePeople([
                    ...Array.from({ length: 20 }, (_, index) => ({ kind: 'person' as const,
                        accountId: index % 2 === 0 ? 'editor-a' : 'editor-b' })),
                    { kind: 'person', accountId: 'viewer' }, { kind: 'agent', accountId: 'agent-owner' },
                    ...(copy ? [{ kind: 'person' as const, accountId: 'editor-a' }] : []),
                ], bindings.get(serverId) ?? null);
            }, { initialProps: { copy: false } });
            await vi.waitFor(() => expect(hook.getCurrent().profiles.get('editor-a')?.profile?.name).toBe('Ada Chen'));
            expect(hook.getCurrent().viewerAccountId).toBe('viewer');
            const reads = home.requests.filter(request => request.path === '/v1/user/profiles');
            expect(reads).toHaveLength(1);
            expect(reads[0]).toMatchObject({ home: 'captured', accountId: 'viewer', method: 'POST',
                body: { ids: ['editor-a', 'editor-b'] } });
            await hook.rerender({ copy: true });
            expect(home.requests.filter(request => request.path === '/v1/user/profiles')).toHaveLength(1);
            await hook.unmount();
        } finally { await home.dispose(); }
    });
});
