import { renderHook } from '@/dev/testkit';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AGENTS_CORE } from '@happier-dev/agents';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS, CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol';
import { act } from 'react-test-renderer';
import {
    createConnectedAccountDescriptorProjectionLoadingState,
    type ConnectedAccountDescriptorProjectionState,
} from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';

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
                groups: [],
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

const authSwitchConnectedAccountProjection = {
    scopeKey: 'auth-switch-test',
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
    }, {
        id: 'openai',
        serviceId: 'openai',
        pluginId: 'happier.voice.openai',
        provenance: 'first_party',
        sourceKind: 'bundled',
        title: 'OpenAI API key',
        authentication: {
            defaultModeId: 'api-key',
            modes: [{
                id: 'api-key',
                kind: 'manual',
                outcomeReconciliation: 'none',
                fields: [{
                    id: 'token',
                    title: 'OpenAI API key',
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

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit');
    return createExpoRouterMock({
        router: { push: routerPushMock },
    }).module;
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (...args: unknown[]) => useFeatureEnabledMock(...args),
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => profileState.current,
}));

vi.mock('@/sync/ops/connectedServices/sessionAuthSwitch', () => ({
    setSessionConnectedServiceAuthBinding: (...args: unknown[]) => setSessionConnectedServiceAuthBindingMock(...args),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit');
    return createModalModuleMock({
        spies: {
            alert: (...args) => modalAlertMock(...args),
            confirm: (...args) => modalConfirmMock(...args),
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
            if (key === 'connectedServices.authChip.connectedCountLabel') {
                return `Auth: ${String(params?.count ?? '')}`;
            }
            if (key === 'connectedServices.authChip.nativeLabel') {
                return 'Native';
            }
            if (key === 'connectedServices.authSwitch.status.restarting') {
                return 'Restarting session';
            }
            if (key === 'connectedServices.authSwitch.status.partialApplicationServiceFailed') {
                return `${String(params?.service ?? '')} auth failed`;
            }
            if (key === 'connectedServices.authSwitch.status.partialApplicationServiceNotApplied') {
                return `${String(params?.service ?? '')} auth not applied`;
            }
            if (key === 'connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume') {
                return `${key}:${String(params?.reason ?? '')}:${String(params?.agentId ?? '')}`;
            }
            return key;
        },
    });
});

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputChipLabel', () => ({
    AgentInputChipLabel: 'AgentInputChipLabel',
}));

describe('useSessionConnectedServicesAuthSwitch', () => {
    beforeEach(() => {
        installConnectedAccountDescriptorProjection(authSwitchConnectedAccountProjection);
        useFeatureEnabledMock.mockReset();
        useFeatureEnabledMock.mockReturnValue(true);
        setSessionConnectedServiceAuthBindingMock.mockReset();
        setSessionConnectedServiceAuthBindingMock.mockResolvedValue({ ok: true, action: 'restart_requested' });
        modalAlertMock.mockReset();
        modalConfirmMock.mockReset();
        modalConfirmMock.mockResolvedValue(true);
        routerPushMock.mockClear();
    });

    afterEach(() => {
        installConnectedAccountDescriptorProjection(
            createConnectedAccountDescriptorProjectionLoadingState('auth-switch-test-cleanup'),
        );
    });

    it('disables changed auth options when no reachable machine target is available', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: null,
                serverId: 'server-1',
                agentCore: AGENTS_CORE.claude,
                sessionMetadata: {
                    connectedServices: {
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
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

        const chip = hook.getCurrent().connectedServicesAuthChip;
        expect(chip).not.toBeNull();
        const renderContent = chip?.collapsedContentPopover?.renderContent;
        expect(typeof renderContent).toBe('function');
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });
        expect(content).toEqual(expect.objectContaining({
            props: expect.objectContaining({
                resolveOptionAvailability: expect.any(Function),
            }),
        }));

        const resolveOptionAvailability = (content as { props: {
            resolveOptionAvailability: (params: {
                serviceId: string;
                binding: { source: 'connected'; selection: 'profile'; profileId: string };
            }) => { disabled?: boolean };
        } }).props.resolveOptionAvailability;

        expect(resolveOptionAvailability({
            serviceId: 'anthropic',
            binding: { source: 'connected', selection: 'profile', profileId: 'work' },
        })).toEqual({ disabled: true });
    });

    it('routes Gemini native-to-connected session switches to the daemon', async () => {
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

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        expect(typeof renderContent).toBe('function');
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });
        const props = (content as { props: {
            resolveOptionAvailability: (params: {
                serviceId: string;
                binding: { source: 'connected'; selection: 'profile'; profileId: string };
            }) => { disabled?: boolean };
            setBindingForService: (
                serviceId: string,
                binding: { source: 'connected'; selection: 'profile'; profileId: string },
            ) => void;
        } }).props;

        expect(props.resolveOptionAvailability({
            serviceId: 'gemini',
            binding: { source: 'connected', selection: 'profile', profileId: 'work' },
        })).toEqual({});

        await act(async () => {
            props.setBindingForService('gemini', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
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
    });

    it('enables Codex native-to-connected session switches when provider state sharing is shared', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.codex,
                sessionMetadata: {
                    connectedServices: {
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

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        expect(typeof renderContent).toBe('function');
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });
        const props = (content as { props: {
            resolveOptionAvailability: (params: {
                serviceId: string;
                binding: { source: 'connected'; selection: 'profile'; profileId: string };
            }) => { disabled?: boolean };
            setBindingForService: (
                serviceId: string,
                binding: { source: 'connected'; selection: 'profile'; profileId: string },
            ) => void;
        } }).props;

        expect(props.resolveOptionAvailability({
            serviceId: 'openai-codex',
            binding: { source: 'connected', selection: 'profile', profileId: 'happier' },
        })).toEqual({});

        await act(async () => {
            props.setBindingForService('openai-codex', {
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
                    openai: {
                        source: 'native',
                    },
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'happier',
                    },
                },
            },
        });
    });

    it('lets the daemon decide Codex native-to-connected switches that require shared provider state', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.codex,
                sessionMetadata: {
                    connectedServices: {
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

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        expect(typeof renderContent).toBe('function');
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });
        const props = (content as { props: {
            resolveOptionAvailability: (params: {
                serviceId: string;
                binding: { source: 'connected'; selection: 'profile'; profileId: string };
            }) => { disabled?: boolean };
            setBindingForService: (
                serviceId: string,
                binding: { source: 'connected'; selection: 'profile'; profileId: string },
            ) => void;
        } }).props;

        expect(props.resolveOptionAvailability({
            serviceId: 'openai-codex',
            binding: { source: 'connected', selection: 'profile', profileId: 'happier' },
        })).toEqual({});

        await act(async () => {
            props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            agentId: 'codex',
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
    });

    it('shows a specific message when the daemon rejects a stale connected-service group switch', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'group_generation_conflict',
            serviceId: 'openai-codex',
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.codex,
                sessionMetadata: {
                    connectedServices: {
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
                        defaults: { configMode: 'linked', stateMode: 'shared' },
                        byAgentId: {},
                        acknowledgedRisksByAgentId: {},
                    },
                },
                switchingDisabledReason: null,
            }),
        );

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        expect(typeof renderContent).toBe('function');
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });
        const props = (content as { props: {
            setBindingForService: (
                serviceId: string,
                binding: { source: 'connected'; selection: 'profile'; profileId: string },
            ) => void;
        } }).props;

        await act(async () => {
            props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(modalAlertMock).toHaveBeenCalledWith(
            'common.error',
            'connectedServices.authSwitch.errors.groupGenerationConflict',
        );
    });

    it('surfaces per-service non-applied badges when multi-service hot apply partially succeeds', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'hot_apply_failed',
            serviceId: 'openai-codex',
            diagnostics: {
                failurePhase: 'hot_apply',
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
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.codex,
                sessionMetadata: {
                    connectedServices: {
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
                        defaults: { configMode: 'linked', stateMode: 'shared' },
                        byAgentId: {},
                        acknowledgedRisksByAgentId: {},
                    },
                },
                switchingDisabledReason: null,
            }),
        );

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(hook.getCurrent().statusBadges).toEqual([
            expect.objectContaining({
                key: 'connected-services-auth-switch-service-openai-codex-failed',
                testID: 'session-connected-services-auth-switch-service-openai-codex-failed-status',
                label: 'Codex auth failed',
                tone: 'warning',
            }),
            expect.objectContaining({
                key: 'connected-services-auth-switch-service-openai-not-attempted',
                testID: 'session-connected-services-auth-switch-service-openai-not-attempted-status',
                label: 'OpenAI API key auth not applied',
                tone: 'warning',
            }),
        ]);
    });

    it('preserves generic diagnostic recovery actions in the alert buttons', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'provider_account_adoption_mismatch',
            serviceId: 'openai-codex',
            diagnostics: {
                uxDiagnostic: {
                    code: 'provider_account_adoption_mismatch',
                    failurePhase: 'post_switch_recovery',
                    source: 'manual_auth_switch',
                    serviceId: 'openai-codex',
                    agentId: 'codex',
                    retryable: true,
                    suggestedActions: ['retry', 'open_connected_accounts', 'dismiss'],
                    diagnostics: {
                        reason: 'selected_account_not_adopted',
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
                agentCore: AGENTS_CORE.codex,
                sessionMetadata: {
                    connectedServices: {
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
                        defaults: { configMode: 'linked', stateMode: 'shared' },
                        byAgentId: {},
                        acknowledgedRisksByAgentId: {},
                    },
                },
                switchingDisabledReason: null,
            }),
        );

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(modalAlertMock).toHaveBeenCalledWith(
            'connectedServices.diagnostics.title.provider_account_adoption_mismatch',
            'connectedServices.diagnostics.body.provider_account_adoption_mismatch',
            expect.arrayContaining([
                expect.objectContaining({ text: 'common.retry', onPress: expect.any(Function) }),
                expect.objectContaining({ text: 'connectedServices.title', onPress: expect.any(Function) }),
                expect.objectContaining({ text: 'common.cancel' }),
            ]),
        );

        const buttons = modalAlertMock.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void | Promise<void> }>;
        const retryButton = buttons.find((button) => button.text === 'common.retry');
        const connectedAccountsButton = buttons.find((button) => button.text === 'connectedServices.title');
        if (!retryButton?.onPress || !connectedAccountsButton?.onPress) throw new Error('Expected diagnostic actions');

        await act(async () => {
            retryButton.onPress?.();
            await Promise.resolve();
        });
        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledTimes(2);

        connectedAccountsButton.onPress();
        expect(routerPushMock).toHaveBeenCalledWith('/(app)/settings/connected-services');
    });

    it('keeps a generic partial-application badge when only legacy partial state is available', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'partial_applied_pending_reconciliation',
            serviceId: 'openai-codex',
            diagnostics: {
                partialState: 'runtime_auth_partially_applied',
            },
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.codex,
                sessionMetadata: {
                    connectedServices: {
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
                        defaults: { configMode: 'linked', stateMode: 'shared' },
                        byAgentId: {},
                        acknowledgedRisksByAgentId: {},
                    },
                },
                switchingDisabledReason: null,
            }),
        );

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(hook.getCurrent().statusBadges).toContainEqual(expect.objectContaining({
            key: 'connected-services-auth-switch-partial-application',
            testID: 'session-connected-services-auth-switch-partial-application-status',
            label: 'connectedServices.authSwitch.status.partialApplication',
            tone: 'warning',
        }));
    });

    it('offers Retry and Revert on a partial hot-apply badge and re-applies through the canonical apply path', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'partial_applied_pending_reconciliation',
            serviceId: 'openai-codex',
            diagnostics: {
                partialState: 'runtime_auth_partially_applied',
            },
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.codex,
                sessionMetadata: {
                    connectedServices: {
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
                        defaults: { configMode: 'linked', stateMode: 'shared' },
                        byAgentId: {},
                        acknowledgedRisksByAgentId: {},
                    },
                },
                switchingDisabledReason: null,
            }),
        );

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });

        modalAlertMock.mockClear();
        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        // The badge itself is the reconcile affordance; the failure is not
        // double-surfaced through the generic one-shot error alert.
        expect(modalAlertMock).not.toHaveBeenCalled();
        const partialBadge = hook.getCurrent().statusBadges.find(
            (badge) => badge.testID === 'session-connected-services-auth-switch-partial-application-status',
        );
        expect(partialBadge?.onPress).toEqual(expect.any(Function));

        await act(async () => {
            partialBadge?.onPress?.();
            await Promise.resolve();
        });
        const alertButtons = modalAlertMock.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }> | undefined;
        expect(alertButtons).toEqual([
            expect.objectContaining({ text: 'connectedServices.authSwitch.partialApply.retry', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'connectedServices.authSwitch.partialApply.revert', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'common.cancel' }),
        ]);

        // Retry re-applies the ATTEMPTED binding via the same canonical mutation.
        setSessionConnectedServiceAuthBindingMock.mockClear();
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({ ok: true, action: 'metadata_updated' });
        modalConfirmMock.mockClear();
        modalConfirmMock.mockResolvedValue(false);
        await act(async () => {
            alertButtons?.find((button) => button.text === 'connectedServices.authSwitch.partialApply.retry')?.onPress?.();
            await Promise.resolve();
        });
        expect(setSessionConnectedServiceAuthBindingMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            bindings: expect.objectContaining({
                bindingsByServiceId: expect.objectContaining({
                    'openai-codex': { source: 'connected', selection: 'profile', profileId: 'happier' },
                }),
            }),
        }));
        expect(modalConfirmMock).not.toHaveBeenCalled();
    });

    it('reverts a partial hot-apply to the previous binding via the canonical apply path', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'partial_applied_pending_reconciliation',
            serviceId: 'openai-codex',
            diagnostics: {
                partialState: 'runtime_auth_partially_applied',
            },
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.codex,
                sessionMetadata: {
                    connectedServices: {
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
                        defaults: { configMode: 'linked', stateMode: 'shared' },
                        byAgentId: {},
                        acknowledgedRisksByAgentId: {},
                    },
                },
                switchingDisabledReason: null,
            }),
        );

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        const partialBadge = hook.getCurrent().statusBadges.find(
            (badge) => badge.testID === 'session-connected-services-auth-switch-partial-application-status',
        );
        modalAlertMock.mockClear();
        await act(async () => {
            partialBadge?.onPress?.();
            await Promise.resolve();
        });
        const alertButtons = modalAlertMock.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }> | undefined;

        // Revert re-applies the PREVIOUS binding (native) with forceReapply — the
        // optimistic binding was already reset, so a plain re-apply would no-op
        // while the live session may still be diverged. The notice clears on success.
        setSessionConnectedServiceAuthBindingMock.mockClear();
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({ ok: true, action: 'metadata_updated' });
        await act(async () => {
            alertButtons?.find((button) => button.text === 'connectedServices.authSwitch.partialApply.revert')?.onPress?.();
            await Promise.resolve();
        });
        expect(setSessionConnectedServiceAuthBindingMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            bindings: expect.objectContaining({
                bindingsByServiceId: expect.objectContaining({
                    'openai-codex': { source: 'native' },
                }),
            }),
        }));
        expect(hook.getCurrent().statusBadges.find(
            (badge) => badge.testID === 'session-connected-services-auth-switch-partial-application-status',
        )).toBeUndefined();
    });

    it.each([
        [
            'provider_state_sharing_required',
            {
                kind: 'provider_state_sharing_required',
                route: '/(app)/settings/connected-services/provider-state-sharing',
            },
            '/(app)/settings/connected-services/provider-state-sharing',
        ],
        [
            'not_group_selection',
            {
                kind: 'not_group_selection',
                route: '/(app)/settings/connected-services',
            },
            '/(app)/settings/connected-services',
        ],
        [
            'connected_service_required',
            {
                kind: 'connected_service_required',
                route: '/(app)/settings/connected-services',
            },
            '/(app)/settings/connected-services',
        ],
        [
            'profile_action_required',
            {
                kind: 'profile_action_required',
                route: '/(app)/settings/connected-services',
            },
            '/(app)/settings/connected-services',
        ],
    ] as const)('surfaces daemon action-required error %s as actionable state', async (errorCode, expectedState, expectedRoute) => {
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
                agentCore: AGENTS_CORE.codex,
                sessionMetadata: {
                    connectedServices: {
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
                        defaults: { configMode: 'linked', stateMode: 'shared' },
                        byAgentId: {},
                        acknowledgedRisksByAgentId: {},
                    },
                },
                switchingDisabledReason: null,
            }),
        );

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(modalAlertMock).not.toHaveBeenCalled();
        expect(routerPushMock).toHaveBeenCalledWith(expectedRoute);
        expect((hook.getCurrent() as { actionableState?: unknown }).actionableState).toEqual(expectedState);
    });

    it('routes a reconnect-profile action requirement to the exact qualified account owner', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'profile_action_required',
            serviceId: 'openai-codex',
            diagnostics: {
                actionRequired: {
                    kind: 'reconnect_profile',
                    profileId: 'happier',
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
                agentCore: AGENTS_CORE.codex,
                sessionMetadata: {
                    connectedServices: {
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
                        defaults: { configMode: 'linked', stateMode: 'shared' },
                        byAgentId: {},
                        acknowledgedRisksByAgentId: {},
                    },
                },
                switchingDisabledReason: null,
            }),
        );

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(routerPushMock).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
                accountId: 'happier',
            },
        });
        expect((hook.getCurrent() as { actionableState?: unknown }).actionableState).toEqual({
            kind: 'reconnect_profile',
            profileId: 'happier',
        });

        await hook.unmount();
    });

    it('surfaces provider session-state resume gaps with executable diagnostic actions', async () => {
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
                agentCore: AGENTS_CORE.codex,
                sessionMetadata: {
                    connectedServices: {
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
                        defaults: { configMode: 'linked', stateMode: 'shared' },
                        byAgentId: {},
                        acknowledgedRisksByAgentId: {},
                    },
                },
                switchingDisabledReason: null,
            }),
        );

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect((hook.getCurrent() as { actionableState?: unknown }).actionableState).toEqual({
            kind: 'provider_session_state_unavailable_for_resume',
            recovery: 'retry_required',
            diagnostic: expect.objectContaining({
                code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
            }),
        });
        expect(hook.getCurrent().statusBadges).toContainEqual(expect.objectContaining({
            label: 'connectedServices.diagnostics.status.provider_session_state_unavailable_for_resume',
            testID: 'session-connected-services-auth-switch-retry-required',
            tone: 'warning',
            onPress: expect.any(Function),
        }));
        expect(modalAlertMock).toHaveBeenCalledWith(
            'connectedServices.diagnostics.title.provider_session_state_unavailable_for_resume',
            'connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume:no_resumable_session_file:codex',
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
        expect(routerPushMock).toHaveBeenCalledWith('/(app)/settings/connected-services');
        alertButtons.find((button) => button.text === 'connectedServices.providerStateSharing.title')?.onPress?.();
        expect(routerPushMock).toHaveBeenCalledWith('/(app)/settings/connected-services/provider-state-sharing');
        alertButtons.find((button) => button.text === 'connectedServices.detail.actions.reconnect')?.onPress?.();
        expect(routerPushMock).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
                accountId: 'happier',
            },
        });

        modalAlertMock.mockClear();
        hook.getCurrent().statusBadges[0]?.onPress?.();
        expect(modalAlertMock).toHaveBeenCalledWith(
            'connectedServices.diagnostics.title.provider_session_state_unavailable_for_resume',
            'connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume:no_resumable_session_file:codex',
            expect.any(Array),
        );

        await act(async () => {
            alertButtons.find((button) => button.text === 'common.continue')?.onPress?.();
            await Promise.resolve();
        });
        expect((hook.getCurrent() as { actionableState?: unknown }).actionableState).toBeNull();

        await act(async () => {
            alertButtons.find((button) => button.text === 'newSession.connectedServiceSwitchUnavailable.startFreshAction')?.onPress?.();
            await Promise.resolve();
        });
        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledTimes(2);
        expect(setSessionConnectedServiceAuthBindingMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            rematerializeServiceId: 'openai-codex',
        }));
    });

    it('surfaces switch verification diagnostics through the shared presentation instead of generic failure copy', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'provider_account_adoption_mismatch',
            serviceId: 'openai-codex',
            diagnostics: {
                uxDiagnostic: {
                    code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerAccountAdoptionMismatch,
                    failurePhase: 'post_switch_verification',
                    source: 'manual_auth_switch',
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
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.codex,
                sessionMetadata: {
                    connectedServices: {
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

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(routerPushMock).not.toHaveBeenCalled();
        expect(modalAlertMock.mock.calls[0]?.[0]).toBe('connectedServices.diagnostics.title.provider_account_adoption_mismatch');
        expect(modalAlertMock.mock.calls[0]?.[1]).toBe('connectedServices.diagnostics.body.provider_account_adoption_mismatch');
        const alertButtons = modalAlertMock.mock.calls[0]?.[2] as Array<{
            text: string;
            onPress?: () => void;
        }>;
        expect(alertButtons).toEqual([
            expect.objectContaining({ text: 'common.retry', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'newSession.connectedServiceSwitchUnavailable.startFreshAction', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'common.continue', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'connectedServices.title', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'connectedServices.detail.actions.reconnect', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'connectedServices.providerStateSharing.title', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'common.cancel', onPress: expect.any(Function) }),
        ]);
        alertButtons.find((button) => button.text === 'connectedServices.title')?.onPress?.();
        expect(routerPushMock).toHaveBeenCalledWith('/(app)/settings/connected-services');
        alertButtons.find((button) => button.text === 'connectedServices.providerStateSharing.title')?.onPress?.();
        expect(routerPushMock).toHaveBeenCalledWith('/(app)/settings/connected-services/provider-state-sharing');
        alertButtons.find((button) => button.text === 'connectedServices.detail.actions.reconnect')?.onPress?.();
        expect(routerPushMock).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
                accountId: 'happier',
            },
        });
        await act(async () => {
            alertButtons.find((button) => button.text === 'newSession.connectedServiceSwitchUnavailable.startFreshAction')?.onPress?.();
            await Promise.resolve();
        });
        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledTimes(2);
        expect(setSessionConnectedServiceAuthBindingMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            rematerializeServiceId: 'openai-codex',
        }));
        expect(modalAlertMock).not.toHaveBeenCalledWith(
            'common.error',
            'connectedServices.authSwitch.switchFailed',
        );
    });

    it('uses structured switch diagnostics with body params instead of generic provider-state-sharing copy', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'provider_state_sharing_unavailable',
            serviceId: 'openai-codex',
            diagnostics: {
                uxDiagnostic: {
                    code: 'provider_session_state_unavailable_for_resume',
                    failurePhase: 'continuity',
                    source: 'manual_auth_switch',
                    serviceId: 'openai-codex',
                    agentId: 'opencode',
                    retryable: false,
                    suggestedActions: ['dismiss'],
                    diagnostics: {
                        reason: 'opencode_restart_rematerialize_required',
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
                agentCore: AGENTS_CORE.codex,
                sessionMetadata: {
                    connectedServices: {
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

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({
            requestClose: vi.fn(),
            maxHeight: 320,
        });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('openai-codex', {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(modalAlertMock).toHaveBeenCalledWith(
            'connectedServices.diagnostics.title.provider_session_state_unavailable_for_resume',
            'connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume:opencode_restart_rematerialize_required:opencode',
            expect.any(Array),
        );
        expect(modalAlertMock).not.toHaveBeenCalledWith(
            'common.error',
            'connectedServices.authSwitch.errors.providerStateSharingUnavailable',
        );
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
                    id: 'codex',
                    connectedServices: {
                        supportedServiceIds: ['openai-codex'],
                        sessionAuthSwitch: { continuityMode: 'restart_shared_state_required' },
                    },
                },
                sessionMetadata: {
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
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
    });

    it('labels native session auth with the compact native label', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.claude,
                sessionMetadata: {
                    connectedServices: {
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
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

        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label).toBe('Native');
    });

    it('renders a stable existing-session auth chip test id', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.claude,
                sessionMetadata: {
                    connectedServices: {
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
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

        const chip = hook.getCurrent().connectedServicesAuthChip;
        const renderedChip = chip?.render({
            chipStyle: () => null,
            iconColor: 'currentColor',
            showLabel: true,
            textStyle: null,
            countTextStyle: null,
            chipAnchorRef: { current: null },
            popoverAnchorRef: { current: null },
            toggleCollapsedPopover: vi.fn(),
        }) as React.ReactElement<{ testID?: string }> | undefined;

        expect(renderedChip?.props.testID).toBe('session-connected-services-auth-chip');
    });

    it('opens connected service settings from the existing-session auth chip', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.claude,
                sessionMetadata: {
                    connectedServices: {
                        bindingsByServiceId: {
                            anthropic: { source: 'native' },
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

        const requestClose = vi.fn();
        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({ requestClose, maxHeight: 320 });

        (content as { props: { onOpenSettings: (serviceId: string) => void } }).props.onOpenSettings('anthropic');

        expect(requestClose).toHaveBeenCalledOnce();
        // UI-2: the picker's settings action deep-links to the tapped service's
        // settings screen, matching the settings-side onOpenConnectedServiceSettings
        // consumers instead of discarding the serviceId.
        expect(routerPushMock).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.claude',
                localId: 'anthropic',
            },
        });
    });

    it('closes the auth popover before starting an existing-session auth switch', async () => {
        const switchOrder: string[] = [];
        modalConfirmMock.mockImplementationOnce(async () => {
            switchOrder.push('confirm');
            return true;
        });
        setSessionConnectedServiceAuthBindingMock.mockImplementationOnce(() => {
            switchOrder.push('rpc');
            return Promise.resolve({ ok: true, action: 'restart_requested' });
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.claude,
                sessionMetadata: {
                    connectedServices: {
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

        const requestClose = vi.fn(() => {
            switchOrder.push('close');
        });
        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({ requestClose, maxHeight: 320 });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
        });

        expect(requestClose).toHaveBeenCalledOnce();
        expect(switchOrder.slice(0, 3)).toEqual(['close', 'confirm', 'rpc']);
    });

    it('does not mutate or call the switch RPC when an active-session switch is cancelled', async () => {
        modalConfirmMock.mockResolvedValueOnce(false);
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() => useSessionConnectedServicesAuthSwitch({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            agentCore: AGENTS_CORE.claude,
            sessionMetadata: {
                connectedServices: {
                    bindingsByServiceId: { anthropic: { source: 'native' } },
                },
            },
            settings: {
                connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                connectedServicesDefaultProfileByServiceId: {},
            },
            switchingDisabledReason: null,
            sessionActive: true,
        }));

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({ requestClose: vi.fn(), maxHeight: 320 });

        await act(async () => {
            (content as { props: { setBindingForService: (serviceId: string, binding: unknown) => void } })
                .props.setBindingForService('anthropic', {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'work',
                });
            await Promise.resolve();
        });

        expect(modalConfirmMock).toHaveBeenCalledOnce();
        expect(setSessionConnectedServiceAuthBindingMock).not.toHaveBeenCalled();
    });

    it('shows a restarting status badge until the switched session is active with the requested binding', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        type HookProps = Readonly<{
            sessionActive: boolean;
            sessionMetadata: unknown;
        }>;
        const nativeSessionMetadata: unknown = {
            connectedServices: {
                bindingsByServiceId: {
                    anthropic: { source: 'native' },
                },
            },
        };
        const connectedSessionMetadata: unknown = {
            connectedServices: {
                bindingsByServiceId: {
                    anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
                },
            },
        };
        const buildHookProps = (props: HookProps) => ({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            agentCore: AGENTS_CORE.claude,
            sessionMetadata: props.sessionMetadata,
            settings: {
                connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                connectedServicesDefaultProfileByServiceId: {},
            },
            switchingDisabledReason: null,
            sessionActive: props.sessionActive,
        } as const);

        const hook = await renderHook(
            (props: HookProps) => useSessionConnectedServicesAuthSwitch(buildHookProps(props)),
            {
                initialProps: {
                    sessionActive: false,
                    sessionMetadata: nativeSessionMetadata,
                },
            },
        );

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({ requestClose: vi.fn(), maxHeight: 320 });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
        });

        expect(hook.getCurrent().statusBadges).toEqual([
            expect.objectContaining({
                key: 'connected-services-auth-switch-restarting',
                label: 'Restarting session',
                tone: 'active',
            }),
        ]);

        await hook.rerender({
            sessionActive: true,
            sessionMetadata: nativeSessionMetadata,
        });

        expect(hook.getCurrent().statusBadges).toEqual([
            expect.objectContaining({
                key: 'connected-services-auth-switch-restarting',
            }),
        ]);

        await hook.rerender({
            sessionActive: true,
            sessionMetadata: connectedSessionMetadata,
        });

        expect(hook.getCurrent().statusBadges).toEqual([]);
    });

    it('clears the restarting badge when daemon materializes the selected group with its active profile id', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        type HookProps = Readonly<{
            sessionActive: boolean;
            sessionMetadata: unknown;
        }>;
        const nativeSessionMetadata: unknown = {
            connectedServices: {
                bindingsByServiceId: {
                    anthropic: { source: 'native' },
                },
            },
        };
        const materializedGroupSessionMetadata: unknown = {
            connectedServices: {
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'team',
                        profileId: 'work',
                    },
                },
            },
        };
        const buildHookProps = (props: HookProps) => ({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            agentCore: AGENTS_CORE.claude,
            sessionMetadata: props.sessionMetadata,
            settings: {
                connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                connectedServicesDefaultProfileByServiceId: {},
            },
            switchingDisabledReason: null,
            sessionActive: props.sessionActive,
        } as const);

        const hook = await renderHook(
            (props: HookProps) => useSessionConnectedServicesAuthSwitch(buildHookProps(props)),
            {
                initialProps: {
                    sessionActive: false,
                    sessionMetadata: nativeSessionMetadata,
                },
            },
        );

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({ requestClose: vi.fn(), maxHeight: 320 });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'group'; groupId: string },
                ) => void;
            } }).props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'group',
                groupId: 'team',
            });
            await Promise.resolve();
        });

        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledWith(expect.objectContaining({
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'team',
                    },
                    'claude-subscription': { source: 'native' },
                },
            },
        }));

        expect(hook.getCurrent().statusBadges).toEqual([
            expect.objectContaining({
                key: 'connected-services-auth-switch-restarting',
            }),
        ]);

        await hook.rerender({
            sessionActive: true,
            sessionMetadata: materializedGroupSessionMetadata,
        });

        expect(hook.getCurrent().statusBadges).toEqual([]);
    });

    it('exposes manual and daemon restart signals as shared restart state', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        const startedAtMs = Date.now();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.claude,
                sessionMetadata: {
                    connectedServices: {
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
                    attemptId: `connected-service-account-switch:manual:${startedAtMs}`,
                    reason: 'manual_auth_switch',
                    startedAtMs,
                }],
            } as Parameters<typeof useSessionConnectedServicesAuthSwitch>[0] & {
                intentionalRestartSignals: ReadonlyArray<{
                    status: 'restarting';
                    attemptId: string;
                    reason: 'manual_auth_switch';
                    startedAtMs: number;
                }>;
            }),
        );

        expect((hook.getCurrent() as { restartState?: unknown }).restartState).toEqual({
            status: 'restarting',
            attemptId: `connected-service-account-switch:manual:${startedAtMs}`,
            reason: 'manual_auth_switch',
            startedAtMs,
        });
    });

    it('keeps restart state when the restart acknowledgement times out', async () => {
        setSessionConnectedServiceAuthBindingMock.mockRejectedValueOnce(
            Object.assign(new Error('RPC timeout'), { rpcErrorCode: 'timeout' }),
        );
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.claude,
                sessionMetadata: {
                    connectedServices: {
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

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({ requestClose: vi.fn(), maxHeight: 320 });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(modalAlertMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
            .toContain('Work');
        expect(hook.getCurrent().statusBadges).toEqual([
            expect.objectContaining({
                key: 'connected-services-auth-switch-restarting',
            }),
        ]);
    });

    it('exits a timed-out restart when active session evidence still has the old binding', async () => {
        setSessionConnectedServiceAuthBindingMock.mockRejectedValueOnce(
            Object.assign(new Error('RPC timeout'), { rpcErrorCode: 'timeout' }),
        );
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        type HookProps = Readonly<{
            sessionActive: boolean;
            sessionMetadata: unknown;
        }>;
        const nativeSessionMetadata: unknown = {
            connectedServices: {
                bindingsByServiceId: {
                    anthropic: { source: 'native' },
                },
            },
        };
        const buildHookProps = (props: HookProps) => ({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            agentCore: AGENTS_CORE.claude,
            sessionMetadata: props.sessionMetadata,
            settings: {
                connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                connectedServicesDefaultProfileByServiceId: {},
            },
            switchingDisabledReason: null,
            sessionActive: props.sessionActive,
        } as const);

        const hook = await renderHook(
            (props: HookProps) => useSessionConnectedServicesAuthSwitch(buildHookProps(props)),
            {
                initialProps: {
                    sessionActive: false,
                    sessionMetadata: nativeSessionMetadata,
                },
            },
        );

        const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
        const content = renderContent({ requestClose: vi.fn(), maxHeight: 320 });

        await act(async () => {
            (content as { props: {
                setBindingForService: (
                    serviceId: string,
                    binding: { source: 'connected'; selection: 'profile'; profileId: string },
                ) => void;
            } }).props.setBindingForService('anthropic', {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(hook.getCurrent().statusBadges).toEqual([
            expect.objectContaining({
                key: 'connected-services-auth-switch-restarting',
            }),
        ]);

        await hook.rerender({
            sessionActive: true,
            sessionMetadata: nativeSessionMetadata,
        });

        expect(modalAlertMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
            .not.toContain('Work');
        expect(hook.getCurrent().statusBadges).toEqual([
            expect.objectContaining({
                key: 'connected-services-auth-switch-retry',
                testID: 'session-connected-services-auth-switch-retry-status',
                tone: 'warning',
            }),
        ]);
    });

    it('bounds a timed-out restart when no matching binding evidence arrives', async () => {
        vi.useFakeTimers();
        try {
            setSessionConnectedServiceAuthBindingMock.mockRejectedValueOnce(
                Object.assign(new Error('RPC timeout'), { rpcErrorCode: 'timeout' }),
            );
            const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

            const hook = await renderHook(() =>
                useSessionConnectedServicesAuthSwitch({
                    sessionId: 'session-1',
                    agentId: 'claude',
                    machineId: 'machine-1',
                    serverId: 'server-1',
                    agentCore: AGENTS_CORE.claude,
                    sessionMetadata: {
                        connectedServices: {
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

            const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
            if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
            const content = renderContent({ requestClose: vi.fn(), maxHeight: 320 });

            await act(async () => {
                (content as { props: {
                    setBindingForService: (
                        serviceId: string,
                        binding: { source: 'connected'; selection: 'profile'; profileId: string },
                    ) => void;
                } }).props.setBindingForService('anthropic', {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'work',
                });
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(hook.getCurrent().statusBadges).toEqual([
                expect.objectContaining({
                    key: 'connected-services-auth-switch-restarting',
                }),
            ]);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000);
            });

            expect(modalAlertMock).not.toHaveBeenCalled();
            expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
                .not.toContain('Work');
            expect(hook.getCurrent().statusBadges).toEqual([
                expect.objectContaining({
                    key: 'connected-services-auth-switch-retry',
                    testID: 'session-connected-services-auth-switch-retry-status',
                    tone: 'warning',
                }),
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears retry state when late authoritative evidence applies the requested binding', async () => {
        vi.useFakeTimers();
        try {
            setSessionConnectedServiceAuthBindingMock.mockRejectedValueOnce(
                Object.assign(new Error('RPC timeout'), { rpcErrorCode: 'timeout' }),
            );
            const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

            type HookProps = Readonly<{
                sessionActive: boolean;
                sessionMetadata: unknown;
            }>;
            const nativeSessionMetadata: unknown = {
                connectedServices: {
                    bindingsByServiceId: {
                        anthropic: { source: 'native' },
                    },
                },
            };
            const connectedSessionMetadata: unknown = {
                connectedServices: {
                    bindingsByServiceId: {
                        anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
                    },
                },
            };
            const buildHookProps = (props: HookProps) => ({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                agentCore: AGENTS_CORE.claude,
                sessionMetadata: props.sessionMetadata,
                settings: {
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
                sessionActive: props.sessionActive,
            } as const);

            const hook = await renderHook(
                (props: HookProps) => useSessionConnectedServicesAuthSwitch(buildHookProps(props)),
                {
                    initialProps: {
                        sessionActive: false,
                        sessionMetadata: nativeSessionMetadata,
                    },
                },
            );

            const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
            if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
            const content = renderContent({ requestClose: vi.fn(), maxHeight: 320 });

            await act(async () => {
                (content as { props: {
                    setBindingForService: (
                        serviceId: string,
                        binding: { source: 'connected'; selection: 'profile'; profileId: string },
                    ) => void;
                } }).props.setBindingForService('anthropic', {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'work',
                });
                await Promise.resolve();
                await Promise.resolve();
            });

            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000);
            });
            expect(hook.getCurrent().statusBadges).toEqual([
                expect.objectContaining({
                    key: 'connected-services-auth-switch-retry',
                }),
            ]);

            await hook.rerender({
                sessionActive: true,
                sessionMetadata: connectedSessionMetadata,
            });

            expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
                .toContain('Work');
            expect(hook.getCurrent().statusBadges).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});
