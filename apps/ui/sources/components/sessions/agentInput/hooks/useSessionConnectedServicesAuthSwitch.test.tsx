import { renderHook } from '@/dev/testkit/hooks/renderHook';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { AGENTS_CORE } from '@happier-dev/agents';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS, CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentInputContentPopoverRenderArgs } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { installNewSessionModulesCommonModuleMocks } from '@/components/sessions/new/modules/newSessionModulesTestHelpers';

const useFeatureEnabledMock = vi.hoisted(() => vi.fn());
const setSessionConnectedServiceAuthBindingMock = vi.hoisted(() => vi.fn());
const modalAlertMock = vi.hoisted(() => vi.fn());
const modalConfirmMock = vi.hoisted(() => vi.fn());
const routerPushMock = vi.hoisted(() => vi.fn());
const profileState = vi.hoisted(() => ({
    current: {
        connectedServicesV2: [
            {
                serviceId: 'anthropic',
                profiles: [
                    {
                        profileId: 'work',
                        status: 'connected',
                        kind: 'token',
                        providerEmail: 'work@example.com',
                    },
                ],
                groups: [
                    {
                        groupId: 'team',
                        displayName: 'Team',
                        activeProfileId: 'work',
                        generation: 7,
                        memberProfileIds: ['work'],
                    },
                ],
            },
            {
                serviceId: 'openai-codex',
                profiles: [
                    {
                        profileId: 'happier',
                        status: 'connected',
                        kind: 'oauth',
                        providerEmail: 'happier@example.com',
                    },
                ],
                groups: [],
            },
        ],
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: (...args: unknown[]) => routerPushMock(...args),
        },
    }).module;
});

installNewSessionModulesCommonModuleMocks({
    modal: () => ({
        Modal: {
            alert: (...args: unknown[]) => modalAlertMock(...args),
            confirm: (...args: unknown[]) => modalConfirmMock(...args),
        },
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: 'Pressable',
            Platform: {
                OS: 'web',
                select: (spec: Record<string, unknown>) => spec.web ?? spec.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => {
                if (key === 'connectedServices.authChip.connectedCountLabel') {
                    return `${String(params?.count ?? '')} connected`;
                }
                if (key === 'connectedServices.authSwitch.status.restarting') {
                    return 'Restarting session';
                }
                if (key.startsWith('connectedServices.diagnostics.body.') && params) {
                    return `${key}:${JSON.stringify(params)}`;
                }
                return key;
            },
        });
    },
});

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputChipLabel', () => ({
    AgentInputChipLabel: 'AgentInputChipLabel',
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (...args: unknown[]) => useFeatureEnabledMock(...args),
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => profileState.current,
}));

vi.mock('@/sync/ops/connectedServices/sessionAuthSwitch', () => ({
    setSessionConnectedServiceAuthBinding: (...args: unknown[]) => setSessionConnectedServiceAuthBindingMock(...args),
}));

function renderChipPopover(
    renderContent: React.ReactNode | ((args: AgentInputContentPopoverRenderArgs) => React.ReactNode) | undefined,
    overrides: Partial<AgentInputContentPopoverRenderArgs> = {},
): React.ReactNode {
    if (typeof renderContent !== 'function') {
        throw new Error('Expected connected-services auth chip to provide popover content');
    }
    return renderContent({
        requestClose: vi.fn(),
        maxHeight: 420,
        ...overrides,
    });
}

describe('useSessionConnectedServicesAuthSwitch', () => {
    beforeEach(() => {
        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [
                        {
                            profileId: 'work',
                            status: 'connected',
                            kind: 'token',
                            providerEmail: 'work@example.com',
                        },
                    ],
                    groups: [
                        {
                            groupId: 'team',
                            displayName: 'Team',
                            activeProfileId: 'work',
                            generation: 7,
                            memberProfileIds: ['work'],
                        },
                    ],
                },
                {
                    serviceId: 'openai-codex',
                    profiles: [
                        {
                            profileId: 'happier',
                            status: 'connected',
                            kind: 'oauth',
                            providerEmail: 'happier@example.com',
                        },
                    ],
                    groups: [],
                },
            ],
        };
        useFeatureEnabledMock.mockReset();
        useFeatureEnabledMock.mockReturnValue(true);
        setSessionConnectedServiceAuthBindingMock.mockReset();
        setSessionConnectedServiceAuthBindingMock.mockResolvedValue({ ok: true, action: 'restart_requested' });
        modalAlertMock.mockReset();
        modalConfirmMock.mockReset();
        modalConfirmMock.mockResolvedValue(true);
        routerPushMock.mockReset();
    });

    it('shows the active session connected profile in the auth chip label', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const chip = hook.getCurrent().connectedServicesAuthChip;
        expect(chip).toEqual(expect.objectContaining({
            key: 'session-connected-services-auth',
            controlId: 'connectedServices',
        }));
        expect(chip?.collapsedContentPopover?.label).toBe('Anthropic: Work');

        const renderedChip = chip!.render({
            chipStyle: () => null,
            iconColor: '#000',
            showLabel: true,
            textStyle: null,
            countTextStyle: null,
            chipAnchorRef: { current: null },
            popoverAnchorRef: { current: null },
            toggleCollapsedPopover: vi.fn(),
        }) as React.ReactElement<{ testID?: string; dataSet?: { authSource?: string } }>;

        expect(renderedChip.props.testID).toBe('session-connected-services-auth-chip');
        expect(renderedChip.props.dataSet?.authSource).toBe('connected');
        await hook.unmount();
    });

    it('recovers the active Codex connected profile from the runtime descriptor when session bindings are missing', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        sessionAuthSwitch: { continuityMode: 'restart_shared_state_required' },
                    },
                },
                sessionMetadata: {
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        providerId: 'codex',
                        provider: {
                            backendMode: 'appServer',
                            home: 'connectedService',
                            connectedServiceId: 'openai-codex',
                            connectedServiceProfileId: 'happier',
                            providerExtra: {
                                owner: 'codex',
                                schemaId: 'codex.agentRuntimeDescriptorExtra',
                                v: 1,
                                runtimeAffinity: {
                                    backendMode: 'appServer',
                                    home: 'connectedService',
                                    connectedServiceId: 'openai-codex',
                                    connectedServiceProfileId: 'happier',
                                },
                            },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'openai-codex/happier': 'Happier' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
            .toBe('Codex: Happier');

        await hook.unmount();
    });

    it('surfaces a reconnect action for the active bound profile when credential health requires reauth', async () => {
        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [{
                        profileId: 'work',
                        status: 'needs_reauth',
                        kind: 'oauth',
                        providerEmail: 'work@example.com',
                    }],
                    groups: [],
                },
            ],
        };
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
            .toBe('Anthropic: Work');

        const requestClose = vi.fn();
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
            { requestClose },
        ) as React.ReactElement<{
            onReconnectProfile: (serviceId: string, profileId: string) => void;
        }>;

        await act(async () => {
            popover.props.onReconnectProfile('anthropic', 'work');
        });

        expect(requestClose).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith({
            pathname: '/settings/connected-services/oauth',
            params: { serviceId: 'anthropic', profileId: 'work' },
        });

        await hook.unmount();
    });

    it('routes supported auth changes through the session auth-switch operation after confirmation', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
        });

        expect(modalConfirmMock).toHaveBeenCalledWith(
            'connectedServices.authSwitch.confirmTitle',
            'connectedServices.authSwitch.confirmBody',
            { confirmText: 'connectedServices.authSwitch.confirmAction' },
        );
        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
                },
            },
        });
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
            .toBe('Anthropic: Work');

        await hook.unmount();
    });

    it('uses the latest stopped-session state after rerendering from active to inactive', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const agentCore = {
            id: 'claude',
            connectedServices: {
                supportedServiceIds: ['anthropic'],
                sessionAuthSwitch: { continuityMode: 'restart_same_home' },
            },
        } as const;
        const sessionMetadata = {
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: { source: 'native' },
                },
            },
        } as const;
        const settings = {
            connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
            connectedServicesDefaultProfileByServiceId: {},
        } as const;
        type HookProps = Readonly<{
            sessionActive: boolean;
            binding?: unknown;
        }>;
        const buildHookProps = (props: HookProps) => ({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            agentCore,
            sessionMetadata,
            settings,
            switchingDisabledReason: null,
            sessionActive: props.sessionActive,
        } as const);

        const hook = await renderHook(
            (props: HookProps) => useSessionConnectedServicesAuthSwitch(buildHookProps(props)),
            { initialProps: { sessionActive: true } },
        );

        await hook.rerender({ sessionActive: false });

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
        });

        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledOnce();

        await hook.unmount();
    });

    it('uses the latest active-session state after rerendering from inactive to active', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const agentCore = {
            id: 'claude',
            connectedServices: {
                supportedServiceIds: ['anthropic'],
                sessionAuthSwitch: { continuityMode: 'restart_same_home' },
            },
        } as const;
        const sessionMetadata = {
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: { source: 'native' },
                },
            },
        } as const;
        const settings = {
            connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
            connectedServicesDefaultProfileByServiceId: {},
        } as const;
        type HookProps = Readonly<{
            sessionActive: boolean;
            binding?: unknown;
        }>;
        const buildHookProps = (props: HookProps) => ({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            agentCore,
            sessionMetadata,
            settings,
            switchingDisabledReason: null,
            sessionActive: props.sessionActive,
        } as const);

        const hook = await renderHook(
            (props: HookProps) => useSessionConnectedServicesAuthSwitch(buildHookProps(props)),
            { initialProps: { sessionActive: false } as HookProps },
        );

        await hook.rerender({ sessionActive: true });

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
        });

        expect(modalConfirmMock).toHaveBeenCalledWith(
            'connectedServices.authSwitch.confirmTitle',
            'connectedServices.authSwitch.confirmBody',
            { confirmText: 'connectedServices.authSwitch.confirmAction' },
        );
        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledOnce();

        await hook.unmount();
    });

    it('reports restart intent without adding a secondary status badge', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        type HookProps = Readonly<{
            sessionActive: boolean;
            binding?: unknown;
        }>;
        const buildHookProps = (props: HookProps) => ({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            agentCore: {
                id: 'claude',
                connectedServices: {
                    supportedServiceIds: ['anthropic'],
                    sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                },
            },
            sessionMetadata: {
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        anthropic: props.binding ?? { source: 'native' },
                    },
                },
            },
            settings: {
                connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                connectedServicesDefaultProfileByServiceId: {},
            },
            switchingDisabledReason: null,
            sessionActive: props.sessionActive,
        } as const);

        const hook = await renderHook(
            (props: HookProps) => useSessionConnectedServicesAuthSwitch(buildHookProps(props)),
            { initialProps: { sessionActive: false } as HookProps },
        );
        const requestedBinding = {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
        };
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('anthropic', requestedBinding);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(hook.getCurrent().statusBadges).toEqual([]);
        expect(hook.getCurrent().restartState).toEqual(expect.objectContaining({
            status: 'restarting',
            attemptId: 'manual-auth-switch:1',
            reason: 'manual_auth_switch',
        }));

        await hook.rerender({ sessionActive: true, binding: requestedBinding });

        expect(hook.getCurrent().statusBadges).toEqual([]);
        expect(hook.getCurrent().restartState).toBeNull();
        await hook.unmount();
    });

    it('clears restart intent when daemon materializes the selected group with its active profile id', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        type HookProps = Readonly<{
            sessionActive: boolean;
            binding?: unknown;
        }>;
        const buildHookProps = (props: HookProps) => ({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            agentCore: {
                id: 'claude',
                connectedServices: {
                    supportedServiceIds: ['anthropic'],
                    sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                },
            },
            sessionMetadata: {
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        anthropic: props.binding ?? { source: 'native' },
                    },
                },
            },
            settings: {
                connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                connectedServicesDefaultProfileByServiceId: {},
            },
            switchingDisabledReason: null,
            sessionActive: props.sessionActive,
        } as const);

        const hook = await renderHook(
            (props: HookProps) => useSessionConnectedServicesAuthSwitch(buildHookProps(props)),
            { initialProps: { sessionActive: false } as HookProps },
        );
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'group',
                groupId: 'team',
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(hook.getCurrent().restartState).toEqual(expect.objectContaining({
            status: 'restarting',
            attemptId: 'manual-auth-switch:1',
            reason: 'manual_auth_switch',
        }));

        await hook.rerender({
            sessionActive: true,
            binding: {
                source: 'connected',
                selection: 'group',
                groupId: 'team',
                profileId: 'work',
            },
        });

        expect(hook.getCurrent().restartState).toBeNull();
        await hook.unmount();
    });

    it('keeps restart state while the active session has not yet applied the requested binding', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const requestedBinding = {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
        };
        type HookProps = Readonly<{
            sessionActive: boolean;
            binding?: unknown;
        }>;
        const buildHookProps = (props: HookProps) => ({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            agentCore: {
                id: 'claude',
                connectedServices: {
                    supportedServiceIds: ['anthropic'],
                    sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                },
            },
            sessionMetadata: {
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        anthropic: props.binding ?? { source: 'native' },
                    },
                },
            },
            settings: {
                connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                connectedServicesDefaultProfileByServiceId: {},
            },
            switchingDisabledReason: null,
            sessionActive: props.sessionActive,
        } as const);

        const hook = await renderHook(
            (props: HookProps) => useSessionConnectedServicesAuthSwitch(buildHookProps(props)),
            { initialProps: { sessionActive: false } as HookProps },
        );
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('anthropic', requestedBinding);
            await Promise.resolve();
            await Promise.resolve();
        });

        await hook.rerender({ sessionActive: true });

        expect(hook.getCurrent().restartState).toEqual(expect.objectContaining({
            status: 'restarting',
            attemptId: 'manual-auth-switch:1',
            reason: 'manual_auth_switch',
        }));

        await hook.rerender({ sessionActive: true, binding: requestedBinding });

        expect(hook.getCurrent().restartState).toBeNull();
        await hook.unmount();
    });

    it('keeps elapsed restart intent pending confirmation until positive failure evidence arrives', async () => {
        vi.useFakeTimers();
        const { useSessionConnectedServicesAuthSwitch, CONNECTED_SERVICES_AUTH_SWITCH_RESTART_FAILSAFE_MS } = await import('./useSessionConnectedServicesAuthSwitch');

        type HookProps = Readonly<{ sessionActive: boolean }>;
        const buildHookProps = (props: HookProps) => ({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            agentCore: {
                id: 'claude',
                connectedServices: {
                    supportedServiceIds: ['anthropic'],
                    sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                },
            },
            sessionMetadata: {
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        anthropic: { source: 'native' },
                    },
                },
            },
            settings: {
                connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                connectedServicesDefaultProfileByServiceId: {},
            },
            switchingDisabledReason: null,
            sessionActive: props.sessionActive,
        } as const);

        const hook = await renderHook(
            (props: HookProps) => useSessionConnectedServicesAuthSwitch(buildHookProps(props)),
            { initialProps: { sessionActive: false } },
        );
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(hook.getCurrent().restartState?.status).toBe('restarting');

        await act(async () => {
            await vi.advanceTimersByTimeAsync(CONNECTED_SERVICES_AUTH_SWITCH_RESTART_FAILSAFE_MS);
        });

        expect(hook.getCurrent().restartState).toEqual(expect.objectContaining({
            status: 'pending_confirmation',
            attemptId: 'manual-auth-switch:1',
            reason: 'manual_auth_switch',
        }));

        await hook.unmount();
        vi.useRealTimers();
    });

    it.each([
        ['runtime auth recovery', 'runtime_auth_recovery'],
        ['refresh-triggered recovery', 'refresh_auth_update'],
        ['usage-limit account switch', 'usage_limit_account_switch'],
    ] as const)('surfaces shared intentional restart signals from %s', async (_label, reason) => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        const startedAtMs = Date.now();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
                sessionActive: false,
                intentionalRestartSignals: [{
                    status: 'restarting',
                    attemptId: `${reason}:1`,
                    reason,
                    startedAtMs,
                }],
            }),
        );

        expect(hook.getCurrent().restartState).toEqual({
            status: 'restarting',
            attemptId: `${reason}:1`,
            reason,
            startedAtMs,
        });

        await hook.unmount();
    });

    it('shows stopped-session switches as pending until the next resume', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({ ok: true, action: 'metadata_updated' });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
                sessionActive: false,
            }),
        );
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
        });

        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledOnce();
        expect(hook.getCurrent().statusBadges).toEqual([expect.objectContaining({
            key: 'connected-services-auth-switch-pending-resume',
            label: 'connectedServices.authSwitch.status.appliesOnNextResume',
            tone: 'complete',
        })]);
        await hook.unmount();
    });

    it('routes needs-reauth profiles from the session auth popover to the reconnect flow', async () => {
        profileState.current = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{
                    profileId: 'happier',
                    status: 'needs_reauth',
                    kind: 'oauth',
                    providerEmail: 'happier@example.com',
                }],
                groups: [],
            }],
        };
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'openai-codex/happier': 'Happier' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ onReconnectProfile: (serviceId: string, profileId: string) => void }>;

        act(() => {
            popover.props.onReconnectProfile('openai-codex', 'happier');
        });

        expect(routerPushMock).toHaveBeenCalledWith({
            pathname: '/settings/connected-services/oauth',
            params: { serviceId: 'openai-codex', profileId: 'happier' },
        });
        expect(setSessionConnectedServiceAuthBindingMock).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('keeps auth selection unchanged when switch confirmation is cancelled', async () => {
        modalConfirmMock.mockResolvedValueOnce(false);
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
        });

        expect(setSessionConnectedServiceAuthBindingMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
            .toBe('connectedServices.authChip.nativeLabel');

        await hook.unmount();
    });

    it('keeps auth selection unchanged when no machine RPC target is available', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: null,
                serverId: 'server-1',
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{
            resolveOptionAvailability: (params: {
                serviceId: string;
                binding: { source: string; selection?: string; profileId?: string };
            }) => { disabled?: boolean; subtitle?: string };
            setBindingForService: (serviceId: string, binding: unknown) => void;
        }>;

        expect(popover.props.resolveOptionAvailability({
            serviceId: 'anthropic',
            binding: { source: 'connected', selection: 'profile', profileId: 'work' },
        })).toEqual({ disabled: true });

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
        });

        expect(setSessionConnectedServiceAuthBindingMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
            .toBe('connectedServices.authChip.nativeLabel');

        await hook.unmount();
    });

    it('allows provider-session switch options while active-turn deferral is enabled', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: 'active_turn',
            }),
        );

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{
            resolveOptionAvailability: (params: {
                binding: { source: string; selection?: string; profileId?: string };
            }) => { disabled?: boolean; subtitle?: string };
            setBindingForService: (serviceId: string, binding: unknown) => void;
        }>;

        expect(popover.props.resolveOptionAvailability({
            binding: { source: 'connected', selection: 'profile', profileId: 'work' },
        })).toEqual({});
        expect(popover.props.resolveOptionAvailability({
            binding: { source: 'native' },
        })).toEqual({});

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
        });

        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
                },
            },
        });

        await hook.unmount();
    });

    it('opens connected-services settings from unavailable auth rows', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            openai: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );
        const modalOrder: string[] = [];
        modalConfirmMock.mockImplementationOnce(() => {
            modalOrder.push('confirm');
            return Promise.resolve(true);
        });
        const requestClose = vi.fn(() => {
            modalOrder.push('close');
        });
        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected connected-services popover content');
        const popover = renderContent({
            requestClose,
            maxHeight: 420,
        }) as React.ReactElement<{ onOpenSettings: () => void }>;

        await act(async () => {
            popover.props.onOpenSettings();
        });

        expect(requestClose).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith('/settings/connected-services');

        await hook.unmount();
    });

    it('keeps only the current provider-session auth option enabled while read-only', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: 'read_only',
            }),
        );

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{
            resolveOptionAvailability: (params: {
                serviceId: string;
                binding: { source: string; selection?: string; profileId?: string };
            }) => { disabled?: boolean; subtitle?: string };
        }>;

        expect(popover.props.resolveOptionAvailability({
            serviceId: 'anthropic',
            binding: { source: 'connected', selection: 'profile', profileId: 'work' },
        })).toEqual({});
        expect(popover.props.resolveOptionAvailability({
            serviceId: 'anthropic',
            binding: { source: 'native' },
        })).toEqual({
            disabled: true,
            subtitle: 'connectedServices.authSwitch.readOnlyDisabled',
        });
        expect(popover.props.resolveOptionAvailability({
            serviceId: 'anthropic',
            binding: { source: 'connected', selection: 'profile', profileId: 'other' },
        })).toEqual({
            disabled: true,
            subtitle: 'connectedServices.authSwitch.readOnlyDisabled',
        });

        await hook.unmount();
    });

    it('disables changing auth options when the agent does not advertise provider-session switch continuity', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{
            resolveOptionAvailability: (params: {
                serviceId: string;
                binding: { source: string; selection?: string; profileId?: string };
            }) => { disabled?: boolean; subtitle?: string };
        }>;

        expect(popover.props.resolveOptionAvailability({
            serviceId: 'anthropic',
            binding: { source: 'native' },
        })).toEqual({});
        expect(popover.props.resolveOptionAvailability({
            serviceId: 'anthropic',
            binding: { source: 'connected', selection: 'profile', profileId: 'work' },
        })).toEqual({ disabled: true });

        await hook.unmount();
    });

    it('lets Gemini native-to-connected session switches reach the daemon when advertised by the manifest', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'gemini',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.gemini,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            gemini: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'gemini/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{
            resolveOptionAvailability: (params: {
                serviceId: string;
                binding: { source: string; selection?: string; profileId?: string };
            }) => { disabled?: boolean; subtitle?: string };
            setBindingForService: (serviceId: string, binding: unknown) => void;
        }>;

        expect(popover.props.resolveOptionAvailability({
            serviceId: 'gemini',
            binding: { source: 'connected', selection: 'profile', profileId: 'work' },
        })).toEqual({});

        await act(async () => {
            popover.props.setBindingForService('gemini', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            agentId: 'gemini',
            machineId: 'machine-1',
            serverId: 'server-1',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    gemini: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
        });

        await hook.unmount();
    });

    it('lets the daemon return provider-state-sharing-required for Codex transitions when sharing is disabled', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'provider_state_sharing_required',
            serviceId: 'openai-codex',
        });
        modalConfirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        sessionAuthSwitch: {
                            continuityMode: 'restart_shared_state_required',
                            supportedTransitions: ['same_connected_group'],
                            providerStateSharingRequired: {
                                serviceIds: ['openai-codex'],
                                supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
                            },
                        },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'openai-codex/happier': 'Happier' },
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesProviderStateSharingSettingsV1: {
                        v: 1,
                        defaults: { configMode: 'linked', stateMode: 'isolated' },
                        byAgentId: {},
                        acknowledgedRisksByAgentId: {},
                    },
                },
                switchingDisabledReason: null,
            }),
        );

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{
            resolveOptionAvailability: (params: {
                serviceId: string;
                binding: { source: string; selection?: string; profileId?: string };
            }) => { disabled?: boolean; subtitle?: string };
            setBindingForService: (serviceId: string, binding: unknown) => void;
        }>;

        expect(popover.props.resolveOptionAvailability({
            serviceId: 'openai-codex',
            binding: { source: 'connected', selection: 'profile', profileId: 'happier' },
        })).toEqual({});

        await act(async () => {
            popover.props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            agentId: 'codex',
            machineId: 'machine-1',
            serverId: 'server-1',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'happier',
                    },
                },
            },
        });
        expect(hook.getCurrent().actionableState).toEqual({
            kind: 'provider_state_sharing_required',
            route: '/settings/connected-services/provider-state-sharing',
            serviceId: 'openai-codex',
        });

        await hook.unmount();
    });

    it('enables Codex native-to-connected session switches when provider state sharing is shared', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        sessionAuthSwitch: {
                            continuityMode: 'restart_shared_state_required',
                            supportedTransitions: ['same_connected_group'],
                            providerStateSharingRequired: {
                                serviceIds: ['openai-codex'],
                                supportedTransitions: ['native_to_connected', 'connected_to_native', 'connected_to_connected'],
                            },
                        },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'openai-codex/happier': 'Happier' },
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesProviderStateSharingSettingsV1: {
                        v: 1,
                        defaults: { configMode: 'linked', stateMode: 'isolated' },
                        byAgentId: {
                            codex: { stateMode: 'shared' },
                        },
                        acknowledgedRisksByAgentId: {},
                    },
                },
                switchingDisabledReason: null,
            }),
        );

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{
            resolveOptionAvailability: (params: {
                serviceId: string;
                binding: { source: string; selection?: string; profileId?: string };
            }) => { disabled?: boolean; subtitle?: string };
            setBindingForService: (serviceId: string, binding: unknown) => void;
        }>;

        expect(popover.props.resolveOptionAvailability({
            serviceId: 'openai-codex',
            binding: { source: 'connected', selection: 'profile', profileId: 'happier' },
        })).toEqual({});

        await act(async () => {
            popover.props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            agentId: 'codex',
            machineId: 'machine-1',
            serverId: 'server-1',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'happier',
                    },
                },
            },
        });

        await hook.unmount();
    });

    it('surfaces provider-state-sharing-required switch failures as an actionable settings state', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'provider_state_sharing_required',
            serviceId: 'openai-codex',
        });
        modalConfirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        sessionAuthSwitch: {
                            continuityMode: 'restart_shared_state_required',
                            supportedTransitions: ['native_to_connected'],
                        },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'openai-codex/happier': 'Happier' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
                sessionActive: true,
            }),
        );
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(modalConfirmMock).toHaveBeenLastCalledWith(
            'connectedServices.providerStateSharing.title',
            'connectedServices.providerStateSharing.stateDisabledSubtitle',
            { confirmText: 'modals.openSettings' },
        );
        expect(routerPushMock).toHaveBeenCalledWith('/settings/connected-services/provider-state-sharing');
        expect(hook.getCurrent().actionableState).toEqual({
            kind: 'provider_state_sharing_required',
            route: '/settings/connected-services/provider-state-sharing',
            serviceId: 'openai-codex',
        });
        expect(hook.getCurrent().restartState).toBeNull();

        await hook.unmount();
    });

    it('routes target-profile reauth switch failures through the reconnect flow', async () => {
        profileState.current = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{
                    profileId: 'happier',
                    status: 'needs_reauth',
                    kind: 'oauth',
                    providerEmail: 'happier@example.com',
                }],
                groups: [],
            }],
        };
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'profile_action_required',
            serviceId: 'openai-codex',
            diagnostics: {
                actionRequired: {
                    kind: 'reconnect_profile',
                    profileId: 'happier',
                    healthStatus: 'needs_reauth',
                },
            },
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'openai-codex/happier': 'Happier' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(hook.getCurrent().actionableState).toEqual({
            kind: 'reconnect_profile',
            serviceId: 'openai-codex',
            profileId: 'happier',
            route: {
                pathname: '/settings/connected-services/oauth',
                params: { serviceId: 'openai-codex', profileId: 'happier' },
            },
        });
        expect(routerPushMock).toHaveBeenCalledWith({
            pathname: '/settings/connected-services/oauth',
            params: { serviceId: 'openai-codex', profileId: 'happier' },
        });
        expect(modalAlertMock).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it.each([
        {
            errorCode: 'connected_service_required',
            expectedKind: 'connected_service_required',
        },
        {
            errorCode: 'not_group_selection',
            expectedKind: 'not_group_selection',
        },
        {
            errorCode: 'profile_action_required',
            expectedKind: 'profile_action_required',
        },
    ] as const)('surfaces $errorCode switch failures as actionable settings states', async ({ errorCode, expectedKind }) => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode,
            serviceId: 'openai-codex',
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'openai-codex/happier': 'Happier' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(hook.getCurrent().actionableState).toEqual({
            kind: expectedKind,
            serviceId: 'openai-codex',
            route: '/settings/connected-services',
        });
        expect(routerPushMock).toHaveBeenCalledWith('/settings/connected-services');
        expect(modalAlertMock).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('surfaces unavailable provider session state with executable diagnostic actions', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'provider_session_state_unavailable_for_resume',
            serviceId: 'openai-codex',
            diagnostics: {
                uxDiagnostic: {
                    code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
                    failurePhase: 'continuity',
                    source: 'manual_auth_switch',
                    serviceId: 'openai-codex',
                    agentId: 'codex',
                    profileId: 'happier',
                    retryable: false,
                    suggestedActions: [
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount,
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.resumeCurrentAccount,
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.reconnectProfile,
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.enableStateSharing,
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.dismiss,
                    ],
                    diagnostics: {
                        reason: 'no_resumable_session_file',
                    },
                },
            },
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'openai-codex/happier': 'Happier' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(hook.getCurrent().actionableState).toEqual({
            kind: 'provider_session_state_unavailable_for_resume',
            serviceId: 'openai-codex',
            recovery: 'retry_required',
            diagnostic: expect.objectContaining({
                code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
            }),
        });
        expect(hook.getCurrent().statusBadges).toEqual([expect.objectContaining({
            key: 'connected-services-auth-switch-retry-required',
            label: 'connectedServices.diagnostics.status.provider_session_state_unavailable_for_resume',
            testID: 'session-connected-services-auth-switch-retry-required',
            tone: 'warning',
            onPress: expect.any(Function),
        })]);
        expect(modalAlertMock).toHaveBeenCalledWith(
            'connectedServices.diagnostics.title.provider_session_state_unavailable_for_resume',
            'connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume:{"reason":"no_resumable_session_file","agentId":"codex"}',
            expect.any(Array),
        );

        const alertButtons = modalAlertMock.mock.calls[0]?.[2] as Array<{
            text: string;
            onPress?: () => void;
        }>;
        expect(alertButtons).toEqual([
            expect.objectContaining({
                text: 'newSession.connectedServiceSwitchUnavailable.startFreshAction',
                onPress: expect.any(Function),
            }),
            expect.objectContaining({
                text: 'common.continue',
                onPress: expect.any(Function),
            }),
            expect.objectContaining({
                text: 'connectedServices.title',
                onPress: expect.any(Function),
            }),
            expect.objectContaining({
                text: 'connectedServices.detail.actions.reconnect',
                onPress: expect.any(Function),
            }),
            expect.objectContaining({
                text: 'connectedServices.providerStateSharing.title',
                onPress: expect.any(Function),
            }),
            expect.objectContaining({
                text: 'common.cancel',
                onPress: expect.any(Function),
            }),
        ]);

        alertButtons.find((button) => button.text === 'connectedServices.title')?.onPress?.();
        expect(routerPushMock).toHaveBeenCalledWith('/settings/connected-services');
        alertButtons.find((button) => button.text === 'connectedServices.providerStateSharing.title')?.onPress?.();
        expect(routerPushMock).toHaveBeenCalledWith('/settings/connected-services/provider-state-sharing');
        alertButtons.find((button) => button.text === 'connectedServices.detail.actions.reconnect')?.onPress?.();
        expect(routerPushMock).toHaveBeenLastCalledWith({
            pathname: '/settings/connected-services/oauth',
            params: {
                serviceId: 'openai-codex',
                profileId: 'happier',
            },
        });

        modalAlertMock.mockClear();
        hook.getCurrent().statusBadges[0]?.onPress?.();
        expect(modalAlertMock).toHaveBeenCalledWith(
            'connectedServices.diagnostics.title.provider_session_state_unavailable_for_resume',
            'connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume:{"reason":"no_resumable_session_file","agentId":"codex"}',
            expect.any(Array),
        );

        await act(async () => {
            alertButtons.find((button) => button.text === 'common.continue')?.onPress?.();
            await Promise.resolve();
        });
        expect(hook.getCurrent().actionableState).toBeNull();

        await act(async () => {
            alertButtons.find((button) => button.text === 'newSession.connectedServiceSwitchUnavailable.startFreshAction')?.onPress?.();
            await Promise.resolve();
        });
        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledTimes(2);
        expect(setSessionConnectedServiceAuthBindingMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            rematerializeServiceId: 'openai-codex',
        }));

        await hook.unmount();
    });

    it('surfaces account-settings freshness failures as a dedicated switch notice', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'restart_failed',
            serviceId: 'openai-codex',
            diagnostics: {
                accountSettingsFreshness: {
                    requestedVersion: 42,
                    status: 'failed',
                    error: 'account_settings_refresh_failed',
                },
            },
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'openai-codex/happier': 'Happier' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(hook.getCurrent().actionableState).toBeNull();
        expect(modalAlertMock).toHaveBeenCalledWith(
            'common.error',
            'connectedServices.authSwitch.errors.accountSettingsRefreshFailed',
        );
        expect(routerPushMock).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('surfaces generic switch diagnostic recovery actions from the daemon response', async () => {
        profileState.current = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{
                    profileId: 'happier',
                    status: 'needs_reauth',
                    kind: 'apiKey',
                    providerEmail: 'happier@example.com',
                }],
                groups: [],
            }],
        };
        setSessionConnectedServiceAuthBindingMock
            .mockResolvedValueOnce({
                ok: false,
                errorCode: 'restart_failed',
                serviceId: 'openai-codex',
                diagnostics: {
                    uxDiagnostic: {
                        code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerAccountAdoptionMismatch,
                        failurePhase: 'post_switch_verification',
                        source: 'session_view',
                        serviceId: 'openai-codex',
                        agentId: 'codex',
                        profileId: 'happier',
                        retryable: true,
                        suggestedActions: [
                            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry,
                            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount,
                            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.resumeCurrentAccount,
                            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
                            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.reconnectProfile,
                            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.enableStateSharing,
                            CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.dismiss,
                        ],
                    },
                },
            })
            .mockResolvedValueOnce({ ok: true, action: 'metadata_updated' });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'openai-codex/happier': 'Happier' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
                sessionActive: false,
            }),
        );
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(modalAlertMock.mock.calls[0]?.[0]).toBe('connectedServices.diagnostics.title.provider_account_adoption_mismatch');
        expect(modalAlertMock.mock.calls[0]?.[1]).toBe('connectedServices.diagnostics.body.provider_account_adoption_mismatch');
        const alertButtons = modalAlertMock.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }> | undefined;
        expect(alertButtons).toEqual([
            expect.objectContaining({ text: 'common.retry', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'newSession.connectedServiceSwitchUnavailable.startFreshAction', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'common.continue', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'connectedServices.title', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'connectedServices.detail.actions.reconnect', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'connectedServices.providerStateSharing.title', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'common.cancel', onPress: expect.any(Function) }),
        ]);

        alertButtons?.find((button) => button.text === 'connectedServices.title')?.onPress?.();
        expect(routerPushMock).toHaveBeenCalledWith('/settings/connected-services');
        alertButtons?.find((button) => button.text === 'connectedServices.providerStateSharing.title')?.onPress?.();
        expect(routerPushMock).toHaveBeenCalledWith('/settings/connected-services/provider-state-sharing');
        alertButtons?.find((button) => button.text === 'connectedServices.detail.actions.reconnect')?.onPress?.();
        expect(routerPushMock).toHaveBeenCalledWith({
            pathname: '/settings/connected-services/profile',
            params: {
                serviceId: 'openai-codex',
                profileId: 'happier',
            },
        });

        await act(async () => {
            alertButtons?.find((button) => button.text === 'common.retry')?.onPress?.();
            await Promise.resolve();
        });
        expect(setSessionConnectedServiceAuthBindingMock.mock.calls[1]?.[0]).not.toEqual(expect.objectContaining({
            rematerializeServiceId: 'openai-codex',
        }));

        await act(async () => {
            alertButtons?.find((button) => button.text === 'newSession.connectedServiceSwitchUnavailable.startFreshAction')?.onPress?.();
            await Promise.resolve();
        });
        expect(setSessionConnectedServiceAuthBindingMock.mock.calls[2]?.[0]).toEqual(expect.objectContaining({
            rematerializeServiceId: 'openai-codex',
        }));
        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledTimes(3);

        await hook.unmount();
    });

    it('prefers a typed continuity diagnostic over provider-state-sharing-unavailable fallback copy', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'provider_state_sharing_unavailable',
            serviceId: 'openai-codex',
            diagnostics: {
                uxDiagnostic: {
                    code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
                    failurePhase: 'continuity',
                    source: 'session_view',
                    serviceId: 'openai-codex',
                    agentId: 'opencode',
                    retryable: false,
                    suggestedActions: [
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
                    ],
                    diagnostics: {
                        reason: 'restart_rematerialize_required',
                    },
                },
            },
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'opencode',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'opencode',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'openai-codex/happier': 'Happier' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
                sessionActive: false,
            }),
        );
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(modalAlertMock).toHaveBeenCalledWith(
            'connectedServices.diagnostics.title.provider_session_state_unavailable_for_resume',
            'connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume:{"reason":"restart_rematerialize_required","agentId":"opencode"}',
            expect.any(Array),
        );
        expect(modalAlertMock.mock.calls[0]?.[1]).not.toBe('connectedServices.authSwitch.errors.providerStateSharingUnavailable');

        await hook.unmount();
    });

    it('does not show provider-state-sharing copy for reachable stopped OpenCode restart/rematerialize switches', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: true,
            action: 'restart_requested',
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'opencode',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'opencode',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'openai-codex/happier': 'Happier' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
                sessionActive: false,
            }),
        );
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledWith(expect.objectContaining({
            agentId: 'opencode',
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
        expect(modalAlertMock).not.toHaveBeenCalled();
        expect(routerPushMock).not.toHaveBeenCalledWith('/settings/connected-services/provider-state-sharing');
        expect(hook.getCurrent().restartState).toEqual(expect.objectContaining({
            status: 'restarting',
            reason: 'manual_auth_switch',
        }));

        await hook.unmount();
    });

    it('sends expected generations only for selected auth groups', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'group',
                groupId: 'team',
                profileId: 'work',
            });
        });

        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'team',
                        profileId: 'work',
                    },
                },
            },
            expectedGroupGenerationByServiceId: { anthropic: 7 },
        });

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
        });

        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenLastCalledWith({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
        });

        await hook.unmount();
    });

    it('rolls back the optimistic label and reports an error when the session switch RPC fails', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            error: 'unsupported',
            errorCode: 'group_generation_conflict',
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
        });

        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
            .toBe('connectedServices.authChip.nativeLabel');
        expect(modalAlertMock).toHaveBeenCalledWith(
            'common.error',
            'connectedServices.authSwitch.errors.groupGenerationConflict',
        );

        await hook.unmount();
    });

    it('keeps visible per-service partial-application badges when multi-service hot apply partially succeeds', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'hot_apply_failed',
            serviceId: 'openai-codex',
            diagnostics: {
                failurePhase: 'hot_apply',
                partialState: 'runtime_auth_partially_applied',
                serviceResultsByServiceId: {
                    anthropic: { status: 'applied' },
                    'openai-codex': { status: 'failed', errorCode: 'hot_apply_failed' },
                    openai: { status: 'not_attempted' },
                },
            },
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic', 'openai-codex', 'openai'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
                            'openai-codex': { source: 'native' },
                            openai: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
        });

        expect(hook.getCurrent().statusBadges).toEqual(expect.arrayContaining([
            expect.objectContaining({
                key: 'connected-services-auth-switch-partial-application-openai-codex',
                testID: 'session-connected-services-auth-switch-partial-application-openai-codex',
                label: 'connectedServices.authSwitch.status.partialApplicationForService',
                tone: 'warning',
            }),
            expect.objectContaining({
                key: 'connected-services-auth-switch-partial-application-openai',
                testID: 'session-connected-services-auth-switch-partial-application-openai',
                label: 'connectedServices.authSwitch.status.partialApplicationForService',
                tone: 'warning',
            }),
        ]));
        expect(hook.getCurrent().statusBadges).not.toContainEqual(expect.objectContaining({
            key: 'connected-services-auth-switch-partial-application',
        }));

        await hook.unmount();
    });

    it('closes the auth popover before asking to confirm an existing-session auth switch', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        sessionAuthSwitch: { continuityMode: 'restart_same_home' },
                    },
                },
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const modalOrder: string[] = [];
        modalConfirmMock.mockImplementationOnce(() => {
            modalOrder.push('confirm');
            return Promise.resolve(true);
        });
        const requestClose = vi.fn(() => {
            modalOrder.push('close');
        });
        const popover = renderChipPopover(
            hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent,
            { requestClose },
        ) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
        });

        expect(requestClose).toHaveBeenCalledTimes(1);
        expect(modalOrder.slice(0, 2)).toEqual(['close', 'confirm']);

        await hook.unmount();
    });
});
