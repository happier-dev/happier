/**
 * Measure-mirror render economy.
 *
 * The single offscreen measure mirror reports the current step body's natural
 * height through `onLayout`. Two consumers read that number: the native
 * popover height gate (`useSelectionListMeasuredPopoverHeight`) and the
 * step-transition height animator (`SelectionListAnimatedHeight`).
 *
 * The animator's copy must NOT travel through orchestrator render state. The
 * orchestrator owns both `body` and the measure mirror, so one orchestrator
 * render rebuilds both subtrees — every option row re-renders twice over —
 * and nothing in this folder is memoised. A mirror layout is a pure
 * measurement report; on its own it must cost zero render passes.
 *
 * Why this is reachable, and where: every popover-hosted SelectionList that
 * leaves transitions enabled mounts the mirror on web, because
 * `resolvePopoverSelectionListHeightBehavior()` returns `undefined` there (no
 * height gate) while `needsBodyMeasurement` still holds for the animator.
 * `AgentInputSelectionListPopover` (the agent-input chips, including machine
 * and worktree), `NewSessionMcpSelectionContent` and
 * `NewSessionConnectedServicesSelectionContent` all take that path. On those
 * surfaces the mirror re-lays out on every filter keystroke that changes the
 * list height, so a render pass per mirror layout doubles the cost of each of
 * those keystrokes.
 *
 * `CommandMenu` is NOT one of those call sites — it passes `disableTransitions`
 * — which is also why the mirror measurement must not be published at all when
 * transitions are off (there is no animator mounted to consume it), while the
 * native height gate must keep receiving it.
 */

import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';

import { SelectionList } from '../SelectionList';
import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function makeRootStep(overrides: Partial<SelectionListStep> = {}): SelectionListStep {
    return {
        id: 'root',
        title: 'Worktrees',
        inputPlaceholder: 'Search worktrees',
        sections: [
            {
                kind: 'static',
                id: 'recent',
                title: 'RECENT',
                options: [
                    { id: 'a', label: 'Alpha' },
                    { id: 'b', label: 'Bravo' },
                    { id: 'c', label: 'Charlie' },
                ],
            },
        ],
        ...overrides,
    };
}

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: makeRootStep(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        testID: 'sl',
        ...overrides,
    };
}

/**
 * Counts COMMITS inside the SelectionList subtree. A commit is exactly the
 * cost this test is about: React re-entering the orchestrator, rebuilding the
 * body and the mirror, and reconciling every option row twice.
 */
function withCommitCounter(node: React.ReactElement): Readonly<{
    element: React.ReactElement;
    commitCount: () => number;
}> {
    const commits = { value: 0 };
    return {
        element: (
            <React.Profiler id="selection-list" onRender={() => { commits.value += 1; }}>
                {node}
            </React.Profiler>
        ),
        commitCount: () => commits.value,
    };
}

function fireLayout(screen: RenderScreenResult, testID: string, height: number): void {
    const host = screen.findHostByTestId(testID);
    if (!host) throw new Error(`expected a host node with testID "${testID}"`);
    const onLayout = host.props.onLayout as ((event: unknown) => void) | undefined;
    if (typeof onLayout !== 'function') {
        throw new Error(`expected onLayout on "${testID}"`);
    }
    act(() => {
        onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height } } });
    });
}

function readContainerStyle(screen: RenderScreenResult): Record<string, unknown> {
    const container = screen.findHostByTestId('sl');
    if (!container) throw new Error('expected the SelectionList container');
    const style = container.props.style as unknown;
    if (!Array.isArray(style)) return (style as Record<string, unknown> | undefined) ?? {};
    return style.reduce<Record<string, unknown>>(
        (acc, entry) => Object.assign(acc, (entry as Record<string, unknown> | null) ?? {}),
        {},
    );
}

describe('SelectionList measure-mirror render economy', () => {
    it('costs zero render passes when the mirror reports heights on the web popover path (no height gate, transitions on)', async () => {
        const { element, commitCount } = withCommitCounter(
            <SelectionList {...defaultProps()} />,
        );
        const screen = await renderScreen(element);

        const baseline = commitCount();

        // First measurement, then the height a filter keystroke would produce.
        fireLayout(screen, 'sl:measure', 300);
        fireLayout(screen, 'sl:measure', 344);

        expect(commitCount() - baseline).toBe(0);
    });

    it('costs zero render passes for a sub-pixel mirror change on the native measured-popover path', async () => {
        const { element, commitCount } = withCommitCounter(
            <SelectionList
                {...defaultProps({
                    heightBehavior: 'measuredToMaxHeight' as SelectionListProps['heightBehavior'],
                    maxHeight: 320,
                })}
            />,
        );
        const screen = await renderScreen(element);

        // The first report legitimately drives the height gate.
        fireLayout(screen, 'sl:measure', 300.4);
        const afterFirstReport = commitCount();

        // The gate dedupes at a 1px epsilon, so this reports nothing new.
        fireLayout(screen, 'sl:measure', 300.9);

        expect(commitCount() - afterFirstReport).toBe(0);
    });

    it('still feeds the native height gate when transitions are disabled (CommandMenu configuration)', async () => {
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep: makeRootStep({ inputPlaceholder: undefined }),
                    disableTransitions: true,
                    heightBehavior: 'measuredToMaxHeight' as SelectionListProps['heightBehavior'],
                    maxHeight: 320,
                })}
            />,
        );

        // Hidden until a height is known.
        expect(readContainerStyle(screen).opacity).toBe(0);

        fireLayout(screen, 'sl:measure', 220);

        const style = readContainerStyle(screen);
        expect(style.opacity).toBe(1);
        expect(style.height).toBe(220);
    });
});
