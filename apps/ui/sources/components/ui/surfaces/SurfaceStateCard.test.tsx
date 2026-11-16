import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { collectUnexpectedRawTextNodes, createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { CurrentUiContextWorkspaceBoundary, useOptionalCurrentUiContextReader, type CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { createSessionBoardDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { executeCurrentUiContextAction } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { resolveBrowseProjectionFailureCopy } from '@/components/sessions/external/browse/browseProjectionFailureCopy';
import { lightTheme } from '@/theme';
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
    it('opens workspace diagnostics through the mounted command while withholding background page controls', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://workspace-details.test', accountId: 'a' }], route: () => undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        let reader: CurrentUiContextReader | null = null;
        function Page() {
            reader = useOptionalCurrentUiContextReader();
            useCurrentUiContextLocalCommands([{ key: 'send', title: 'Send draft', invoke: () => true }]);
            const dispatch = useAppPaneContext(value => value.dispatch);
            React.useLayoutEffect(() => {
                dispatch({ type: 'activateScope', scopeId: 'session:diagnostics' });
                dispatch({ type: 'openDetailsTab', scopeId: 'session:diagnostics', tab: createSessionBoardDetailsTab(), openAs: 'pinned' });
            }, [dispatch]);
            return <CurrentUiContextWorkspaceBoundary>
                <PluginSurfaceFocusEligibilityProvider active={false}>
                    <SurfaceStateCard testID="underlay-details" kind="error" title="Underlay unavailable" diagnosticCode="underlay_failure" />
                </PluginSurfaceFocusEligibilityProvider>
                <PluginSurfaceFocusEligibilityProvider active>
                    <SurfaceStateCard testID="workspace-details" kind="error" title="Simulator unavailable" diagnosticCode="helper_artifact_missing" />
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextWorkspaceBoundary>;
        }
        try {
            const screen = await renderMountedCurrentUiContext(<Page />);
            expect(reader!.readCurrentUiContext()?.navigation.area).toBe('workspace');
            expect(reader!.readCurrentUiContext()?.commands.some(row => row.title === 'Send draft')).toBe(false);
            expect(reader!.readCurrentUiContext()?.commands.some(row => row.title.startsWith('Underlay unavailable: '))).toBe(false);
            await screen.pressByTestIdAsync('workspace-details-details-toggle');
            expect(screen.findByTestId('workspace-details-details-code')?.props.children).toBe('helper_artifact_missing');
            const command = reader!.readCurrentUiContext()!.commands.find(row => row.title.startsWith('Simulator unavailable: '));
            expect(command).toBeDefined();
            await screen.pressByTestIdAsync('workspace-details-details-toggle');
            expect(screen.findByTestId('workspace-details-details-code')).toBeNull();
            await screen.update(<View />);
            expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
                input: { commandId: command!.id }, context: { surface: 'agent' } })).toMatchObject({ ok: false });
        } finally { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home.dispose(); }
    });

    it.each([undefined, 'line'] as const)('shares the %s diagnostic disclosure state with mounted agent commands', async size => {
        const home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://state-details.test', accountId: 'a' }], route: () => undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        let reader: CurrentUiContextReader | null = null;
        function Reader() { reader = useOptionalCurrentUiContextReader(); return null; }
        try {
            const screen = await renderMountedCurrentUiContext(<><Reader /><SurfaceStateCard testID="agent-details"
                size={size} kind="error" title="Could not read usage" diagnosticCode="usage_query_failed" diagnosticDetail="request-123" /></>);
            expect(screen.findByTestId('agent-details-details-code')).toBeNull();
            const command = reader!.readCurrentUiContext()!.commands.find(row => row.title.startsWith('Could not read usage: '));
            expect(command).toBeDefined();
            await act(async () => { expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
                input: { commandId: command!.id }, context: { surface: 'agent' } })).toMatchObject({ ok: true }); });
            expect(screen.findByTestId('agent-details-details-code')?.props.children).toBe('usage_query_failed\nrequest-123');
            await screen.pressByTestIdAsync('agent-details-details-toggle');
            expect(screen.findByTestId('agent-details-details-code')).toBeNull();
            await screen.update(<Reader />);
            expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
                input: { commandId: command!.id }, context: { surface: 'agent' } })).toMatchObject({ ok: false });
        } finally { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home.dispose(); }
    });

    it('renders the Browse projection failure without raw text under a View', async () => {
        const copy = resolveBrowseProjectionFailureCopy({
            phase: 'error', failureReason: 'timeout', machineName: 'Devin box',
        });
        const screen = await renderScreen(<SurfaceStateCard
            testID="browse-failed" kind="error" iconName="link-break"
            accessibilitySemantics="alert" title={copy.title} reason={copy.reason}
            diagnosticCode={copy.diagnosticCode}
            action={{ label: 'Retry', onPress: () => {} }}
            secondaryAction={{ label: 'Close', onPress: () => {} }}
        />);
        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
        expect(screen.tree.findAll((node) => node.type === View)
            .flatMap((node) => React.Children.toArray(node.props.children))
            .filter((child) => typeof child === 'string')).toEqual([]);
    });
    it('keeps a failed line calm in ink and tints only a warning line amber: the words carry the failure (ui-craft "glyphs stay ink")', async () => {
        const glyphColor = async (kind: 'error' | 'warning') => {
            const screen = await renderScreen(<SurfaceStateCard size="line" kind={kind} title="Couldn't update this comment" />);
            return screen.findAll((node) => typeof node.props?.name === 'string' && node.props?.color !== undefined)[0]?.props.color;
        };
        expect(await glyphColor('error')).toBe(lightTheme.colors.text.secondary);
        expect(await glyphColor('warning')).toBe(lightTheme.colors.state.warning.foreground);
    });
    it.each([undefined, 'inline'] as const)('reads failure detail before recovery in %s layout', async (layout) => {
        const screen = await renderScreen(<SurfaceStateCard layout={layout} kind="error" title="Failed"
            detail="The comparison could not be loaded." action={{ label: 'Retry', onPress: () => {} }} />);
        const content = screen.getTextContent();
        expect(content.indexOf('The comparison could not be loaded.')).toBeLessThan(content.indexOf('Retry'));
    });
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
    // A line's second way forward can open a panel (a recovery strip's Details): it says whether that panel is open.
    it('announces whether a line recovery that opens a panel has it open', async () => {
        const screen = await renderScreen(<SurfaceStateCard testID="error" size="line" kind="error" title="Couldn’t start"
            action={{ testID: 'retry', label: 'Retry', onPress: () => {} }}
            secondaryAction={{ testID: 'details', label: 'Details', onPress: () => {}, expanded: true }} />);
        expect(screen.findByTestId('details')?.props.accessibilityState).toMatchObject({ expanded: true });
        expect(screen.findByTestId('retry')?.props.accessibilityState?.expanded).toBeUndefined();
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

    it('runs no wait clock while its pane is hidden, and reads the true wait once shown again', async () => {
        vi.useFakeTimers();
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const { SurfaceStateSizeProvider } = await import('./surfaceStateSize');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const render = (presented: boolean) => (
            <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
                <SurfaceStateSizeProvider size="pane">
                    <SurfaceStateCard testID="state-card" kind="loading" title="Scanning local services" />
                </SurfaceStateSizeProvider>
            </PluginSurfaceFocusEligibilityProvider>
        );
        const screen = await renderScreen(render(false));
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => {
            vi.advanceTimersByTime(6_000);
        });
        expect(screen.getTextContent()).not.toContain('Still waiting');
        await screen.update(render(true));
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

    it('gives a failure that fills a sized surface the failed scene by default; an unsized, line or inline one keeps its glyph', async () => {
        const { SurfaceStateCard } = await import('./SurfaceStateCard');
        const hasScene = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAllHostsByTestId('scene-planet').length > 0;

        for (const kind of ['error', 'unavailable'] as const) {
            for (const size of ['page', 'phone', 'pane', 'details'] as const) {
                expect(hasScene(await renderScreen(<SurfaceStateCard size={size} kind={kind} title="Triage can’t open" />)), `${kind} ${size}`).toBe(true);
            }
            // A local failure (a line among rows, an inline note, a card with no sized container) keeps its glyph.
            expect(hasScene(await renderScreen(<SurfaceStateCard kind={kind} title="Couldn’t load" />))).toBe(false);
            expect(hasScene(await renderScreen(<SurfaceStateCard size="pane" layout="inline" kind={kind} title="Couldn’t load" />))).toBe(false);
            expect(hasScene(await renderScreen(<SurfaceStateCard size="line" kind={kind} title="Couldn’t list files" />))).toBe(false);
        }
        expect(hasScene(await renderScreen(<SurfaceStateCard size="page" kind="empty" title="No Teams yet" />))).toBe(false);
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
        // One row (owner 11-06): a failure line offers its code behind a quiet Details beside its recovery,
        // and keeps the code out of the tree until it is opened.
        expect(screen.findByTestId('state-line-details-toggle')).toBeTruthy();
        expect(screen.findByTestId('state-line-diagnostic-rpc_timeout')).toBeFalsy();
        expect(screen.findByTestId('state-line-details-code')).toBeFalsy();
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
