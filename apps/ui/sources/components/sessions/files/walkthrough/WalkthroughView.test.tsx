import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import {
    SPECIMEN_ANALYSIS_COMPLETE,
    SPECIMEN_ANALYSIS_EARLY,
    SPECIMEN_COMPARISON,
    SPECIMEN_WALKTHROUGH,
} from '@/components/dev/changes/walkthroughSpecimenFixture';

import { buildWalkthroughReading, EMPTY_WALKTHROUGH_READING, type WalkthroughReadingInput } from './walkthroughReading';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    });
});
// Renderer leaves stand in as host elements; the view's own reading, ordering and control decisions run for real.
vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: Record<string, unknown>) => React.createElement('DiffViewer', props),
}));
vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: Record<string, unknown>) => React.createElement('MarkdownView', props),
}));

const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { WalkthroughView } = await import('./WalkthroughView');

const COMPLETE: WalkthroughReadingInput = {
    comparison: SPECIMEN_COMPARISON,
    walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH },
    analysis: SPECIMEN_ANALYSIS_COMPLETE,
    reviewed: null,
};

it('keeps model provenance and yields the extra scope detail in a narrow drawer', async () => {
    const screen = await renderScreen(<WalkthroughView reading={buildWalkthroughReading(COMPLETE)} scopeLabel="This session"
        scopeDetail="Extra session span" modelLabel="A long model name" layout="narrow" />);
    const header = screen.findByTestId('walkthrough-editorial-header');
    expect(header?.findAll((node) => typeof node.type === 'string' && node.children.some((child) =>
        typeof child === 'string' && child.includes('Extra session span')))).toHaveLength(0);
    expect(header?.findAll((node) => typeof node.type === 'string' && node.children.some((child) =>
        typeof child === 'string' && child.includes('A long model name'))).length).toBeGreaterThan(0);
});

function view(input: WalkthroughReadingInput, props: Partial<React.ComponentProps<typeof WalkthroughView>> = {}) {
    return (
        <WalkthroughView
            reading={buildWalkthroughReading(input)}
            scopeLabel="This session"
            layout="wide"
            {...props}
        />
    );
}

/** Host elements whose testID starts with a prefix, in render order. */
function hostIds(screen: Awaited<ReturnType<typeof renderScreen>>, prefix: string): string[] {
    return screen.findAll((node) => typeof node.type === 'string' && typeof node.props.testID === 'string' && node.props.testID.startsWith(prefix))
        .map((node) => String(node.props.testID));
}

function diffsUnder(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): string[] {
    const stop = screen.findByTestId(testID);
    return (stop?.findAllByType('DiffViewer' as never) ?? []).map((node) => String(node.props.unifiedDiff));
}

describe('WalkthroughView (lab WT1-A)', () => {
    it('begins at the next unread stop without automatically marking it', async () => {
        const initial = buildWalkthroughReading(COMPLETE);
        const stops = initial.stops.map((stop, index) => ({ ...stop, reviewed: index < 2 }));
        const onToggleReviewed = vi.fn();
        const screen = await renderScreen(<WalkthroughView reading={{ ...initial, stops }} scopeLabel="This session" layout="phone" onToggleReviewed={onToggleReviewed} />);
        expect(onToggleReviewed).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('walkthrough-phone-mark');
        expect(onToggleReviewed.mock.calls[0]?.[0]).toMatchObject({ id: stops[2]!.id, reviewed: false });
    });
    it.each(['wide', 'phone'] as const)('keeps saved-result controls in the reading stream on %s', async (layout) => {
        const screen = await renderScreen(view(COMPLETE, { layout, savedActions: <View testID="saved-result-actions-slot" /> }));
        expect(screen.findByTestId('saved-result-actions-slot')).toBeTruthy();
    });
    it('admits a first walkthrough only on START and keeps the model choice visible', async () => {
        const start = vi.fn();
        const screen = await renderScreen(<WalkthroughView reading={EMPTY_WALKTHROUGH_READING} scopeLabel="This session" layout="wide"
            start={{ modelPicker: <View testID="walkthrough-model-choice" />, onStart: start }} />);
        expect(start).not.toHaveBeenCalled();
        expect(screen.findByTestId('walkthrough-model-choice')).toBeTruthy();
        await screen.pressByTestIdAsync('walkthrough-start');
        expect(start).toHaveBeenCalledTimes(1);
    });
    it('reads the stops in order, each above only its own hunks, then the other changes', async () => {
        const screen = await renderScreen(view(COMPLETE));
        const stopIds = hostIds(screen, 'walkthrough-stop-');
        expect(stopIds).toEqual(SPECIMEN_WALKTHROUGH.stops.map((stop) => `walkthrough-stop-${stop.id}`));
        const why = diffsUnder(screen, 'walkthrough-stop-why');
        expect(why).toHaveLength(1);
        expect(why[0]).toContain('useSettingsRouteKey(route);');
        expect(why[0]).not.toContain('compact={width < 600}');
        // A cross-file stop draws one card per file, in the stop's order.
        expect(diffsUnder(screen, 'walkthrough-stop-key').map((diff) => diff.split('\n')[0])).toEqual([
            'diff --git a/apps/ui/sources/components/settings/useSettingsRouteKey.ts b/apps/ui/sources/components/settings/useSettingsRouteKey.ts',
            'diff --git a/apps/ui/sources/components/settings/settingsRoutes.ts b/apps/ui/sources/components/settings/settingsRoutes.ts',
            'diff --git a/apps/ui/sources/components/settings/SettingsModal.tsx b/apps/ui/sources/components/settings/SettingsModal.tsx',
        ]);
        expect(screen.findByTestId('walkthrough-other-yarn.lock')).toBeTruthy();
        expect(screen.findByTestId('walkthrough-contents-count')?.props.children).toBe('walkthrough.reviewedOfTotal:{"count":0,"total":5}');
    });

    it('marks only on the person’s press, and offers Ask only when the generator can take a turn', async () => {
        const onToggleReviewed = vi.fn();
        const screen = await renderScreen(view(COMPLETE, { onToggleReviewed }));
        expect(hostIds(screen, 'walkthrough-ask-')).toHaveLength(0);
        await screen.pressByTestIdAsync('walkthrough-mark-sheet');
        expect(onToggleReviewed).toHaveBeenCalledTimes(1);
        expect(onToggleReviewed.mock.calls[0]![0]).toMatchObject({ id: 'sheet', reviewed: false });

        const onAsk = vi.fn();
        const withGenerator = await renderScreen(view(COMPLETE, { onToggleReviewed, onAsk }));
        await withGenerator.pressByTestIdAsync('walkthrough-ask-why');
        expect(onAsk.mock.calls[0]![0]).toMatchObject({ id: 'why' });
    });

    it('stays readable offline, but cannot mark or ask without the machine', async () => {
        const onToggleReviewed = vi.fn();
        const screen = await renderScreen(view(COMPLETE, { onToggleReviewed, onAsk: vi.fn(), offline: { machine: 'MacBook Pro', time: '10:42' } }));
        expect(screen.findByTestId('walkthrough-notice-offline')).toBeTruthy();
        expect(diffsUnder(screen, 'walkthrough-stop-why')).toHaveLength(1);
        expect(hostIds(screen, 'walkthrough-ask-')).toHaveLength(0);
        await screen.pressByTestIdAsync('walkthrough-mark-why');
        expect(onToggleReviewed).not.toHaveBeenCalled();
    });

    it('shows every file before a word is written, and invites Files when nothing was asked for', async () => {
        const writing = await renderScreen(view({ ...COMPLETE, walkthrough: { state: 'writing' }, analysis: SPECIMEN_ANALYSIS_EARLY }));
        expect(hostIds(writing, 'walkthrough-stop-')).toHaveLength(0);
        expect(hostIds(writing, 'walkthrough-inventory-')).toHaveLength(SPECIMEN_COMPARISON.inventory.files.length);

        const onShowFiles = vi.fn();
        const none = await renderScreen(<WalkthroughView reading={EMPTY_WALKTHROUGH_READING} scopeLabel="This session" layout="wide" onShowFiles={onShowFiles} />);
        expect(none.findByTestId('walkthrough-none')).toBeTruthy();
    });

    it('keeps what was written when writing fails, and says the rest was not', async () => {
        const failed = await renderScreen(view({
            ...COMPLETE,
            walkthrough: { state: 'failed', value: { ...SPECIMEN_WALKTHROUGH, stops: SPECIMEN_WALKTHROUGH.stops.slice(0, 2), otherChangeRefs: [] }, reason: 'overloaded' },
        }, { onRetry: vi.fn() }));
        expect(hostIds(failed, 'walkthrough-stop-')).toHaveLength(2);
        expect(failed.findByTestId('walkthrough-notice-failed')).toBeTruthy();
        expect(failed.findByTestId('walkthrough-rest')).toBeTruthy();
        expect(failed.findByTestId('walkthrough-retry')).toBeTruthy();
    });
});
