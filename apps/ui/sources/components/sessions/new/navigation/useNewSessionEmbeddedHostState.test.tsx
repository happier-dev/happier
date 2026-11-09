import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { NewSessionHostParams } from './newSessionHost';
import { useNewSessionEmbeddedHostState } from './useNewSessionEmbeddedHostState';

const focusBoundary = vi.hoisted(() => ({ effects: new Set<() => void | (() => void)>() }));
vi.mock('@react-navigation/native', async () => {
    const React = await import('react');
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        // Navigation focus is the external boundary; the draft lifecycle stays real.
        useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(() => {
            focusBoundary.effects.add(effect);
            const cleanup = effect();
            return () => { focusBoundary.effects.delete(effect); cleanup?.(); };
        }, [effect]),
    };
});

it('keeps authored input during late context hydration and starts the next draft in that context after handoff', async () => {
    const seed: NewSessionHostParams = { spawnServerId: 'page-home', machineId: 'page-machine' };
    const hook = await renderHook((params: NewSessionHostParams) => useNewSessionEmbeddedHostState(params), { initialProps: seed });
    const firstDraftId = hook.getCurrent().host.params.draftId;
    await act(async () => hook.getCurrent().host.setParams({ directory: '/authored', prompt: 'my prompt' }));
    await hook.rerender({ ...seed, directory: '/home/page' });
    expect(hook.getCurrent().host.params.directory).toBe('/authored');
    expect(hook.getCurrent().host.params.prompt).toBe('my prompt');
    await act(async () => {
        hook.getCurrent().host.onHandedOff('/session/created');
        for (const effect of focusBoundary.effects) effect();
    });
    expect(hook.getCurrent().host.params).toMatchObject({ ...seed, directory: '/home/page' });
    expect(hook.getCurrent().host.params.draftId).not.toBe(firstDraftId);
    expect(hook.getCurrent().host.params.prompt).toBeUndefined();
    expect(hook.getCurrent().host.targetServerId).toBe('page-home');
    await hook.unmount();
});

it('renews an in-place shell draft on handoff without waiting for page focus', async () => {
    const hook = await renderHook(() => useNewSessionEmbeddedHostState(undefined, { renewOnHandOff: true }));
    try {
        const firstDraftId = hook.getCurrent().host.params.draftId;
        await act(async () => hook.getCurrent().host.setParams({ prompt: 'sent text', machineId: 'machine' }));
        await act(async () => hook.getCurrent().host.onHandedOff('/session/created'));
        expect(hook.getCurrent().host.params.draftId).not.toBe(firstDraftId);
        expect(hook.getCurrent().host.params.prompt).toBeUndefined();
        const renewed = hook.getCurrent().host.params.draftId;
        await act(async () => { for (const effect of focusBoundary.effects) effect(); });
        expect(hook.getCurrent().host.params.draftId).toBe(renewed);
    } finally { await hook.unmount(); }
});

it('keeps untouched ordinary entries off the Account and persists exactly one draft once the person types', async () => {
    const React = await import('react');
    const { renderScreen } = await import('@/dev/testkit');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { createSessionDraftPrivatePayloadV2 } = await import('@happier-dev/protocol/drafts/sessionDraftsV2');
    const { useNewSessionDraftProjections } = await import('@/components/sessions/shell/NewSessionDraftsSection');
    const { useResolveNewSessionOrdinaryEntryRoute } = await import('./newSessionOrdinaryEntryRoute');
    const { createNewSessionComposerDocumentOwner } = await import('@/components/sessions/composer/newSessionComposerDocumentOwner');
    const {
        configureSessionDraftRepository, flushSessionDraft, getSessionDraftSnapshot, listNewSessionDraftProjections,
    } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const scope = { serverId: 'srv-space-seed', accountId: 'space-seed-account' };
    // The Account draft endpoint is the network boundary; every remote draft write reaches `mutate`.
    const remoteWrites: string[] = [];
    configureSessionDraftRepository({
        scope,
        syncEnabled: true,
        cipher: {
            seal: async (address, document) => ({ t: 'plain' as const, v: createSessionDraftPrivatePayloadV2(address, document) }),
            open: async (_address, content) => content.t === 'plain' ? content.v.document : null,
        },
        transport: {
            read: async () => ({ status: 'absent' as const }),
            list: async () => ({ items: [], nextAfter: undefined }),
            mutate: async ({ address, content }) => {
                remoteWrites.push(address.kind === 'newSession' ? address.draftId : address.kind);
                return { status: 'updated' as const, record: { address, revision: 0, content, createdAt: 1, updatedAt: 1 } };
            },
        },
    });
    const before = storage.getState();
    storage.setState({ profileScope: scope, settingsScope: scope, settingsVersion: 1,
        settings: { ...before.settings, collectionSpacesEnabled: true, sessionSpacesEnabled: true } });
    const renderUpdates = vi.spyOn(console, 'error').mockImplementation(() => {});
    let homeDraftId: string | undefined;
    let docked: ReturnType<typeof useNewSessionEmbeddedHostState> | undefined;
    let resolveEntry: ReturnType<typeof useResolveNewSessionOrdinaryEntryRoute> | undefined;
    function DraftsReader() { useNewSessionDraftProjections(scope); return null; }
    function Home() { homeDraftId = useNewSessionEmbeddedHostState().host.params.draftId as string; return null; }
    function Docked() { docked = useNewSessionEmbeddedHostState(undefined, { renewOnHandOff: true }); return null; }
    function Entry() { resolveEntry = useResolveNewSessionOrdinaryEntryRoute(); return null; }
    try {
        // The drafts list is already showing when the root docked host and the Home composer mount beside it.
        const screen = await renderScreen(<><DraftsReader /></>);
        await screen.update(<><DraftsReader /><Docked /><Home /><Entry /></>);
        const entered = new Set<string>([homeDraftId!, docked!.host.params.draftId as string]);
        for (let index = 0; index < 3; index += 1) {
            await act(async () => docked!.host.onHandedOff('/session/created'));
            entered.add(docked!.host.params.draftId as string);
            entered.add(resolveEntry!({ forceFresh: true }).draftId);
        }
        await act(async () => { await Promise.all([...entered].map(draftId => flushSessionDraft({ scope, address: { kind: 'newSession', draftId } }))); });
        expect(entered.size).toBe(8);
        // Opening New Session is not authoring: no entry leaves a draft here or on the Account.
        expect({ remoteWrites: remoteWrites.length, localDrafts: listNewSessionDraftProjections(scope).length }).toEqual({ remoteWrites: 0, localDrafts: 0 });
        expect(getSessionDraftSnapshot(scope, { kind: 'newSession', draftId: homeDraftId! })).toBeNull();

        const owner = createNewSessionComposerDocumentOwner({ scope, ref: { kind: 'newSession', instanceId: homeDraftId! } });
        await act(async () => { owner.replaceDocument({ ...owner.read().document, text: 'A real question' }); });
        await act(async () => { await flushSessionDraft({ scope, address: { kind: 'newSession', draftId: homeDraftId! } }); });
        expect({ remoteWrites, localDrafts: listNewSessionDraftProjections(scope).length }).toEqual({ remoteWrites: [homeDraftId], localDrafts: 1 });
        expect(renderUpdates.mock.calls.filter(call => String(call[0]).includes('Cannot update a component'))).toEqual([]);
        await screen.unmount();
    } finally {
        renderUpdates.mockRestore();
        storage.setState(before, true);
        configureSessionDraftRepository({ syncEnabled: false });
    }
});
