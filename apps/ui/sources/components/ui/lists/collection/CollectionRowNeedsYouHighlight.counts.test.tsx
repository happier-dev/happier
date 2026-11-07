import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { storage } from '@/sync/domains/state/storage';
import { WorkStatusRowMark } from '@/components/work/status/WorkStatusRowMark';
import type { WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';

import { CollectionRowNeedsYouLeading } from './CollectionRowNeedsYouHighlight';
import type { HappierNeedsYouHighlightPreference as NeedsYouHighlightPreference } from '@happier-dev/plugin-ui/presentation';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View', Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default } });
});

const needsYou: WorkStatusPresentation = { state: 'permission_required', bucket: 'needs_you', tone: 'attention', word: 'Needs permission', attentionType: 'approval' };
const calm: WorkStatusPresentation = { state: 'stopped', bucket: 'idle', tone: 'neutral', word: 'Stopped', attentionType: null };
/** One visible unopened row that should move, and the rows that must stay still: off screen, opened, calm. */
const ROWS = [
    { id: 'moving', status: needsYou, facts: { unopened: true, visible: true } },
    { id: 'offscreen', status: needsYou, facts: { unopened: true, visible: false } },
    { id: 'opened', status: needsYou, facts: { unopened: false, visible: true } },
    { id: 'calm', status: calm, facts: null },
] as const;

function setPreference(value: NeedsYouHighlightPreference) {
    storage.setState({ localSettings: { ...storage.getState().localSettings, sessionListNeedsYouHighlight: value } });
}

function Rows(props: Readonly<{ counter: ReturnType<typeof createRenderCommitCounter> }>) {
    useRenderCommitCounter(props.counter);
    return <>{ROWS.map((row) => (
        <React.Fragment key={row.id}>
            {row.facts ? <CollectionRowNeedsYouLeading {...row.facts} testID={`hl-${row.id}`} /> : null}
            <WorkStatusRowMark status={row.status} testIDSuffix={row.id} needsYouHighlight={row.facts} />
        </React.Fragment>
    ))}</>;
}

/** Each drawn (host) node that declares a CSS animation: one entry per moving element. */
function animatedNames(screen: Awaited<ReturnType<typeof renderScreen>>): string[] {
    return screen.root.findAll((node) => typeof node.type === 'string')
        .map((node) => [node.props?.style].flat(Infinity).find((style: any) => style?.animationName)?.animationName)
        .filter((name): name is string => typeof name === 'string');
}

afterEach(() => {
    setReducedMotionPreferenceOverride(null);
    standardCleanup();
    vi.useRealTimers();
});

describe('needs-you highlight cost shape (owner ruling 2026-11-01)', () => {
    it.each(['glint', 'shimmer', 'pulse'] as const)('%s animates exactly the visible unopened row, with no timers and no render per frame', async (preference) => {
        vi.useFakeTimers();
        setPreference(preference);
        const census = installTimerCensus();
        const counter = createRenderCommitCounter();
        const screen = await renderScreen(<Rows counter={counter} />);
        const expected = preference === 'pulse' ? 'happierStatusDotPulse' : preference === 'glint' ? 'happierNeedsYouGlint' : 'happierNeedsYouShimmer';
        // Exactly one moving element: the visible row nobody has opened. Off-screen, opened and calm rows are still.
        expect(animatedNames(screen)).toEqual([expected]);
        // The motion is declarative (CSS on the web, the native driver elsewhere): no timer, no render per frame.
        const before = counter.read();
        const firesBefore = census.readFires();
        await act(async () => { vi.advanceTimersByTime(10_000); });
        expect(counter.read()).toEqual(before);
        expect(census.read().filter((timer) => timer.kind === 'interval')).toEqual([]);
        expect(census.readFires().interval).toBe(firesBefore.interval);
        census.stop();
    });

    it('keeps the default Dot and Accent entirely still, and falls back to Accent under reduced motion', async () => {
        for (const [preference, reduced] of [['dot', false], ['accent', false], ['shimmer', true], ['pulse', true]] as const) {
            setPreference(preference);
            setReducedMotionPreferenceOverride(reduced);
            const screen = await renderScreen(<Rows counter={createRenderCommitCounter()} />);
            expect(animatedNames(screen)).toEqual([]);
            const accents = ROWS.filter((row) => screen.findHostByTestId(`hl-${row.id}:accent`)).map((row) => row.id);
            expect(accents).toEqual(preference === 'dot' ? [] : ['moving', 'offscreen', 'opened']);
            standardCleanup();
        }
    });

    it('draws working as the spinner by default and, with the Pulse working indicator, as one pulsing dot with no timer', async () => {
        const working: WorkStatusPresentation = { state: 'thinking', bucket: 'working', tone: 'neutral', word: 'Working', attentionType: null };
        for (const style of ['spinner', 'pulse'] as const) {
            vi.useFakeTimers();
            storage.setState({ settings: { ...storage.getState().settings, sessionListNarrowWorkingIndicatorStyle: style } });
            const census = installTimerCensus();
            const screen = await renderScreen(<WorkStatusRowMark status={working} testIDSuffix="w" />);
            expect(Boolean(screen.findHostByTestId('session-row-attention-indicator-spinner-w'))).toBe(style === 'spinner');
            expect(animatedNames(screen).filter((name) => name === 'happierStatusDotPulse')).toHaveLength(style === 'pulse' ? 1 : 0);
            const fires = census.readFires().interval;
            await act(async () => { vi.advanceTimersByTime(10_000); });
            expect(census.readFires().interval).toBe(fires);
            census.stop();
            standardCleanup();
            vi.useRealTimers();
        }
    });
});

