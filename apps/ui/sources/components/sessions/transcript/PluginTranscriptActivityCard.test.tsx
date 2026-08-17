import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ChatListItem } from '@/components/sessions/chatListItems';
import {
    resolveItemSubtitleMaxLines,
    resolveItemTitleMaxLines,
} from '@/components/ui/lists/itemTextClamp';
import { renderScreen } from '@/dev/testkit';

const accessibilityPlatform = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' | 'android' }));
const announceForAccessibilityMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock({ View: 'View' });
    return {
        ...base,
        AccessibilityInfo: {
            ...base.AccessibilityInfo,
            announceForAccessibility: announceForAccessibilityMock,
        },
        Platform: {
            ...base.Platform,
            get OS() {
                return accessibilityPlatform.os;
            },
        },
    };
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (
        props: Record<string, unknown> & { children?: React.ReactNode },
    ) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

type PluginActivityItem = Extract<ChatListItem, { kind: 'plugin-transcript-activity' }>;

function activity(overrides: Partial<PluginActivityItem> = {}): PluginActivityItem {
    return {
        kind: 'plugin-transcript-activity',
        id: 'plugin-transcript-activity:build',
        identityKey: 'build',
        pluginId: 'acme.preview',
        contributionId: 'activity',
        generation: '7',
        sessionId: 'session-a',
        resourceId: 'live-activity',
        localActivityId: 'build',
        phase: 'succeeded',
        title: 'Build complete',
        status: null,
        progress: null,
        checklist: [],
        dismissible: true,
        actions: [
            { pluginId: 'acme.preview', localId: 'retry', label: 'Retry' },
            { pluginId: 'acme.preview', localId: 'retired', label: 'Retired action' },
        ],
        freshness: 'current',
        createdAt: 0,
        ...overrides,
    } as PluginActivityItem;
}

type RenderedItem = Readonly<{ props: Record<string, unknown> }> | null | undefined;

/**
 * The line an `Item` paints for its title, derived from the props the card actually passed and
 * `Item`'s own clamp rule — never from a literal, and never from the descriptor under test.
 */
function paintedTitleLine(node: RenderedItem): Readonly<{ text: unknown; maxLines: number }> {
    if (!node) throw new Error('Expected the card to paint this Item.');
    return {
        text: node.props.title,
        maxLines: resolveItemTitleMaxLines(Boolean(node.props.subtitle)),
    };
}

/** The same, for the one `Item` subtitle this card paints. */
function paintedSubtitleLine(node: RenderedItem): Readonly<{ text: unknown; maxLines: number | null }> | null {
    if (!node) throw new Error('Expected the card to paint this Item.');
    const subtitle = node.props.subtitle;
    if (typeof subtitle !== 'string') return null;
    return {
        text: subtitle,
        maxLines: resolveItemSubtitleMaxLines({
            text: subtitle,
            subtitleLines: node.props.subtitleLines as number | undefined,
        }),
    };
}

describe('PluginTranscriptActivityCard', () => {
    it('renders the final Session-admitted snapshot Actions and delegates their canonical open', async () => {
        const onOpenAction = vi.fn();
        const { PluginTranscriptActivityCard } = await import('./PluginTranscriptActivityCard');
        const screen = await renderScreen(
            <PluginTranscriptActivityCard
                activity={activity({
                    actions: [{ pluginId: 'acme.preview', localId: 'retry', label: 'Retry' }],
                })}
                onDismiss={() => undefined}
                onOpenAction={onOpenAction}
            />,
        );

        expect(screen.findByTestId('plugin-transcript-activity-action:retry')).toBeTruthy();
        expect(screen.findByTestId('plugin-transcript-activity-action:retired')).toBeNull();
        await screen.pressByTestIdAsync('plugin-transcript-activity-action:retry');
        expect(onOpenAction).toHaveBeenCalledWith({ pluginId: 'acme.preview', localId: 'retry' });
    });

    it('presents bounded Resource progress and checklist state without treating count ticks as live announcements', async () => {
        accessibilityPlatform.os = 'web';
        announceForAccessibilityMock.mockClear();
        const item = activity({
            phase: 'running',
            status: 'Compiling',
            progress: { completed: 3, total: 10 },
            checklist: [
                { id: 'lint', label: 'Lint', state: 'complete' },
                { id: 'build', label: 'Build', state: 'active' },
            ],
        });
        const { PluginTranscriptActivityCard } = await import('./PluginTranscriptActivityCard');
        const screen = await renderScreen(
            <PluginTranscriptActivityCard
                activity={item}
                onDismiss={() => undefined}
                onOpenAction={() => undefined}
            />,
        );

        const status = screen.findByTestId('plugin-transcript-activity-status');
        expect(status?.props).toMatchObject({
            title: 'status.working',
            subtitle: 'Compiling · 3 / 10',
            accessibilityLabel: 'Build complete. status.working. Compiling. 3 / 10',
        });
        const progress = status?.props.rightElement as React.ReactElement | undefined;
        expect(progress?.props).toMatchObject({
            testID: 'plugin-transcript-activity-progress',
            label: 'Build complete. status.working. Compiling. 3 / 10',
            value: 0.3,
            pointerEvents: 'none',
        });
        expect(screen.findByTestId('plugin-transcript-activity-checklist-step-done-lint')).toBeTruthy();
        expect(screen.findByTestId('plugin-transcript-activity-checklist-step-active-build')).toBeTruthy();
        expect(screen.findByTestId('plugin-transcript-activity-a11y-status')?.props).toMatchObject({
            accessibilityLiveRegion: 'polite',
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': true,
        });
        expect(announceForAccessibilityMock).not.toHaveBeenCalled();
    });

    it('announces semantic activity transitions on iOS without repeating progress ticks', async () => {
        accessibilityPlatform.os = 'ios';
        announceForAccessibilityMock.mockClear();
        const { PluginTranscriptActivityCard } = await import('./PluginTranscriptActivityCard');
        const commonProps = {
            onDismiss: () => undefined,
            onOpenAction: () => undefined,
        };
        const screen = await renderScreen(
            <PluginTranscriptActivityCard
                {...commonProps}
                activity={activity({
                    phase: 'running',
                    status: 'Compiling',
                    progress: { completed: 3, total: 10 },
                })}
            />,
        );

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            expect.stringContaining('status.working'),
        );

        await screen.update(
            <PluginTranscriptActivityCard
                {...commonProps}
                activity={activity({
                    phase: 'running',
                    status: 'Compiling',
                    progress: { completed: 4, total: 10 },
                })}
            />,
        );
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);

        await screen.update(
            <PluginTranscriptActivityCard
                {...commonProps}
                activity={activity({
                    phase: 'running',
                    status: 'Compiling',
                    progress: { completed: 4, total: 10 },
                    freshness: 'stale',
                })}
            />,
        );
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(2);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            expect.stringContaining('status.offline'),
        );
        accessibilityPlatform.os = 'web';
    });

    /**
     * F-P4 (2026-08-10) anti-drift guard. `buildTranscriptRowShellSignature` keys this row off
     * `resolvePluginTranscriptActivityHeightBearingPaint` instead of guessing at projection fields.
     * That is only safe while the descriptor names exactly what the card paints, so assert the two
     * against ONE render: every painted line must appear in the descriptor, and the descriptor must
     * not invent one.
     *
     * F-2 (2026-08-11): the clamps used to be asserted against LITERALS (`maxLines: 1` / `2`) while
     * the descriptor hand-copied them from `Item.tsx`. Two copies and no derivation is not a guard —
     * deleting the descriptor's with/without-subtitle flip survived this whole file, because every
     * fixture here carries a subtitle and so never reached the clamp-2 branch. The expectations are
     * now derived from the RENDERED `Item` props through `Item`'s own clamp rule
     * (`itemTextClamp`, pinned to the real render by `itemTextClamp.render.test.tsx`), and the
     * subtitle-less case below reaches the branch the literals could not.
     */
    it('paints exactly the lines its height-bearing paint descriptor declares', async () => {
        const item = activity({
            phase: 'running',
            status: 'Compiling',
            progress: { completed: 3, total: 10 },
            checklist: [
                { id: 'lint', label: 'Lint', state: 'complete' },
                { id: 'build', label: 'Build', state: 'active' },
            ],
            dismissible: true,
        });
        const { PluginTranscriptActivityCard } = await import('./PluginTranscriptActivityCard');
        const { resolvePluginTranscriptActivityHeightBearingPaint } = await import(
            './pluginTranscriptActivityPresentation'
        );
        const paint = resolvePluginTranscriptActivityHeightBearingPaint(item);
        const screen = await renderScreen(
            <PluginTranscriptActivityCard
                activity={item}
                onDismiss={() => undefined}
                onOpenAction={() => undefined}
            />,
        );

        const status = screen.findByTestId('plugin-transcript-activity-status');
        expect(status?.props.title).toBe('status.working');
        expect(status?.props.subtitle).toBe('Compiling · 3 / 10');
        expect(paint.statusTitle).toEqual(paintedTitleLine(status));
        expect(paint.statusDetail).toEqual(paintedSubtitleLine(status));
        expect(paint.hasProgress).toBe(true);
        expect(paint.checklistStepLabels).toEqual([
            paintedTitleLine(screen.findByTestId('plugin-transcript-activity-checklist-step-done-lint')),
            paintedTitleLine(screen.findByTestId('plugin-transcript-activity-checklist-step-active-build')),
        ]);
        expect(paint.checklistStepLabels.map((line) => line.text)).toEqual(['Lint', 'Build']);
        expect(paint.actionLabels).toEqual([
            paintedTitleLine(screen.findByTestId('plugin-transcript-activity-action:retry')),
            paintedTitleLine(screen.findByTestId('plugin-transcript-activity-action:retired')),
        ]);
        expect(paint.actionLabels.map((line) => line.text)).toEqual(['Retry', 'Retired action']);
        expect(paint.groupTitle).toEqual({ text: item.title, maxLines: null });
        // `phase: 'running'` withholds the dismiss Item, and the descriptor says so.
        expect(paint.canDismiss).toBe(false);
        expect(screen.findByTestId('plugin-transcript-activity-dismiss')).toBeNull();
    });

    /**
     * F-2's missing case. With no plugin status AND no progress there is no subtitle, so `Item`
     * clamps the status title to TWO lines instead of one — the branch every other fixture in this
     * file skips, and the only one that can catch a descriptor which stopped asking.
     */
    it('reports the subtitle-less status clamp the card actually paints', async () => {
        const item = activity({ phase: 'running', status: null, progress: null, checklist: [] });
        const { PluginTranscriptActivityCard } = await import('./PluginTranscriptActivityCard');
        const { resolvePluginTranscriptActivityHeightBearingPaint } = await import(
            './pluginTranscriptActivityPresentation'
        );
        const paint = resolvePluginTranscriptActivityHeightBearingPaint(item);
        const screen = await renderScreen(
            <PluginTranscriptActivityCard
                activity={item}
                onDismiss={() => undefined}
                onOpenAction={() => undefined}
            />,
        );

        const status = screen.findByTestId('plugin-transcript-activity-status');
        expect(status?.props.title).toBe('status.working');
        expect(status?.props.subtitle).toBeNull();
        expect(paint.statusDetail).toBeNull();
        expect(paint.hasProgress).toBe(false);
        expect(paint.statusTitle).toEqual(paintedTitleLine(status));
        // Named explicitly so the derivation above cannot pass by agreeing on the wrong value.
        expect(paint.statusTitle.maxLines).toBe(2);
    });
});
