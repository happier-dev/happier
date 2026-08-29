import { renderHook } from '@/dev/testkit';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS,
    CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
    type PluginProjectedAgentConnectedAccountPurposeV2,
} from '@happier-dev/protocol';
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

// Canonical qualified Connected Account service keys used across this suite.
const CLAUDE_SERVICE_KEY = 'happier.agent.claude/anthropic';
const CODEX_SERVICE_KEY = 'happier.agent.codex/openai-codex';
const GEMINI_SERVICE_KEY = 'happier.agent.gemini/gemini-account';
const OPENAI_SERVICE_KEY = 'happier.voice.openai/openai';
// Novel external plugin service: no bundled enum member, no generated legacy
// mapping, no built-in Agent identity.
const NOVEL_SERVICE_KEY = 'acme.review/reviewer-service';

const profileState = vi.hoisted(() => ({
    current: {
        connectedAccountsV4: [] as Array<Record<string, unknown>>,
        connectedAccountGroupsV4: [] as Array<Record<string, unknown>>,
        connectedServiceCredentialRevisionsV1: [] as Array<Record<string, unknown>>,
    },
}));

function v4Account(params: Readonly<{
    pluginId: string;
    localId: string;
    accountId: string;
    email?: string;
    displayName?: string;
    kind?: 'oauth' | 'token';
    status?: string;
}>): Record<string, unknown> {
    return {
        revisionSemantics: 'legacy_unfenced',
        ref: {
            service: { pluginId: params.pluginId, localId: params.localId },
            accountId: params.accountId,
        },
        status: params.status ?? 'connected',
        authenticationModeId: null,
        configurationReady: true,
        configurationRevision: null,
        kind: params.kind ?? null,
        expiresAt: null,
        lastUsedAt: null,
        providerIdentity: params.email ? { email: params.email } : {},
        ...(params.displayName ? { displayName: params.displayName } : {}),
    };
}

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
    }, {
        // Public descriptor for the novel external plugin service: the exact
        // machine-published presentation used by every neutral/public surface.
        id: 'reviewer-service',
        serviceId: 'reviewer-service',
        pluginId: 'acme.review',
        provenance: 'first_party',
        sourceKind: 'bundled',
        title: 'Acme Reviewer Auth',
        authentication: {
            defaultModeId: 'api-key',
            modes: [{
                id: 'api-key',
                kind: 'manual',
                outcomeReconciliation: 'none',
                fields: [{
                    id: 'token',
                    title: 'Acme token',
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

const CLAUDE_CONNECTED_ACCOUNTS = [
    {
        purpose: 'primary',
        service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
    },
    {
        purpose: 'primary',
        service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
    },
] satisfies readonly PluginProjectedAgentConnectedAccountPurposeV2[];
const CODEX_CONNECTED_ACCOUNTS = [
    {
        purpose: 'primary',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
    },
    {
        purpose: 'model_upstream',
        service: { pluginId: 'happier.voice.openai', localId: 'openai' },
    },
] satisfies readonly PluginProjectedAgentConnectedAccountPurposeV2[];
const CLAUDE_SUBSCRIPTION_SERVICE_KEY = 'happier.agent.claude/claude-subscription';
const GEMINI_CONNECTED_ACCOUNTS = [{
    purpose: 'primary',
    service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' },
}] satisfies readonly PluginProjectedAgentConnectedAccountPurposeV2[];
const NOVEL_CONNECTED_ACCOUNTS = [{
    purpose: 'primary',
    service: { pluginId: 'acme.review', localId: 'reviewer-service' },
}] satisfies readonly PluginProjectedAgentConnectedAccountPurposeV2[];

function seedClaudeProfile(): void {
    profileState.current = {
        connectedAccountsV4: [
            v4Account({
                pluginId: 'happier.agent.claude',
                localId: 'anthropic',
                accountId: 'work',
                email: 'work@example.com',
                kind: 'token',
                displayName: 'Work',
            }),
        ],
        connectedAccountGroupsV4: [],
        connectedServiceCredentialRevisionsV1: [],
    };
}

function seedCodexProfile(): void {
    profileState.current = {
        connectedAccountsV4: [
            v4Account({
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
                accountId: 'happier',
                email: 'happier@example.com',
                kind: 'oauth',
                displayName: 'Happier',
            }),
            v4Account({
                pluginId: 'happier.voice.openai',
                localId: 'openai',
                accountId: 'api',
                email: 'api@example.com',
                kind: 'token',
                displayName: 'API',
            }),
        ],
        connectedAccountGroupsV4: [],
        connectedServiceCredentialRevisionsV1: [],
    };
}

function seedNovelProfile(): void {
    profileState.current = {
        connectedAccountsV4: [
            v4Account({
                pluginId: 'acme.review',
                localId: 'reviewer-service',
                accountId: 'reviewer',
                email: 'reviewer@acme.test',
                kind: 'token',
                displayName: 'Reviewer',
            }),
        ],
        connectedAccountGroupsV4: [],
        connectedServiceCredentialRevisionsV1: [],
    };
}

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

// Mock factories must import the leaf testkit mock modules, never the full
// `@/dev/testkit` barrel: the barrel's own evaluation transitively imports
// product modules (e.g. `@/text` via the Agent catalog fixtures), so awaiting
// the barrel inside a factory that is itself invoked during that evaluation
// deadlocks module evaluation and the runner collects no tests.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
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

// Leaf import, not the barrel — see the factory-deadlock note above.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: (...args) => modalAlertMock(...args),
            confirm: (...args) => modalConfirmMock(...args),
        },
    }).module;
});

// Leaf import, not the barrel — see the factory-deadlock note above.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
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
                return params ? `${key}:${JSON.stringify(params)}` : key;
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

type PopoverConnectedBinding = {
    source: 'connected';
    selection: 'profile' | 'group';
    profileId?: string;
    groupId?: string;
};
type PopoverBinding = PopoverConnectedBinding | { source: 'native' };
type PopoverContentProps = {
    resolveOptionAvailability: (params: {
        serviceId: string;
        binding: PopoverConnectedBinding;
    }) => { disabled?: boolean };
    setBindingForService: (serviceId: string, binding: PopoverBinding) => void;
};

type AuthSwitchHookLike = {
    getCurrent: () => {
        connectedServicesAuthChip: import('@/components/sessions/agentInput/agentInputContracts').AgentInputExtraActionChip | null;
    };
};

function renderChipPopover(
    hook: AuthSwitchHookLike,
    maxHeight = 320,
): PopoverContentProps {
    const renderContent = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
    expect(typeof renderContent).toBe('function');
    if (typeof renderContent !== 'function') throw new Error('Expected renderContent');
    const content = renderContent({ requestClose: vi.fn(), maxHeight }) as { props: PopoverContentProps };
    return content.props;
}

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
        seedClaudeProfile();
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
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            [CLAUDE_SERVICE_KEY]: { source: 'native' },
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

        const props = renderChipPopover(hook);
        expect(props.resolveOptionAvailability({
            serviceId: CLAUDE_SERVICE_KEY,
            binding: { source: 'connected', selection: 'profile', profileId: 'work' },
        })).toEqual({ disabled: true });
    });

    it('routes Gemini native-to-connected session switches to the daemon with the qualified key', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');

        profileState.current = {
            connectedAccountsV4: [
                v4Account({
                    pluginId: 'happier.agent.gemini',
                    localId: 'gemini-account',
                    accountId: 'work',
                    email: 'work@example.com',
                    kind: 'token',
                    displayName: 'Work',
                }),
            ],
            connectedAccountGroupsV4: [],
            connectedServiceCredentialRevisionsV1: [],
        };

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'gemini',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: GEMINI_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            [GEMINI_SERVICE_KEY]: { source: 'native' },
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

        const props = renderChipPopover(hook);
        expect(props.resolveOptionAvailability({
            serviceId: GEMINI_SERVICE_KEY,
            binding: { source: 'connected', selection: 'profile', profileId: 'work' },
        })).toEqual({});

        await act(async () => {
            props.setBindingForService(GEMINI_SERVICE_KEY, {
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
                    [GEMINI_SERVICE_KEY]: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
        });
    });

    it('offers a NOVEL external plugin service with neutral/public presentation and never a bundled identity', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedNovelProfile();

        const hook = await renderHook(() => useSessionConnectedServicesAuthSwitch({
            sessionId: 'session-novel',
            agentId: 'acme.review/reviewer',
            machineId: 'machine-1',
            serverId: 'server-1',
            connectedAccounts: NOVEL_CONNECTED_ACCOUNTS,
            sessionMetadata: {
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        [NOVEL_SERVICE_KEY]: { source: 'native' },
                    },
                },
            },
            settings: {
                connectedServicesProfileLabelByKey: {},
                connectedServicesDefaultProfileByServiceId: {},
            },
            switchingDisabledReason: null,
        }));

        // A native session binding keeps the compact neutral native label; the
        // public descriptor presentation is asserted on the connected binding
        // after the switch below.
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
            .toBe('Native');

        const props = renderChipPopover(hook);
        expect(props.resolveOptionAvailability({
            serviceId: NOVEL_SERVICE_KEY,
            binding: { source: 'connected', selection: 'profile', profileId: 'reviewer' },
        })).toEqual({});

        await act(async () => {
            props.setBindingForService(NOVEL_SERVICE_KEY, {
                source: 'connected',
                selection: 'profile',
                profileId: 'reviewer',
            });
            await Promise.resolve();
        });

        // Public presentation: the applied machine descriptor title, not a
        // borrowed Codex/Claude brand name, and not a raw service id.
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
            .toBe('Acme Reviewer Auth: Reviewer');

        // The canonical switch RPC receives the exact qualified key.
        const rpcParams = setSessionConnectedServiceAuthBindingMock.mock.calls[0]?.[0];
        expect(rpcParams).toEqual(expect.objectContaining({
            sessionId: 'session-novel',
            agentId: 'acme.review/reviewer',
            machineId: 'machine-1',
        }));
        expect(rpcParams.bindings).toEqual({
            v: 1,
            bindingsByServiceId: {
                [NOVEL_SERVICE_KEY]: {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'reviewer',
                },
            },
        });
        // The novel service must not collapse onto a bundled Agent identity.
        expect(Object.keys(rpcParams.bindings.bindingsByServiceId))
            .toEqual([NOVEL_SERVICE_KEY]);
        expect(rpcParams.bindings.bindingsByServiceId[CODEX_SERVICE_KEY]).toBeUndefined();
        expect(rpcParams.bindings.bindingsByServiceId[CLAUDE_SERVICE_KEY]).toBeUndefined();
    });

    it('settles a novel-service switch from refreshed session state and survives rerender', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedNovelProfile();

        const nativeMetadata: unknown = {
            connectedServices: {
                v: 1,
                bindingsByServiceId: { [NOVEL_SERVICE_KEY]: { source: 'native' } },
            },
        };
        const connectedMetadata: unknown = {
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    [NOVEL_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'reviewer' },
                },
            },
        };

        const hook = await renderHook(
            (props: { sessionActive: boolean; sessionMetadata: unknown }) => useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-novel',
                agentId: 'acme.review/reviewer',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: NOVEL_CONNECTED_ACCOUNTS,
                sessionMetadata: props.sessionMetadata,
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
                sessionActive: props.sessionActive,
            }),
            { initialProps: { sessionActive: false, sessionMetadata: nativeMetadata } },
        );

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(NOVEL_SERVICE_KEY, {
                source: 'connected',
                selection: 'profile',
                profileId: 'reviewer',
            });
            await Promise.resolve();
        });

        expect(hook.getCurrent().statusBadges).toEqual([
            expect.objectContaining({ key: 'connected-services-auth-switch-restarting' }),
        ]);

        // Refreshed session evidence carries the requested qualified binding.
        await hook.rerender({ sessionActive: true, sessionMetadata: connectedMetadata });
        expect(hook.getCurrent().statusBadges).toEqual([]);
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
            .toBe('Acme Reviewer Auth: Reviewer');
    });

    it('displays bundled legacy persisted bindings through the compatibility adapter while new writes stay qualified', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedClaudeProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-legacy',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                // Released bundled Sessions persisted the scalar service id;
                // the provenance-named ingress maps it to the canonical key.
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
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

        // Display: the legacy binding is shown through the compatibility adapter
        // under the canonical qualified identity.
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label)
            .toBe('Anthropic API key: Work');

        // New writes are qualified: switching away emits ONLY canonical keys.
        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CLAUDE_SERVICE_KEY, { source: 'native' });
            await Promise.resolve();
        });
        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledWith(expect.objectContaining({
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    [CLAUDE_SERVICE_KEY]: { source: 'native' },
                    [CLAUDE_SUBSCRIPTION_SERVICE_KEY]: { source: 'native' },
                },
            },
        }));
        const writtenKeys = Object.keys(
            setSessionConnectedServiceAuthBindingMock.mock.calls[0]?.[0].bindings.bindingsByServiceId,
        );
        // The canonical writer emits the full declared service set under
        // canonical qualified keys only (same contract as the sibling
        // materialization and Codex switch tests).
        expect(writtenKeys).toEqual([CLAUDE_SERVICE_KEY, CLAUDE_SUBSCRIPTION_SERVICE_KEY]);
        expect(writtenKeys).not.toContain('anthropic');
    });

    it('fails closed for an undeclared service and writes only declared services', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                // The Agent declares ONLY the Codex service.
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
                // Metadata carries a binding for an undeclared novel service.
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            [CODEX_SERVICE_KEY]: { source: 'native' },
                            [NOVEL_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'reviewer' },
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

        // The undeclared connected binding never surfaces as connected auth.
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label).toBe('Native');

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        const rpcParams = setSessionConnectedServiceAuthBindingMock.mock.calls[0]?.[0];
        expect(rpcParams.bindings.bindingsByServiceId).toEqual({
            [OPENAI_SERVICE_KEY]: { source: 'native' },
            [CODEX_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'happier' },
        });
        expect(rpcParams.bindings.bindingsByServiceId[NOVEL_SERVICE_KEY]).toBeUndefined();
    });

    it('fails closed with neutral actions when the daemon rejects an unsupported service', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedNovelProfile();
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'unsupported_service',
            serviceId: NOVEL_SERVICE_KEY,
        });

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-novel',
                agentId: 'acme.review/reviewer',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: NOVEL_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [NOVEL_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(NOVEL_SERVICE_KEY, {
                source: 'connected',
                selection: 'profile',
                profileId: 'reviewer',
            });
            await Promise.resolve();
        });

        // Neutral failure surface: a plain error alert, no routing, no
        // actionable diagnostic, and the optimistic binding is reverted.
        expect(modalAlertMock).toHaveBeenCalledWith(
            'common.error',
            'connectedServices.authSwitch.errors.unsupportedService',
        );
        expect(routerPushMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().statusBadges).toEqual([]);
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label).toBe('Native');
    });

    it('enables Codex native-to-connected session switches when provider state sharing is shared', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            [CODEX_SERVICE_KEY]: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        expect(props.resolveOptionAvailability({
            serviceId: CODEX_SERVICE_KEY,
            binding: { source: 'connected', selection: 'profile', profileId: 'happier' },
        })).toEqual({});

        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
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
                    [OPENAI_SERVICE_KEY]: { source: 'native' },
                    [CODEX_SERVICE_KEY]: {
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
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            [CODEX_SERVICE_KEY]: { source: 'native' },
                        },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        expect(props.resolveOptionAvailability({
            serviceId: CODEX_SERVICE_KEY,
            binding: { source: 'connected', selection: 'profile', profileId: 'happier' },
        })).toEqual({});

        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
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
            serviceId: CODEX_SERVICE_KEY,
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CODEX_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
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
            serviceId: CODEX_SERVICE_KEY,
            diagnostics: {
                failurePhase: 'hot_apply',
                serviceResultsByServiceId: {
                    [CLAUDE_SERVICE_KEY]: { status: 'applied' },
                    [CODEX_SERVICE_KEY]: { status: 'failed', errorCode: 'hot_apply_failed' },
                    [OPENAI_SERVICE_KEY]: { status: 'not_attempted' },
                },
            },
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: [
                    ...CODEX_CONNECTED_ACCOUNTS,
                    { purpose: 'model_upstream', service: { pluginId: 'happier.agent.claude', localId: 'anthropic' } },
                    { purpose: 'model_upstream', service: { pluginId: 'happier.voice.openai', localId: 'openai' } },
                ] satisfies readonly PluginProjectedAgentConnectedAccountPurposeV2[],
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CODEX_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(hook.getCurrent().statusBadges).toEqual([
            expect.objectContaining({
                key: 'connected-services-auth-switch-service-happier.agent.codex_openai-codex-failed',
                testID: 'session-connected-services-auth-switch-service-happier.agent.codex_openai-codex-failed-status',
                label: 'Codex auth failed',
                tone: 'warning',
            }),
            expect.objectContaining({
                key: 'connected-services-auth-switch-service-happier.voice.openai_openai-not-attempted',
                testID: 'session-connected-services-auth-switch-service-happier.voice.openai_openai-not-attempted-status',
                label: 'OpenAI API key auth not applied',
                tone: 'warning',
            }),
        ]);
    });

    it('preserves generic diagnostic recovery actions in the alert buttons', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'provider_account_adoption_mismatch',
            serviceId: CODEX_SERVICE_KEY,
            diagnostics: {
                uxDiagnostic: {
                    code: 'provider_account_adoption_mismatch',
                    failurePhase: 'post_switch_recovery',
                    source: 'manual_auth_switch',
                    serviceId: CODEX_SERVICE_KEY,
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
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CODEX_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
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
            serviceId: CODEX_SERVICE_KEY,
            diagnostics: {
                partialState: 'runtime_auth_partially_applied',
            },
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CODEX_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
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
            serviceId: CODEX_SERVICE_KEY,
            diagnostics: {
                partialState: 'runtime_auth_partially_applied',
            },
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CODEX_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        modalAlertMock.mockClear();
        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

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
                    [CODEX_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'happier' },
                }),
            }),
        }));
        expect(modalConfirmMock).not.toHaveBeenCalled();
    });

    it('reverts a partial hot-apply to the previous binding via the canonical apply path', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'partial_applied_pending_reconciliation',
            serviceId: CODEX_SERVICE_KEY,
            diagnostics: {
                partialState: 'runtime_auth_partially_applied',
            },
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CODEX_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
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

        setSessionConnectedServiceAuthBindingMock.mockClear();
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({ ok: true, action: 'metadata_updated' });
        await act(async () => {
            alertButtons?.find((button) => button.text === 'connectedServices.authSwitch.partialApply.revert')?.onPress?.();
            await Promise.resolve();
        });
        expect(setSessionConnectedServiceAuthBindingMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            bindings: expect.objectContaining({
                bindingsByServiceId: expect.objectContaining({
                    [CODEX_SERVICE_KEY]: { source: 'native' },
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
            serviceId: CODEX_SERVICE_KEY,
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CODEX_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
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
            serviceId: CODEX_SERVICE_KEY,
            diagnostics: {
                actionRequired: {
                    kind: 'reconnect_profile',
                    profileId: 'happier',
                },
            },
        });
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CODEX_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
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

    it('routes passive Provider daemon/runtime failures into the incumbent recovery owner', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedCodexProfile();

        const hook = await renderHook(() => useSessionConnectedServicesAuthSwitch({
            sessionId: 'session-passive-provider',
            agentId: 'codex',
            machineId: 'machine-1',
            serverId: 'server-1',
            connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
            sessionMetadata: {
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        [CODEX_SERVICE_KEY]: {
                            source: 'connected',
                            selection: 'profile',
                            profileId: 'happier',
                        },
                    },
                },
            },
            settings: {
                connectedServicesProfileLabelByKey: {},
                connectedServicesDefaultProfileByServiceId: {},
                connectedServicesProviderStateSharingSettingsV1: {
                    v: 1,
                    defaults: { configMode: 'linked', stateMode: 'shared' },
                    byAgentId: {},
                    acknowledgedRisksByAgentId: {},
                },
            },
            switchingDisabledReason: null,
            passiveProviderRecoveryServiceId: CODEX_SERVICE_KEY,
        }));

        await act(async () => { await Promise.resolve(); });
        expect(hook.getCurrent().actionableState).toEqual(expect.objectContaining({
            kind: 'provider_session_state_unavailable_for_resume',
            recovery: 'retry_required',
            diagnostic: expect.objectContaining({
                code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
                source: 'runtime_auth_recovery',
                serviceId: CODEX_SERVICE_KEY,
            }),
        }));
        const recoveryBadge = hook.getCurrent().statusBadges.find(
            (badge) => badge.testID === 'session-connected-services-auth-switch-retry-required',
        );
        expect(recoveryBadge?.onPress).toEqual(expect.any(Function));
        await act(async () => {
            recoveryBadge?.onPress?.();
            await Promise.resolve();
        });
        const alertButtons = modalAlertMock.mock.calls.at(-1)?.[2] as Array<{
            text: string;
            onPress?: () => void;
        }>;
        await act(async () => {
            alertButtons.find((button) => button.text === 'newSession.connectedServiceSwitchUnavailable.startFreshAction')?.onPress?.();
            await Promise.resolve();
        });
        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-passive-provider',
            rematerializeServiceId: CODEX_SERVICE_KEY,
        }));
    });

    it('surfaces provider session-state resume gaps with executable diagnostic actions', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'provider_session_state_unavailable_for_resume',
            serviceId: CODEX_SERVICE_KEY,
            diagnostics: {
                uxDiagnostic: {
                    code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
                    failurePhase: 'continuity',
                    source: 'manual_auth_switch',
                    serviceId: CODEX_SERVICE_KEY,
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
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CODEX_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
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
            'connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume',
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
            'connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume',
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
            rematerializeServiceId: CODEX_SERVICE_KEY,
        }));
    });

    it('surfaces switch verification diagnostics through the shared presentation instead of generic failure copy', async () => {
        setSessionConnectedServiceAuthBindingMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'provider_account_adoption_mismatch',
            serviceId: CODEX_SERVICE_KEY,
            diagnostics: {
                uxDiagnostic: {
                    code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerAccountAdoptionMismatch,
                    failurePhase: 'post_switch_verification',
                    source: 'manual_auth_switch',
                    serviceId: CODEX_SERVICE_KEY,
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
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CODEX_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
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
            rematerializeServiceId: CODEX_SERVICE_KEY,
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
            serviceId: CODEX_SERVICE_KEY,
            diagnostics: {
                uxDiagnostic: {
                    code: 'provider_session_state_unavailable_for_resume',
                    failurePhase: 'continuity',
                    source: 'manual_auth_switch',
                    serviceId: CODEX_SERVICE_KEY,
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
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CODEX_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CODEX_SERVICE_KEY, {
                source: 'connected',
                selection: 'profile',
                profileId: 'happier',
            });
            await Promise.resolve();
        });

        expect(modalAlertMock).toHaveBeenCalledWith(
            'connectedServices.diagnostics.title.provider_session_state_unavailable_for_resume',
            'connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume',
            expect.any(Array),
        );
        expect(modalAlertMock).not.toHaveBeenCalledWith(
            'common.error',
            'connectedServices.authSwitch.errors.providerStateSharingUnavailable',
        );
    });

    it('recovers the active Codex connected profile from the runtime descriptor when session bindings are missing', async () => {
        const { useSessionConnectedServicesAuthSwitch } = await import('./useSessionConnectedServicesAuthSwitch');
        seedCodexProfile();

        const hook = await renderHook(() =>
            useSessionConnectedServicesAuthSwitch({
                sessionId: 'session-1',
                agentId: 'codex',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CODEX_CONNECTED_ACCOUNTS,
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
                    connectedServicesProfileLabelByKey: {},
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
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } },
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
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } },
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
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } },
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
        const props = renderChipPopover(hook);
        props.resolveOptionAvailability({
            serviceId: CLAUDE_SERVICE_KEY,
            binding: { source: 'connected', selection: 'profile', profileId: 'work' },
        });

        const popoverRenderer = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof popoverRenderer !== 'function') throw new Error('Expected renderContent');
        const content = popoverRenderer({ requestClose, maxHeight: 320 }) as {
            props: { onOpenSettings: (serviceId: string) => void };
        };
        content.props.onOpenSettings(CLAUDE_SERVICE_KEY);

        expect(requestClose).toHaveBeenCalledOnce();
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
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
            }),
        );

        const requestClose = vi.fn(() => {
            switchOrder.push('close');
        });
        const popoverRenderer = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.renderContent;
        if (typeof popoverRenderer !== 'function') throw new Error('Expected renderContent');
        const content = popoverRenderer({ requestClose, maxHeight: 320 }) as { props: PopoverContentProps };

        await act(async () => {
            content.props.setBindingForService(CLAUDE_SERVICE_KEY, {
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
            connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
            sessionMetadata: {
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } },
                },
            },
            settings: {
                connectedServicesProfileLabelByKey: {},
                connectedServicesDefaultProfileByServiceId: {},
            },
            switchingDisabledReason: null,
            sessionActive: true,
        }));

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CLAUDE_SERVICE_KEY, {
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
                v: 1,
                bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } },
            },
        };
        const connectedSessionMetadata: unknown = {
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
                },
            },
        };
        const buildHookProps = (props: HookProps) => ({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
            sessionMetadata: props.sessionMetadata,
            settings: {
                connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CLAUDE_SERVICE_KEY, {
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

        profileState.current = {
            connectedAccountsV4: [
                v4Account({
                    pluginId: 'happier.agent.claude',
                    localId: 'anthropic',
                    accountId: 'work',
                    email: 'work@example.com',
                    kind: 'token',
                    displayName: 'Work',
                }),
                v4Account({
                    pluginId: 'happier.agent.claude',
                    localId: 'claude-subscription',
                    accountId: 'pro',
                    email: 'pro@example.com',
                    kind: 'oauth',
                    displayName: 'Pro',
                }),
            ],
            connectedAccountGroupsV4: [{
                v: 1,
                ref: { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, groupId: 'team' },
                incarnation: 'team:1',
                displayName: 'Team pool',
                policy: { v: 1, strategy: 'least_limited', autoSwitch: true, switchOn: { usageLimit: true, authExpired: true, accountChanged: false, refreshFailure: true } },
                activeConnectedAccountId: 'work',
                generation: 3,
                runtimeStateRevision: 1,
                state: { status: 'ready' },
                createdAt: 0,
                updatedAt: 0,
                members: [
                    { v: 1, connectedAccountId: 'work', priority: 100, enabled: true, state: {}, createdAt: 0, updatedAt: 0 },
                ],
            }],
            connectedServiceCredentialRevisionsV1: [],
        };

        type HookProps = Readonly<{
            sessionActive: boolean;
            sessionMetadata: unknown;
        }>;
        const nativeSessionMetadata: unknown = {
            connectedServices: {
                v: 1,
                bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } },
            },
        };
        const materializedGroupSessionMetadata: unknown = {
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    [CLAUDE_SERVICE_KEY]: {
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
            connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
            sessionMetadata: props.sessionMetadata,
            settings: {
                connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CLAUDE_SERVICE_KEY, {
                source: 'connected',
                selection: 'group',
                groupId: 'team',
            });
            await Promise.resolve();
        });

        expect(setSessionConnectedServiceAuthBindingMock).toHaveBeenCalledWith(expect.objectContaining({
            expectedGroupGenerationByServiceId: { [CLAUDE_SERVICE_KEY]: 3 },
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    [CLAUDE_SERVICE_KEY]: {
                        source: 'connected',
                        selection: 'group',
                        groupId: 'team',
                    },
                    'happier.agent.claude/claude-subscription': { source: 'native' },
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
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
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
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                sessionMetadata: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } },
                    },
                },
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                },
                switchingDisabledReason: null,
                sessionActive: false,
            }),
        );

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CLAUDE_SERVICE_KEY, {
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
                v: 1,
                bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } },
            },
        };
        const buildHookProps = (props: HookProps) => ({
            sessionId: 'session-1',
            agentId: 'claude',
            machineId: 'machine-1',
            serverId: 'server-1',
            connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
            sessionMetadata: props.sessionMetadata,
            settings: {
                connectedServicesProfileLabelByKey: {},
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

        const props = renderChipPopover(hook);
        await act(async () => {
            props.setBindingForService(CLAUDE_SERVICE_KEY, {
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
                    connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                    sessionMetadata: {
                        connectedServices: {
                            v: 1,
                            bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } },
                        },
                    },
                    settings: {
                        connectedServicesProfileLabelByKey: {},
                        connectedServicesDefaultProfileByServiceId: {},
                    },
                    switchingDisabledReason: null,
                    sessionActive: false,
                }),
            );

            const props = renderChipPopover(hook);
            await act(async () => {
                props.setBindingForService(CLAUDE_SERVICE_KEY, {
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
                    v: 1,
                    bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } },
                },
            };
            const connectedSessionMetadata: unknown = {
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
                    },
                },
            };
            const buildHookProps = (props: HookProps) => ({
                sessionId: 'session-1',
                agentId: 'claude',
                machineId: 'machine-1',
                serverId: 'server-1',
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                sessionMetadata: props.sessionMetadata,
                settings: {
                    connectedServicesProfileLabelByKey: {},
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

            const props = renderChipPopover(hook);
            await act(async () => {
                props.setBindingForService(CLAUDE_SERVICE_KEY, {
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
