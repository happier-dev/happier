import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { ESCAPE_LAYER_PRIORITIES, registerEscapeLayer } from '@/keyboard/escape';
import type { InboxItem, InboxItemView } from '@/components/inbox/inboxItems';
import type { InboxItemFocus } from '@/components/inbox/inboxItemFocus';
import { useInboxItemNavigation } from './useInboxItemNavigation';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// Counts Inbox route derivations; the real route owner still runs underneath.
vi.mock('@/components/inbox/inboxItemFocus', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/inbox/inboxItemFocus')>();
    return { ...actual, createInboxItemRoute: vi.fn(actual.createInboxItemRoute) };
});

const initialSettings = storage.getState().settings;
const opened: string[] = [];
const read: string[] = [];
const initialItems: readonly InboxItem[] = ['first', 'next', 'update', 'mention'].map((id, index) => ({
    key: id, producer: 'live', type: index < 2 ? 'decision' : index === 2 ? 'update' : 'mention',
    view: index < 2 ? 'needs_you' : index === 2 ? 'updates' : 'mentions', title: id, context: null, createdAt: 1,
    read: false, source: { kind: 'session', serverId: 'home-a', id },
    focus: { kind: 'session', serverId: 'home-a', id }, pageRoute: `/session/${id}?serverId=home-a`,
}));
let state: Readonly<{ focus: InboxItemFocus | null; setFocus: React.Dispatch<React.SetStateAction<InboxItemFocus | null>>;
    setItems: React.Dispatch<React.SetStateAction<readonly InboxItem[]>>; setView: React.Dispatch<React.SetStateAction<InboxItemView>>;
    setSelectedResolved: React.Dispatch<React.SetStateAction<boolean>> }> | null = null;

function Probe() {
    const [items, setItems] = React.useState(initialItems);
    const [focus, setFocus] = React.useState<InboxItemFocus | null>(null);
    const [view, setView] = React.useState<InboxItemView>('needs_you');
    const [selectedResolved, setSelectedResolved] = React.useState(false);
    const close = React.useCallback(() => setFocus(null), []);
    const open = React.useCallback((route: string) => { opened.push(route); }, []);
    const markOpened = React.useCallback(async (item: InboxItem) => {
        read.push(item.key);
        setItems(items => items.map(row => row.key === item.key ? { ...row, read: true } : row));
    }, []);
    useInboxItemNavigation({ items, view, focus, enabled: true, select: setFocus, close, open, markOpened,
        ...{ selectedResolved } });
    state = { focus, setFocus, setItems, setView, setSelectedResolved };
    return null;
}

function key(key: string, overrides: Record<string, unknown> = {}) {
    const event = new Event('keydown', { cancelable: true });
    // Node's generic Event has none of KeyboardEvent's modifier defaults.
    for (const [name, value] of Object.entries({ key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, ...overrides })) {
        Object.defineProperty(event, name, { value });
    }
    window.dispatchEvent(event);
}

describe('Inbox selection through the shared keyboard runtime', () => {
    beforeEach(() => {
        opened.length = 0; read.length = 0; state = null;
        vi.stubGlobal('window', new EventTarget());
        vi.stubGlobal('navigator', { platform: 'Linux' });
        storage.setState({ settings: { ...initialSettings, keyboardShortcutsV2Enabled: true, keyboardSingleKeyShortcutsEnabled: true } });
    });
    afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); storage.setState({ settings: initialSettings }); });

    it('keeps local navigation available with general shortcuts off and respects the letter-key preference', async () => {
        storage.setState({ settings: { ...initialSettings, keyboardShortcutsV2Enabled: false, keyboardSingleKeyShortcutsEnabled: false } });
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Probe /></KeyboardShortcutProvider>);
        await act(async () => key('ArrowDown'));
        expect(state?.focus?.id).toBe('first');
        await act(async () => key('j'));
        expect(state?.focus?.id).toBe('first');
        await act(async () => key('Enter'));
        expect(opened).toEqual(['/session/first?serverId=home-a']);
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings,
                keyboardShortcutDisabledCommandIdsV1: ['inbox.item.next'] } });
        });
        await act(async () => key('ArrowDown'));
        expect(state?.focus?.id).toBe('first');
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, keyboardSingleKeyShortcutsEnabled: true,
                keyboardShortcutDisabledCommandIdsV1: [] } });
        });
        await act(async () => key('j'));
        expect(state?.focus?.id).toBe('next');
        await act(async () => key('Escape'));
        expect(state?.focus).toBeNull();
    });

    it('moves selection, opens the full page and closes without reading Needs you or stealing an editor/modal key', async () => {
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Probe /></KeyboardShortcutProvider>);
        await act(async () => key('ArrowDown'));
        expect(state?.focus?.id).toBe('first');
        await act(async () => key('j'));
        expect(state?.focus?.id).toBe('next');
        await act(async () => key('Enter'));
        expect(opened).toEqual(['/session/next?serverId=home-a']);
        expect(read).toEqual([]);
        await act(async () => { key('k', { target: { tagName: 'TEXTAREA' } }); key('k', { isComposing: true }); });
        expect(state?.focus?.id).toBe('next');
        const removeModal = registerEscapeLayer({ priority: ESCAPE_LAYER_PRIORITIES.modal, onEscape: () => {} });
        try {
            await act(async () => { key('k'); key('Escape'); });
            expect(state?.focus?.id).toBe('next');
        } finally { removeModal(); }
        await act(async () => key('Escape'));
        expect(state?.focus).toBeNull();
    });

    it('keeps a resolved detail selected until the person moves on; informational opens read only the selected row', async () => {
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Probe /></KeyboardShortcutProvider>);
        await act(async () => key('ArrowDown'));
        await act(async () => {
            state!.setSelectedResolved(true);
            state!.setItems(items => items.map(row => row.key === 'first' ? { ...row, type: 'update', view: 'updates' } : row));
        });
        expect(state?.focus?.id).toBe('first');
        await act(async () => key('j'));
        expect(state?.focus?.id).toBe('next');
        expect(read).toEqual([]);
        await act(async () => { state!.setView('updates'); state!.setFocus(initialItems[2]!.focus); });
        expect(read).toEqual(['update']);
        await act(async () => state!.setItems(items => items.filter(row => row.key !== 'update')));
        expect(state?.focus?.id).toBe('update');
        await act(async () => { state!.setView('mentions'); state!.setFocus(initialItems[3]!.focus); });
        expect(read).toEqual(['update', 'mention']);
        await act(async () => state!.setItems(items => items.filter(row => row.key !== 'mention')));
        expect(state?.focus?.id).toBe('mention');
    });

    it('keeps the selected request through hydration gaps and a confirmed answer until Next item', async () => {
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Probe /></KeyboardShortcutProvider>);
        await act(async () => key('ArrowDown'));
        await act(async () => state!.setItems(items => items.filter(row => row.key !== 'first')));
        expect(state?.focus?.id).toBe('first');
        await act(async () => state!.setItems(initialItems));
        expect(state?.focus?.id).toBe('first');
        await act(async () => state!.setItems(items => items.filter(row => row.key !== 'first')));
        expect(state?.focus?.id).toBe('first');
        await act(async () => state!.setSelectedResolved(true));
        expect(state?.focus?.id).toBe('first');
        await act(async () => key('j'));
        expect(state?.focus?.id).toBe('next');
        expect(read).toEqual([]);
    });

    it('consumes an answered selection with no survivor instead of opening a later arrival', async () => {
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Probe /></KeyboardShortcutProvider>);
        await act(async () => key('ArrowDown'));
        await act(async () => { state!.setItems([]); state!.setSelectedResolved(true); });
        expect(state?.focus?.id).toBe('first');
        await act(async () => state!.setItems([initialItems[1]!]));
        expect(state?.focus?.id).toBe('first');
    });
    it('finds the selected row without deriving a route per Inbox row on every render', async () => {
        const { createInboxItemRoute } = await import('@/components/inbox/inboxItemFocus');
        const routes = vi.mocked(createInboxItemRoute);
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Probe /></KeyboardShortcutProvider>);
        const many: readonly InboxItem[] = Array.from({ length: 200 }, (_, index) => ({ ...initialItems[0]!, key: `row-${index}`,
            title: `row-${index}`, source: { kind: 'session', serverId: 'home-a', id: `row-${index}` },
            focus: { kind: 'session', serverId: 'home-a', id: `row-${index}` } }));
        await act(async () => state!.setItems(many));
        routes.mockClear();
        // Renders with nothing selected never derive a route.
        for (const resolved of [true, false, true]) await act(async () => state!.setSelectedResolved(resolved));
        const unselected = routes.mock.calls.length;
        await act(async () => state!.setFocus({ kind: 'session', serverId: 'home-a', id: 'row-150' }));
        routes.mockClear();
        // A selection is found once per Inbox change: a re-render derives only the selection's own key, never one per row.
        for (const resolved of [false, true, false]) await act(async () => state!.setSelectedResolved(resolved));
        expect(unselected).toBe(0);
        expect(routes.mock.calls.length).toBeLessThanOrEqual(3 * 3);
        await act(async () => key('ArrowDown'));
        expect(state?.focus?.id).toBe('row-151');
    });
});
