import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { AgentActivityRowEntry } from '../agentActivityRowEntry';
import { AGENT_ACTIVITY_ROW_NO_ACTIONS } from '../agentActivityRowEntry';

const platformRef = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock();
    return {
        ...base,
        Platform: {
            ...base.Platform,
            get OS() {
                return platformRef.os;
            },
            select: (options: Record<string, unknown>) =>
                options[platformRef.os] ?? options.default ?? options.native ?? options.ios,
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

const modalRef = vi.hoisted(() => ({ confirmed: true, calls: [] as unknown[][] }));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: (...args: unknown[]) => {
            modalRef.calls.push(args);
            return Promise.resolve(modalRef.confirmed);
        },
        alert: () => {},
    },
}));

/**
 * A pass-through counter on the row's own title resolver.
 *
 * The row's render body calls it exactly once per render, so the call count IS the row's render
 * count — which is what the memo proof needs and what no public API exposes. The real
 * implementation still runs, so nothing about the rendered output changes.
 */
const titleRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock('../presentation/resolveAgentActivityTitle', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../presentation/resolveAgentActivityTitle')>();
    return {
        ...actual,
        resolveAgentActivityTitle: (entry: AgentActivityRowEntry) => {
            titleRenders.count += 1;
            return actual.resolveAgentActivityTitle(entry);
        },
    };
});

const START_MS = Date.parse('2026-05-12T00:00:00.000Z');

function makeEntry(overrides: Partial<AgentActivityRowEntry> = {}): AgentActivityRowEntry {
    return {
        id: 'entry-1',
        status: 'running',
        title: 'Audit the reducer',
        startedAtMs: START_MS,
        actions: AGENT_ACTIVITY_ROW_NO_ACTIONS,
        ...overrides,
    };
}

async function importRow() {
    return (await import('./AgentActivityRow')).AgentActivityRow;
}

/**
 * The single node carrying `Item`'s prop contract.
 *
 * Matched by prop signature rather than by component identity: `React.memo` renders as a
 * `SimpleMemoComponent` fiber whose `type` is the inner function, so `findAllByType(Item)` finds
 * nothing. `showChevron` + `iconBoxSize` + `subtitleLines` is `Item`'s own vocabulary and no other
 * component in this tree speaks it.
 */
function findItemProps(screen: Awaited<ReturnType<typeof renderScreen>>): Record<string, unknown> {
    const matches = screen.tree.root.findAll((node) => {
        const nodeProps = node.props as Record<string, unknown> | undefined;
        return nodeProps != null
            && 'showChevron' in nodeProps
            && 'iconBoxSize' in nodeProps
            && 'subtitleLines' in nodeProps;
    });
    expect(matches).toHaveLength(1);
    return matches[0].props as Record<string, unknown>;
}

/** The `ItemRowActions` node, matched the same way (`compactThreshold` is its own vocabulary). */
function findOverflowProps(screen: Awaited<ReturnType<typeof renderScreen>>): Record<string, unknown> | null {
    const matches = screen.tree.root.findAll((node) => {
        const nodeProps = node.props as Record<string, unknown> | undefined;
        return nodeProps != null && 'compactThreshold' in nodeProps && 'actions' in nodeProps;
    });
    return matches.length > 0 ? (matches[0].props as Record<string, unknown>) : null;
}

describe('AgentActivityRow', () => {
    beforeEach(() => {
        platformRef.os = 'web';
        modalRef.confirmed = true;
        modalRef.calls = [];
        titleRenders.count = 0;
        vi.useFakeTimers();
        vi.setSystemTime(new Date(START_MS + 42_000));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('is a composition over Item, so press, hover and ripple are not restated by hand', async () => {
        const AgentActivityRow = await importRow();
        const onPress = vi.fn();
        const screen = await renderScreen(
            <AgentActivityRow entry={makeEntry()} onPress={onPress} testID="row" />,
        );

        // One Item, not a bespoke Pressable tree: this is what deletes the duplicated web/native
        // JSX fork, the missing web pressed state, and the divergent accessible names at a stroke.
        const item = findItemProps(screen);
        expect(item.showChevron).toBe(false);
        expect(item.accessibilityRole).toBe('button');

        screen.pressByTestId('row');
        expect(onPress).toHaveBeenCalledWith('entry-1');

        await screen.unmount();
    });

    it('announces the same name on web and on native', async () => {
        const AgentActivityRow = await importRow();
        const names: string[] = [];
        const roles: unknown[] = [];

        for (const os of ['web', 'ios'] as const) {
            platformRef.os = os;
            const screen = await renderScreen(
                <AgentActivityRow entry={makeEntry({ status: 'failed' })} onPress={() => {}} testID="row" />,
            );
            const item = findItemProps(screen);
            names.push(String(item.accessibilityLabel));
            roles.push(item.accessibilityRole);
            await screen.unmount();
        }

        // Defect A7: web set a container label with no role, native set a role with no label.
        expect(names[0]).toBe(names[1]);
        expect(roles[0]).toBe(roles[1]);
        expect(names[0]).toContain('Audit the reducer');
        expect(names[0]).toContain('Failed');
    });

    it('keeps the ticking clock out of its own accessible name', async () => {
        const AgentActivityRow = await importRow();
        const screen = await renderScreen(
            <AgentActivityRow entry={makeEntry()} onPress={() => {}} testID="row" />,
        );

        const item = findItemProps(screen);
        // The elapsed value is on screen, but interpolating it here would make VoiceOver
        // re-announce the focused row once a second.
        expect(screen.getTextContent()).toContain('0:42');
        expect(String(item.accessibilityLabel)).not.toContain('0:42');
        expect(item.accessibilityState).toMatchObject({ busy: true });

        await screen.unmount();
    });

    it('collapses to one line when there is no meta line, and never grows past two', async () => {
        const AgentActivityRow = await importRow();

        const oneLine = await renderScreen(
            <AgentActivityRow entry={makeEntry({ status: 'running' })} testID="row" />,
        );
        expect((findItemProps(oneLine)).subtitle).toBeNull();
        await oneLine.unmount();

        const twoLine = await renderScreen(
            <AgentActivityRow
                entry={makeEntry({ status: 'failed', metaDetail: 'exit code 2' })}
                testID="row"
            />,
        );
        const item = findItemProps(twoLine);
        expect(String(item.subtitle)).toContain('Failed');
        expect(String(item.subtitle)).toContain('exit code 2');
        expect(item.subtitleLines).toBe(1);
        await twoLine.unmount();
    });

    it('moves the meta line into the right slot when the host asks for a single-line row', async () => {
        const AgentActivityRow = await importRow();
        const screen = await renderScreen(
            <AgentActivityRow
                entry={makeEntry({ status: 'blocked', metaDetail: 'waiting on build' })}
                metaPlacement="inline"
                testID="row"
            />,
        );

        const item = findItemProps(screen);
        expect(item.subtitle).toBeNull();
        expect(String(item.detail)).toContain('Blocked');

        await screen.unmount();
    });

    it('derives its affordances from the data, never from a flag', async () => {
        const AgentActivityRow = await importRow();

        const readOnly = await renderScreen(<AgentActivityRow entry={makeEntry()} testID="row" />);
        const readOnlyItem = findItemProps(readOnly);
        expect(readOnlyItem.mode).toBe('info');
        expect(readOnlyItem.accessibilityRole).toBeUndefined();
        expect(readOnly.findByTestId('row:overflow')).toBeNull();
        await readOnly.unmount();

        // An `onAction` with no actions must still not produce an ellipsis opening an empty sheet.
        const noActions = await renderScreen(
            <AgentActivityRow entry={makeEntry()} onAction={() => {}} testID="row" />,
        );
        expect(noActions.findByTestId('row:overflow')).toBeNull();
        await noActions.unmount();

        const withActions = await renderScreen(
            <AgentActivityRow
                entry={makeEntry({ actions: ['open_full', 'delete'] })}
                onPress={() => {}}
                onAction={() => {}}
                testID="row"
            />,
        );
        expect(withActions.findByTestId('row:overflow')).not.toBeNull();
        await withActions.unmount();
    });

    it('takes the 44pt touch height only when it actually carries an action', async () => {
        const AgentActivityRow = await importRow();
        const { AGENT_ROW_MIN_HEIGHT_PX } = await import('./agentRowMetrics');

        const readOnly = await renderScreen(<AgentActivityRow entry={makeEntry()} testID="row" />);
        const readOnlyStyle = flatten((findItemProps(readOnly)).style);
        expect(readOnlyStyle.minHeight).toBe(AGENT_ROW_MIN_HEIGHT_PX.readOnly);
        await readOnly.unmount();

        const actionable = await renderScreen(
            <AgentActivityRow
                entry={makeEntry({ actions: ['stop'] })}
                onPress={() => {}}
                onAction={() => {}}
                testID="row"
            />,
        );
        const actionableStyle = flatten((findItemProps(actionable)).style);
        expect(actionableStyle.minHeight).toBe(AGENT_ROW_MIN_HEIGHT_PX.withActions);
        await actionable.unmount();
    });

    it('rails only the status that escalates to a person', async () => {
        const AgentActivityRow = await importRow();

        const waiting = await renderScreen(
            <AgentActivityRow entry={makeEntry({ status: 'waiting' })} testID="row" />,
        );
        const waitingRail = flatten(waiting.findByTestId('row:attention-rail')?.props.style);
        expect(waitingRail.backgroundColor).not.toBe('transparent');
        await waiting.unmount();

        const failed = await renderScreen(
            <AgentActivityRow entry={makeEntry({ status: 'failed' })} testID="row" />,
        );
        // Failure is loud enough with a glyph and a word; the rail means "you are the blocker".
        const failedRail = flatten(failed.findByTestId('row:attention-rail')?.props.style);
        expect(failedRail.backgroundColor).toBe('transparent');
        await failed.unmount();
    });

    it('offers exactly the actions the entry declares, in order, keyed by entry id', async () => {
        const AgentActivityRow = await importRow();
        const onAction = vi.fn();

        const screen = await renderScreen(
            <AgentActivityRow
                entry={makeEntry({ actions: ['open_full', 'send', 'delete'] })}
                onAction={onAction}
                testID="row"
            />,
        );

        const overflow = findOverflowProps(screen);
        const actions = overflow?.actions as ReadonlyArray<{ id: string; onPress?: () => void }>;
        expect(actions.map((action) => action.id)).toEqual(['open_full', 'send', 'delete']);

        actions[1].onPress?.();
        expect(onAction).toHaveBeenCalledWith('entry-1', 'send');

        await screen.unmount();
    });

    it('does not re-render when the clock ticks, or when the list re-renders with the same entries', async () => {
        const AgentActivityRow = await importRow();
        const entries = [
            makeEntry({ id: 'a', title: 'Alpha' }),
            makeEntry({ id: 'b', title: 'Beta' }),
            makeEntry({ id: 'c', title: 'Gamma' }),
        ] as const;
        const onPress = () => {};
        const onAction = () => {};

        function Roster(props: Readonly<{ items: readonly AgentActivityRowEntry[] }>) {
            return (
                <>
                    {props.items.map((entry) => (
                        <AgentActivityRow
                            key={entry.id}
                            entry={entry}
                            onPress={onPress}
                            onAction={onAction}
                        />
                    ))}
                </>
            );
        }

        const screen = await renderScreen(<Roster items={entries} />);
        const rendersAfterMount = titleRenders.count;
        expect(rendersAfterMount).toBe(entries.length);
        expect(screen.getTextContent()).toContain('0:42');

        await act(async () => {
            vi.advanceTimersByTime(3_000);
        });

        // The clock moved and the rows did not: the subscription lives in the time slot, below the
        // memo boundary. If it lived in the row, this would be 3 more renders every second, forever.
        expect(screen.getTextContent()).toContain('0:45');
        expect(titleRenders.count).toBe(rendersAfterMount);

        await screen.update(<Roster items={entries} />);

        // And the memo is real: stable entries plus one callback per list, not one closure per row.
        expect(titleRenders.count).toBe(rendersAfterMount);

        await screen.unmount();
    });
});

function flatten(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flatten));
    }
    return (style ?? {}) as Record<string, unknown>;
}
