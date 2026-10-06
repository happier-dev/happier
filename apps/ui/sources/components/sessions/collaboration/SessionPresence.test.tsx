import * as React from 'react';
import { Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionListRenderableSessionFixture, renderScreen } from '@/dev/testkit';
import { findTestInstanceByTypeContainingText, type RenderScreenResult } from '@/dev/testkit/render/renderScreen';
import { sessionHumanPresenceStore } from '@/sync/domains/session/humanPresence/sessionHumanPresenceStore';
import { storage } from '@/sync/domains/state/storageStore';
import {
    createSessionCollaborationHeaderMenuItem,
    resolveSessionCollaborationHeaderPlacement,
    SessionCollaborationHeaderEntry,
    useSessionCollaborationHeaderState,
} from './SessionCollaborationHeaderEntry';
import { STALE_PRESENCE_OPACITY } from './SessionViewerFacepile';
import { SessionCollaborationRailBadge, useSessionConversationMentioned } from './sessionConversationAttention';
import { SessionPresenceSection } from './SessionPresenceSection';

const modal = vi.hoisted(() => ({ mock: null as ReturnType<typeof import('@/dev/testkit/mocks/modal').createModalModuleMock> | null }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    modal.mock = createModalModuleMock();
    return modal.mock.module;
});

const target = { serverId: 'presence-test-home', sessionId: 'presence-test-session' };
const account = (id: string) => ({ kind: 'account', accountId: id, firstName: id, lastName: null, username: null, avatarUrl: null });
let home: ReturnType<typeof sessionHumanPresenceStore.attachHome> | undefined;
let previousStorageState: ReturnType<typeof storage.getState>;
beforeEach(() => { previousStorageState = storage.getState(); });
afterEach(() => {
    home?.dispose();
    home = undefined;
    storage.setState(previousStorageState, true);
});

function publishViewerAttention(reasons: readonly ('mentioned' | 'unread_discussion')[], tracked = true): void {
    const row = createSessionListRenderableSessionFixture({
        id: target.sessionId,
        viewer: {
            readState: tracked
                ? { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null }
                : { state: 'not_started' },
            attention: {
                needsAttention: reasons.length > 0,
                reasons,
                primary: reasons[0] ?? null,
                presentation: 'full',
            },
            relevance: { relevant: true, reasons: ['owned_by_me'] },
            follow: { follows: false, notificationLevel: null },
            notification: { level: 'important', source: 'owner' },
        },
    });
    storage.setState((state) => ({
        ...state,
        sessionListRowsByServerId: {
            ...state.sessionListRowsByServerId,
            [target.serverId]: { [target.sessionId]: row },
        },
    }));
}

function HeaderEntryFromCanonicalState(props: Readonly<{ onPress: () => void }>) {
    return <SessionCollaborationHeaderEntry target={target} onPress={props.onPress} />;
}

function HeaderPlacementFromCanonicalState(props: Readonly<{ compact: boolean }>) {
    const state = useSessionCollaborationHeaderState(target, props.compact);
    return <View testID="session-collaboration-placement" accessibilityLabel={state.direct ? 'direct' : state.overflow ? 'overflow' : 'none'} />;
}

function expectPresenceText(screen: RenderScreenResult, testID: string, text: string): void {
    const line = screen.findByTestId(testID);
    expect(line).not.toBeNull();
    // The shared Item text presentation can wrap the line in another Text;
    // inspect its rendered descendants through the canonical text query.
    const rendered = findTestInstanceByTypeContainingText(line!, Text, text);
    expect(rendered).toBeDefined();
    expect(rendered?.findAll((node) => typeof node.type === 'string')
        .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
        .join('')).toBe(text);
}

describe('Session presence surfaces', () => {
    it('places the compact collaboration entry exactly once as presence changes', () => {
        expect(resolveSessionCollaborationHeaderPlacement({ compact: true, hasNamedViewers: false })).toEqual({
            direct: false,
            overflow: true,
        });
        expect(resolveSessionCollaborationHeaderPlacement({ compact: true, hasNamedViewers: true })).toEqual({
            direct: true,
            overflow: false,
        });
        expect(resolveSessionCollaborationHeaderPlacement({ compact: false, hasNamedViewers: false })).toEqual({
            direct: true,
            overflow: false,
        });
    });

    it('preserves collaboration attention in the folded menu presentation', () => {
        const item = createSessionCollaborationHeaderMenuItem({
            iconColor: '#111111',
            attentionColor: '#222222',
            attentionLabel: '1 unread',
        });

        expect(item.accessibilityLabel).toContain('1 unread');
        expect(item.rightElement).not.toBeNull();
    });

    it('uses one header action, bounded avatars, all accessible names and stale continuity', async () => {
        home = sessionHumanPresenceStore.attachHome(target.serverId, 'self');
        home.beginDeclaration([target.sessionId]);
        const open = vi.fn();
        const screen = await renderScreen(<HeaderEntryFromCanonicalState onPress={open} />);
        expect(screen.findByTestId('session-collaboration-header')).not.toBeNull();
        expect(screen.findByTestId('session-viewer-facepile')).toBeNull();
        await act(async () => home!.receiveSnapshot({ v: 1, sessionId: target.sessionId, observedAt: 1,
            viewers: ['Alice', 'Bob', 'Charlie', 'Dana', 'self'].map((id) => ({ account: account(id), typing: id === 'Alice' })),
        }));
        expect(screen.findByTestId('session-viewer-facepile')).not.toBeNull();
        expect(screen.findByTestId('session-collaboration-header')).toBeNull();
        expect(screen.findAllByTestId('session-viewer-avatar')).toHaveLength(3);
        expect(screen.findByTestId('session-viewer-overflow')?.props.children).toBe('+1');
        expect(screen.findByTestId('session-viewer-facepile')?.props.accessibilityLabel).toContain('Dana');
        await screen.pressByTestIdAsync('session-viewer-facepile');
        expect(open).toHaveBeenCalledOnce();
        await act(async () => home!.setStatus('unavailable'));
        expect(screen.findByTestId('session-viewer-facepile')?.props.accessibilityLabel).toContain('May be out of date');
    });

    it('says who is typing instead of signalling it with the avatar ring colour alone', async () => {
        home = sessionHumanPresenceStore.attachHome(target.serverId, 'self');
        home.beginDeclaration([target.sessionId]);
        const screen = await renderScreen(<HeaderEntryFromCanonicalState onPress={vi.fn()} />);
        await act(async () => home!.receiveSnapshot({
            v: 1, sessionId: target.sessionId, observedAt: 2,
            viewers: [{ account: account('Alice'), typing: true }, { account: account('Bob'), typing: false }],
        }));

        // The ring is a colour difference a screen reader and a colour-blind viewer
        // cannot perceive, so the same fact has to reach the accessible name.
        const label = screen.findByTestId('session-viewer-facepile')?.props.accessibilityLabel as string;
        expect(label).toContain('Alice · Typing…');
        expect(label).toContain('Bob');
        expect(label).not.toContain('Bob · Typing…');
    });

    it('announces presence changes only inside the Viewing now region the user focused', async () => {
        home = sessionHumanPresenceStore.attachHome(target.serverId, 'self');
        home.beginDeclaration([target.sessionId]);
        const screen = await renderScreen(<SessionPresenceSection {...target} />);
        await act(async () => home!.receiveSnapshot({
            v: 1, sessionId: target.sessionId, observedAt: 3,
            viewers: [{ account: account('Alice'), typing: false }],
        }));

        // Unfocused, the row states presence but publishes no live region: an
        // unattended polite region speaks every viewer change of every Session.
        expect(screen.findByTestId('session-presence-status')?.props.accessibilityLiveRegion).toBeUndefined();
        expectPresenceText(screen, 'session-presence-title', 'Alice is here');
        expect(screen.findByTestId('session-presence-announcement')).toBeNull();

        await act(async () => { screen.findByTestId('session-presence-summary-anchor')?.props.onFocus?.(); });
        expectPresenceText(screen, 'session-presence-announcement', 'Viewing now: Alice');

        // A typing renewal is not a membership change; the announcement is
        // coalesced away while the visible row still shows it.
        await act(async () => home!.receiveSnapshot({
            v: 1, sessionId: target.sessionId, observedAt: 4,
            viewers: [{ account: account('Alice'), typing: true }],
        }));
        expectPresenceText(screen, 'session-presence-status', 'Alice is typing…');
        expectPresenceText(screen, 'session-presence-announcement', 'Viewing now: Alice');

        await act(async () => home!.receiveSnapshot({
            v: 1, sessionId: target.sessionId, observedAt: 5,
            viewers: [{ account: account('Alice'), typing: true }, { account: account('Bob'), typing: false }],
        }));
        expectPresenceText(screen, 'session-presence-announcement', 'Viewing now: Alice, Bob');

        await act(async () => { screen.findByTestId('session-presence-summary-anchor')?.props.onBlur?.(); });
        expect(screen.findByTestId('session-presence-announcement')).toBeNull();
    });

    it('replaces the solo collaboration action with the compact facepile when another viewer arrives', async () => {
        home = sessionHumanPresenceStore.attachHome(target.serverId, 'self');
        home.beginDeclaration([target.sessionId]);
        const open = vi.fn();
        const screen = await renderScreen(
            <HeaderEntryFromCanonicalState onPress={open} />,
        );

        expect(screen.findByTestId('session-collaboration-header')).not.toBeNull();
        expect(screen.findByTestId('session-viewer-facepile')).toBeNull();

        await act(async () => home!.receiveSnapshot({
            v: 1,
            sessionId: target.sessionId,
            observedAt: 4,
            viewers: [{ account: account('Alice'), typing: false }],
        }));

        expect(screen.findByTestId('session-viewer-facepile')).not.toBeNull();
        await screen.pressByTestIdAsync('session-viewer-facepile');
        expect(open).toHaveBeenCalledOnce();
    });

    it('keeps the facepile direct while allowing a folded solo action to stay in overflow', async () => {
        home = sessionHumanPresenceStore.attachHome(target.serverId, 'self');
        home.beginDeclaration([target.sessionId]);
        const open = vi.fn();
        const screen = await renderScreen(
            <SessionCollaborationHeaderEntry target={target} attentionLabel={null} compact onPress={open} />,
        );

        expect(screen.findByTestId('session-collaboration-header')).toBeNull();
        expect(screen.findByTestId('session-viewer-facepile')).toBeNull();

        await act(async () => home!.receiveSnapshot({
            v: 1,
            sessionId: target.sessionId,
            observedAt: 5,
            viewers: [{ account: account('Alice'), typing: false }],
        }));

        expect(screen.findByTestId('session-viewer-facepile')).not.toBeNull();
        await screen.pressByTestIdAsync('session-viewer-facepile');
        expect(open).toHaveBeenCalledOnce();
    });

    it('moves the compact action from overflow to direct without subscribing its parent', async () => {
        home = sessionHumanPresenceStore.attachHome(target.serverId, 'self');
        home.beginDeclaration([target.sessionId]);
        let parentRenderCount = 0;
        function Parent() {
            parentRenderCount += 1;
            return <HeaderPlacementFromCanonicalState compact />;
        }
        const screen = await renderScreen(<Parent />);
        expect(screen.findByTestId('session-collaboration-placement')?.props.accessibilityLabel).toBe('overflow');

        await act(async () => home!.receiveSnapshot({
            v: 1,
            sessionId: target.sessionId,
            observedAt: 6,
            viewers: [{ account: account('Alice'), typing: false }],
        }));

        expect(screen.findByTestId('session-collaboration-placement')?.props.accessibilityLabel).toBe('direct');
        expect(parentRenderCount).toBe(1);
    });

    it('keeps one present line through connecting, just-you and unsupported, never collapsing the space', async () => {
        home = sessionHumanPresenceStore.attachHome(target.serverId, 'self');
        home.beginDeclaration([target.sessionId]);
        const screen = await renderScreen(<SessionPresenceSection {...target} />);
        expectPresenceText(screen, 'session-presence-title', 'Checking who’s here…');
        await act(async () => home!.receiveSnapshot({ v: 1, sessionId: target.sessionId, observedAt: 2, viewers: [] }));
        expectPresenceText(screen, 'session-presence-title', 'Just you here');
        await act(async () => home!.setStatus('unsupported'));
        // A Home without live presence still says so in the same line.
        expect(screen.findByTestId('session-presence-section')).not.toBeNull();
        expectPresenceText(screen, 'session-presence-title', 'Live presence isn’t available on this Home');
    });

    it('says who is here and who is typing in one line', async () => {
        home = sessionHumanPresenceStore.attachHome(target.serverId, 'self');
        home.beginDeclaration([target.sessionId]);
        const screen = await renderScreen(<SessionPresenceSection {...target} />);
        await act(async () => home!.receiveSnapshot({
            v: 1, sessionId: target.sessionId, observedAt: 2,
            viewers: [{ account: account('Ana'), typing: false }, { account: account('Ben'), typing: true }],
        }));
        expectPresenceText(screen, 'session-presence-title', 'Ana and Ben are here');
        expectPresenceText(screen, 'session-presence-status', 'Ben is typing…');
        expect(screen.findByTestId('session-presence-summary')?.props.accessibilityLabel).toContain('Ben · Typing…');
    });

    it('de-emphasizes the stale summary like the facepile and returns focus to it from the viewer list', async () => {
        home = sessionHumanPresenceStore.attachHome(target.serverId, 'self');
        home.beginDeclaration([target.sessionId]);
        // Warmed here so the assertion below measures the open, not this
        // runner's first transform of the lazily imported viewer list.
        await import('./SessionPresenceViewerList');
        const nodes = new Map<string, object>();
        const screen = await renderScreen(<SessionPresenceSection {...target} />, {
            createNodeMock: (element) => {
                const testID = (element as { props?: { testID?: string } }).props?.testID;
                const node = { testID };
                if (testID) nodes.set(testID, node);
                return node;
            },
        });
        await act(async () => home!.receiveSnapshot({
            v: 1, sessionId: target.sessionId, observedAt: 7,
            viewers: [{ account: account('Alice'), typing: false }],
        }));
        // Live rows carry no de-emphasis; only the retained last-known rows do.
        expect(screen.findByTestId('session-presence-summary-anchor')?.props.style).toBeFalsy();

        await act(async () => home!.setStatus('unavailable'));
        expectPresenceText(screen, 'session-presence-title', 'Alice is here');
        expectPresenceText(screen, 'session-presence-status', 'May be out of date');
        expect(screen.findByTestId('session-presence-summary-anchor')?.props.style)
            .toMatchObject({ opacity: STALE_PRESENCE_OPACITY });

        await screen.pressByTestIdAsync('session-presence-summary');
        // The viewer list is lazily imported, so the open is asynchronous.
        await vi.waitFor(() => expect(modal.mock?.spies.show).toHaveBeenCalled(), { timeout: 10_000 });
        const shown = modal.mock?.spies.show.mock.calls.at(-1)?.[0];
        expect(shown?.focusReturnRef?.current).toBe(nodes.get('session-presence-summary-anchor'));
    });

    it('presents the complete viewer list as read-only identities, not activation targets', async () => {
        home = sessionHumanPresenceStore.attachHome(target.serverId, 'self');
        home.beginDeclaration([target.sessionId]);
        const { SessionPresenceViewerList } = await import('./SessionPresenceViewerList');
        const screen = await renderScreen(<SessionPresenceViewerList target={target} onClose={vi.fn()} />);
        await act(async () => home!.receiveSnapshot({
            v: 1,
            sessionId: target.sessionId,
            observedAt: 9,
            viewers: [
                { account: account('Alice'), typing: true },
                { account: account('Bob'), typing: false },
            ],
        }));

        // Every named viewer is still presented with the live typing detail.
        const content = screen.getTextContent();
        expect(content).toContain('Alice');
        expect(content).toContain('Bob');
        expect(content).toContain('Typing');

        // The list answers "who is here"; selecting a person does nothing, so a row
        // must not present itself as a button, an option, or a keyboard tab stop.
        const viewerRowProps = (node: { props: unknown }) => node.props as Readonly<{
            title?: unknown;
            onPress?: unknown;
            accessibilityRole?: unknown;
            role?: unknown;
            tabIndex?: unknown;
            disabled?: unknown;
        }>;
        const isViewerRow = (node: { props: unknown }) => {
            const title = viewerRowProps(node).title;
            return title === 'Alice' || title === 'Bob';
        };
        const activationTargets = screen.findAll((node) => {
            if (!isViewerRow(node)) return false;
            const props = viewerRowProps(node);
            return typeof props.onPress === 'function'
                || props.accessibilityRole === 'button'
                || props.role === 'option'
                || props.tabIndex === 0;
        });
        expect(activationTargets).toEqual([]);

        // Read-only is not unavailable: a dimmed/disabled row would misdescribe a
        // person who is present right now.
        const disabledRows = screen.findAll((node) => isViewerRow(node) && viewerRowProps(node).disabled === true);
        expect(disabledRows).toEqual([]);
    });

    it('decorates the existing header action from exact-Home canonical discussion attention', async () => {
        home = sessionHumanPresenceStore.attachHome(target.serverId, 'self');
        home.beginDeclaration([target.sessionId]);
        publishViewerAttention(['mentioned']);

        const screen = await renderScreen(<HeaderEntryFromCanonicalState onPress={vi.fn()} />);
        expect(screen.findByTestId('session-collaboration-attention')).not.toBeNull();
        // A mention is the one targeted signal the feature adds; announcing the
        // generic "1 unread" both hid it and stated a count this client never has.
        expect(screen.findByTestId('session-collaboration-header')?.props.accessibilityLabel)
            .toContain('You were mentioned');

        await act(async () => home!.receiveSnapshot({
            v: 1,
            sessionId: target.sessionId,
            observedAt: 3,
            viewers: [{ account: account('Alice'), typing: false }],
        }));
        expect(screen.findByTestId('session-collaboration-attention')).not.toBeNull();
        expect(screen.findByTestId('session-viewer-facepile')?.props.accessibilityLabel)
            .toContain('You were mentioned');
    });

    it('announces ordinary unread discussion without the mention wording or a fabricated count', async () => {
        home = sessionHumanPresenceStore.attachHome(target.serverId, 'self');
        home.beginDeclaration([target.sessionId]);
        publishViewerAttention(['unread_discussion']);

        const screen = await renderScreen(<HeaderEntryFromCanonicalState onPress={vi.fn()} />);
        const label = screen.findByTestId('session-collaboration-header')?.props.accessibilityLabel as string;
        expect(label).toContain('Unread conversations');
        expect(label).not.toContain('mention');
        expect(label).not.toContain('1 unread');
    });

    it('does not decorate untracked, unknown, or another Home Session state', async () => {
        publishViewerAttention(['unread_discussion'], false);
        const screen = await renderScreen(<HeaderEntryFromCanonicalState onPress={vi.fn()} />);
        expect(screen.findByTestId('session-collaboration-attention')).toBeNull();

        publishViewerAttention(['unread_discussion']);
        storage.setState((state) => ({
            ...state,
            sessionListRowsByServerId: {
                ...state.sessionListRowsByServerId,
                [target.serverId]: {},
                'another-home': state.sessionListRowsByServerId[target.serverId] ?? {},
            },
        }));
        expect(screen.findByTestId('session-collaboration-attention')).toBeNull();
    });
});

describe('Collaboration rail mention dot', () => {
    function MentionedProbe(props: Readonly<{ onRender: () => void }>) {
        props.onRender();
        const mentioned = useSessionConversationMentioned(target);
        return <View testID="mentioned-probe" accessibilityLabel={mentioned ? 'mentioned' : 'quiet'} />;
    }

    it('shows a dot for an unread mention only, from the same attention the header facepile reads', async () => {
        publishViewerAttention(['mentioned', 'unread_discussion']);
        const screen = await renderScreen(<SessionCollaborationRailBadge target={target} />);
        expect(screen.findByTestId('session-action-rail:collaboration:badge')).not.toBeNull();

        // Plain unread conversations stay quiet on the rail.
        await act(async () => publishViewerAttention(['unread_discussion']));
        expect(screen.findByTestId('session-action-rail:collaboration:badge')).toBeNull();

        await act(async () => publishViewerAttention(['mentioned'], false));
        expect(screen.findByTestId('session-action-rail:collaboration:badge')).toBeNull();
    });

    it('re-renders always-mounted chrome only when the mention bit changes', async () => {
        publishViewerAttention(['unread_discussion']);
        let renders = 0;
        const screen = await renderScreen(<MentionedProbe onRender={() => { renders += 1; }} />);
        expect(screen.findByTestId('mentioned-probe')?.props.accessibilityLabel).toBe('quiet');
        const baseline = renders;

        // An unrelated change to the same row (its follow state) is not the rail's summary bit.
        await act(async () => storage.setState((state) => {
            const row = state.sessionListRowsByServerId[target.serverId]?.[target.sessionId];
            if (!row?.viewer) return state;
            return {
                ...state,
                sessionListRowsByServerId: {
                    ...state.sessionListRowsByServerId,
                    [target.serverId]: { [target.sessionId]: { ...row, viewer: { ...row.viewer, follow: { follows: true, notificationLevel: null } } } },
                },
            };
        }));
        expect(renders).toBe(baseline);

        await act(async () => publishViewerAttention(['mentioned']));
        expect(screen.findByTestId('mentioned-probe')?.props.accessibilityLabel).toBe('mentioned');
    });
});
