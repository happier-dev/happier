import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
    invokeTestInstanceHandler,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import type { TranscriptNavigationEntry } from './transcriptNavigationTypes';
import {
    PaneHeaderSlotProvider,
    PaneHeaderSlotScope,
    usePublishedPaneHeaderContent,
} from '@/components/appShell/panes/paneHeaderSlot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

installNavigationCommonModuleMocks({
    // The real typography owner: the panel's states render the shared state composition, whose graph
    // reads the full Typography module (weights, mono), not a two-function stub.
    typography: async () => vi.importActual('@/constants/Typography'),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            FlatList: ({ data, renderItem, keyExtractor, ListFooterComponent, ...props }: any) => React.createElement(
                'FlatList',
                { ...props, data },
                (data ?? []).map((item: any, index: number) => React.createElement(
                    React.Fragment,
                    { key: keyExtractor ? keyExtractor(item, index) : String(index) },
                    renderItem?.({ item, index }),
                )),
                typeof ListFooterComponent === 'function' ? React.createElement(ListFooterComponent) : ListFooterComponent,
            ),
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            ScrollView: ({ children, ...props }: any) => React.createElement('ScrollView', props, children),
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => (
                typeof params?.label === 'string'
                    ? `${key}:${params.label}`
                    : typeof params?.count === 'number' ? `${key.split('.').pop()}:${params.count}` : key
            ),
        });
    },
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

// Resolve after the shared boundary options are configured, before timed interactions.
await import('./TranscriptNavigationPanel');

function entry(overrides: Partial<TranscriptNavigationEntry> & Pick<TranscriptNavigationEntry, 'id' | 'kind' | 'seq' | 'promptPreview'>): TranscriptNavigationEntry {
    const pinned = overrides.pinned ?? overrides.kind.startsWith('pinned-');
    return {
        id: overrides.id,
        sessionId: 's1',
        seq: overrides.seq,
        routeMessageId: overrides.routeMessageId ?? `server:${overrides.id}`,
        transcriptBlockIndex: overrides.transcriptBlockIndex ?? null,
        kind: overrides.kind,
        role: overrides.role ?? (overrides.kind === 'pinned-assistant' ? 'assistant' : overrides.kind === 'pinned-tool' ? 'tool' : 'user'),
        label: overrides.label ?? overrides.promptPreview ?? 'Entry',
        promptPreview: overrides.promptPreview,
        responsePreview: overrides.responsePreview ?? null,
        createdAtMs: overrides.createdAtMs ?? Number(overrides.seq ?? 0) * 100,
        pinned,
        pinnedAtMs: overrides.pinnedAtMs ?? (pinned ? 1000 : null),
        loaded: overrides.loaded ?? true,
        facts: overrides.facts,
    };
}

const ENTRIES: readonly TranscriptNavigationEntry[] = [
    entry({
        id: 'turn-1',
        kind: 'user-turn',
        seq: 1,
        promptPreview: 'Set up the project',
        responsePreview: 'Project is ready',
        pinned: false,
        pinnedAtMs: null,
    }),
    entry({
        id: 'answer-1',
        kind: 'pinned-assistant',
        seq: 1,
        promptPreview: 'Set up the project',
        responsePreview: 'Important answer',
    }),
];

/** The pane header a real host draws: the published live line and trailing action, read from the slot. */
function PublishedHeader() {
    const content = usePublishedPaneHeaderContent('navigation');
    const line = content?.line?.segments.map((segment) => (typeof segment === 'string' ? segment : segment.text)).join(' · ') ?? '';
    return React.createElement('View', { testID: 'pane-header' }, React.createElement('Text', { testID: 'pane-header-line' }, line), content?.action ?? null);
}

function inPaneHeaderHost(panel: React.ReactElement): React.ReactElement {
    return (
        <PaneHeaderSlotProvider>
            <PublishedHeader />
            <PaneHeaderSlotScope slotKey="navigation">{panel}</PaneHeaderSlotScope>
        </PaneHeaderSlotProvider>
    );
}

describe('TranscriptNavigationPanel', () => {
    it('uses the enclosing pane chrome without a second title or close control', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={ENTRIES}
                activeEntryId={null}
                onEntryPress={() => {}}
                onRequestClose={() => {}}
                testIDPrefix="nav"
            />,
        );
        expect(screen.findByTestId('nav-close')).toBeNull();
        expect(screen.getTextContent()).not.toContain('session.transcriptNavigation.title');
        // The count lives in the pane header's line now, not in a body strip.
        expect(screen.getTextContent()).not.toContain('entryCount');
        expect(screen.getTextContent()).not.toContain('turnCount');
        // The filters are one row in the body, under the header (lab NA).
        expect(screen.findByTestId('nav-filter:all')).toBeTruthy();
    });

    it('publishes "N turns · K waiting for you" to the one pane header, with no trailing action', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const turns = [
            ENTRIES[0]!,
            entry({ id: 'turn-2', kind: 'user-turn', seq: 2, promptPreview: 'Second', pinned: true, pinnedAtMs: 5 }),
            ENTRIES[1]!,
            entry({
                id: 'turn-3',
                kind: 'user-turn',
                seq: 3,
                promptPreview: 'Push it',
                facts: { toolCount: 1, failedCount: 0, approvals: [{ outcome: 'pending', label: 'git push' }], running: true, lastToolFailed: false, endedAtMs: null },
            }),
        ];
        const screen = await renderScreen(inPaneHeaderHost(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={turns}
                activeEntryId={null}
                onEntryPress={() => {}}
                testIDPrefix="nav"
            />,
        ));

        // Three user turns, one of them waiting for an approval.
        expect(screen.findByTestId('pane-header-line')).toBeTruthy();
        expect(screen.getTextContent()).toContain('turnCount:3 · waitingCount:1');
        const header = screen.findByTestId('pane-header');
        expect(header?.findAll((node) => typeof node.props.testID === 'string' && node.props.testID.startsWith('nav-filter')).length).toBe(0);
    });

    it('offers Approvals and Errors only when a turn has them, and says when history is partial', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const quiet = await renderScreen(
            <TranscriptNavigationPanel sessionId="s1" entries={ENTRIES} activeEntryId={null} onEntryPress={() => {}} testIDPrefix="nav" />,
        );
        expect(quiet.findByTestId('nav-filter:approvals')).toBeNull();
        expect(quiet.findByTestId('nav-filter:errors')).toBeNull();

        standardCleanup();
        const onLoadEarlier = vi.fn();
        const failed = entry({
            id: 'turn-9',
            kind: 'user-turn',
            seq: 9,
            promptPreview: 'Build the phone app',
            facts: { toolCount: 3, failedCount: 1, approvals: [], running: false, lastToolFailed: true, endedAtMs: null },
        });
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={[...ENTRIES, failed]}
                activeEntryId={null}
                historyComplete={false}
                onLoadEarlier={onLoadEarlier}
                onEntryPress={() => {}}
                testIDPrefix="nav"
            />,
        );
        expect(screen.findByTestId('nav-filter:approvals')).toBeNull();
        await screen.pressByTestIdAsync('nav-filter:errors');
        expect(screen.findByTestId('nav-entry:turn-9')).toBeTruthy();
        expect(screen.findByTestId('nav-entry:turn-1')).toBeNull();
        expect(screen.findByTestId('nav-partial')).toBeTruthy();
        expect(screen.getTextContent()).toContain('session.transcriptNavigation.loadEarlierTurns');
    });

    it('switches between All and Pinned with the filter row', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const screen = await renderScreen(inPaneHeaderHost(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={ENTRIES}
                activeEntryId={null}
                onEntryPress={() => {}}
                testIDPrefix="nav"
            />,
        ));

        expect(screen.findByTestId('nav-entry:turn-1')).toBeTruthy();
        expect(screen.findByTestId('nav-entry:answer-1')).toBeTruthy();

        await screen.pressByTestIdAsync('nav-filter:pinned');

        expect(screen.findByTestId('nav-entry:turn-1')).toBeNull();
        expect(screen.findByTestId('nav-entry:answer-1')).toBeTruthy();

        await screen.pressByTestIdAsync('nav-filter:all');
        expect(screen.findByTestId('nav-entry:turn-1')).toBeTruthy();
        expect(screen.findByTestId('nav-entry:answer-1')).toBeTruthy();
    });

    it('shows a loading state while the session transcript has not produced a first page, not the empty state', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={[]}
                activeEntryId={null}
                onEntryPress={() => {}}
                isLoading
                testIDPrefix="nav"
            />,
        );

        expect(screen.findByTestId('nav-loading')).toBeTruthy();
        expect(screen.findByTestId('nav-empty')).toBeNull();
        expect(screen.getTextContent()).toContain('session.transcriptNavigation.loadingBody');
    });

    it('keeps showing loaded entries while a background refresh reports loading', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={ENTRIES}
                activeEntryId={null}
                onEntryPress={() => {}}
                isLoading
                testIDPrefix="nav"
            />,
        );

        expect(screen.findByTestId('nav-loading')).toBeNull();
        expect(screen.findByTestId('nav-entry:turn-1')).toBeTruthy();
    });

    it('invites pinning when nothing is pinned and offers the way back to every turn', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const screen = await renderScreen(inPaneHeaderHost(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={[
                    entry({
                        id: 'turn-1',
                        kind: 'user-turn',
                        seq: 1,
                        promptPreview: 'Only prompt',
                        pinned: false,
                        pinnedAtMs: null,
                    }),
                ]}
                activeEntryId={null}
                onEntryPress={() => {}}
                testIDPrefix="nav"
            />,
        ));

        await screen.pressByTestIdAsync('nav-filter:pinned');

        expect(screen.findByTestId('nav-empty-pinned')).toBeTruthy();
        expect(screen.findByTestId('nav-entry:turn-1')).toBeNull();
        expect(screen.getTextContent()).toContain('session.transcriptNavigation.emptyPinnedTitle');

        // The one next step is back to every turn, not a dead end.
        await screen.pressByTestIdAsync('nav-empty-pinned-secondary-action');
        expect(screen.findByTestId('nav-empty-pinned')).toBeNull();
        expect(screen.findByTestId('nav-entry:turn-1')).toBeTruthy();
    });

    it('calls the entry click callback with the selected entry', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const onEntryPress = vi.fn();
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={ENTRIES}
                activeEntryId={null}
                onEntryPress={onEntryPress}
                testIDPrefix="nav"
            />,
        );

        await screen.pressByTestIdAsync('nav-entry:answer-1');

        expect(onEntryPress).toHaveBeenCalledTimes(1);
        expect(onEntryPress).toHaveBeenCalledWith(ENTRIES[1]);
    });

    it('renders localized fallback text for unloaded pinned entries without derivation labels', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const fallbackEntry = {
            ...entry({
                id: 'answer-unloaded',
                kind: 'pinned-assistant',
                seq: 4,
                promptPreview: null,
                responsePreview: null,
                label: '',
                loaded: false,
            }),
            fallbackLabelKind: 'pinned-assistant' as const,
        };
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={[fallbackEntry]}
                activeEntryId={null}
                onEntryPress={() => {}}
                testIDPrefix="nav"
            />,
        );

        expect(screen.getTextContent()).toContain('session.transcriptNavigation.fallbackPinnedAssistant');
        expect(screen.findByTestId('nav-entry:answer-unloaded')?.props.accessibilityLabel).toContain(
            'session.transcriptNavigation.fallbackPinnedAssistant',
        );
    });

    it('supports basic keyboard movement and activation when the harness exposes key handlers', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const onEntryPress = vi.fn();
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={ENTRIES}
                activeEntryId={null}
                onEntryPress={onEntryPress}
                testIDPrefix="nav"
            />,
        );

        const preventDefault = vi.fn();
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('nav-entry-list'), 'onKeyDown', {
                nativeEvent: { key: 'ArrowDown' },
                preventDefault,
            });
        });
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('nav-entry-list'), 'onKeyDown', {
                nativeEvent: { key: 'Enter' },
                preventDefault,
            });
        });

        expect(preventDefault).toHaveBeenCalled();
        expect(onEntryPress).toHaveBeenCalledTimes(1);
        // Newest first: ArrowDown from the top reaches the older user turn.
        expect(onEntryPress).toHaveBeenCalledWith(ENTRIES[0]);
    });

    it('closes on Escape when the panel provides a close request handler', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const onRequestClose = vi.fn();
        const preventDefault = vi.fn();
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={ENTRIES}
                activeEntryId={null}
                onEntryPress={() => {}}
                onRequestClose={onRequestClose}
                testIDPrefix="nav"
            />,
        );

        invokeTestInstanceHandler(screen.findByTestId('nav-entry-list'), 'onKeyDown', {
            nativeEvent: { key: 'Escape' },
            preventDefault,
        });

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });

    it('ignores Escape when no close request handler is provided', async () => {
        standardCleanup();
        const { TranscriptNavigationPanel } = await import('./TranscriptNavigationPanel');
        const preventDefault = vi.fn();
        const onEntryPress = vi.fn();
        const screen = await renderScreen(
            <TranscriptNavigationPanel
                sessionId="s1"
                entries={ENTRIES}
                activeEntryId={null}
                onEntryPress={onEntryPress}
                testIDPrefix="nav"
            />,
        );

        invokeTestInstanceHandler(screen.findByTestId('nav-entry-list'), 'onKeyDown', {
            nativeEvent: { key: 'Escape' },
            preventDefault,
        });

        expect(preventDefault).not.toHaveBeenCalled();
        expect(onEntryPress).not.toHaveBeenCalled();
    });
});
