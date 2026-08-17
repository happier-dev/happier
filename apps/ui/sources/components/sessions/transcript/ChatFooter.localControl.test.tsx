import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks, resetTranscriptCommonModuleMockState } from './transcriptTestHelpers';
import { ChatFooter } from './ChatFooter';

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

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
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
                    agentLabel: null,
                    machineLabel: null,
                },
            },
        });

        expect(screen.getTextContent()).toContain('status.externalStatusUnknown');
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

    it('renders Import into Happier as a separate primary external-session action', async () => {
        const onRequestMaterialize = vi.fn(async () => {});
        const screen = await renderFooter({
            externalControl: {
                statusKnown: true,
                machineOnline: true,
                runnerActive: true,
                activity: 'running',
                takeoverPreflightInFlight: false,
                takeoverInFlight: null,
                materialize: {
                    requestEnabled: true,
                    inFlight: false,
                    onRequest: onRequestMaterialize,
                },
            },
        } as any);

        expect(screen.findByTestId('session-chatFooter-importIntoHappier')).not.toBeNull();
        expect(screen.getTextContent()).toContain('externalSessions.operationTitleMaterialize');

        await act(async () => {
            screen.pressByTestId('session-chatFooter-importIntoHappier');
        });

        expect(onRequestMaterialize).toHaveBeenCalledTimes(1);
    });

    it('keeps Import into Happier available to perform its current-status preflight', async () => {
        const onRequestMaterialize = vi.fn(async () => {});
        const screen = await renderFooter({
            externalControl: {
                statusKnown: false,
                machineOnline: false,
                runnerActive: false,
                activity: 'unknown',
                takeoverPreflightInFlight: false,
                takeoverInFlight: null,
                materialize: {
                    requestEnabled: true,
                    inFlight: false,
                    onRequest: onRequestMaterialize,
                },
            },
        } as any);

        const action = screen.findByTestId('session-chatFooter-importIntoHappier');
        expect(action?.props.disabled).toBe(false);
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

        expect(screen.getTextContent()).toContain('status.externalStatusUnknown');
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
        expect(action?.props.onPress).toBeUndefined();
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
});
