import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import type { TranscriptNavigationEntry, TranscriptNavigationTurnFacts } from './transcriptNavigationTypes';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const motionPreference = vi.hoisted(() => ({ reduced: false }));
const startedAnimations = vi.hoisted(() => ({ count: 0 }));

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const base = await createReactNativeWebMock({});
        return createReactNativeWebMock({
            FlatList: ({ data, renderItem, keyExtractor, ...rest }: any) => React.createElement(
                'FlatList',
                { ...rest, data },
                (data ?? []).map((item: any, index: number) => React.createElement(
                    React.Fragment,
                    { key: keyExtractor ? keyExtractor(item, index) : String(index) },
                    renderItem?.({ item, index }),
                )),
            ),
            Animated: {
                ...base.Animated,
                timing: (value: any, config: any) => {
                    const animation = (base.Animated as any).timing(value, config);
                    return {
                        ...animation,
                        start: (cb?: any) => {
                            startedAnimations.count += 1;
                            animation.start(cb);
                        },
                    };
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => motionPreference.reduced,
}));

// Resolve the real graph after boundary options are installed, during suite collection.
const { TranscriptNavigationEntryList } = await import('./TranscriptNavigationEntryList');

function entry(overrides: Partial<TranscriptNavigationEntry> & Pick<TranscriptNavigationEntry, 'id' | 'seq'>): TranscriptNavigationEntry {
    return {
        id: overrides.id,
        sessionId: 's1',
        seq: overrides.seq,
        routeMessageId: overrides.routeMessageId ?? `server:${overrides.id}`,
        transcriptBlockIndex: null,
        kind: overrides.kind ?? 'user-turn',
        role: overrides.role ?? 'user',
        label: overrides.label ?? `Prompt ${overrides.id}`,
        promptPreview: overrides.promptPreview ?? `Prompt ${overrides.id}`,
        responsePreview: overrides.responsePreview ?? null,
        createdAtMs: overrides.createdAtMs ?? null,
        pinned: overrides.pinned ?? false,
        pinnedAtMs: overrides.pinnedAtMs ?? null,
        loaded: overrides.loaded ?? true,
        facts: overrides.facts,
    };
}

function facts(overrides: Partial<TranscriptNavigationTurnFacts> = {}): TranscriptNavigationTurnFacts {
    return { toolCount: 0, failedCount: 0, approvals: [], running: false, endedAtMs: null, lastToolFailed: false, ...overrides };
}

async function renderTimeline(params: Readonly<{
    entries: readonly TranscriptNavigationEntry[];
    activeEntryId?: string | null;
    visibleEntryIds?: readonly string[];
    newestTurn?: 'working' | 'waiting' | null;
}>) {
    return renderScreen(
        <TranscriptNavigationEntryList
            entries={params.entries}
            activeEntryId={params.activeEntryId ?? null}
            visibleEntryIds={params.visibleEntryIds}
            newestTurn={params.newestTurn ?? null}
            onEntryPress={() => {}}
            testIDPrefix="nav"
        />,
    );
}

function atLocal(year: number, month: number, day: number, hour: number): number {
    return new Date(year, month - 1, day, hour, 0, 0, 0).getTime();
}

describe('TranscriptNavigationEntryList timeline', () => {
    it('keeps the newest waiting turn present with now and an elapsed counter until it ends', async () => {
        standardCleanup();
        const screen = await renderTimeline({
            entries: [entry({ id: 'waiting', seq: 1, createdAtMs: Date.now() - 134_000, facts: facts({ approvals: [{ outcome: 'pending', label: 'yarn test' }] }) })],
            newestTurn: 'waiting',
        });
        expect(screen.getTextContent()).toContain('session.transcriptNavigation.now');
        expect(screen.getTextContent()).toMatch(/2:1[4-9]/);
        standardCleanup();
        const ended = await renderTimeline({
            entries: [entry({ id: 'waiting', seq: 1, createdAtMs: Date.now() - 134_000, facts: facts({ approvals: [{ outcome: 'pending', label: 'yarn test' }], endedAtMs: Date.now() - 1_000 }) })],
        });
        expect(ended.getTextContent()).not.toContain('session.transcriptNavigation.now');
        expect(ended.getTextContent()).not.toMatch(/2:1[4-9]/);
    });
    it('marks the reader position, pinned turns, and plain turns with distinct rail nodes', async () => {
        standardCleanup();
        const screen = await renderTimeline({
            entries: [
                entry({ id: 'turn-1', seq: 1 }),
                entry({ id: 'turn-2', seq: 2, pinned: true, pinnedAtMs: 10 }),
                entry({ id: 'turn-3', seq: 3 }),
            ],
            activeEntryId: 'turn-3',
        });

        expect(screen.findByTestId('nav-node-plain:turn-1')).toBeTruthy();
        expect(screen.findByTestId('nav-node-pinned:turn-2')).toBeTruthy();
        expect(screen.findByTestId('nav-node-current:turn-3')).toBeTruthy();
        // The current position wins over the pin marker so the reader keeps one "you are here".
        expect(screen.findByTestId('nav-node-pinned:turn-3')).toBeNull();
    });

    it('announces the current row as selected and labels every row as one button', async () => {
        standardCleanup();
        const screen = await renderTimeline({
            entries: [entry({ id: 'turn-1', seq: 1 }), entry({ id: 'turn-2', seq: 2 })],
            activeEntryId: 'turn-2',
        });

        const first = screen.findByTestId('nav-entry:turn-1');
        const second = screen.findByTestId('nav-entry:turn-2');
        expect(first?.props.accessibilityRole).toBe('button');
        expect(typeof first?.props.accessibilityLabel).toBe('string');
        expect(first?.props.accessibilityLabel.length).toBeGreaterThan(0);
        expect(first?.props.accessibilityState).toEqual({ selected: false });
        expect(second?.props.accessibilityState).toEqual({ selected: true });
    });

    it('hides the timeline decoration from assistive technology', async () => {
        standardCleanup();
        const screen = await renderTimeline({ entries: [entry({ id: 'turn-1', seq: 1 })] });

        expect(screen.findByTestId('nav-node-plain:turn-1')).toBeTruthy();
        const rail = screen.tree.root.findAll((instance) => (
            instance.props?.accessibilityElementsHidden === true
            && instance.props?.importantForAccessibility === 'no-hide-descendants'
        ));
        expect(rail.length).toBeGreaterThan(0);
    });

    it('lists the newest turn first under a dated day header, even within one day', async () => {
        standardCleanup();
        const screen = await renderTimeline({
            entries: [
                entry({ id: 'turn-1', seq: 1, createdAtMs: atLocal(2026, 7, 27, 9) }),
                entry({ id: 'turn-2', seq: 2, createdAtMs: atLocal(2026, 7, 27, 17) }),
            ],
        });
        expect(screen.findByTestId(`nav-day:${atLocal(2026, 7, 27, 0)}`)).toBeTruthy();
        const order = screen.tree.root
            .findAll((instance) => typeof instance.props?.testID === 'string' && instance.props.testID.startsWith('nav-entry:'))
            .map((instance) => instance.props.testID);
        expect(order.filter((id, index) => order.indexOf(id) === index)).toEqual(['nav-entry:turn-2', 'nav-entry:turn-1']);
    });

    it('marks what the turns did: live, waiting for you, ended in failure', async () => {
        standardCleanup();
        const live = await renderTimeline({
            entries: [entry({ id: 'turn-1', seq: 1, facts: facts() }), entry({ id: 'turn-2', seq: 2, facts: facts({ running: true }) })],
            newestTurn: 'working',
        });
        expect(live.findByTestId('nav-node-live:turn-2')).toBeTruthy();
        expect(live.findByTestId('nav-node-live:turn-1')).toBeNull();

        standardCleanup();
        const typed = await renderTimeline({
            entries: [
                entry({ id: 'turn-1', seq: 1, facts: facts({ toolCount: 3, failedCount: 1, lastToolFailed: true }) }),
                entry({ id: 'turn-2', seq: 2, facts: facts({ toolCount: 1, approvals: [{ outcome: 'pending', label: 'git push' }] }) }),
            ],
        });
        expect(typed.findByTestId('nav-node-failed:turn-1')).toBeTruthy();
        expect(typed.findByTestId('nav-node-waiting:turn-2')).toBeTruthy();
    });

    it('shows what happened in between only when it is known, never as zero', async () => {
        standardCleanup();
        const screen = await renderTimeline({
            entries: [
                entry({ id: 'known', seq: 1, facts: facts({ toolCount: 6, failedCount: 1, approvals: [{ outcome: 'allowed', label: 'yarn test' }] }) }),
                entry({ id: 'quiet', seq: 2, facts: facts() }),
                entry({ id: 'unknown', seq: 3, loaded: false }),
            ],
        });
        expect(screen.findByTestId('nav-entry-facts:known')).toBeTruthy();
        expect(screen.findHostByTestId('nav-entry-facts:quiet')).toBeNull();
        expect(screen.findByTestId('nav-entry-facts:unknown')).toBeNull();
        const text = screen.getTextContent();
        expect(text).toContain('session.transcriptNavigation.toolCount');
        expect(text).toContain('session.transcriptNavigation.failedCount');
    });

    it('bands the turns that are on screen, following the transcript', async () => {
        standardCleanup();
        const screen = await renderTimeline({
            entries: [entry({ id: 'turn-1', seq: 1 }), entry({ id: 'turn-2', seq: 2 }), entry({ id: 'turn-3', seq: 3 })],
            activeEntryId: 'turn-2',
            visibleEntryIds: ['turn-2', 'turn-3'],
        });
        expect(screen.findByTestId('nav-inview:turn-2')).toBeTruthy();
        expect(screen.findByTestId('nav-inview:turn-3')).toBeTruthy();
        expect(screen.findByTestId('nav-inview:turn-1')).toBeNull();
    });

    it('distinguishes a turn still waiting for its reply from one whose reply is not loaded', async () => {
        standardCleanup();
        const screen = await renderTimeline({
            entries: [
                entry({ id: 'turn-1', seq: 1, loaded: false, responsePreview: null }),
                entry({ id: 'turn-2', seq: 2, responsePreview: 'Done' }),
                entry({ id: 'turn-3', seq: 3, responsePreview: null }),
            ],
        });

        expect(screen.findByTestId('nav-entry-pending-reply:turn-1')).toBeTruthy();
        expect(screen.findByTestId('nav-entry-pending-reply:turn-2')).toBeNull();
        expect(screen.findByTestId('nav-entry-pending-reply:turn-3')).toBeTruthy();

        const text = screen.getTextContent();
        expect(text).toContain('session.transcriptNavigation.replyNotLoaded');
        expect(text).toContain('session.transcriptNavigation.awaitingReply');
    });

    it('renders rows through a virtualized list rather than mounting every entry in a scroll view', async () => {
        standardCleanup();
        const screen = await renderTimeline({
            entries: [entry({ id: 'turn-1', seq: 1 }), entry({ id: 'turn-2', seq: 2 })],
        });

        const list = screen.tree.root.findAllByType('FlatList' as never);
        expect(list).toHaveLength(1);
        expect(list[0]?.props.data).toHaveLength(2);
    });

    it('drops the staggered entrance under a reduced-motion preference', async () => {
        standardCleanup();
        motionPreference.reduced = false;
        startedAnimations.count = 0;
        await renderTimeline({
            entries: [entry({ id: 'turn-1', seq: 1 }), entry({ id: 'turn-2', seq: 2 })],
        });
        expect(startedAnimations.count).toBeGreaterThan(0);

        standardCleanup();
        motionPreference.reduced = true;
        startedAnimations.count = 0;
        await renderTimeline({
            entries: [entry({ id: 'turn-1', seq: 1 }), entry({ id: 'turn-2', seq: 2 })],
        });
        expect(startedAnimations.count).toBe(0);
    });
});
