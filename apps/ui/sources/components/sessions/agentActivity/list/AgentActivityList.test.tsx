import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    makeAgentActivityRosterFixture,
    makeAgentActivityRowEntryFixture,
    renderScreen,
} from '@/dev/testkit';

import { Text } from '@/components/ui/text/Text';

import type { AgentActivityRowEntry } from '../agentActivityRowEntry';
// Imported statically: `vi.mock` is hoisted above it, and pulling the list's module graph in at
// collection time keeps a heavily-loaded machine's transform cost out of each test's own budget.
import { AgentActivityList } from './AgentActivityList';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

/**
 * A pass-through counter on the row's own title resolver.
 *
 * The row calls it exactly once per render, so the call count is the number of row renders — the
 * only way to observe the memo boundary, which no public API exposes. The real implementation still
 * runs, so nothing rendered changes.
 */
const rowRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('../presentation/resolveAgentActivityTitle', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../presentation/resolveAgentActivityTitle')>();
    return {
        ...actual,
        resolveAgentActivityTitle: (entry: AgentActivityRowEntry) => {
            rowRenders.count += 1;
            return actual.resolveAgentActivityTitle(entry);
        },
    };
});

const T0 = Date.parse('2026-05-12T00:00:00.000Z');

function entry(
    overrides: Partial<AgentActivityRowEntry> & Pick<AgentActivityRowEntry, 'id'>,
): AgentActivityRowEntry {
    // The list's tests care about a running clock far more than the model's do, so the shared
    // builder is given a default start time here rather than in the testkit.
    //
    // `canOpen` defaults to true HERE and nowhere shared: the list offers `onPress` only to an
    // entry that resolved a target, so a fixture that wants to be pressed has to say so. The
    // fail-closed default is exercised by its own case below.
    return makeAgentActivityRowEntryFixture({ startedAtMs: T0, canOpen: true, ...overrides });
}

async function advance(ms: number) {
    await act(async () => {
        vi.advanceTimersByTime(ms);
    });
}

/** Every node carrying `Item`'s prop vocabulary — one per rendered agent row. */
function rowTitles(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return screen.tree.root
        .findAll((node) => {
            const props = node.props as Record<string, unknown> | undefined;
            return props != null
                && 'showChevron' in props
                && 'iconBoxSize' in props
                && 'subtitleLines' in props;
        })
        .map((node) => String((node.props as { title?: unknown }).title));
}

describe('AgentActivityList', () => {
    beforeEach(() => {
        rowRenders.count = 0;
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T0 + 42_000));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps a permission-blocked row among the working rows, under named section headers', async () => {
        const screen = await renderScreen(
            <AgentActivityList
                testID="roster"
                entries={[
                    entry({ id: 'live', title: 'Sweeping the corridor', status: 'running' }),
                    entry({ id: 'done', title: 'Wrote the report', status: 'succeeded', endedAtMs: T0 + 5_000 }),
                    entry({ id: 'needs', title: 'Awaiting approval', status: 'waiting' }),
                ]}
            />,
        );

        // r4.0: two sections, and neither is an attention claim. A permission-blocked agent is
        // still in flight, so it sits in WORKING ordered by start like every other live row — it is
        // its glyph and status word that say it is blocked, not a header above it.
        expect(rowTitles(screen)).toEqual(['Sweeping the corridor', 'Awaiting approval', 'Wrote the report']);
        const text = screen.getTextContent();
        expect(text).not.toContain('Needs you');
        expect(text).toContain('Working');
        expect(text).toContain('Finished');

        await screen.unmount();
    });

    it('omits a section header entirely when that section is empty', async () => {
        const screen = await renderScreen(
            <AgentActivityList testID="roster" entries={[entry({ id: 'live', status: 'running' })]} />,
        );

        const text = screen.getTextContent();
        expect(text).toContain('Working');
        expect(text).not.toContain('Needs you');
        expect(text).not.toContain('Finished');

        await screen.unmount();
    });

    it('opens a row by id through one callback per list, never a closure per row', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <AgentActivityList
                testID="roster"
                entries={[entry({ id: 'alpha' }), entry({ id: 'beta', startedAtMs: T0 + 1 })]}
                onPress={onPress}
            />,
        );

        screen.pressByTestId('roster:row:beta');
        expect(onPress).toHaveBeenCalledWith('beta');

        await screen.unmount();
    });

    /**
     * A9, at the largest target on the row. The pane handed `onPress` to every row and resolved the
     * target inside the handler, so a headline-only entry — no local subagent, no route, nothing to
     * open — still carried a ripple, a pressed overlay and `role="button"` over a function that
     * returned silently. The list now offers the press only where a target was established.
     */
    it('withholds the press from an entry that resolved no target, even when the host supplied one', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <AgentActivityList
                testID="roster"
                entries={[
                    entry({ id: 'openable' }),
                    makeAgentActivityRowEntryFixture({ id: 'headline-only', startedAtMs: T0 + 1 }),
                ]}
                onPress={onPress}
            />,
        );

        const deadRow = screen.findByTestId('roster:row:headline-only');
        expect(deadRow).not.toBeNull();
        expect((deadRow!.props as { onPress?: unknown }).onPress).toBeUndefined();
        expect((deadRow!.props as { accessibilityRole?: unknown }).accessibilityRole).not.toBe('button');

        // The row beside it is unaffected: the gate is per entry, not a surface-wide switch.
        screen.pressByTestId('roster:row:openable');
        expect(onPress).toHaveBeenCalledWith('openable');

        await screen.unmount();
    });

    it('renders zero rows again when the clock ticks and when the array is rebuilt (INV-4)', async () => {
        const onPress = vi.fn();
        const entries = [
            entry({ id: 'a' }),
            entry({ id: 'b', startedAtMs: T0 + 1 }),
            entry({ id: 'c', startedAtMs: T0 + 2 }),
        ];
        const screen = await renderScreen(
            <AgentActivityList testID="roster" entries={entries} onPress={onPress} />,
        );

        expect(rowRenders.count).toBe(3);
        expect(screen.getTextContent()).toContain('0:42');

        rowRenders.count = 0;
        await advance(3_000);
        // The clock lives in the leaf time slot, below the memo boundary.
        expect(screen.getTextContent()).toContain('0:45');
        expect(rowRenders.count).toBe(0);

        // A fresh array holding the SAME entry objects is what a derivation produces on every
        // recompute. Inline `onPress={() => onPress(entry.id)}` closures would defeat the memo here.
        await screen.update(
            <AgentActivityList testID="roster" entries={[...entries]} onPress={onPress} />,
        );
        expect(rowRenders.count).toBe(0);

        await screen.unmount();
    });

    it('offers a warm first-run empty state with the launch affordance', async () => {
        const onLaunch = vi.fn();
        const screen = await renderScreen(
            <AgentActivityList testID="roster" entries={[]} onLaunch={onLaunch} />,
        );

        expect(screen.getTextContent()).toContain('Your agents will show up here');
        screen.pressByTestId('roster:empty:launch');
        expect(onLaunch).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('says one quiet line when a session simply has nothing running now', async () => {
        const screen = await renderScreen(
            <AgentActivityList testID="roster" entries={[]} emptyVariant="idle" onLaunch={() => {}} />,
        );

        const text = screen.getTextContent();
        expect(text).toContain('No agents running right now');
        // The orienting copy and its illustration belong to first use only; repeating them every
        // time a session goes quiet turns warmth into noise.
        expect(text).not.toContain('Your agents will show up here');
        expect(screen.findByTestId('roster:empty:launch')).toBeNull();

        await screen.unmount();
    });

    it('derives the skeleton count from the headline and caps it at four', async () => {
        const many = await renderScreen(
            <AgentActivityList testID="roster" entries={[]} freshness={{ kind: 'hydrating', expectedCount: 9 }} />,
        );
        expect(many.findAllByTestId('roster:skeleton:row')).toHaveLength(4);
        await many.unmount();

        const few = await renderScreen(
            <AgentActivityList testID="roster" entries={[]} freshness={{ kind: 'hydrating', expectedCount: 2 }} />,
        );
        expect(few.findAllByTestId('roster:skeleton:row')).toHaveLength(2);
        await few.unmount();
    });

    it('invents neither a skeleton count nor an empty state when the headline has not arrived', async () => {
        const screen = await renderScreen(
            <AgentActivityList testID="roster" entries={[]} freshness={{ kind: 'hydrating', expectedCount: null }} />,
        );

        expect(screen.findAllByTestId('roster:skeleton:row')).toHaveLength(0);
        // "No agents" is a claim, and hydration has not earned it yet.
        expect(screen.getTextContent()).not.toContain('Your agents will show up here');
        expect(screen.getTextContent()).not.toContain('No agents running right now');

        await screen.unmount();
    });

    it('never replaces hydrated rows with a skeleton while refreshing', async () => {
        const screen = await renderScreen(
            <AgentActivityList
                testID="roster"
                entries={[entry({ id: 'live', title: 'Sweeping the corridor' })]}
                freshness={{ kind: 'hydrating', expectedCount: 6 }}
            />,
        );

        expect(screen.getTextContent()).toContain('Sweeping the corridor');
        expect(screen.findAllByTestId('roster:skeleton:row')).toHaveLength(0);
        expect(screen.getTextContent()).toContain('Refreshing');

        await screen.unmount();
    });

    it('keeps the last known roster offline and says so, instead of claiming there is none', async () => {
        const withRows = await renderScreen(
            <AgentActivityList
                testID="roster"
                entries={[entry({ id: 'live', title: 'Sweeping the corridor' })]}
                freshness={{ kind: 'offline' }}
            />,
        );
        expect(withRows.getTextContent()).toContain('Sweeping the corridor');
        expect(withRows.getTextContent()).toContain('Offline');
        await withRows.unmount();

        const withoutRows = await renderScreen(
            <AgentActivityList testID="roster" entries={[]} freshness={{ kind: 'offline' }} onLaunch={() => {}} />,
        );
        // Unreachable is not empty.
        expect(withoutRows.getTextContent()).toContain('Offline');
        expect(withoutRows.getTextContent()).not.toContain('Your agents will show up here');
        await withoutRows.unmount();
    });

    it('caps the finished rows only when there is somewhere for "show all" to go', async () => {
        const entries = makeAgentActivityRosterFixture({
            count: 30,
            statuses: ['succeeded'],
            startedAtMs: T0,
            idPrefix: 'done',
        });
        const onShowAllFinished = vi.fn();

        const capped = await renderScreen(
            <AgentActivityList testID="roster" entries={entries} onShowAllFinished={onShowAllFinished} />,
        );
        expect(rowTitles(capped)).toHaveLength(24);
        capped.pressByTestId('roster:show-all:finished');
        expect(onShowAllFinished).toHaveBeenCalledTimes(1);
        expect(capped.getTextContent()).toContain('Show all 30');
        await capped.unmount();

        const uncapped = await renderScreen(<AgentActivityList testID="roster" entries={entries} />);
        // No route means the cap would strand 6 rows with no way to reach them.
        expect(rowTitles(uncapped)).toHaveLength(30);
        expect(uncapped.findByTestId('roster:show-all:finished')).toBeNull();
        await uncapped.unmount();
    });

    it('discloses a body in place for a row that has nowhere to navigate to', async () => {
        // A background command is a headless process: no transcript, no route. Its detail opens
        // under its own row rather than through a screen that does not exist, and every other row
        // keeps the host's navigation press.
        const onPress = vi.fn();
        const screen = await renderScreen(
            <AgentActivityList
                testID="roster"
                entries={[
                    entry({ id: 'agent', status: 'running' }),
                    // `canOpen: false` is what the roster actually derives for a background
                    // command — `resolveAgentActivityOpenTarget` returns no target for one — and
                    // stating it here is what makes this the "nowhere to navigate to" case rather
                    // than a shape the producer cannot emit.
                    entry({
                        id: 'background_task:task_1',
                        title: 'sleep 60',
                        status: 'running',
                        canOpen: false,
                    }),
                ]}
                onPress={onPress}
                renderEntryBody={(entryId) => (
                    entryId === 'background_task:task_1'
                        ? <Text testID="task-body">detail</Text>
                        : null
                )}
            />,
        );

        expect(screen.findByTestId('task-body')).toBeNull();
        const disclosureRow = screen.findByTestId('roster:row:background_task:task_1');
        expect(disclosureRow).not.toBeNull();
        await act(async () => {
            (disclosureRow!.props as { onPress?: () => void }).onPress?.();
        });
        expect(screen.findByTestId('task-body')).not.toBeNull();
        // The disclosure owns its own press; it must not also fire the host's navigation.
        expect(onPress).not.toHaveBeenCalled();

        const navigationRow = screen.findByTestId('roster:row:agent');
        await act(async () => {
            (navigationRow!.props as { onPress?: () => void }).onPress?.();
        });
        expect(onPress).toHaveBeenCalledWith('agent');

        await screen.unmount();
    });

    it('keeps the press meaning "open" on a row that can both open and disclose', async () => {
        // The W23 preview gave agent rows a body. A body must not spend the press a row already
        // had: opening stays one press, and the caret beside it is what discloses.
        const onPress = vi.fn();
        const screen = await renderScreen(
            <AgentActivityList
                testID="roster"
                entries={[entry({ id: 'agent', status: 'running', canOpen: true })]}
                onPress={onPress}
                renderEntryBody={() => <Text testID="agent-body">preview</Text>}
            />,
        );

        const row = screen.findByTestId('roster:row:agent');
        await act(async () => {
            (row!.props as { onPress?: () => void }).onPress?.();
        });
        expect(onPress).toHaveBeenCalledWith('agent');
        expect(screen.findByTestId('agent-body')).toBeNull();

        const caret = screen.findByTestId('roster:row:agent:disclosure');
        expect(caret).not.toBeNull();
        await act(async () => {
            (caret!.props as { onPress?: () => void }).onPress?.();
        });
        expect(screen.findByTestId('agent-body')).not.toBeNull();
        expect(onPress).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('keeps every header and row a sibling in one container, so a row can travel between sections', async () => {
        const screen = await renderScreen(
            <AgentActivityList
                testID="roster"
                entries={[
                    entry({ id: 'needs', status: 'waiting' }),
                    entry({ id: 'live', status: 'running' }),
                    entry({ id: 'done', status: 'succeeded', endedAtMs: T0 + 1 }),
                ]}
            />,
        );

        // Two headers plus three rows, all children of the list body — `waiting` is live work and
        // sits under WORKING, so there are two sections, not three. A per-section wrapper would
        // look identical and would remount a row that changes section, so it could never travel.
        const body = screen.findByTestId('roster:body');
        expect(body).not.toBeNull();
        expect(body!.props.children).toHaveLength(5);

        await screen.unmount();
    });
});
