import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const paneState = vi.hoisted(() => ({
    openRight: vi.fn(),
    setRightTab: vi.fn(),
}));
const cockpitState = vi.hoisted(() => ({
    registration: null as null | Readonly<{
        sessionId: string;
        terminalTabAvailable: boolean;
        switchSurface: (surface: string) => void;
    }>,
}));
const machineState = vi.hoisted(() => ({
    sessionAttachSupported: true as boolean | undefined,
}));
const layoutState = vi.hoisted(() => ({
    windowWidthPx: 1400,
    deviceType: 'tablet' as 'phone' | 'tablet',
    platformOS: 'web' as 'web' | 'ios',
}));
const routerPushSpy = vi.hoisted(() => vi.fn());
const sessionState = vi.hoisted(() => ({
    session: {
        id: 'session-1',
        active: true,
        metadata: {
            flavor: 'claude',
            terminal: {
                mode: 'zellij',
                zellij: {
                    sessionName: 'happier-claude-unified-session-1',
                    paneId: 'terminal_1',
                },
                controlServiceabilityV1: {
                    v: 1,
                    attachmentId: 'attachment-1',
                    state: 'servable',
                    observedAt: 1,
                },
            },
        },
        agentState: {
            localControl: {
                attached: true,
                topology: 'shared',
                canAttach: true,
                canDetach: false,
                remoteWritable: true,
            },
        },
    } as Record<string, unknown> | null,
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: null,
        openRight: paneState.openRight,
        setRightTab: paneState.setRightTab,
    }),
}));

vi.mock('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry', () => ({
    useSessionCockpitChromeRegistration: () => cockpitState.registration,
}));

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => ({ machineId: 'machine-1' }),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: layoutState.windowWidthPx, height: 900 }),
        Platform: Object.defineProperty({}, 'OS', {
            get: () => layoutState.platformOS,
            enumerable: true,
        }) as any,
    });
});

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => layoutState.deviceType,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPushSpy } }).module;
});

vi.mock('@/sync/domains/state/storage', () => ({
    getStorage: () => (selector: (state: any) => unknown) => selector({
        sessions: sessionState.session ? { 'session-1': sessionState.session } : {},
    }),
    // Multi-pane on: the sidebar terminal now asks the shared open decision whether this layout has
    // a right pane at all, so a switched-off setting would send every case to the terminal screen.
    useLocalSetting: (key: string) => (key === 'uiMultiPanePanelsEnabled' ? true : null),
    useMachine: () => ({
        metadata: {
            daemonTerminalSessionAttachSupported: machineState.sessionAttachSupported,
        },
    }),
}));

vi.mock('./useSessionTerminalAvailability', () => ({
    useSessionTerminalAvailability: () => ({
        terminalEnabled: true,
        dockLocation: 'sidebar',
    }),
}));

describe('useOpenAttachedSessionTerminal', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        paneState.openRight.mockReset();
        paneState.setRightTab.mockReset();
        routerPushSpy.mockReset();
        layoutState.windowWidthPx = 1400;
        layoutState.deviceType = 'tablet';
        layoutState.platformOS = 'web';
        cockpitState.registration = null;
        machineState.sessionAttachSupported = true;
        sessionState.session = {
            id: 'session-1',
            active: true,
            metadata: {
                flavor: 'claude',
                terminal: {
                    mode: 'zellij',
                    zellij: {
                        sessionName: 'happier-claude-unified-session-1',
                        paneId: 'terminal_1',
                    },
                    controlServiceabilityV1: {
                        v: 1,
                        attachmentId: 'attachment-1',
                        state: 'servable',
                        observedAt: 1,
                    },
                },
            },
            agentState: {
                localControl: {
                    attached: true,
                    topology: 'shared',
                    canAttach: true,
                    canDetach: false,
                    remoteWritable: true,
                },
            },
        };
    });

    it('switches the matching cockpit session to its terminal surface', async () => {
        const switchSurface = vi.fn();
        cockpitState.registration = {
            sessionId: 'session-1',
            terminalTabAvailable: true,
            switchSurface,
        };
        const { useOpenAttachedSessionTerminal } = await import('./openAttachedSessionTerminal');

        const hook = await renderHook(() => useOpenAttachedSessionTerminal('session-1'));
        hook.getCurrent().open();

        expect(switchSurface).toHaveBeenCalledWith('terminal');
        expect(paneState.openRight).not.toHaveBeenCalled();
        expect(paneState.setRightTab).not.toHaveBeenCalled();
    });

    it('keeps legacy pane docking outside the matching cockpit session', async () => {
        const { useOpenAttachedSessionTerminal } = await import('./openAttachedSessionTerminal');

        const hook = await renderHook(() => useOpenAttachedSessionTerminal('session-1'));
        hook.getCurrent().open();

        expect(paneState.openRight).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(paneState.setRightTab).toHaveBeenCalledWith('terminal');
    });

    it('opens the terminal screen instead of a hidden right pane on a phone layout', async () => {
        // The overflow item's phone path. Outside the cockpit it docked to `sidebar`, which is the
        // right pane, which no phone draws — the same dead control as the header terminal button.
        layoutState.deviceType = 'phone';
        layoutState.platformOS = 'ios';
        layoutState.windowWidthPx = 390;
        const { useOpenAttachedSessionTerminal } = await import('./openAttachedSessionTerminal');

        const hook = await renderHook(() => useOpenAttachedSessionTerminal('session-1'));
        hook.getCurrent().open();

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/terminal');
        expect(paneState.openRight).not.toHaveBeenCalled();
    });

    it('fails closed when the target daemon does not advertise typed session attach', async () => {
        machineState.sessionAttachSupported = undefined;
        const { useOpenAttachedSessionTerminal } = await import('./openAttachedSessionTerminal');

        const hook = await renderHook(() => useOpenAttachedSessionTerminal('session-1'));
        hook.getCurrent().open();

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            available: false,
            unavailableReason: 'cli_update_required',
        }));
        expect(paneState.openRight).not.toHaveBeenCalled();
        expect(paneState.setRightTab).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'Codex terminal session',
            session: {
                id: 'session-1',
                active: true,
                metadata: {
                    flavor: 'codex',
                    terminal: {
                        mode: 'zellij',
                        controlServiceabilityV1: {
                            v: 1,
                            attachmentId: 'attachment-codex',
                            state: 'servable',
                            observedAt: 1,
                        },
                    },
                },
                agentState: {
                    localControl: {
                        attached: true,
                        topology: 'shared',
                        canAttach: true,
                        remoteWritable: true,
                    },
                },
            },
        },
        {
            name: 'Pi session',
            session: {
                id: 'session-1',
                active: true,
                metadata: {
                    flavor: 'pi',
                    terminal: {
                        mode: 'zellij',
                        controlServiceabilityV1: {
                            v: 1,
                            attachmentId: 'attachment-pi',
                            state: 'servable',
                            observedAt: 1,
                        },
                    },
                },
                agentState: {
                    localControl: {
                        attached: true,
                        topology: 'shared',
                        canAttach: true,
                        remoteWritable: true,
                    },
                },
            },
        },
        {
            name: 'custom ACP session',
            session: {
                id: 'session-1',
                active: true,
                metadata: {
                    flavor: 'customAcp',
                    terminal: {
                        mode: 'zellij',
                        controlServiceabilityV1: {
                            v: 1,
                            attachmentId: 'attachment-acp',
                            state: 'servable',
                            observedAt: 1,
                        },
                    },
                },
                agentState: {
                    localControl: {
                        attached: true,
                        topology: 'shared',
                        canAttach: true,
                        remoteWritable: true,
                    },
                },
            },
        },
        {
            name: 'Claude Agent SDK session',
            session: {
                id: 'session-1',
                active: true,
                metadata: {
                    flavor: 'claude',
                },
                agentState: {
                    localControl: null,
                },
            },
        },
        {
            name: 'stopped Claude Unified session',
            session: {
                id: 'session-1',
                active: false,
                metadata: {
                    flavor: 'claude',
                    terminal: {
                        mode: 'zellij',
                        controlServiceabilityV1: {
                            v: 1,
                            attachmentId: 'attachment-stopped',
                            state: 'servable',
                            observedAt: 1,
                        },
                    },
                },
                agentState: {
                    localControl: {
                        attached: true,
                        topology: 'shared',
                        canAttach: true,
                        remoteWritable: true,
                    },
                },
            },
        },
        {
            name: 'uncontrollable Claude Unified session',
            session: {
                id: 'session-1',
                active: true,
                metadata: {
                    flavor: 'claude',
                    terminal: {
                        mode: 'zellij',
                        controlServiceabilityV1: {
                            v: 1,
                            attachmentId: 'attachment-unservable',
                            state: 'recoverable_unservable',
                            observedAt: 1,
                        },
                    },
                },
                agentState: {
                    localControl: {
                        attached: true,
                        topology: 'shared',
                        canAttach: true,
                        remoteWritable: true,
                    },
                },
            },
        },
    ])('hides attached terminal control for a $name', async ({ session }) => {
        sessionState.session = session;
        const { useOpenAttachedSessionTerminal } = await import('./openAttachedSessionTerminal');

        const hook = await renderHook(() => useOpenAttachedSessionTerminal('session-1'));
        hook.getCurrent().open();

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            available: false,
            unavailableReason: 'session_not_attachable',
        }));
        expect(paneState.openRight).not.toHaveBeenCalled();
        expect(paneState.setRightTab).not.toHaveBeenCalled();
    });
});
