import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { SessionBotFaceMark } from '@/components/sessions/bots/SessionBotFaceMark';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { createSessionDiscussionDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { useOpenDiscussion } from './useOpenDiscussion';
import { seedDiscussionDraft, useDiscussionDraft } from './useDiscussionDraft';
import { getSessionComposerDraftSnapshot } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

const route = vi.hoisted(() => ({ push: vi.fn(), pathname: '/discussions', params: {} as Record<string, string | string[]> }));
const viewport = vi.hoisted(() => ({ width: 390, height: 844, scale: 1, fontScale: 1 }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => viewport,
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
vi.mock('@/components/ui/popover', async (importOriginal) => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: route.push }, pathname: () => route.pathname, params: () => route.params }).module;
});
const runtime = installSessionPaneRuntimeTestHarness({ scopeId: ({ sessionId, serverId }) => createSessionPaneScopeId(sessionId, serverId),
    features: () => createRootLayoutFeaturesResponse({ features: { sharing: { session: { enabled: true } },
        sessions: { enabled: true, conversations: { enabled: true } } } }),
});

describe('open Discussion', () => {
    beforeEach(() => {
        route.push.mockClear();
        route.pathname = '/discussions';
        route.params = { serverId: 'home-b' };
        viewport.width = 390;
    });
    afterEach(standardCleanup);

    it.each([
        { width: 1440, sessionId: undefined },
        { width: 1440, sessionId: 'source-a' },
        { width: 390, sessionId: 'source-a' },
    ])('pushes routes without a pane provider at $width with source $sessionId', async ({ width, sessionId }) => {
        viewport.width = width;
        const hook = await renderHook(() => useOpenDiscussion({ address: { serverId: 'home-b' },
            ...(sessionId ? { anchor: { kind: 'session' as const, sessionId }, sourceSurface: 'collaboration' as const } : {}),
        }));
        await act(async () => hook.getCurrent().openDiscussion('review'));
        expect(route.push).toHaveBeenLastCalledWith(`/discussions/review?serverId=home-b${sessionId ? '&sourceSurface=collaboration' : ''}`);
        await act(async () => hook.getCurrent().openNewDiscussion());
        expect(new URL(route.push.mock.lastCall![0], 'https://happier.test').searchParams.get('draftId')).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it('opens the canonical resource without a parent Session and retains the captured Home', async () => {
        const hook = await renderHook(({ serverId }: { serverId: string }) => useOpenDiscussion({ address: { serverId } }), {
            initialProps: { serverId: 'home-b' },
            wrapper: runtime.Wrapper,
        });
        const capturedOpen = hook.getCurrent().openDiscussion;
        await hook.rerender({ serverId: 'home-c' });
        await act(async () => capturedOpen('same-id'));
        expect(route.push).toHaveBeenLastCalledWith('/discussions/same-id?serverId=home-b');
        await act(async () => hook.getCurrent().openDiscussion('same-id'));
        expect(route.push).toHaveBeenLastCalledWith('/discussions/same-id?serverId=home-c');
        await act(async () => hook.getCurrent().openNewDiscussion());
        const first = new URL(route.push.mock.lastCall![0], 'https://happier.test');
        expect(first.searchParams.get('draftId')).toMatch(/^[0-9a-f-]{36}$/i);
        await act(async () => hook.getCurrent().openNewDiscussion());
        const second = new URL(route.push.mock.lastCall![0], 'https://happier.test');
        expect(second.searchParams.get('draftId')).not.toBe(first.searchParams.get('draftId'));
    });

    it('derives selection from the canonical route and exact Home', async () => {
        route.pathname = '/discussions/same-id';
        route.params = { serverId: 'home-b', discussionId: 'same-id' };
        const hook = await renderHook(() => useOpenDiscussion({ address: { serverId: 'home-b' } }), { wrapper: runtime.Wrapper });
        expect(hook.getCurrent().activeDiscussionKey).toBe('same-id');
        route.params = { serverId: 'home-c', discussionId: 'same-id' };
        await hook.rerender();
        expect(hook.getCurrent().activeDiscussionKey).toBeNull();
        route.params = { serverId: 'home-b' };
        route.pathname = '/discussions/new';
        await hook.rerender();
        expect(hook.getCurrent().activeDiscussionKey).toBe('new');
    });

    it('seeds an explicit New intent into that fresh route draft without borrowing the singleton', async () => {
        const scope = runtime.accountScope!;
        const hook = await renderHook(() => useOpenDiscussion({ address: scope,
            prepareNewDraft: draftId => { seedDiscussionDraft({ scope, address: { kind: 'newDiscussion', draftId },
                text: 'Please help with this Bot', mentions: [] }); },
        }), { wrapper: runtime.Wrapper });
        await act(async () => hook.getCurrent().openNewDiscussion());
        const draftId = new URL(route.push.mock.lastCall![0], 'https://happier.test').searchParams.get('draftId')!;
        expect(getSessionComposerDraftSnapshot(scope, { kind: 'newDiscussion', draftId })?.composer.text.value).toBe('Please help with this Bot');
        expect(getSessionComposerDraftSnapshot(scope, { kind: 'newDiscussion' })).toBeNull();
    });

    it('preselects the Bot in the ordinary fresh Discussion draft without addressing the first message', async () => {
        const accountLifetime = captureActiveServerAccountScopeLifetime()!;
        const scope = accountLifetime.scope;
        const participant = { kind: 'session' as const, sessionId: 'release-captain' };
        const screen = await renderScreen(<runtime.Wrapper><SessionBotFaceMark sessionId={participant.sessionId}
            serverId={scope.serverId} accountLifetime={accountLifetime} size={32} facts={{ seed: participant.sessionId, face: null }} />
        </runtime.Wrapper>);
        await vi.waitFor(() => expect(screen.findByTestId('bot-face-mark')?.props['aria-haspopup']).toBe('menu'));
        await screen.pressByTestIdAsync('bot-face-mark');
        await screen.pressByTestIdAsync('dropdown-option-new-discussion');
        await vi.waitFor(() => expect(route.push).toHaveBeenCalledTimes(1));
        const draftId = new URL(route.push.mock.lastCall![0], 'https://happier.test').searchParams.get('draftId')!;
        const draft = await renderHook(() => useDiscussionDraft({ scope, address: { kind: 'newDiscussion', draftId } }),
            { wrapper: runtime.Wrapper });
        expect(draft.getCurrent().participants).toEqual([{ ...participant, answerPolicy: 'when_mentioned' }]);
        expect(draft.getCurrent().recipients).toEqual([]);
        expect(draft.getCurrent().text).toBe('');
    });

    it('makes People an anchor adapter to the same canonical destination', async () => {
        const hook = await renderHook(() => useOpenDiscussion({ address: { serverId: 'home-b' }, anchor: { kind: 'session', sessionId: 'source-a' }, sourceSurface: 'collaboration' }), { wrapper: runtime.Wrapper });
        await act(async () => hook.getCurrent().openDiscussion('same-id'));
        expect(route.push).toHaveBeenLastCalledWith('/discussions/same-id?serverId=home-b&sourceSurface=collaboration');
        await act(async () => hook.getCurrent().openNewDiscussion());
        const href = new URL(route.push.mock.lastCall![0], 'https://happier.test');
        expect(href.pathname).toBe('/discussions/new');
        expect(href.searchParams.get('anchorSessionId')).toBe('source-a');
        expect(href.searchParams.get('draftId')).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it('opens beside the source on desktop and derives selection from the actual active tab', async () => {
        viewport.width = 1440;
        const address = { serverId: runtime.serverId, sessionId: 's1' };
        const anchor = { kind: 'session' as const, sessionId: 's1', messageId: 'source-answer' };
        const hook = await renderHook(() => useOpenDiscussion({ address, anchor, sourceSurface: 'collaboration' }), { wrapper: runtime.Wrapper });
        await act(async () => hook.getCurrent().openDiscussion('review', 'Review'));
        expect(route.push).not.toHaveBeenCalled();
        expect(runtime.pane.scopeState?.details.tabs).toEqual([expect.objectContaining({
            title: 'Review', isPreview: true, resource: { kind: 'discussion', target: { kind: 'discussion', address, discussionId: 'review' } },
        })]);
        expect(hook.getCurrent().activeDiscussionKey).toBe('review');
        await act(async () => runtime.pane.openDetailsTab(createSessionDiscussionDetailsTab({ kind: 'discussion',
            address: { ...address, serverId: 'other-home' }, discussionId: 'review' }), { intent: 'preview' }));
        expect(hook.getCurrent().activeDiscussionKey).toBeNull();
        await act(async () => hook.getCurrent().openNewDiscussion());
        const first = runtime.pane.scopeState!.details.tabs.at(-1)!;
        expect(first.resource).toMatchObject({ target: { kind: 'new', address, anchor, draftId: expect.stringMatching(/^[0-9a-f-]{36}$/i) } });
        await act(async () => hook.getCurrent().openNewDiscussion());
        expect(runtime.pane.scopeState!.details.tabs.at(-1)!.key).not.toBe(first.key);
        expect(hook.getCurrent().activeDiscussionKey).toBe('new');
    });
});
