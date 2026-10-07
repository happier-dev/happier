import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen } from '@/dev/testkit';
import { SurfaceStateCard } from './SurfaceStateCard';

const accessibilityPlatform = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios' | 'android',
}));
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

/**
 * L0-2 — behavioral contract for the ONE shared surface terminal-state card
 * (audit XS-3). Every kind renders; the action fires; the human `reason` is
 * shown; the raw `diagnosticCode` never reaches visible text (testID channel
 * only).
 */
describe('SurfaceStateCard', () => {
    it('keeps a caller-owned domain summary before recovery actions, without adding it to a line state', async () => {
        const onOpen = vi.fn();
        const screen = await renderScreen(<SurfaceStateCard testID="summary" layout="inline" kind="success" title="Ready" live={{ text: 'Last pushed' }} body={<span>Current commit</span>} actionCaption="Suggested next" action={{ label: 'Open PR', onPress: onOpen }} />);
        const content = screen.getTextContent();
        expect(content).toContain('Current commit');
        expect(content.indexOf('Last pushed')).toBeLessThan(content.indexOf('Current commit'));
        expect(content.indexOf('Current commit')).toBeLessThan(content.indexOf('Open PR'));
        expect(content).toContain('Suggested next');
        expect(content.indexOf('Current commit')).toBeLessThan(content.indexOf('Suggested next'));
        await screen.pressByTestIdAsync('summary-action');
        expect(onOpen).toHaveBeenCalledOnce();
        const line = await renderScreen(<SurfaceStateCard size="line" kind="success" title="Ready" body={<span>Current commit</span>} />);
        expect(line.getTextContent()).not.toContain('Current commit');
    });
    it('keeps a pending line recovery disabled and preserves its caller test identity', async () => {
        const onRetry = vi.fn();
        const screen = await renderScreen(<SurfaceStateCard testID="error" size="line" kind="error" title="Try again" action={{ testID: 'retry', label: 'Retry', onPress: onRetry, disabled: true, busy: true }} />);
        const retry = screen.findByTestId('retry');
        expect(retry).toBeTruthy();
        expect(retry?.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
        await act(async () => { retry?.props.onPress?.(); });
        expect(onRetry).not.toHaveBeenCalled();
    });
    beforeEach(() => {
        accessibilityPlatform.os = 'web';
        announceForAccessibilityMock.mockClear();
    });

    it.each(['empty', 'error', 'unavailable'] as const)('renders title and reason for kind=%s', async (kind) => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind={kind}
                title="Nothing to show"
                reason="Run your dev server and it appears here."
            />,
        );
        expect(screen.findByTestId('state-card')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Nothing to show');
        expect(screen.getTextContent()).toContain('Run your dev server and it appears here.');
        expect(screen.findByTestId('state-card')?.props.accessibilityLiveRegion).toBeUndefined();
    });

    it('renders a warning state with the canonical warning glyph', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="warning"
                title="Selection changed"
                reason="Choose the current value before continuing."
            />,
        );

        expect(screen.findAll((node) => node.props?.name === 'warning-circle')).toHaveLength(1);
    });

    it('renders a completed state with the canonical success glyph', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="success"
                title="Home connected"
                reason="Everything is ready."
            />,
        );

        expect(screen.findAll((node) => node.props?.name === 'check-circle')).toHaveLength(1);
    });

    it('announces only opted-in state transitions with the requested urgency', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="loading"
                title="Connecting…"
                accessibilitySemantics="status"
                animationEnabled={false}
            />,
        );

        const loading = screen.findByTestId('state-card');
        expect(loading?.props.accessibilityLiveRegion).toBe('polite');
        expect(loading?.props.role).toBe('status');
        expect(loading?.props['aria-live']).toBe('polite');

        await act(async () => {
            screen.tree.update(
                <SurfaceStateCard
                    testID="state-card"
                    kind="error"
                    title="Connection failed"
                    accessibilitySemantics="alert"
                />,
            );
        });

        const error = screen.findByTestId('state-card');
        expect(error?.props.accessibilityRole).toBe('alert');
        expect(error?.props.accessibilityLiveRegion).toBe('assertive');
        expect(error?.props.role).toBe('alert');
        expect(error?.props['aria-live']).toBe('assertive');
        expect(screen.tree.root.findAllByProps({ accessibilityLiveRegion: 'assertive' })).toHaveLength(1);
    });

    it('announces opted-in human state copy on iOS without exposing diagnostics', async () => {
        accessibilityPlatform.os = 'ios';
        const { SurfaceStateCard } = await import('./SurfaceStateCard');

        await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="error"
                title="Connection failed"
                reason="Try again."
                diagnosticCode="operation_failed"
                accessibilitySemantics="alert"
            />,
        );

        expect(announceForAccessibilityMock).toHaveBeenCalledOnce();
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith('Connection failed. Try again.');
        expect(announceForAccessibilityMock).not.toHaveBeenCalledWith(
            expect.stringContaining('operation_failed'),
        );
    });

    it('hides its decorative icon from the accessibility tree', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="unavailable"
                title="Preview unavailable"
                reason="Human copy."
            />,
        );
        const icon = screen.findByTestId('state-card-icon');
        expect(icon?.props.accessibilityElementsHidden).toBe(true);
        expect(icon?.props.importantForAccessibility).toBe('no-hide-descendants');
    });

    it('renders a spinner (not an icon) for kind=loading', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard testID="state-card" kind="loading" title="Connecting…" animationEnabled={false} />,
        );
        expect(screen.findByTestId('state-card-loading-spinner')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Connecting…');
    });

    it('renders a caller-supplied icon node when a surface owns the glyph', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="empty"
                title="Nothing here"
                icon={React.createElement('SurfaceStateCustomIcon', { testID: 'state-card-custom-icon' })}
            />,
        );
        expect(screen.findByTestId('state-card-custom-icon')).toBeTruthy();
    });

    it('fires the primary action and supports async pending', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const deferred = createDeferred<void>();
        const onPress = vi.fn(() => deferred.promise);
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="error"
                title="Something went wrong"
                action={{ label: 'Retry', onPress }}
            />,
        );
        expect(screen.getTextContent()).toContain('Retry');
        screen.pressByTestId('state-card-action');
        screen.pressByTestId('state-card-action');
        expect(onPress).toHaveBeenCalledTimes(1);
        deferred.resolve();
        await act(async () => deferred.promise);
    });

    it('fires the secondary action independently', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const onPrimary = vi.fn();
        const onSecondary = vi.fn();
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="unavailable"
                title="Preview unavailable"
                action={{ label: 'Retry', onPress: onPrimary }}
                secondaryAction={{ label: 'Open in browser', onPress: onSecondary }}
            />,
        );
        await act(async () => {
            screen.pressByTestId('state-card-secondary-action');
        });
        expect(onSecondary).toHaveBeenCalledTimes(1);
        expect(onPrimary).not.toHaveBeenCalled();
    });

    it('keeps the raw diagnostic code out of the card until Details is opened, then shows it', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="unavailable"
                title="Stream unavailable"
                reason="The device preview is unavailable right now."
                diagnosticCode="webcodecs_decoder_unavailable"
            />,
        );
        // Collapsed: the card leads with human copy; the code is only on the QA channel.
        expect(screen.getTextContent()).not.toContain('webcodecs_decoder_unavailable');
        expect(screen.findByTestId('state-card-diagnostic-webcodecs_decoder_unavailable')).toBeTruthy();
        expect(screen.findByTestId('state-card-details-toggle')?.props.accessibilityState).toMatchObject({ expanded: false });

        await act(async () => {
            screen.pressByTestId('state-card-details-toggle');
        });

        // Opened on purpose: support and expert users can read and copy it.
        expect(screen.findByTestId('state-card-details-toggle')?.props.accessibilityState).toMatchObject({ expanded: true });
        expect(screen.findByTestId('state-card-details-code')?.props.selectable).toBe(true);
        expect(screen.getTextContent()).toContain('webcodecs_decoder_unavailable');
    });

    it.each(['empty', 'success', 'loading'] as const)('offers no Details reveal on a %s card, where nothing failed', async (kind) => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind={kind}
                title="Nothing here yet"
                diagnosticCode="no_items"
            />,
        );
        expect(screen.findByTestId('state-card-details-toggle')).toBeFalsy();
        expect(screen.getTextContent()).not.toContain('no_items');
        expect(screen.findByTestId('state-card-diagnostic-no_items')).toBeTruthy();
    });

    it('does not use the raw diagnostic code as an accessibility label (XS-4 inversion guard)', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind="unavailable"
                title="Stream unavailable"
                reason="Human copy."
                diagnosticCode="stream_error"
            />,
        );
        const withRawLabel = screen.findAll((node) => node.props?.accessibilityLabel === 'stream_error');
        expect(withRawLabel).toHaveLength(0);
    });

    // U8.5 craft S4: a failure or loading surface uses the empty-state anatomy — no muted card, a calm
    // glyph in the secondary colour (the title carries the trouble), and one small secondary action.
    it.each(['error', 'unavailable', 'warning'] as const)('renders kind=%s with the empty-state anatomy', async (kind) => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const render = (k: 'empty' | typeof kind) => renderScreen(
            <SurfaceStateCard
                testID="state-card"
                kind={k}
                title="Can't reach Happier on MacBook Pro"
                reason="It may still be starting."
                action={{ label: 'Try again', onPress: () => {} }}
            />,
        );
        const failure = await render(kind);
        const empty = await render('empty');
        const glyphColor = (screen: Awaited<ReturnType<typeof render>>) =>
            screen.findAll((node) => typeof node.props?.name === 'string' && node.props?.color !== undefined)[0]?.props.color;

        expect(failure.findAll((node) => node.props?.tone === 'muted')).toHaveLength(0);
        expect(glyphColor(failure)).toBe(glyphColor(empty));
        const button = failure.findAll((node) => node.props?.testID === 'state-card-action' && 'title' in (node.props ?? {}))[0];
        expect(button?.props.size).toBe('small');
        expect(button?.props.display).toBe('secondary');
    });
});

/**
 * Pane-states lab 0: the one state composition for panes, details and app pages — sized by its
 * container, with the live present ("Still waiting · 6 s"), a denied state that says who can, the quiet
 * "How it works" link, and the compact in-list line.
 */
describe('SurfaceStateCard pane-state composition', () => {
    beforeEach(() => {
        accessibilityPlatform.os = 'web';
        vi.useRealTimers();
    });

    it('tells how long a sized loading state has been waiting once the wait is noticeable', async () => {
        vi.useFakeTimers();
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const { SurfaceStateSizeProvider } = await import('./surfaceStateSize');
        const screen = await renderScreen(
            <SurfaceStateSizeProvider size="pane">
                <SurfaceStateCard testID="state-card" kind="loading" title="Opening SettingsModal.tsx" />
            </SurfaceStateSizeProvider>,
        );
        expect(screen.getTextContent()).not.toContain('Still waiting');

        await act(async () => {
            vi.advanceTimersByTime(6_000);
        });

        expect(screen.findByTestId('state-card-live')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Still waiting · 6 s');
    });

    it('a caller live line replaces the automatic wait line', async () => {
        vi.useFakeTimers();
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                size="page"
                kind="unavailable"
                title="You’re offline"
                live={{ text: 'Reconnecting · next try in 8 s', busy: true }}
            />,
        );
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        expect(screen.getTextContent()).toContain('Reconnecting · next try in 8 s');
        expect(screen.getTextContent()).not.toContain('Still waiting');
    });

    it('a denied state says who can, with a lock glyph and no dead action', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                size="pane"
                kind="denied"
                title="Only Leeroy can change who has access"
                reason="Leeroy Brun owns this session. You can edit it and join its conversations."
            />,
        );
        expect(screen.findAll((node) => node.props?.name === 'lock')).toHaveLength(1);
        expect(screen.findByTestId('state-card-action')).toBeFalsy();
        expect(screen.getTextContent()).toContain('Leeroy Brun owns this session.');
    });

    it('offers "How it works" as a quiet link after a note', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const learnMore = vi.fn();
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-card"
                size="page"
                kind="empty"
                title="Let agents work while you’re away"
                action={{ label: 'New automation', onPress: () => {} }}
                note="Runs on a machine in Personal Home."
                learnMore={{ label: 'How it works', onPress: learnMore }}
            />,
        );
        expect(screen.getTextContent()).toContain('Runs on a machine in Personal Home.');
        await act(async () => {
            screen.pressByTestId('state-card-learn-more');
        });
        expect(learnMore).toHaveBeenCalledTimes(1);
    });

    it('draws its Daybreak scene in the glyph slot only where the state has room for it', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const hasScene = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllHostsByTestId('scene-planet').length > 0;
        const glyph = (screen: Awaited<ReturnType<typeof renderScreen>>, name: string) => screen.findAll((node) => node.props?.name === name).length;

        const empty = await renderScreen(<SurfaceStateCard size="pane" kind="empty" iconName="globe" scene="nothingListening" title="No local services" />);
        expect(hasScene(empty)).toBe(true);
        expect(glyph(empty, 'globe'), 'the scene takes the glyph\'s place').toBe(0);

        const offline = await renderScreen(<SurfaceStateCard size="page" kind="unavailable" scene="homeOffline" title="Studio is out of reach" />);
        expect(hasScene(offline)).toBe(true);

        const inline = await renderScreen(<SurfaceStateCard size="pane" layout="inline" kind="success" scene="treeClean" title="Working tree clean" />);
        expect(hasScene(inline)).toBe(false);

        const line = await renderScreen(<SurfaceStateCard size="line" kind="empty" iconName="globe" scene="nothingListening" title="Nothing running" />);
        expect(hasScene(line)).toBe(false);
        expect(glyph(line, 'globe')).toBe(1);
    });

    it('in a list it is one quiet line: the kind glyph, the sentence and an inline recovery', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const retry = vi.fn();
        const screen = await renderScreen(
            <SurfaceStateCard
                testID="state-line"
                size="line"
                kind="error"
                title="Couldn’t load who has access."
                diagnosticCode="rpc_timeout"
                action={{ label: 'Try again', onPress: retry }}
            />,
        );
        expect(screen.getTextContent()).toContain('Couldn’t load who has access.');
        expect(screen.findAll((node) => node.props?.name === 'warning')).toHaveLength(1);
        // A line is not a card: no Details disclosure, the code stays on the QA channel.
        expect(screen.findByTestId('state-line-details-toggle')).toBeFalsy();
        expect(screen.findByTestId('state-line-diagnostic-rpc_timeout')).toBeTruthy();
        await act(async () => {
            screen.pressByTestId('state-line-action');
        });
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it('a loading line shows a spinner instead of a glyph', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const screen = await renderScreen(
            <SurfaceStateCard testID="state-line" size="line" kind="loading" title="Connecting…" />,
        );
        expect(screen.findByTestId('state-line-loading-spinner')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Connecting…');
    });
});

describe('SurfaceFreshnessLine', () => {
    it('keeps content honest: as of when, why, and one retry', async () => {
        const { SurfaceFreshnessLine } = await import('./SurfaceFreshnessLine');
        const { formatAsOfTime } = await import('@/utils/time/formatAsOfTime');
        const retry = vi.fn();
        const asOf = Date.now() - 60_000;
        const screen = await renderScreen(
            <SurfaceFreshnessLine
                testID="fresh"
                asOf={asOf}
                reason="devbox isn’t answering"
                action={{ label: 'Retry', onPress: retry }}
            />,
        );
        expect(screen.getTextContent()).toContain(`As of ${formatAsOfTime(asOf)}`);
        expect(screen.getTextContent()).toContain('devbox isn’t answering');
        await act(async () => {
            screen.pressByTestId('fresh-action');
        });
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it('shows a working ring while it reconnects', async () => {
        const { SurfaceFreshnessLine } = await import('./SurfaceFreshnessLine');
        const screen = await renderScreen(
            <SurfaceFreshnessLine testID="fresh" reason="Reconnecting to MacBook Pro…" busy />,
        );
        expect(screen.findByTestId('fresh-spinner')).toBeTruthy();
    });
});
