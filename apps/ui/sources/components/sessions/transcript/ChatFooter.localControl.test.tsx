import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { getSessionLocalControlState } from '@/sync/domains/session/control/sessionLocalControl';
import { shouldOfferLocalControlRelease } from '@/sync/domains/session/control/localControlSwitch';
import { installTranscriptCommonModuleMocks, resetTranscriptCommonModuleMockState } from './transcriptTestHelpers';
import { ChatFooter } from './ChatFooter';
import { WarningActionBanner } from '@/components/sessions/shell/view/WarningActionBanner';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            Platform: { OS: 'web', select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? null },
            AppState: { addEventListener: () => ({ remove: () => {} }) },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                surface: '#fff',
                divider: '#ddd',
                groupped: { sectionTitle: '#444' },
                shadow: { color: '#000', opacity: 0.2 },
                box: { warning: { background: '#fff3cd', text: '#856404' } },
            },
        });
    },
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (
            params ? `${key}:${JSON.stringify(params)}` : key
        ),
    }),
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 800 },
    useLayoutMaxWidth: () => 800,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 800 }),
}));

type ChatFooterProps = React.ComponentProps<typeof ChatFooter>;
type ExternalControl = NonNullable<ChatFooterProps['externalControl']>;
type ChatFooterTestProps = Omit<ChatFooterProps, 'externalControl'> & Readonly<{
    externalControl?: (
        Omit<ExternalControl, 'externalAgentPresentation'>
        & Partial<Pick<ExternalControl, 'externalAgentPresentation'>>
    ) | null;
}>;

const UNKNOWN_EXTERNAL_AGENT_PRESENTATION: ExternalControl['externalAgentPresentation'] = {
    state: 'unknown',
    labelKey: 'status.externalStatusUnknown',
    needsAttention: false,
    agentLabel: null,
    machineLabel: null,
};

async function renderFooter(props: ChatFooterTestProps) {
    const { externalControl, ...rest } = props;
    return renderScreen(
        <ChatFooter
            {...rest}
            externalControl={externalControl
                ? {
                    externalAgentPresentation: UNKNOWN_EXTERNAL_AGENT_PRESENTATION,
                    ...externalControl,
                }
                : externalControl}
        />,
    );
}

describe('ChatFooter (local control)', () => {
    it('offers release of the runner-owned shared terminal without model authentication', async () => {
        const session = createSessionFixture({ active: true, agentState: { controlledByUser: false, localControl: {
            attached: true, topology: 'shared', remoteWritable: true, canDetach: true,
        } } });
        const release = vi.fn();
        const screen = await renderFooter({
            controlledByUser: false,
            localControl: getSessionLocalControlState(session),
            onRequestSwitchToRemote: shouldOfferLocalControlRelease(session, 'logged_out') ? release : undefined,
        });
        const action = screen.findByTestId('session-chatFooter-detachLocalTerminal');
        expect(action).not.toBeNull();
        await act(async () => { action!.props.onPress(); });
        expect(release).toHaveBeenCalledOnce();
        expect(screen.findByTestId('session-chatFooter-switchToRemote')).toBeNull();
        expect(session.agentState?.localControl?.remoteWritable).toBe(true);
    });

    it.each([false, undefined])('does not offer release without runner-owned capability (%s)', async (canDetach) => {
        const session = createSessionFixture({ active: true, agentState: { controlledByUser: false, localControl: {
            attached: true, topology: 'shared', remoteWritable: true,
            ...(canDetach === undefined ? {} : { canDetach }),
        } } });
        const screen = await renderFooter({
            localControl: getSessionLocalControlState(session),
            onRequestSwitchToRemote: shouldOfferLocalControlRelease(session, 'logged_out') ? vi.fn() : undefined,
        });
        expect(screen.findByTestId('session-chatFooter-detachLocalTerminal')).toBeNull();
    });

    afterEach(() => {
        resetTranscriptCommonModuleMockState();
        standardCleanup();
    });

    it('renders a switch-to-remote button when controlled by user', async () => {
        const screen = await renderFooter({
            controlledByUser: true,
            onRequestSwitchToRemote: vi.fn(),
        });

        expect(screen.findByTestId('session-chatFooter-switchToRemote')).not.toBeNull();
        expect(screen.getTextContent()).toContain('chatFooter.permissionsTerminalOnly');
    });

    it('shows a local-running notice (without terminal-only copy) when the local permission bridge is enabled', async () => {
        const screen = await renderFooter({
            controlledByUser: true,
            permissionsInUiWhileLocal: true,
            onRequestSwitchToRemote: vi.fn(),
        });

        expect(screen.getTextContent()).toContain('chatFooter.sessionRunningLocally');
        expect(screen.getTextContent()).not.toContain('chatFooter.permissionsTerminalOnly');
        expect(screen.findByTestId('session-chatFooter-switchToRemote')).not.toBeNull();
    });

    it('does not render footer actions when the session is not locally controlled', async () => {
        const screen = await renderFooter({
            controlledByUser: false,
        });

        expect(screen.findByTestId('session-chatFooter-switchToRemote')).toBeNull();
        expect(screen.findByTestId('session-chatFooter-switchToLocal')).toBeNull();
        expect(screen.findByTestId('session-chatFooter-detachLocalTerminal')).toBeNull();
    });

    it('hides the local-control banner when remote sessions cannot attach locally', async () => {
        const screen = await renderFooter({
            controlledByUser: false,
            localControl: {
                attached: false,
                topology: 'exclusive',
                remoteWritable: true,
                canAttach: false,
                canDetach: false,
            },
        } as any);

        expect(screen.findByTestId('session-chatFooter-switchToRemote')).toBeNull();
        expect(screen.findByTestId('session-chatFooter-switchToLocal')).toBeNull();
        expect(screen.findByTestId('session-chatFooter-detachLocalTerminal')).toBeNull();
        expect(screen.getTextContent()).not.toContain('chatFooter.permissionsTerminalOnly');
    });

    it('renders a switching-to-remote message and hides the action while a control switch is in flight', async () => {
        const screen = await renderFooter({
            controlledByUser: true,
            controlSwitchTo: 'remote',
            onRequestSwitchToRemote: vi.fn(),
        });

        expect(screen.getTextContent()).toContain('chatFooter.switchingToRemote');
        expect(screen.findByTestId('session-chatFooter-switchToRemote')).toBeNull();
    });

    it('renders a detach-local action for shared local attachment', async () => {
        const screen = await renderFooter({
            localControl: {
                attached: true,
                topology: 'shared',
                remoteWritable: true,
                canAttach: true,
                canDetach: true,
            },
            onRequestSwitchToRemote: vi.fn(),
        } as any);

        expect(screen.getTextContent()).toContain('chatFooter.sessionRunningLocallyAndRemotely');
        expect(screen.findByTestId('session-chatFooter-detachLocalTerminal')).not.toBeNull();
        expect(screen.findByTestId('session-chatFooter-switchToRemote')).toBeNull();
    });

    it('does not render app-side switch-to-local for shared remote sessions that can be attached locally', async () => {
        const screen = await renderFooter({
            controlledByUser: false,
            localControl: {
                attached: false,
                topology: 'shared',
                remoteWritable: true,
                canAttach: true,
                canDetach: false,
            },
            onRequestSwitchToLocal: vi.fn(),
        } as any);

        // Remote -> local takeover is intentionally not exposed in the app transcript UI.
        // Users should attach from their terminal instead; keep this assertion so future
        // changes do not reintroduce the misleading "Switch to local" banner/button.
        expect(screen.findByTestId('session-chatFooter-switchToLocal')).toBeNull();
        expect(screen.getTextContent()).not.toContain('chatFooter.switchToLocal');
    });

    it('does not render app-side switch-to-local for exclusive remote sessions that can be attached locally', async () => {
        const screen = await renderFooter({
            controlledByUser: false,
            localControl: {
                attached: false,
                topology: 'exclusive',
                remoteWritable: true,
                canAttach: true,
                canDetach: false,
            },
            onRequestSwitchToLocal: vi.fn(),
        } as any);

        // Remote -> local takeover is intentionally not exposed in the app transcript UI.
        // Users should attach from their terminal instead; keep this assertion so future
        // changes do not reintroduce the misleading "Switch to local" banner/button.
        expect(screen.findByTestId('session-chatFooter-switchToLocal')).toBeNull();
        expect(screen.getTextContent()).not.toContain('chatFooter.switchToLocal');
    });

    it('renders one takeover preflight action and leaves mode choices to the takeover dialog', async () => {
        const onRequestTakeoverPreflight = vi.fn(async () => {});
        const screen = await renderFooter({
            controlledByUser: false,
            externalControl: {
                statusKnown: true,
                machineOnline: true,
                runnerActive: false,
                trustedPid: null,
                activity: 'active_recently',
                canTakeOverDirect: true,
                canTakeOverPersist: false,
                takeoverPreflightInFlight: false,
                takeoverInFlight: null,
                onRequestTakeoverPreflight,
                externalAgentPresentation: {
                    state: 'idle',
                    labelKey: 'status.ready',
                    needsAttention: false,
                    agentLabel: null,
                    machineLabel: null,
                },
            },
        } as any);

        expect(screen.getTextContent()).toContain('status.ready');
        expect(screen.findByTestId('session-chatFooter-takeOverDirect')).not.toBeNull();
        expect(screen.findByTestId('session-chatFooter-takeOverPersist')).toBeNull();

        await act(async () => {
            screen.pressByTestId('session-chatFooter-takeOverDirect');
        });

        expect(onRequestTakeoverPreflight).toHaveBeenCalledTimes(1);
    });

    it('describes pushed external-Agent status with canonical Agent and machine identity', async () => {
        const screen = await renderFooter({
            externalControl: {
                statusKnown: true,
                machineOnline: true,
                runnerActive: false,
                trustedPid: null,
                activity: 'idle',
                canTakeOverDirect: true,
                canTakeOverPersist: false,
                takeoverPreflightInFlight: false,
                takeoverInFlight: null,
                onRequestTakeoverPreflight: vi.fn(async () => {}),
                materialize: null,
                externalAgentPresentation: {
                    state: 'waiting',
                    labelKey: 'status.needsInputExternally',
                    needsAttention: true,
                    agentLabel: 'Codex',
                    machineLabel: 'MacBook Pro',
                },
            },
        });

        expect(screen.getTextContent()).toContain('externalSessions.externalAgentStatusOnMachine');
        expect(screen.getTextContent()).not.toContain('chatFooter.externalSessionTakeoverAvailable');
    });

    it('does not advertise or offer takeover when the current status supports neither mode', async () => {
        const screen = await renderFooter({
            externalControl: {
                statusKnown: true,
                machineOnline: true,
                runnerActive: false,
                trustedPid: null,
                activity: 'idle',
                canTakeOverDirect: false,
                canTakeOverPersist: false,
                takeoverPreflightInFlight: false,
                takeoverInFlight: null,
                onRequestTakeoverPreflight: vi.fn(async () => {}),
                materialize: null,
                externalAgentPresentation: {
                    state: 'unknown',
                    labelKey: 'status.externalStatusUnknown',
                    needsAttention: false,
                    agentLabel: null,
                    machineLabel: null,
                },
            },
        });

        expect(screen.getTextContent()).toContain('externalSessions.externalAgentRunsOutsideHappier');
        expect(screen.getTextContent()).not.toContain('externalSessions.externalAgentTakeOverHint');
        expect(screen.getTextContent()).not.toContain('chatFooter.externalSessionTakeoverAvailable');
        expect(screen.findByTestId('session-chatFooter-takeOverDirect')).toBeNull();
    });

    it('keeps external status read-only when operation recovery owns every action', async () => {
        const screen = await renderFooter({
            externalControl: {
                statusKnown: true,
                machineOnline: true,
                runnerActive: false,
                trustedPid: null,
                activity: 'idle',
                canTakeOverDirect: true,
                canTakeOverPersist: true,
                takeoverPreflightInFlight: false,
                takeoverInFlight: null,
                onRequestTakeoverPreflight: undefined,
                materialize: null,
            },
        });

        expect(screen.findByTestId('session-chatFooter-externalControl')).not.toBeNull();
        expect(screen.findByTestId('session-chatFooter-importIntoHappier')).toBeNull();
        expect(screen.findByTestId('session-chatFooter-takeOverDirect')).toBeNull();
        expect(screen.findByTestId('session-chatFooter-takeOverPersist')).toBeNull();
    });

    it('presents a verified running external process with bounded identity and a refresh action', async () => {
        const onRequestTakeoverPreflight = vi.fn(async () => {});
        const screen = await renderFooter({
            externalControl: {
                statusKnown: true,
                machineOnline: true,
                runnerActive: true,
                trustedPid: 12_345,
                activity: 'running',
                canTakeOverDirect: false,
                canTakeOverPersist: false,
                takeoverPreflightInFlight: false,
                takeoverInFlight: null,
                onRequestTakeoverPreflight,
                materialize: null,
            },
        });

        expect(screen.getTextContent()).toContain('chatFooter.externalSessionTakeoverBlocked');
        expect(screen.getTextContent()).toContain('runs.detail.pid');
        expect(screen.getTextContent()).toContain('chatFooter.externalSessionRecheck');
        expect(screen.getTextContent()).not.toContain('chatFooter.externalSessionAlreadyControlled');
        expect(screen.findByTestId('session-chatFooter-takeOverDirect')).not.toBeNull();

        await act(async () => {
            screen.pressByTestId('session-chatFooter-takeOverDirect');
        });

        expect(onRequestTakeoverPreflight).toHaveBeenCalledTimes(1);
    });

    it('keeps one external-session footer row with Take over primary and Import into Happier secondary', async () => {
        const onRequestMaterialize = vi.fn(async () => {});
        const onRequestTakeoverPreflight = vi.fn(async () => {});
        const screen = await renderFooter({
            externalControl: {
                statusKnown: true,
                machineOnline: true,
                runnerActive: false,
                trustedPid: null,
                activity: 'idle',
                canTakeOverDirect: true,
                canTakeOverPersist: false,
                takeoverPreflightInFlight: false,
                takeoverInFlight: null,
                onRequestTakeoverPreflight,
                materialize: {
                    requestEnabled: true,
                    inFlight: false,
                    onRequest: onRequestMaterialize,
                },
            },
        });

        const banners = screen.findAllByType(WarningActionBanner);
        expect(banners.map((banner) => banner.props.testID)).toEqual(['session-chatFooter-externalControl']);
        expect(banners[0]?.props.actionTestID).toBe('session-chatFooter-takeOverDirect');
        expect(banners[0]?.props.secondaryActions?.map((action: { testID: string }) => action.testID))
            .toEqual(['session-chatFooter-importIntoHappier']);

        await act(async () => {
            screen.pressByTestId('session-chatFooter-importIntoHappier');
        });
        expect(onRequestMaterialize).toHaveBeenCalledTimes(1);
        expect(onRequestTakeoverPreflight).not.toHaveBeenCalled();
    });

    it('makes Import into Happier the one primary, with its purpose, when Take over is not offered', async () => {
        const onRequestMaterialize = vi.fn(async () => {});
        const screen = await renderFooter({
            externalControl: {
                statusKnown: false,
                machineOnline: false,
                runnerActive: false,
                trustedPid: null,
                activity: 'unknown',
                canTakeOverDirect: false,
                canTakeOverPersist: false,
                takeoverPreflightInFlight: false,
                takeoverInFlight: null,
                materialize: {
                    requestEnabled: true,
                    inFlight: false,
                    onRequest: onRequestMaterialize,
                },
            },
        });

        const banners = screen.findAllByType(WarningActionBanner);
        expect(banners.map((banner) => banner.props.testID)).toEqual(['session-chatFooter-externalControl']);
        expect(banners[0]?.props.actionTestID).toBe('session-chatFooter-importIntoHappier');
        expect(banners[0]?.props.secondaryActions ?? []).toEqual([]);
        expect(banners[0]?.props.disabled).toBe(false);
        expect(screen.getTextContent()).toContain('externalSessions.operationMaterializeAvailable');
        await act(async () => {
            screen.pressByTestId('session-chatFooter-importIntoHappier');
        });
        expect(onRequestMaterialize).toHaveBeenCalledTimes(1);
    });

    it('labels unfetched takeover state honestly while keeping the explicit preflight action available', async () => {
        const screen = await renderFooter({
            externalControl: {
                statusKnown: false,
                machineOnline: false,
                runnerActive: false,
                trustedPid: null,
                activity: 'unknown',
                canTakeOverDirect: false,
                canTakeOverPersist: false,
                takeoverPreflightInFlight: false,
                takeoverInFlight: null,
                onRequestTakeoverPreflight: vi.fn(async () => {}),
                materialize: null,
            },
        });

        expect(screen.getTextContent()).toContain('externalSessions.externalAgentRunsOutsideHappier');
        expect(screen.getTextContent()).toContain('externalSessions.externalAgentTakeOverHint');
        expect(screen.getTextContent()).not.toContain('chatFooter.externalSessionTakeoverAvailable');
        expect(screen.findByTestId('session-chatFooter-takeOverDirect')).not.toBeNull();
    });

    it('disables the takeover affordance and exposes busy accessibility state during preflight', async () => {
        const onRequestTakeoverPreflight = vi.fn(async () => {});
        const screen = await renderFooter({
            externalControl: {
                statusKnown: false,
                machineOnline: false,
                runnerActive: false,
                trustedPid: null,
                activity: 'unknown',
                canTakeOverDirect: false,
                canTakeOverPersist: false,
                takeoverPreflightInFlight: true,
                takeoverInFlight: null,
                onRequestTakeoverPreflight,
                materialize: null,
            },
        });

        const action = screen.findByTestId('session-chatFooter-takeOverDirect');
        expect(action?.props.accessibilityState).toEqual({ busy: true, disabled: true });
        expect(action?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('session-chatFooter-takeOverDirect');
        expect(screen.getTextContent()).toContain('chatFooter.checkingExternalSessionTakeover');

        expect(onRequestTakeoverPreflight).not.toHaveBeenCalled();
    });

    it('renders a takeover-in-flight message and hides direct takeover actions while a direct switch is pending', async () => {
        const screen = await renderFooter({
            controlledByUser: false,
            externalControl: {
                statusKnown: true,
                machineOnline: true,
                runnerActive: false,
                activity: 'running',
                takeoverPreflightInFlight: false,
                takeoverInFlight: 'direct',
            },
        } as any);

        expect(screen.getTextContent()).toContain('chatFooter.switchingToDirectTakeover');
        expect(screen.findByTestId('session-chatFooter-takeOverDirect')).toBeNull();
        expect(screen.findByTestId('session-chatFooter-takeOverPersist')).toBeNull();
    });

    it.each([
        ['unknown', 'status.externalStatusUnknown', false, 'neutral'],
        ['working', 'status.workingExternally', false, 'neutral'],
        ['idle', 'status.ready', false, 'neutral'],
        ['waiting', 'status.needsInputExternally', true, 'warning'],
        ['retrying', 'status.retryingExternally', true, 'warning'],
    ] as const)('styles the %s external-Agent footer by whether it needs the user', async (state, labelKey, needsAttention, tone) => {
        const screen = await renderFooter({
            externalControl: {
                statusKnown: true,
                machineOnline: true,
                runnerActive: false,
                trustedPid: null,
                activity: 'idle',
                canTakeOverDirect: true,
                canTakeOverPersist: false,
                takeoverPreflightInFlight: false,
                takeoverInFlight: null,
                onRequestTakeoverPreflight: vi.fn(async () => {}),
                materialize: null,
                externalAgentPresentation: {
                    state,
                    labelKey,
                    needsAttention,
                    agentLabel: 'Codex',
                    machineLabel: 'MacBook Pro',
                },
            },
        });

        const banner = screen.findAllByType(WarningActionBanner)
            .find((instance) => instance.props.testID === 'session-chatFooter-externalControl');
        expect(banner?.props.tone).toBe(tone);
    });

    it('says where an unreported external session runs and what Take over does, instead of an unknown status', async () => {
        const screen = await renderFooter({
            externalControl: {
                statusKnown: false,
                machineOnline: false,
                runnerActive: false,
                trustedPid: null,
                activity: 'unknown',
                canTakeOverDirect: false,
                canTakeOverPersist: false,
                takeoverPreflightInFlight: false,
                takeoverInFlight: null,
                onRequestTakeoverPreflight: vi.fn(async () => {}),
                materialize: null,
                externalAgentPresentation: {
                    state: 'unknown',
                    labelKey: 'status.externalStatusUnknown',
                    needsAttention: false,
                    agentLabel: 'Codex',
                    machineLabel: 'MacBook Pro',
                },
            },
        });

        const text = screen.getTextContent();
        expect(text).toContain('externalSessions.externalAgentRunsOnMachine');
        expect(text).toContain('externalSessions.externalAgentTakeOverHint');
        expect(text).not.toContain('status.externalStatusUnknown');
        expect(screen.findByTestId('session-chatFooter-takeOverDirect')).not.toBeNull();
    });
});
