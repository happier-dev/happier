import { renderHook } from '@/dev/testkit';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { act } from 'react-test-renderer';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createConnectedAccountDescriptorProjectionLoadingState,
    type ConnectedAccountDescriptorProjectionState,
} from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import {
    installConnectedAccountDescriptorProjection,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { installNewSessionModulesCommonModuleMocks } from './newSessionModulesTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const modalShowMock = vi.hoisted(() => vi.fn());
const useFeatureEnabledMock = vi.hoisted(() => vi.fn());
const newSessionConnectedAccountProjection = {
    scopeKey: 'new-session-test',
    status: 'ready',
    descriptors: [{
        id: 'openai-codex',
        serviceId: 'openai-codex',
        pluginId: 'happier.agent.codex',
        provenance: 'first_party',
        sourceKind: 'bundled',
        title: 'Codex',
        authentication: {
            defaultModeId: 'oauth',
            modes: [{
                id: 'oauth',
                kind: 'oauthAuthorizationCode',
                scopes: ['openid', 'profile', 'email', 'offline_access'],
                pkce: 'required',
                outcomeReconciliation: 'none',
            }],
        },
        capabilities: [],
        availability: { state: 'available', reason: 'resolved' },
        diagnostics: [],
    }, {
        id: 'anthropic',
        serviceId: 'anthropic',
        pluginId: 'happier.agent.claude',
        provenance: 'first_party',
        sourceKind: 'bundled',
        title: 'Anthropic API key',
        authentication: {
            defaultModeId: 'api-key',
            modes: [{
                id: 'api-key',
                kind: 'manual',
                outcomeReconciliation: 'none',
                fields: [{
                    id: 'token',
                    title: 'Anthropic API key',
                    schema: { type: 'string', minLength: 1 },
                    secret: true,
                }],
            }],
        },
        capabilities: [],
        availability: { state: 'available', reason: 'resolved' },
        diagnostics: [],
    }],
    conflicts: [],
    errorReason: null,
} satisfies ConnectedAccountDescriptorProjectionState;
type TestAccountProfile = Readonly<{
    connectedServicesV2: Array<{
        serviceId: string;
        profiles: Array<{
            profileId: string;
            status: string;
            kind: string;
            providerEmail: string;
        }>;
        groups?: unknown;
    }>;
}>;

const profileState = vi.hoisted((): { current: TestAccountProfile } => ({
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
            },
        ],
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installNewSessionModulesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (...args: any[]) => modalShowMock(...args),
            },
        }).module;
    },
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
            translate: (key: string) => key,
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
    useFeatureEnabled: (...args: any[]) => useFeatureEnabledMock(...args),
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => profileState.current,
}));
function requireCollapsedContentPopover(chip: AgentInputExtraActionChip | null) {
    const popover = chip?.collapsedContentPopover;
    if (!popover) {
        throw new Error('Expected connected services collapsed content popover');
    }
    return popover;
}

describe('useNewSessionConnectedServices', () => {
    beforeEach(() => {
        installConnectedAccountDescriptorProjection(newSessionConnectedAccountProjection);
        modalShowMock.mockReset();
        useFeatureEnabledMock.mockReset();
        useFeatureEnabledMock.mockReturnValue(true);
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
                },
            ],
        };
    });

    afterEach(() => {
        installConnectedAccountDescriptorProjection(
            createConnectedAccountDescriptorProjectionLoadingState('new-session-test-cleanup'),
        );
    });

    it('returns a connected-services chip that opens the anchored account picker popover', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        const routerPush = vi.fn();
        const setAgentOptionStateForCurrentAgent = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: {
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        supportedKindsByServiceId: { anthropic: ['token'] },
                    },
                },
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: null,
                router: { push: routerPush },
                setAgentOptionStateForCurrentAgent,
            }),
        );

        const chip = hook.getCurrent().connectedServicesAuthChip;
        expect(chip).toEqual(
            expect.objectContaining({
                key: 'new-session-connected-services-auth',
                controlId: 'connectedServices',
            }),
        );
        expect(chip?.collapsedAction).toBeUndefined();
        expect(chip?.collapsedContentPopover).toEqual(expect.objectContaining({
            title: 'connectedServices.authChip.nativeLabel',
            label: 'connectedServices.authChip.nativeLabel',
            scrollEnabled: false,
            renderContent: expect.any(Function),
        }));

        const toggleCollapsedPopover = vi.fn();
        const renderedChip = chip!.render({
            chipStyle: () => null,
            iconColor: '#000',
            showLabel: true,
            textStyle: null,
            countTextStyle: null,
            chipAnchorRef: { current: null },
            popoverAnchorRef: { current: null },
            toggleCollapsedPopover,
        }) as React.ReactElement<{
            onPress?: () => void;
            testID?: string;
            dataSet?: { authSource?: string };
        }>;
        expect(renderedChip.props.testID).toBe('new-session-connected-services-auth-chip');
        expect(renderedChip.props.dataSet?.authSource).toBe('native');

        renderedChip.props.onPress?.();

        expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-connected-services-auth');
        expect(modalShowMock).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('updates the chip label and reopened popover selection after choosing a connected profile', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        const setAgentOptionStateForCurrentAgent = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: {
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        supportedKindsByServiceId: { anthropic: ['token'] },
                    },
                },
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: null,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent,
            }),
        );

        const firstPopoverRenderer = requireCollapsedContentPopover(
            hook.getCurrent().connectedServicesAuthChip,
        ).renderContent;
        if (typeof firstPopoverRenderer !== 'function') {
            throw new Error('Expected connected services popover content renderer');
        }
        const firstPopover = firstPopoverRenderer({
            requestClose: vi.fn(),
            maxHeight: 420,
        }) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            firstPopover.props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
        });

        expect(setAgentOptionStateForCurrentAgent).toHaveBeenCalledWith(
            'connectedServicesBindingsByServiceId',
            { anthropic: { source: 'connected', selection: 'profile', profileId: 'work' } },
        );
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('Anthropic API key: Work');

        const reopenedPopoverRenderer = requireCollapsedContentPopover(
            hook.getCurrent().connectedServicesAuthChip,
        ).renderContent;
        if (typeof reopenedPopoverRenderer !== 'function') {
            throw new Error('Expected connected services popover content renderer');
        }
        const reopenedPopover = reopenedPopoverRenderer({
            requestClose: vi.fn(),
            maxHeight: 420,
        }) as React.ReactElement<{ bindingsByServiceId: Record<string, unknown> }>;

        expect(reopenedPopover.props.bindingsByServiceId).toEqual({
            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
        });

        await hook.unmount();
    });

    it('keeps the core chip available while scoping the account-groups decision to the target server', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        useFeatureEnabledMock.mockImplementation((featureId: string, scope?: { scopeKind?: string; serverId?: string | null }) => {
            return featureId === 'connectedServices.accountGroups'
                && scope?.scopeKind === 'spawn'
                && scope?.serverId === 'server-123';
        });

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: {
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        supportedKindsByServiceId: { anthropic: ['token'] },
                    },
                },
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: 'server-123',
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        expect(hook.getCurrent().connectedServicesAuthChip).toEqual(
            expect.objectContaining({
                key: 'new-session-connected-services-auth',
                controlId: 'connectedServices',
            }),
        );
        expect(useFeatureEnabledMock).toHaveBeenCalledWith('connectedServices.accountGroups', {
            scopeKind: 'spawn',
            serverId: 'server-123',
        });
        await hook.unmount();
    });

    it('keeps the core chip available while using the default scope for account groups', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        useFeatureEnabledMock.mockImplementation((featureId: string, scope?: { scopeKind?: string; serverId?: string | null }) => {
            return featureId === 'connectedServices.accountGroups' && scope === undefined;
        });

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: {
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        supportedKindsByServiceId: { anthropic: ['token'] },
                    },
                },
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: null,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        expect(hook.getCurrent().connectedServicesAuthChip).toEqual(
            expect.objectContaining({
                key: 'new-session-connected-services-auth',
                controlId: 'connectedServices',
            }),
        );
        expect(useFeatureEnabledMock).toHaveBeenCalledWith('connectedServices.accountGroups', undefined);
        expect(useFeatureEnabledMock).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('applies the per-agent default connected auth binding before the user opens the chip', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        supportedKindsByServiceId: { anthropic: ['token'] },
                    },
                },
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            claude: {
                                v: 1,
                                bindingsByServiceId: {
                                    anthropic: {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'work',
                                    },
                                },
                            },
                        },
                    },
                },
                targetServerId: null,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        expect(hook.getCurrent().connectedServicesBindingsPayload).toEqual({
            v: 1,
            bindingsByServiceId: {
                anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
            },
        });
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('Anthropic API key: Work');

        await hook.unmount();
    });

    it('preserves a per-agent default group binding when the active profile changes', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [
                        {
                            profileId: 'fresh-profile',
                            status: 'connected',
                            kind: 'oauth',
                            providerEmail: 'fresh@example.com',
                        },
                    ],
                    groups: [{
                        groupId: 'primary',
                        displayName: 'Primary pool',
                        activeProfileId: 'fresh-profile',
                        memberProfileIds: ['fresh-profile'],
                    }],
                },
            ],
        };

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        supportedKindsByServiceId: { 'openai-codex': ['oauth'] },
                    },
                },
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            codex: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'group',
                                        groupId: 'primary',
                                    },
                                },
                            },
                        },
                    },
                },
                targetServerId: null,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        expect(hook.getCurrent().connectedServicesBindingsPayload).toEqual({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'primary',
                },
            },
        });
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('Codex: Primary pool');

        await hook.unmount();
    });

    it('preserves a stale default group identity while presenting native availability', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [
                        {
                            profileId: 'work',
                            status: 'connected',
                            kind: 'oauth',
                            providerEmail: 'work@example.com',
                        },
                    ],
                    groups: [],
                },
            ],
        };

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        supportedKindsByServiceId: { 'openai-codex': ['oauth'] },
                    },
                },
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            codex: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'group',
                                        groupId: 'missing-group',
                                    },
                                },
                            },
                        },
                    },
                },
                targetServerId: null,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        expect(hook.getCurrent().connectedServicesBindingsPayload).toEqual({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'missing-group',
                },
            },
        });
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('connectedServices.authChip.nativeLabel');

        const popoverRenderer = requireCollapsedContentPopover(
            hook.getCurrent().connectedServicesAuthChip,
        ).renderContent;
        if (typeof popoverRenderer !== 'function') {
            throw new Error('Expected connected services popover content renderer');
        }
        const popover = popoverRenderer({
            requestClose: vi.fn(),
            maxHeight: 420,
        }) as React.ReactElement<{
            resolveOptionAvailability?: (params: { serviceId: string; optionId: string }) => { subtitle?: string };
        }>;

        expect(popover.props.resolveOptionAvailability?.({
            serviceId: 'openai-codex',
            optionId: 'connected-service:openai-codex:native',
        })).toEqual({
            subtitle: 'connectedServices.defaultAuth.warning.connected_group_unavailable',
        });

        await hook.unmount();
    });

    it('deep-links the picker settings action to the tapped service settings screen (UI-2)', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        const requestClose = vi.fn();
        const routerPush = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: {
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        supportedKindsByServiceId: { anthropic: ['token'] },
                    },
                },
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: null,
                router: { push: routerPush },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        const popoverRenderer = requireCollapsedContentPopover(
            hook.getCurrent().connectedServicesAuthChip,
        ).renderContent;
        if (typeof popoverRenderer !== 'function') {
            throw new Error('Expected connected services popover content renderer');
        }
        const popover = popoverRenderer({
            requestClose,
            maxHeight: 420,
        }) as React.ReactElement<{
            onOpenSettings: (serviceId: string) => void;
        }>;

        expect(typeof popover.props.onOpenSettings).toBe('function');
        act(() => {
            popover.props.onOpenSettings('anthropic');
        });

        // UI-2: the picker's settings action deep-links to the tapped service's
        // settings screen instead of discarding the serviceId.
        expect(routerPush).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.claude',
                localId: 'anthropic',
            },
        });

        await hook.unmount();
    });

    it('routes oauth profiles that need reauth from the new-session popover to the reconnect flow', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'openai-codex',
                    profiles: [
                        {
                            profileId: 'happier',
                            status: 'needs_reauth',
                            kind: 'oauth',
                            providerEmail: 'happier@example.com',
                        },
                    ],
                    groups: [],
                },
            ],
        };
        const requestClose = vi.fn();
        const routerPush = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: {
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        supportedKindsByServiceId: { 'openai-codex': ['oauth'] },
                    },
                },
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: null,
                router: { push: routerPush },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        const popoverRenderer = requireCollapsedContentPopover(
            hook.getCurrent().connectedServicesAuthChip,
        ).renderContent;
        if (typeof popoverRenderer !== 'function') {
            throw new Error('Expected connected services popover content renderer');
        }
        const popover = popoverRenderer({
            requestClose,
            maxHeight: 420,
        }) as React.ReactElement<{
            onReconnectProfile?: (serviceId: string, profileId: string) => void;
        }>;

        expect(typeof popover.props.onReconnectProfile).toBe('function');
        act(() => {
            popover.props.onReconnectProfile?.('openai-codex', 'happier');
        });

        expect(requestClose).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
                accountId: 'happier',
            },
        });

        await hook.unmount();
    });

    it('routes token profiles that need reauth from the new-session popover to the profile action surface', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'anthropic',
                    profiles: [
                        {
                            profileId: 'work@example.com',
                            status: 'needs_reauth',
                            kind: 'token',
                            providerEmail: 'work@example.com',
                        },
                    ],
                    groups: [],
                },
            ],
        };
        const requestClose = vi.fn();
        const routerPush = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: {
                    id: 'claude',
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        supportedKindsByServiceId: { anthropic: ['token'] },
                    },
                },
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: null,
                router: { push: routerPush },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        const popoverRenderer = requireCollapsedContentPopover(
            hook.getCurrent().connectedServicesAuthChip,
        ).renderContent;
        if (typeof popoverRenderer !== 'function') {
            throw new Error('Expected connected services popover content renderer');
        }
        const popover = popoverRenderer({
            requestClose,
            maxHeight: 420,
        }) as React.ReactElement<{
            onReconnectProfile?: (serviceId: string, profileId: string) => void;
        }>;

        expect(typeof popover.props.onReconnectProfile).toBe('function');
        act(() => {
            popover.props.onReconnectProfile?.('anthropic', 'work@example.com');
        });

        expect(requestClose).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.claude',
                localId: 'anthropic',
                accountId: 'work@example.com',
            },
        });

        await hook.unmount();
    });

});
