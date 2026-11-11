import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
    SPECIMEN_ANALYSIS_COMPLETE,
    SPECIMEN_ANALYSIS_EARLY,
    SPECIMEN_COMPARISON,
    SPECIMEN_WALKTHROUGH,
} from '@/components/dev/changes/walkthroughSpecimenFixture';

import { SCM_DIFF_SUMMARY_ENDED_PARTWAY_FAILURE, SCM_DIFF_SUMMARY_GENERIC_FAILURE } from '@/sync/domains/scm/diffSummary/state';

import { buildWalkthroughReading, EMPTY_WALKTHROUGH_READING, type WalkthroughReadingInput } from './walkthroughReading';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nativeScrollRequests = vi.hoisted(() => [] as Array<{ y: number; animated: boolean }>);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    // Native scroll commands are the platform boundary; reading/layout decisions stay real.
    const ScrollView = React.forwardRef<{ scrollTo: (request: { y: number; animated: boolean }) => void }, { children?: React.ReactNode }>(
        function ScrollView(props, ref) {
            React.useImperativeHandle(ref, () => ({ scrollTo: (request) => nativeScrollRequests.push(request) }), []);
            return React.createElement('ScrollView', props);
        },
    );
    return createReactNativeWebMock({ ScrollView });
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

it('does not claim complete line totals when a captured file has unavailable evidence', async () => {
    const complete = buildWalkthroughReading(COMPLETE);
    const known = await renderScreen(<WalkthroughView reading={complete} scopeLabel="This session" layout="wide" />);
    const sourceStrings = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findHostByTestId('walkthrough-source-fact')!
        .findAll((node) => typeof node.type === 'string')
        .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'));
    expect(sourceStrings(known)).toContain(`+${complete.source.added.toLocaleString()}`);
    const comparison = { ...SPECIMEN_COMPARISON, inventory: { ...SPECIMEN_COMPARISON.inventory,
        files: SPECIMEN_COMPARISON.inventory.files.map((file, index) => index === 0
            ? { ...file, evidence: { state: 'unavailable' as const, reason: 'binary' as const } } : file),
    } };
    const reading = buildWalkthroughReading({ comparison, walkthrough: { state: 'complete', value: SPECIMEN_WALKTHROUGH },
        analysis: SPECIMEN_ANALYSIS_COMPLETE, reviewed: null });
    expect(reading.source.added).toBeGreaterThan(0);
    const screen = await renderScreen(<WalkthroughView reading={reading} scopeLabel="This session" layout="wide" />);
    const strings = sourceStrings(screen);
    expect(strings).not.toContain(`+${reading.source.added.toLocaleString()}`);
    expect(strings).not.toContain(`−${reading.source.removed.toLocaleString()}`);
    expect(strings.some((text) => text.startsWith('scmComparison.fileCount'))).toBe(true);
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

it.each(['wide', 'phone'] as const)('navigates to the measured findings tail in the %s reading scroll', async (layout) => {
    const screen = await renderScreen(view(COMPLETE, { layout, review: {
        renderStopFindings: (stop, nav) => ({ refs: <View testID={`findings-nav-${stop.id}`} onTouchEnd={nav.scrollToFindings} /> }),
        afterStops: <View testID="findings-content" />,
    } }));
    const anchor = screen.findHostByTestId('walkthrough-findings-tail-anchor')!;
    let stream = anchor.parent;
    while (stream && typeof stream.props.onLayout !== 'function') stream = stream.parent;
    expect(stream).not.toBeNull();
    await act(async () => {
        stream!.props.onLayout({ nativeEvent: { layout: { y: 100 } } });
        anchor.props.onLayout({ nativeEvent: { layout: { y: 300 } } });
        screen.findByTestId(`findings-nav-${SPECIMEN_WALKTHROUGH.stops[0]!.id}`)!.props.onTouchEnd();
    });
    expect(nativeScrollRequests.at(-1)).toEqual({ y: layout === 'phone' ? 348 : 400, animated: false });
});

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
    it.each(['restoring', 'unavailable'] as const)('does not offer a new walkthrough while saved data is %s', async restoreState => {
        const screen = await renderScreen(<WalkthroughView reading={EMPTY_WALKTHROUGH_READING} scopeLabel="Pending changes" layout="wide"
            restoreState={restoreState} start={{ options: null, onStart: vi.fn(), busy: false, disabled: false }} />);
        expect(Boolean(screen.findByTestId('walkthrough-none'))).toBe(false);
        expect(Boolean(screen.findByTestId('walkthrough-start'))).toBe(false);
        expect(Boolean(screen.findByTestId(`walkthrough-${restoreState}`))).toBe(true);
    });
    it('offers the Overview code map only when the reading outlines more than one group of files', async () => {
        const reading = buildWalkthroughReading(COMPLETE);
        expect(reading.codeMap.length).toBeGreaterThan(1);
        const many = await renderScreen(<WalkthroughView reading={reading} scopeLabel="This session" layout="wide" />);
        expect(Boolean(many.findByTestId('walkthrough-overview'))).toBe(true);
        const one = await renderScreen(<WalkthroughView reading={{ ...reading, codeMap: reading.codeMap.slice(0, 1) }} scopeLabel="This session" layout="wide" />);
        expect(Boolean(one.findByTestId('walkthrough-overview'))).toBe(false);
    });
    it('holds the reviewed fact\u2019s room, unseen, while the marks are read, and never claims progress it cannot read', async () => {
        const hiddenFact = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
            let node = screen.findHostByTestId('walkthrough-reviewed-fact') ?? null;
            if (!node) return { present: false, hidden: false };
            let hidden = false;
            for (; node; node = node.parent) hidden ||= node.props?.accessibilityElementsHidden === true;
            return { present: true, hidden };
        };
        const pending = await renderScreen(view(COMPLETE, { reviewedProgressAvailable: false, reviewedProgressPending: true }));
        expect(hiddenFact(pending)).toEqual({ present: true, hidden: true });
        const unreadable = await renderScreen(view(COMPLETE, { reviewedProgressAvailable: false }));
        expect(hiddenFact(unreadable).present).toBe(false);
        const read = await renderScreen(view(COMPLETE, { reviewedProgressAvailable: true }));
        expect(hiddenFact(read)).toEqual({ present: true, hidden: false });
    });
    it('shows the captured rename, untracked and conflict kinds before narration, and opens their exact files', async () => {
        const reading = buildWalkthroughReading({ ...COMPLETE, walkthrough: { state: 'pending' } });
        const onOpenFile = vi.fn();
        const screen = await renderScreen(<WalkthroughView reading={{ ...reading, inventory: reading.inventory.slice(0, 3)
            .map((row, index) => ({ ...row, changeKind: ['renamed', 'untracked', 'conflicted'][index]! })) }}
            scopeLabel="This session" layout="wide" onOpenFile={onOpenFile} />);
        const inventory = screen.findByTestId('walkthrough-inventory')!;
        const letters = inventory.findAll(node => typeof node.type === 'string')
            .flatMap(node => node.children.filter((child): child is string => typeof child === 'string'));
        expect(letters).toEqual(expect.arrayContaining(['R', 'A', '!']));
        await screen.pressByTestIdAsync(`walkthrough-inventory-${reading.inventory[0]!.path}`);
        expect(onOpenFile).toHaveBeenCalledWith(reading.inventory[0]!.path);
    });
    it('begins at the next unread stop without automatically marking it', async () => {
        const initial = buildWalkthroughReading(COMPLETE);
        const stops = initial.stops.map((stop, index) => ({ ...stop, reviewed: index < 2 }));
        const onToggleReviewed = vi.fn();
        const screen = await renderScreen(<WalkthroughView reading={{ ...initial, stops }} scopeLabel="This session" layout="phone" onToggleReviewed={onToggleReviewed} />);
        expect(onToggleReviewed).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('walkthrough-phone-mark');
        expect(onToggleReviewed.mock.calls[0]?.[0]).toMatchObject({ id: stops[2]!.id, reviewed: false });
    });
    it.each(['wide', 'phone'] as const)('opens on the stop it begins at once measured, unless the reader moved first (%s)', async (layout) => {
        const initial = buildWalkthroughReading(COMPLETE);
        const stops = initial.stops.map((stop, index) => ({ ...stop, reviewed: index < 2 }));
        const measure = async (screen: Awaited<ReturnType<typeof renderScreen>>, stopY: number) => {
            let section = screen.findHostByTestId(`walkthrough-stop-${stops[2]!.id}`);
            while (section && typeof section.props.onLayout !== 'function') section = section.parent;
            let stream = section?.parent ?? null;
            while (stream && typeof stream.props.onLayout !== 'function') stream = stream.parent;
            await act(async () => {
                stream!.props.onLayout({ nativeEvent: { layout: { y: 100 } } });
                section!.props.onLayout({ nativeEvent: { layout: { y: stopY } } });
            });
        };
        nativeScrollRequests.length = 0;
        const screen = await renderScreen(<WalkthroughView reading={{ ...initial, stops }} scopeLabel="This session" layout={layout} />);
        await measure(screen, 500);
        // The pointer and the page agree: stop 3 is both what the bar names and what is on screen.
        expect(nativeScrollRequests).toEqual([{ y: layout === 'phone' ? 548 : 600, animated: false }]);

        nativeScrollRequests.length = 0;
        const moved = await renderScreen(<WalkthroughView reading={{ ...initial, stops }} scopeLabel="This session" layout={layout} />);
        const scroller = moved.findAll((node) => node.type === 'ScrollView' && typeof node.props.onScroll === 'function')[0]!;
        await act(async () => { scroller.props.onScroll({ nativeEvent: { contentOffset: { y: 40 } } }); });
        await measure(moved, 500);
        expect(nativeScrollRequests).toEqual([]);
    });
    it('keeps the phone bar Ask slot while Ask is being resolved, so Mark reviewed never shrinks when it arrives (N5)', async () => {
        const reading = buildWalkthroughReading(COMPLETE);
        const onAsk = vi.fn();
        const screen = await renderScreen(<WalkthroughView reading={reading} scopeLabel="This session" layout="phone" onToggleReviewed={vi.fn()} askPending />);
        const pending = screen.findHostByTestId('walkthrough-phone-ask');
        expect(pending?.props.accessibilityState?.disabled ?? pending?.props.disabled).toBe(true);
        await screen.update(<WalkthroughView reading={reading} scopeLabel="This session" layout="phone" onToggleReviewed={vi.fn()} onAsk={onAsk} />);
        await screen.pressByTestIdAsync('walkthrough-phone-ask');
        expect(onAsk).toHaveBeenCalledTimes(1);
    });
    it.each(['wide', 'phone'] as const)('keeps saved-result controls in the reading stream on %s', async (layout) => {
        const screen = await renderScreen(view(COMPLETE, { layout, savedActions: <View testID="saved-result-actions-slot" /> }));
        expect(screen.findByTestId('saved-result-actions-slot')).toBeTruthy();
    });
    it('admits a first walkthrough only on START and keeps the model choice visible', async () => {
        const start = vi.fn();
        const screen = await renderScreen(<WalkthroughView reading={EMPTY_WALKTHROUGH_READING} scopeLabel="This session" layout="wide"
            start={{ options: <View testID="walkthrough-model-choice" />, onStart: start }} />);
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

    it('keeps displayed changes reviewable offline while questions need the Machine', async () => {
        const onToggleReviewed = vi.fn();
        const screen = await renderScreen(view(COMPLETE, { onToggleReviewed, onAsk: vi.fn(), offline: { machine: 'MacBook Pro', time: '10:42' } }));
        expect(screen.findByTestId('walkthrough-notice-offline')).toBeTruthy();
        expect(diffsUnder(screen, 'walkthrough-stop-why')).toHaveLength(1);
        expect(hostIds(screen, 'walkthrough-ask-')).toHaveLength(0);
        await screen.pressByTestIdAsync('walkthrough-mark-why');
        expect(onToggleReviewed).toHaveBeenCalledWith(expect.objectContaining({ id: 'why' }));
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

    it('names a reading that stopped partway beside the stops it kept, with Try again as the one recovery', async () => {
        const partial = await renderScreen(view({
            ...COMPLETE,
            walkthrough: { state: 'partial', value: { ...SPECIMEN_WALKTHROUGH, stops: SPECIMEN_WALKTHROUGH.stops.slice(0, 2), otherChangeRefs: [] }, reason: 'capacity' },
        }, { failure: SCM_DIFF_SUMMARY_ENDED_PARTWAY_FAILURE, onRetry: vi.fn(), onChooseModel: vi.fn() }));
        expect(hostIds(partial, 'walkthrough-stop-')).toHaveLength(2);
        expect(partial.findHostByTestId('walkthrough-notice-failed')?.props.accessibilityRole).toBe('alert');
        // The band leads with the stops that were written; the unclassified cause adds nothing.
        expect(partial.getTextContent()).toContain('walkthrough.notice.stoppedAfter');
        expect(partial.getTextContent()).not.toContain('walkthrough.notice.endedPartway');
        expect(partial.getTextContent()).not.toContain('capacity');
        expect(partial.findByTestId('walkthrough-rest')).toBeTruthy();
        expect(partial.findByTestId('walkthrough-retry')).toBeTruthy();
        expect(partial.findByTestId('walkthrough-choose-model')).toBeNull();
    });

    it('says a stopped writing once: the typed cancellation carries Try again and the plain stopped line does not repeat it', async () => {
        const cancelled = { reason: 'cancelled', messageKey: 'walkthrough.notice.cancelled', nextAction: 'retry', nextActionKey: 'walkthrough.notice.tryAgain' } as const;
        const stopped = await renderScreen(view({
            ...COMPLETE,
            walkthrough: { state: 'cancelled', value: { ...SPECIMEN_WALKTHROUGH, stops: SPECIMEN_WALKTHROUGH.stops.slice(0, 2), otherChangeRefs: [] } },
        }, { failure: cancelled, onRetry: vi.fn() }));
        expect(stopped.getTextContent().split('walkthrough.notice.cancelled')).toHaveLength(2);
        expect(stopped.findByTestId('walkthrough-retry')).toBeTruthy();
        // Without a typed failure the stopped line still stands alone.
        const bare = await renderScreen(view({
            ...COMPLETE,
            walkthrough: { state: 'cancelled', value: { ...SPECIMEN_WALKTHROUGH, stops: SPECIMEN_WALKTHROUGH.stops.slice(0, 2), otherChangeRefs: [] } },
        }));
        expect(bare.findByTestId('walkthrough-notice-cancelled')).toBeTruthy();
    });

    it('interrupts only for a failed write; a refinement update and stale reading stay polite', async () => {
        const failed = await renderScreen(view({ ...COMPLETE, walkthrough: { state: 'failed', value: SPECIMEN_WALKTHROUGH, reason: 'overloaded' } }));
        expect(failed.findHostByTestId('walkthrough-notice-failed')?.props.accessibilityRole).toBe('alert');
        const quiet = await renderScreen(view(COMPLETE, {
            update: { title: 'Merged stops 2 and 3', onUndo: vi.fn() },
            stale: { onRefresh: vi.fn() },
        }));
        for (const testID of ['walkthrough-notice-update', 'walkthrough-notice-stale']) {
            const band = quiet.findHostByTestId(testID);
            expect(band).toBeTruthy();
            expect(band?.props.accessibilityRole).not.toBe('alert');
            expect(band?.props.accessibilityLiveRegion).toBe('polite');
        }
    });

    it('renders the owner’s genuine refinement failure even after its conversation ended', async () => {
        const ended = { onStartNew: vi.fn(), onAskSession: vi.fn() };
        // Run-observation refusals are removed by the state owner; an explicit generation refusal stays actionable.
        const generic = await renderScreen(view(COMPLETE, { endedConversation: ended, failure: SCM_DIFF_SUMMARY_GENERIC_FAILURE, onRetry: vi.fn() }));
        expect(generic.findByTestId('walkthrough-notice-ended')).toBeTruthy();
        expect(Boolean(generic.findByTestId('walkthrough-notice-failed'))).toBe(true);
        // A typed reason the reader can act on is never hidden behind it.
        const typed = await renderScreen(view(COMPLETE, { endedConversation: ended, onChooseModel: vi.fn(),
            failure: { reason: 'modelUnavailable', messageKey: 'walkthrough.generationFailure.modelUnavailable', nextAction: 'chooseModel', nextActionKey: 'walkthrough.notice.chooseModel' } }));
        expect(typed.findByTestId('walkthrough-notice-failed')).toBeTruthy();
    });
});

describe('an uncertain Start (the Machine may not have received it)', () => {
    const texts = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAll((node) => typeof node.type === 'string')
        .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'));
    const pending = { ...COMPLETE, walkthrough: { state: 'pending' as const }, analysis: SPECIMEN_ANALYSIS_EARLY };

    it('says it may not have started, keeps every file readable, and drops the writing presentation', async () => {
        const healthy = await renderScreen(view(pending, { notify: <View testID="notify-offer" /> }));
        // The healthy pending reading is the control: it writes, offers notification and labels each file as being read.
        expect(texts(healthy)).toContain('walkthrough.readingChanges');
        expect(texts(healthy)).toContain('walkthrough.inventory.reading');
        expect(healthy.findByTestId('notify-offer')).toBeTruthy();
        expect(healthy.findByTestId('walkthrough-notice-unknown')).toBeNull();

        const screen = await renderScreen(view(pending, { admission: 'outcomeUnknown', onCheckAdmission: vi.fn(), notify: <View testID="notify-offer" /> }));
        expect(screen.findByTestId('walkthrough-notice-unknown')).toBeTruthy();
        expect(texts(screen)).toContain('walkthrough.notice.unknownStart');
        // A pane-local notice in the walkthrough: the shared inline notice, never a hard-edged strip (PATTERN-AUDIT-UI-1111 E).
        const { HappierBanner } = await import('@happier-dev/plugin-ui/presentation');
        expect(screen.tree.root.findAllByType(HappierBanner).map((banner) => banner.props.presentation ?? 'card')).not.toContain('strip');
        expect(texts(screen)).not.toContain('walkthrough.readingChanges');
        expect(texts(screen)).not.toContain('walkthrough.inventory.reading');
        expect(screen.findByTestId('notify-offer')).toBeNull();
        expect(hostIds(screen, 'walkthrough-inventory-')).toHaveLength(SPECIMEN_COMPARISON.inventory.files.length);
        // Nothing here starts another Run.
        expect(screen.findByTestId('walkthrough-start')).toBeNull();
        expect(screen.findByTestId('walkthrough-retry')).toBeNull();
    });

    it('checks again only through the supplied callback, and shows it working until it settles', async () => {
        let settle = () => {};
        const onCheckAdmission = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
        const screen = await renderScreen(view(pending, { admission: 'outcomeUnknown', onCheckAdmission }));
        await screen.pressByTestIdAsync('walkthrough-check-admission');
        expect(onCheckAdmission).toHaveBeenCalledTimes(1);
        await screen.pressByTestIdAsync('walkthrough-check-admission');
        expect(onCheckAdmission).toHaveBeenCalledTimes(1);
        await act(async () => settle());
        await screen.pressByTestIdAsync('walkthrough-check-admission');
        expect(onCheckAdmission).toHaveBeenCalledTimes(2);
    });

    it('keeps captured prose readable and stops announcing that more is arriving', async () => {
        const first = { ...SPECIMEN_WALKTHROUGH, stops: SPECIMEN_WALKTHROUGH.stops.slice(0, 2) };
        const writing = { ...COMPLETE, walkthrough: { state: 'writing' as const, value: first } };
        const healthy = await renderScreen(view(writing, { notify: <View testID="notify-offer" /> }));
        expect(healthy.findByTestId('walkthrough-arriving')).toBeTruthy();
        const screen = await renderScreen(view(writing, { admission: 'outcomeUnknown', onCheckAdmission: vi.fn(), notify: <View testID="notify-offer" /> }));
        expect(screen.findByTestId('walkthrough-notice-unknown')).toBeTruthy();
        expect(hostIds(screen, 'walkthrough-stop-')).toHaveLength(2);
        expect(screen.findByTestId('walkthrough-arriving')).toBeNull();
        expect(screen.findByTestId('notify-offer')).toBeNull();
        expect(screen.findByTestId('walkthrough-editorial-header')?.findAll((node) => node.props.markdown === first.intro)).not.toHaveLength(0);
    });

    it('does not claim uncertainty for a reading whose original Run is already known', async () => {
        const screen = await renderScreen(view(COMPLETE, { admission: 'outcomeUnknown', onCheckAdmission: vi.fn() }));
        expect(screen.findByTestId('walkthrough-notice-unknown')).toBeNull();
    });
});

describe('stop arrival motion', () => {
    const fading = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.tree.root
        .findAll((node) => node.props.entering !== undefined && node.findAll((inner) => typeof inner.props.testID === 'string'
            && inner.props.testID.startsWith('walkthrough-stop-')).length > 0, { deep: false }).length;

    it('shows a restored saved reading in place; only stops written while reading fade into their slot', async () => {
        const screen = await renderScreen(<WalkthroughView reading={EMPTY_WALKTHROUGH_READING} restoreState="restoring" scopeLabel="Pending changes" layout="phone" />);
        await screen.update(<WalkthroughView reading={buildWalkthroughReading(COMPLETE)} restoreState="ready" scopeLabel="Pending changes" layout="phone" />);
        expect(fading(screen)).toBe(0);

        const first = { ...SPECIMEN_WALKTHROUGH, stops: SPECIMEN_WALKTHROUGH.stops.slice(0, 1) };
        const writing = await renderScreen(<WalkthroughView reading={buildWalkthroughReading({ ...COMPLETE, walkthrough: { state: 'writing', value: first } })}
            scopeLabel="Pending changes" layout="phone" />);
        await writing.update(<WalkthroughView reading={buildWalkthroughReading({ ...COMPLETE, walkthrough: { state: 'writing', value: SPECIMEN_WALKTHROUGH } })}
            scopeLabel="Pending changes" layout="phone" />);
        expect(fading(writing)).toBe(SPECIMEN_WALKTHROUGH.stops.length - 1);
    });
});
