import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { AccountProfileSchema } from '@happier-dev/protocol';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
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

// Canonical qualified Connected Account service keys used across this suite.
const CLAUDE_SERVICE_KEY = 'happier.agent.claude/anthropic';
const CODEX_SERVICE_KEY = 'happier.agent.codex/openai-codex';
// Novel external plugin service: no bundled enum member and no generated
// legacy mapping.
const NOVEL_SERVICE_KEY = 'acme.review/reviewer-service';

const modalShowMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => 'modal-1'));
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => false));
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
    }, {
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

type TestAccountProfile = {
    connectedAccountsV4: Array<Record<string, unknown>>;
    connectedAccountGroupsV4: Array<Record<string, unknown>>;
    connectedServiceCredentialRevisionsV1?: Array<Record<string, unknown>>;
};

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
        credentialRevision: null,
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

const profileState = {
    set current(profile: TestAccountProfile) {
        storage.setState({ profile: AccountProfileSchema.parse({ ...profileDefaults, ...profile }) });
    },
};
const initialStorageState = storage.getState();
let activeHomeId = '';
let targetHomeId = '';
let activeGroupsEnabled = true;

async function arrangeAccountGroupFeatures(preload = true) {
    const { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
    const request: typeof fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname !== '/v1/features') return new Response('{}', { status: 404 });
        const response = buildServerFeaturesResponse();
        response.features.connectedServices.accountGroups.enabled = url.hostname === 'target-connected-services.test' || activeGroupsEnabled;
        return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    setRuntimeFetch(request);
    vi.stubGlobal('fetch', request);
    if (preload) {
        await Promise.all([activeHomeId, targetHomeId].map((serverId) => getServerFeaturesSnapshot({ serverId, force: true })));
    }
}

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

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installNewSessionModulesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: modalShowMock,
                confirm: modalConfirmMock,
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

function requireCollapsedContentPopover(chip: AgentInputExtraActionChip | null) {
    const popover = chip?.collapsedContentPopover;
    if (!popover) {
        throw new Error('Expected connected services collapsed content popover');
    }
    return popover;
}

type ConnectedAccountsParam = ReadonlyArray<Readonly<{
    purpose: string;
    service: { pluginId: string; localId: string };
}>>;

const CLAUDE_CONNECTED_ACCOUNTS: ConnectedAccountsParam = [
    { purpose: 'primary', service: { pluginId: 'happier.agent.claude', localId: 'anthropic' } },
];
const NOVEL_CONNECTED_ACCOUNTS: ConnectedAccountsParam = [
    { purpose: 'primary', service: { pluginId: 'acme.review', localId: 'reviewer-service' } },
];

describe('useNewSessionConnectedServices', () => {
    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        activeGroupsEnabled = true;
        // Home activation can probe immediately; arrange HTTP before choosing it.
        await arrangeAccountGroupFeatures(false);
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const active = await upsertServerProfile({ serverUrl: 'https://active-connected-services.test', name: 'Active' });
        const target = await upsertServerProfile({ serverUrl: 'https://target-connected-services.test', name: 'Target' });
        activeHomeId = active.id;
        targetHomeId = target.id;
        await setActiveServerId(activeHomeId, { scope: 'device' });
        await arrangeAccountGroupFeatures();
        installConnectedAccountDescriptorProjection(newSessionConnectedAccountProjection);
        modalShowMock.mockReset();
        modalConfirmMock.mockReset();
        modalConfirmMock.mockResolvedValue(false);
        seedClaudeProfile();
    });

    afterEach(async () => {
        await standardCleanup();
        resetRuntimeFetch();
        vi.unstubAllGlobals();
        storage.setState(initialStorageState, true);
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
                agentCore: null,
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: {},
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
                agentCore: null,
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: {},
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
            firstPopover.props.setBindingForService(CLAUDE_SERVICE_KEY, {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
        });

        expect(setAgentOptionStateForCurrentAgent).toHaveBeenCalledWith(
            'connectedServicesBindingsByServiceId',
            { [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' } },
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
            [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
        });

        await hook.unmount();
    });

    it('keeps the core chip available while scoping the account-groups decision to the target server', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        activeGroupsEnabled = false;
        await arrangeAccountGroupFeatures();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: targetHomeId,
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
        const renderContent = requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected account-groups picker content');
        const content = renderContent({ requestClose: vi.fn(), maxHeight: 420 }) as React.ReactElement<{ accountGroupsEnabled: boolean }>;
        expect(content.props.accountGroupsEnabled).toBe(true);
        await hook.unmount();
    });

    it('keeps the core chip available while using the default scope for account groups', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        activeGroupsEnabled = false;
        await arrangeAccountGroupFeatures();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: {},
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
        const renderContent = requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected account-groups picker content');
        const content = renderContent({ requestClose: vi.fn(), maxHeight: 420 }) as React.ReactElement<{ accountGroupsEnabled: boolean }>;
        expect(content.props.accountGroupsEnabled).toBe(false);
        await hook.unmount();
    });

    it('applies the per-agent default connected auth binding before the user opens the chip', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: { id: 'claude', connectedServices: null },
                defaultAuthConsumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            claude: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CLAUDE_SERVICE_KEY]: {
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
            v: 2,
            bindingsByServiceId: {
                [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
            },
        });
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('Anthropic API key: Work');

        await hook.unmount();
    });

    it('applies the Team resource purpose default chosen on the Agent page over a released service-keyed default', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const teamSelection = {
            source: 'team_resource',
            resourceId: 'resource-acme',
            deliveryMode: 'direct',
            disclosedMember: { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'source-member' },
        } as const;

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: { id: 'claude', connectedServices: null },
                defaultAuthConsumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    // What the Agent page chooser persists: the canonical Team
                    // selection of its Team (lane 10 child 02 :271).
                    connectedAccountPurposeBindingsV1: {
                        v: 1,
                        bindings: [],
                        teamResourceSelections: [{
                            purpose: {
                                consumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
                                purpose: 'primary',
                            },
                            teamId: 'team-acme',
                            selection: teamSelection,
                        }],
                    },
                    // A stale released default for the same Agent never wins.
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            claude: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
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
            v: 2,
            bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: teamSelection },
        });

        await hook.unmount();
    });

    it('applies an installed Agent default through its selected routing identity', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const installedAgentId = 'acme.review/reviewer';
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

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                defaultAuthAgentId: installedAgentId,
                defaultAuthConsumer: { pluginId: 'acme.review', localId: 'reviewer' },
                connectedAccounts: NOVEL_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            [installedAgentId]: {
                                v: 1,
                                bindingsByServiceId: {
                                    [NOVEL_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'reviewer',
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
            v: 2,
            bindingsByServiceId: {
                [NOVEL_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'reviewer' },
            },
        });

        await hook.unmount();
    });

    it('preserves a per-agent default group binding when the active profile changes', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        profileState.current = {
            connectedAccountsV4: [
                v4Account({
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                    accountId: 'fresh-profile',
                    email: 'fresh@example.com',
                    kind: 'oauth',
                    displayName: 'Fresh',
                }),
            ],
            connectedAccountGroupsV4: [{
                v: 1,
                ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'primary' },
                incarnation: 'primary:1',
                displayName: 'Primary pool',
                policy: { v: 1, strategy: 'least_limited', autoSwitch: true, switchOn: { usageLimit: true, authExpired: true, accountChanged: false, refreshFailure: true } },
                activeConnectedAccountId: 'fresh-profile',
                generation: 1,
                runtimeStateRevision: 1,
                state: { status: 'ready' },
                createdAt: 0,
                updatedAt: 0,
                members: [
                    { v: 1, connectedAccountId: 'fresh-profile', priority: 100, enabled: true, state: {}, createdAt: 0, updatedAt: 0 },
                ],
            }],
            connectedServiceCredentialRevisionsV1: [],
        };

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: { id: 'codex', connectedServices: null },
                defaultAuthConsumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
                connectedAccounts: [
                    { purpose: 'primary', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
                ],
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
                                    [CODEX_SERVICE_KEY]: {
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
            v: 2,
            bindingsByServiceId: {
                [CODEX_SERVICE_KEY]: {
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
            connectedAccountsV4: [
                v4Account({
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                    accountId: 'work',
                    email: 'work@example.com',
                    kind: 'oauth',
                    displayName: 'Work',
                }),
            ],
            connectedAccountGroupsV4: [],
            connectedServiceCredentialRevisionsV1: [],
        };

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: { id: 'codex', connectedServices: null },
                defaultAuthConsumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
                connectedAccounts: [
                    { purpose: 'primary', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
                ],
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
                                    [CODEX_SERVICE_KEY]: {
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
            v: 2,
            bindingsByServiceId: {
                [CODEX_SERVICE_KEY]: {
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
            serviceId: CODEX_SERVICE_KEY,
            optionId: `connected-service:${encodeURIComponent(CODEX_SERVICE_KEY)}:native`,
        })).toEqual({
            subtitle: 'connectedServices.defaultAuth.warning.connected_group_unavailable',
        });

        await hook.unmount();
    });

    it('offers a NOVEL external plugin service from its projected declaration and emits the qualified spawn payload', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

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

        const setAgentOptionStateForCurrentAgent = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                // An installed external Agent has no bundled core and no bundled
                // scalar service declaration — only the machine projection.
                agentCore: null,
                connectedAccounts: NOVEL_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: null,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent,
            }),
        );

        // Neutral/public presentation from the applied descriptor projection.
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
        }) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService(NOVEL_SERVICE_KEY, {
                source: 'connected',
                selection: 'profile',
                profileId: 'reviewer',
            });
        });

        expect(setAgentOptionStateForCurrentAgent).toHaveBeenCalledWith(
            'connectedServicesBindingsByServiceId',
            { [NOVEL_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'reviewer' } },
        );
        expect(hook.getCurrent().connectedServicesBindingsPayload).toEqual({
            v: 2,
            bindingsByServiceId: {
                [NOVEL_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'reviewer' },
            },
        });
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('Acme Reviewer Auth: Reviewer');

        await hook.unmount();
    });

    it('deep-links the picker settings action to the tapped service settings screen (UI-2)', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        const requestClose = vi.fn();
        const routerPush = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
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
            popover.props.onOpenSettings(CLAUDE_SERVICE_KEY);
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
            connectedAccountsV4: [
                v4Account({
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                    accountId: 'happier',
                    email: 'happier@example.com',
                    kind: 'oauth',
                    displayName: 'Happier',
                    status: 'needs_reauth',
                }),
            ],
            connectedAccountGroupsV4: [],
            connectedServiceCredentialRevisionsV1: [],
        };
        const requestClose = vi.fn();
        const routerPush = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                connectedAccounts: [
                    { purpose: 'primary', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
                ],
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
            popover.props.onReconnectProfile?.(CODEX_SERVICE_KEY, 'happier');
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
            connectedAccountsV4: [
                v4Account({
                    pluginId: 'happier.agent.claude',
                    localId: 'anthropic',
                    accountId: 'work@example.com',
                    email: 'work@example.com',
                    kind: 'token',
                    displayName: 'Work',
                    status: 'needs_reauth',
                }),
            ],
            connectedAccountGroupsV4: [],
            connectedServiceCredentialRevisionsV1: [],
        };
        const requestClose = vi.fn();
        const routerPush = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
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
            popover.props.onReconnectProfile?.(CLAUDE_SERVICE_KEY, 'work@example.com');
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

    it('preserves the new-Session Connected Service draft when direct disclosure is cancelled', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const setAgentOptionStateForCurrentAgent = vi.fn();
        const selection = {
            source: 'team_resource' as const,
            resourceId: 'resource-1',
            deliveryMode: 'direct' as const,
            disclosedMember: {
                service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
                accountId: 'shared-account',
            },
        };
        const resource = {
            id: 'resource-1', teamId: 'team-1', displayName: 'Shared Claude', resourceRevision: 4,
            readiness: { kind: 'available' as const }, recoveryAction: null,
            deliveryMode: 'direct' as const, mayBroker: false, mayReceiveDirect: true,
            directMaterialState: 'never_delivered' as const,
            sessionUsePolicy: 'personal_allowed' as const,
            providerModels: [], connectedServiceSelections: [selection],
            sourcePresentation: {
                kind: 'connected_service' as const,
                service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
            },
        };
        const hook = await renderHook(() => useNewSessionConnectedServices({
            agentCore: null,
            connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
            agentOptionState: null,
            settings: {
                connectedServicesProfileLabelByKey: {},
                connectedServicesDefaultProfileByServiceId: {},
            },
            targetServerId: 'server-1',
            teamCredentialResources: [resource],
            teamNameById: { 'team-1': 'Acme' },
            router: { push: vi.fn() },
            setAgentOptionStateForCurrentAgent,
        }));
        const renderContent = requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected connected services popover content renderer');
        const popover = renderContent({ requestClose: vi.fn(), maxHeight: 420 }) as React.ReactElement<{
            setBindingForService: (serviceId: string, binding: typeof selection) => Promise<void> | void;
        }>;

        await act(async () => {
            await popover.props.setBindingForService(CLAUDE_SERVICE_KEY, selection);
        });

        expect(modalConfirmMock).toHaveBeenCalledOnce();
        expect(setAgentOptionStateForCurrentAgent).not.toHaveBeenCalled();
        expect(hook.getCurrent().connectedServicesBindingsPayload).toBeNull();
        await hook.unmount();
    });

    it('commits the exact direct Connected Service selection once after disclosure continues', async () => {
        modalConfirmMock.mockResolvedValue(true);
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const setAgentOptionStateForCurrentAgent = vi.fn();
        const selection = {
            source: 'team_resource' as const,
            resourceId: 'resource-1',
            deliveryMode: 'direct' as const,
            disclosedMember: {
                service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
                accountId: 'shared-account',
            },
        };
        const resource = {
            id: 'resource-1', teamId: 'team-1', displayName: 'Shared Claude', resourceRevision: 4,
            readiness: { kind: 'available' as const }, recoveryAction: null,
            deliveryMode: 'direct' as const, mayBroker: false, mayReceiveDirect: true,
            directMaterialState: 'current' as const,
            sessionUsePolicy: 'personal_allowed' as const,
            providerModels: [], connectedServiceSelections: [selection],
            sourcePresentation: {
                kind: 'connected_service' as const,
                service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
            },
        };
        const hook = await renderHook(() => useNewSessionConnectedServices({
            agentCore: null,
            connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
            agentOptionState: null,
            settings: {
                connectedServicesProfileLabelByKey: {},
                connectedServicesDefaultProfileByServiceId: {},
            },
            targetServerId: 'server-1',
            teamCredentialResources: [resource],
            teamNameById: { 'team-1': 'Acme' },
            router: { push: vi.fn() },
            setAgentOptionStateForCurrentAgent,
        }));
        const renderContent = requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected connected services popover content renderer');
        const popover = renderContent({ requestClose: vi.fn(), maxHeight: 420 }) as React.ReactElement<{
            setBindingForService: (serviceId: string, binding: typeof selection) => Promise<void> | void;
        }>;

        await act(async () => {
            await popover.props.setBindingForService(CLAUDE_SERVICE_KEY, selection);
        });

        expect(modalConfirmMock).toHaveBeenCalledOnce();
        expect(setAgentOptionStateForCurrentAgent).toHaveBeenCalledOnce();
        expect(setAgentOptionStateForCurrentAgent).toHaveBeenCalledWith(
            'connectedServicesBindingsByServiceId',
            { [CLAUDE_SERVICE_KEY]: selection },
        );
        await hook.unmount();
    });

});
