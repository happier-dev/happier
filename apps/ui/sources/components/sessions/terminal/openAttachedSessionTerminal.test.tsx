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
const sessionState = vi.hoisted(() => ({
    session: {
        id: 'session-1',
        active: true,
        metadata: {
            flavor: 'claude',
            terminal: {
                mode: 'zellij',
                controlServiceabilityV1: {
                    v: 1,
                    attachmentId: 'attachment-1',
                    state: 'servable',
                    observedAt: 1,
                },
            },
        },
        agentState: null,
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

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: Object.assign(
            (selector?: (state: any) => unknown) => {
                const state = {
                    sessions: sessionState.session ? { 'session-1': sessionState.session } : {},
                };
                return typeof selector === 'function' ? selector(state) : state;
            },
            {
                getState: () => ({
                    sessions: sessionState.session ? { 'session-1': sessionState.session } : {},
                }),
                setState: () => undefined,
                subscribe: () => () => undefined,
            },
        ),
        useMachine: () => ({
            metadata: {
                daemonTerminalSessionAttachSupported: machineState.sessionAttachSupported,
            },
        }),
    });
});

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
        cockpitState.registration = null;
        machineState.sessionAttachSupported = true;
        sessionState.session = {
            id: 'session-1',
            active: true,
            metadata: {
                flavor: 'claude',
                terminal: {
                    mode: 'zellij',
                    controlServiceabilityV1: {
                        v: 1,
                        attachmentId: 'attachment-1',
                        state: 'servable',
                        observedAt: 1,
                    },
                },
            },
            agentState: null,
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

    it('keeps configured pane docking outside the matching cockpit session', async () => {
        const { useOpenAttachedSessionTerminal } = await import('./openAttachedSessionTerminal');

        const hook = await renderHook(() => useOpenAttachedSessionTerminal('session-1'));
        hook.getCurrent().open();

        expect(paneState.openRight).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(paneState.setRightTab).toHaveBeenCalledWith('terminal');
    });

    it.each([undefined, false])(
        'fails closed when the target daemon advertises session attach as %s despite a current session runner',
        async (sessionAttachSupported) => {
            machineState.sessionAttachSupported = sessionAttachSupported;
            const { useOpenAttachedSessionTerminal } = await import('./openAttachedSessionTerminal');

            const hook = await renderHook(() => useOpenAttachedSessionTerminal('session-1'));
            hook.getCurrent().open();

            expect(hook.getCurrent()).toEqual(expect.objectContaining({
                available: false,
                unavailableReason: 'cli_update_required',
            }));
            expect(paneState.openRight).not.toHaveBeenCalled();
            expect(paneState.setRightTab).not.toHaveBeenCalled();
        },
    );

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
                agentState: null,
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
                agentState: null,
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
                agentState: null,
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
                agentState: null,
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
                agentState: null,
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
                agentState: null,
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
