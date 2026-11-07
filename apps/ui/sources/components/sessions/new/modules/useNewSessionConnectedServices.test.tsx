import { act } from 'react-test-renderer';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { ConnectedServicesDefaultAuthByAgentIdV1 } from '@happier-dev/protocol';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installNewSessionModulesCommonModuleMocks } from './newSessionModulesTestHelpers';
import { __resetConnectedServiceQuotaSnapshotStore } from '@/sync/domains/connectedServices/connectedServiceQuotaSnapshotStore';
import { useNewSessionConnectedServices } from './useNewSessionConnectedServices';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const modalShowMock = vi.hoisted(() => vi.fn());
const useFeatureEnabledMock = vi.hoisted(() => vi.fn());

type TestConnectedServiceProfile = {
    profileId: string;
    status: string;
    kind: string;
    providerEmail?: string;
};

type TestAccountProfile = {
    connectedServicesV2: Array<{
        serviceId: string;
        profiles: TestConnectedServiceProfile[];
        groups?: unknown;
    }>;
};

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

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const { createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    return {
        ...await importOriginal<typeof import('@/sync/store/hooks')>(),
        useProfile: () => profileState.current,
        useSetting: createUseSettingMock({ fallback: (key) => settingsDefaults[key] }),
    };
});

// Network boundaries behind the provider usage gauge: the account encryption mode and the
// connected-service quota snapshot endpoints. Everything between them and the hook stays real.
const quotaApiState = vi.hoisted(() => ({
    plainSnapshot: null as unknown,
    // Stable like the real auth context: credentials-dependent queries re-run when the identity changes.
    auth: { credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => quotaApiState.auth,
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
    fetchAccountEncryptionMode: async () => ({ mode: 'plain', updatedAt: 0 }),
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
    getConnectedServiceQuotaSnapshotSealed: async () => null,
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
    getConnectedServiceQuotaSnapshotPlain: async () => quotaApiState.plainSnapshot,
}));

function requireCollapsedContentPopover(chip: AgentInputExtraActionChip | null) {
    const popover = chip?.collapsedContentPopover;
    if (!popover) {
        throw new Error('Expected connected services collapsed content popover');
    }
    return popover;
}

describe('useNewSessionConnectedServices', () => {
    beforeEach(async () => {
        __resetConnectedServiceQuotaSnapshotStore();
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
                    connectedServicesProfileLabelByKey: { 'anthropic:work': 'Work' },
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
        }) as React.ReactElement<{ onPress?: () => void; testID?: string; dataSet?: { authSource?: string } }>;
        expect(renderedChip.props.testID).toBe('new-session-connected-services-auth-chip');
        expect(renderedChip.props.dataSet).toEqual({ authSource: 'native' });

        renderedChip.props.onPress?.();

        expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-connected-services-auth');
        expect(modalShowMock).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('deep-links the picker settings action to the tapped service settings screen (UI-2)', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

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
                    connectedServicesProfileLabelByKey: { 'anthropic:work': 'Work' },
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
        const content = popoverRenderer({
            requestClose: vi.fn(),
            maxHeight: 420,
        }) as React.ReactElement<{ onOpenSettings: (serviceId: string) => void }>;

        content.props.onOpenSettings('anthropic');

        expect(routerPush).toHaveBeenCalledWith({
            pathname: '/settings/connected-services/[serviceId]',
            params: { serviceId: 'anthropic' },
        });
        await hook.unmount();
    });

    it('updates the chip label and reopened popover selection after choosing a connected profile', async () => {
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
            firstPopover.props.setBindingForService('anthropic', { source: 'connected', selection: 'profile', profileId: 'work' });
        });

        expect(setAgentOptionStateForCurrentAgent).toHaveBeenCalledWith(
            'connectedServicesBindingsByServiceId',
            { anthropic: { source: 'connected', selection: 'profile', profileId: 'work' } },
        );
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('connectedServices.serviceNames.anthropic: Work');

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

    it('uses the latest native login usage before the new session exists', async () => {
        profileState.current = { connectedServicesV2: [] };
        const { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } = await import('@happier-dev/protocol');
        const { writeProviderAccountUsageSnapshotToCache } = await import('@/sync/domains/connectedServices/accountUsage/cache');
        const { resolveAuthCredentialsScopeKey } = await import('@/auth/storage/resolveAuthCredentialsScopeKey');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const previousSessions = storage.getState().sessions;
        const previousReady = storage.getState().isDataReady;
        const recordKey = { providerId: 'codex', accountSubjectId: 'native-work', subjectKind: 'account', quotaScope: 'account' } as const;
        const recordId = buildProviderAccountUsageRecordId(recordKey);
        const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
            v: 1, recordId, recordKey, providerId: 'codex',
            accountSubject: { kind: 'providerSubject', id: 'native-work' },
            observedAtMs: Date.now(), fetchedAtMs: Date.now(), staleAfterMs: 60_000,
            source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data',
            meters: [{ meterId: 'weekly', label: 'Weekly', used: 40, limit: 100,
                unit: 'count', utilizationPct: null, resetsAt: null, status: 'ok', details: {} }],
        });
        writeProviderAccountUsageSnapshotToCache({
            credentialScope: resolveAuthCredentialsScopeKey(quotaApiState.auth.credentials), snapshot,
        });
        const claudeRecordKey = { ...recordKey, providerId: 'claude' } as const;
        const claudeRecordId = buildProviderAccountUsageRecordId(claudeRecordKey);
        writeProviderAccountUsageSnapshotToCache({
            credentialScope: resolveAuthCredentialsScopeKey(quotaApiState.auth.credentials),
            snapshot: ProviderAccountUsageSnapshotV1Schema.parse({
                ...snapshot, recordId: claudeRecordId, recordKey: claudeRecordKey, providerId: 'claude',
                meters: [{ ...snapshot.meters[0], used: 60 }],
            }),
        });
        const session = createSessionFixture({ metadata: {
            path: '/repo', host: 'test', flavor: 'codex',
            // Usage references survive a provider switch; snapshot identity, not current flavor, owns them.
            providerAccountUsageRefsV1: { v: 1, recordIds: [recordId, claudeRecordId], updatedAtMs: Date.now() },
        } });
        const exhaustedClaude = createSessionFixture({
            id: 'exhausted-claude', metadata: { path: '/repo', host: 'test', flavor: 'claude' },
            lastRuntimeIssue: {
                v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
                provider: 'claude', occurredAt: Date.now(),
                usageLimit: { v: 1, resetAtMs: Date.now() + 3_600_000, retryAfterMs: null,
                    quotaScope: 'account', recoverability: 'wait', limitCategory: 'usage_limit' },
            },
        });
        storage.setState({ sessions: { [session.id]: session, [exhaustedClaude.id]: exhaustedClaude }, isDataReady: true });
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const hook = await renderHook(() => useNewSessionConnectedServices({
            agentCore: { id: 'codex', connectedServices: { supportedServiceIds: ['openai-codex'] } },
            usageAgentIds: ['claude', 'codex'],
            agentOptionState: null,
            settings: { connectedServicesProfileLabelByKey: {}, connectedServicesDefaultProfileByServiceId: {} },
            targetServerId: null, router: { push: vi.fn() }, setAgentOptionStateForCurrentAgent: vi.fn(),
        }));
        try {
            await flushHookEffects({ cycles: 5, turns: 5 });
            expect(hook.getCurrent().providerUsageGauge?.remainingPct).toBe(60);
            // The picker must include every provider, including a native account with only limit-hit evidence.
            expect(hook.getCurrent().providerUsageGaugesByAgentId?.get('codex')?.remainingPct).toBe(60);
            expect(hook.getCurrent().providerUsageGaugesByAgentId?.get('claude')?.remainingPct).toBe(0);
            expect(hook.getCurrent().providerUsageGaugesByAgentId?.get('claude')?.tone).toBe('critical');
            // The shared details header must identify the provider even for native limit-only evidence.
            expect(hook.getCurrent().providerUsageGaugesByAgentId?.get('codex')?.providerDisplayName).toBe('agentInput.agent.codex');
            expect(hook.getCurrent().providerUsageGaugesByAgentId?.get('claude')?.providerDisplayName).toBe('agentInput.agent.claude');
            await act(async () => storage.setState({ sessions: {
                [session.id]: session, [exhaustedClaude.id]: { ...exhaustedClaude, lastRuntimeIssue: undefined },
            } }));
            expect(hook.getCurrent().providerUsageGaugesByAgentId?.get('claude')?.remainingPct).toBe(40);
        } finally {
            await hook.unmount();
            storage.setState({ sessions: previousSessions, isDataReady: previousReady });
        }
    });

    it('meters the selected connected account quota for the new-session composer', async () => {
        const { ConnectedServiceQuotaSnapshotV1Schema } = await import('@happier-dev/protocol');
        quotaApiState.plainSnapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'anthropic',
            profileId: 'work',
            fetchedAt: Date.now(),
            staleAfterMs: 60_000,
            planLabel: 'Pro',
            accountLabel: null,
            meters: [{
                meterId: 'weekly',
                label: 'Weekly',
                used: 40,
                limit: 100,
                unit: 'count',
                utilizationPct: null,
                resetsAt: null,
                status: 'ok',
                confidence: 'exact',
                details: { limitCategory: 'quota' },
            }],
        });
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: {
                    connectedServices: {
                        supportedServiceIds: ['anthropic'],
                        supportedKindsByServiceId: { anthropic: ['token'] },
                    },
                },
                agentOptionState: {
                    connectedServicesBindingsByServiceId: {
                        anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
                    },
                },
                modelId: null,
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
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(hook.getCurrent().providerUsageGauge?.remainingPct).toBe(60);

        await hook.unmount();
        quotaApiState.plainSnapshot = null;
    });

    it('uses spawn-scoped feature gating so the chip stays available for the selected target server', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        useFeatureEnabledMock.mockImplementation((featureId: string, scope?: { scopeKind?: string; serverId?: string | null }) => {
            return featureId === 'connectedServices'
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
                    connectedServicesProfileLabelByKey: { 'anthropic:work': 'Work' },
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
                                    anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
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
            .toBe('connectedServices.serviceNames.anthropic: Work');

        await hook.unmount();
    });

    it('falls back to native auth when persisted per-agent default auth settings are malformed', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const malformedDefaultAuthSettings = { v: 1 };
        Object.defineProperty(malformedDefaultAuthSettings, 'bindingsByAgentId', {
            enumerable: true,
            get: () => {
                throw new Error('corrupt default auth settings');
            },
        });

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
                    connectedServicesDefaultAuthByAgentIdV1: malformedDefaultAuthSettings as unknown as ConnectedServicesDefaultAuthByAgentIdV1,
                },
                targetServerId: null,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        expect(hook.getCurrent().connectedServicesBindingsPayload).toBeNull();
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('connectedServices.authChip.nativeLabel');

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
                        sessionAuthSwitch: {
                            continuityMode: 'restart_shared_state_required',
                        },
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
                                        profileId: 'stale-profile',
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
            .toBe('connectedServices.serviceNames.openaiCodex: Primary pool (fresh@example.com)');

        await hook.unmount();
    });

    it('keeps account groups visible but disabled when the agent cannot switch group auth', async () => {
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
                    groups: [{
                        groupId: 'primary',
                        displayName: 'Primary pool',
                        activeProfileId: 'work',
                        memberProfileIds: ['work'],
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
                agentOptionState: {
                    connectedServicesBindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'primary',
                        },
                    },
                },
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

        expect(hook.getCurrent().connectedServicesBindingsPayload).toEqual({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': { source: 'connected', selection: 'group', groupId: 'primary' },
            },
        });

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
            accountGroupOptionsByServiceId?: Record<string, unknown[]>;
            resolveOptionAvailability?: (params: { serviceId: string; optionId: string; binding: unknown }) => { disabled?: boolean; subtitle?: string };
        }>;

        expect(popover.props.accountGroupOptionsByServiceId?.['openai-codex']).toHaveLength(1);
        expect(popover.props.resolveOptionAvailability?.({
            serviceId: 'openai-codex',
            optionId: 'connected-service:openai-codex:group:primary',
            binding: { source: 'connected', selection: 'group', groupId: 'primary' },
        })).toEqual({
            disabled: true,
            subtitle: 'connectedServices.authModal.groupUnsupportedSubtitle',
        });

        await hook.unmount();
    });

    it('degrades a stale default group binding to native with a warning in the popover path', async () => {
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
                'openai-codex': { source: 'connected', selection: 'group', groupId: 'missing-group' },
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
        expect(routerPush).toHaveBeenCalledWith('/settings/connected-services/oauth?serviceId=openai-codex&profileId=happier');

        await hook.unmount();
    });

    it('routes token profiles that need reauth from the new-session popover to the profile action surface', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        profileState.current = {
            connectedServicesV2: [
                {
                    serviceId: 'claude-subscription',
                    profiles: [
                        {
                            profileId: 'leeroy.brun@gmail.com',
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
                        supportedServiceIds: ['claude-subscription'],
                        supportedKindsByServiceId: { 'claude-subscription': ['token'] },
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
            popover.props.onReconnectProfile?.('claude-subscription', 'leeroy.brun@gmail.com');
        });

        expect(requestClose).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith(
            '/settings/connected-services/profile?serviceId=claude-subscription&profileId=leeroy.brun%40gmail.com',
        );

        await hook.unmount();
    });
});
