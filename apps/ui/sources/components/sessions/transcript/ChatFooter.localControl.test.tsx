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
                button: {
                    primary: {
                        tint: '#ffffff',
                    },
                },
                box: { warning: { background: '#fff3cd', text: '#856404' } },
            },
        });
    },
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
        translate: (key: string) => key,
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
}));

vi.mock('@/components/sessions/SessionNoticeBanner', () => ({
    SessionNoticeBanner: () => null,
}));

async function renderFooter(props: React.ComponentProps<typeof ChatFooter>) {
    return renderScreen(<ChatFooter {...props} />);
}

function findTextNode(screen: Awaited<ReturnType<typeof renderFooter>>, text: string) {
    return screen.findAll((node) => String(node.type) === 'Text' && node.props?.children === text)[0] ?? null;
}

function resolveStyleColor(style: unknown): string | undefined {
    const styles = Array.isArray(style) ? style : [style];

    for (const entry of styles) {
        if (entry && typeof entry === 'object' && 'color' in entry && typeof entry.color === 'string') {
            return entry.color.toLowerCase();
        }
    }

    return undefined;
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

    it('renders direct takeover actions for linked direct sessions that are not yet controlled by Happier', async () => {
        const onRequestTakeOverDirect = vi.fn();
        const onRequestTakeOverPersist = vi.fn();
        const screen = await renderFooter({
            controlledByUser: false,
            directControl: {
                machineOnline: true,
                runnerActive: false,
                activity: 'active_recently',
                canTakeOverDirect: true,
                canTakeOverPersist: true,
                takeoverInFlight: null,
                onRequestTakeOverDirect,
                onRequestTakeOverPersist,
            },
        } as any);

        expect(screen.getTextContent()).toContain('chatFooter.directSessionTakeoverAvailable');
        expect(screen.findByTestId('session-chatFooter-takeOverDirect')).not.toBeNull();
        expect(screen.findByTestId('session-chatFooter-takeOverPersist')).not.toBeNull();
        expect(resolveStyleColor(findTextNode(screen, 'chatFooter.takeOverDirect')?.props.style)).toBe('#ffffff');
        expect(resolveStyleColor(findTextNode(screen, 'chatFooter.takeOverPersist')?.props.style)).toBe('#ffffff');

        await act(async () => {
            screen.pressByTestId('session-chatFooter-takeOverDirect');
            screen.pressByTestId('session-chatFooter-takeOverPersist');
        });

        expect(onRequestTakeOverDirect).toHaveBeenCalledTimes(1);
        expect(onRequestTakeOverPersist).toHaveBeenCalledTimes(1);
    });

    it('renders a takeover-in-flight message and hides direct takeover actions while a direct switch is pending', async () => {
        const screen = await renderFooter({
            controlledByUser: false,
            directControl: {
                machineOnline: true,
                runnerActive: false,
                activity: 'running',
                canTakeOverDirect: true,
                canTakeOverPersist: true,
                takeoverInFlight: 'direct',
            },
        } as any);

        expect(screen.getTextContent()).toContain('chatFooter.switchingToDirectTakeover');
        expect(screen.findByTestId('session-chatFooter-takeOverDirect')).toBeNull();
        expect(screen.findByTestId('session-chatFooter-takeOverPersist')).toBeNull();
    });
});
