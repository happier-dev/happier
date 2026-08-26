import React from 'react';
import { act } from 'react-test-renderer';
import { PluginContributesV2Schema } from '@happier-dev/protocol';
import { vi } from 'vitest';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import type {
    MachineCapabilitiesCacheState,
    MachineCapabilitiesSnapshot,
} from '@/hooks/server/useMachineCapabilitiesCache';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
    ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
} from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import {
    OPENAI_REALTIME_DEFAULT_SETTINGS,
} from '../../../../../../packages/plugins/openai/src/protocol/voice/settings';
import {
    XAI_REALTIME_DEFAULT_SETTINGS,
} from '../../../../../../packages/plugins/xai/src/protocol/voice/settings';

import { installVoiceSettingsPanelCommonModuleMocks } from './voiceSettingsPanelTestHelpers';

const storageBoundary = vi.hoisted(() => ({
    settings: null as unknown,
}));
const passiveSetupBoundary = vi.hoisted(() => ({
    profile: null as unknown,
    machineTarget: { daemonStateVersion: 0, isOnline: false },
    state: { status: 'idle' } as MachineCapabilitiesCacheState,
    refresh: vi.fn(),
    invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(
        async () => ({ supported: false, reason: 'error' }),
    ),
}));

const activeAccountLifetimeBoundary = vi.hoisted(() => ({
    value: null as Readonly<{
        scope: Readonly<{ serverId: string; accountId: string }>;
        isCurrent(): boolean;
    }> | null,
}));

function createActiveAccountLifetime(accountId: string): Readonly<{
    scope: Readonly<{ serverId: string; accountId: string }>;
    isCurrent(): boolean;
    retire(): void;
}> {
    let current = true;
    return Object.freeze({
        scope: Object.freeze({ serverId: 'server-1', accountId }),
        isCurrent: () => current,
        retire: () => { current = false; },
    });
}

afterEach(() => {
    activeAccountLifetimeBoundary.value = null;
    passiveSetupBoundary.invoke.mockReset();
    passiveSetupBoundary.invoke.mockResolvedValue({ supported: false, reason: 'error' });
});

installVoiceSettingsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        });
    },
    icons: async () => ({
        Ionicons: (props: any) => React.createElement('Ionicons', props),
    }),
    storage: async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettings: () => storageBoundary.settings ?? settingsParse({}),
        });
    },
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => 'middle',
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => ({}),
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/hooks/server/useDaemonScopedMachineCapabilitiesCache', () => ({
    useDaemonScopedMachineCapabilitiesCache: () => ({
        state: passiveSetupBoundary.state,
        refresh: passiveSetupBoundary.refresh,
    }),
}));

vi.mock('@/sync/ops/capabilities', () => ({
    machineCapabilitiesInvoke: (...args: unknown[]) => passiveSetupBoundary.invoke(...args),
}));

vi.mock('@/sync/store/hooks', () => ({
    useMachineCliDetectionTarget: () => passiveSetupBoundary.machineTarget,
    useProfile: () => passiveSetupBoundary.profile ?? { connectedServicesV2: [] },
    useLocalSetting: (key: string) => key === 'uiFontScale' ? 1 : null,
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetimeBoundary.value,
}));

vi.mock('./realtime/VoiceGlobalConnectedServicesBindingField', () => ({
    VoiceGlobalConnectedServicesBindingField: (props: any) =>
        React.createElement('VoiceGlobalConnectedServicesBindingField', props),
}));

function elevenLabsByoConfig() {
    return {
        ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
        billingMode: 'byo' as const,
    };
}

const OPENAI_PROVIDER_ID = 'happier.voice.openai/realtime-openai';
const XAI_PROVIDER_ID = 'happier.voice.xai/realtime-grok';
const ELEVENLABS_PROVIDER_ID = 'happier.voice.elevenlabs/realtime-elevenlabs';
const CODEX_PROVIDER_ID = 'happier.agent.codex/realtime-codex';

function installCodexConnectedAccountDescriptor() {
    installConnectedAccountDescriptorProjection({
        scopeKey: 'voice-provider-section-test',
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
        }],
        conflicts: [],
        errorReason: null,
    });
}

describe('VoiceProviderSection', () => {
    it('does not render a second declarative settings writer for a provider-owned settings section', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: {
                providerId: XAI_PROVIDER_ID,
                providers: {
                    [XAI_PROVIDER_ID]: {
                        schemaVersion: 1,
                        config: XAI_REALTIME_DEFAULT_SETTINGS,
                    },
                },
            } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));

        const duplicateDeclarativeControls = screen.tree.root.findAll((node) => (
            typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('settings.plugins.detail.happier.voice.xai.settings.')
        ));
        expect(duplicateDeclarativeControls).toEqual([]);
    }, 120_000);

    it('checks the exact machine and selected Codex Connected Service through the passive capability', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{
                    profileId: 'codex-profile',
                    status: 'connected',
                    kind: 'oauth',
                }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        passiveSetupBoundary.state = {
            status: 'loaded',
            snapshot: {
                response: {
                    protocolVersion: 1,
                    results: {
                        'cli.codex': {
                            ok: true,
                            checkedAt: 1,
                            data: {
                                available: true,
                                version: '0.146.0',
                                resolvedPath: '/managed/codex',
                            },
                        },
                    },
                },
            },
        };
        passiveSetupBoundary.refresh.mockClear();
        passiveSetupBoundary.invoke.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { v: 1, status: 'unavailable' } },
        });
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            localAvailability: {
                browserSpeech: { support: 'available' },
            },
            executionMachineId: 'machine-1',
        }));

        await screen.pressByTestIdAsync('settings.voice.provider.checkSetup');

        expect(passiveSetupBoundary.refresh).toHaveBeenCalledWith(expect.objectContaining({
            bypassCache: true,
        }));
        expect(passiveSetupBoundary.invoke).toHaveBeenCalledWith(
            'machine-1',
            {
                id: 'cli.codex',
                method: 'probePassiveRealtimeSetup',
                params: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            'openai-codex': {
                                source: 'connected',
                                selection: 'profile',
                                profileId: 'codex-profile',
                            },
                        },
                    },
                },
            },
            { timeoutMs: 30_000 },
        );
        const readinessHost = screen.findHostByTestId('settings.voice.provider.readiness');
        expect(readinessHost?.type).toBe('View');
        expect(readinessHost?.props.onPress).toBeUndefined();
        expect(readinessHost?.props.role).toBeUndefined();
        const readinessText = readinessHost?.findAllByType('Text' as any)
            .map((node) => node.props.children)
            .filter((value): value is string => typeof value === 'string')
            .join(' ') ?? '';
        expect(readinessText).toContain('voice.readiness.runtime_unknown');
        expect(readinessText).not.toContain('voice.readiness.actions.switch_provider');
        const status = screen.findHostByTestId('settings.voice.provider.readiness-status');
        expect(status).not.toBeNull();
        if (status === null) return;
        expect(status.props.accessibilityLiveRegion).toBe('polite');
        expect(status.props['aria-live']).toBe('polite');
    }, 120_000);

    it('marks Codex setup ready only from the strict passive owner result', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'connected', kind: 'oauth' }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        passiveSetupBoundary.invoke.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { v: 1, status: 'ready' } },
        });
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const sectionProps = {
            voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            executionMachineId: 'machine-1',
        };
        const screen = await renderScreen(React.createElement(VoiceProviderSection, sectionProps));

        await screen.pressByTestIdAsync('settings.voice.provider.checkSetup');

        expect(screen.getTextContent()).toContain('voice.readiness.ready');

        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'needs_reauth', kind: 'oauth' }],
            }],
        };
        await act(async () => {
            screen.tree.update(React.createElement(VoiceProviderSection, sectionProps));
        });

        expect(screen.getTextContent()).toContain('voice.readiness.credential_missing');
        expect(screen.getTextContent()).not.toContain('voice.readiness.ready');
    }, 120_000);

    it('does not commit a stale passive result after the selected execution machine changes', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'connected', kind: 'oauth' }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        let settlePassiveCheck: ((value: unknown) => void) | null = null;
        const pendingPassiveCheck = new Promise<unknown>((resolve) => {
            settlePassiveCheck = resolve;
        });
        passiveSetupBoundary.invoke
            .mockImplementationOnce(async () => await pendingPassiveCheck)
            .mockResolvedValueOnce({
                supported: true,
                response: { ok: true, result: { v: 1, status: 'ready' } },
            });
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const render = (executionMachineId: string) => React.createElement(VoiceProviderSection, {
            voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            executionMachineId,
        });
        const screen = await renderScreen(render('machine-1'));

        await screen.pressByTestIdAsync('settings.voice.provider.checkSetup');
        await act(async () => {
            screen.tree.update(render('machine-2'));
        });
        await act(async () => {
            settlePassiveCheck?.({
                supported: true,
                response: { ok: true, result: { v: 1, status: 'ready' } },
            });
            await Promise.resolve();
        });

        expect(screen.findHostByTestId('settings.voice.provider.readiness')).toBeNull();
        expect(passiveSetupBoundary.invoke).toHaveBeenCalledTimes(1);
    }, 120_000);

    it('clears a settled passive result when the active Account changes', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'connected', kind: 'oauth' }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        const accountA = createActiveAccountLifetime('account-a');
        activeAccountLifetimeBoundary.value = accountA;
        passiveSetupBoundary.invoke.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { v: 1, status: 'ready' } },
        });
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const sectionProps = {
            voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web' as const,
            executionMachineId: 'machine-1',
        };
        const screen = await renderScreen(React.createElement(VoiceProviderSection, sectionProps));

        await screen.pressByTestIdAsync('settings.voice.provider.checkSetup');
        expect(screen.findHostByTestId('settings.voice.provider.readiness')).not.toBeNull();

        accountA.retire();
        activeAccountLifetimeBoundary.value = createActiveAccountLifetime('account-b');
        await act(async () => {
            screen.tree.update(React.createElement(VoiceProviderSection, sectionProps));
        });

        expect(screen.findHostByTestId('settings.voice.provider.readiness')).toBeNull();
    }, 120_000);

    it('does not display a settled passive result after the active Account lifetime restarts', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'connected', kind: 'oauth' }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        const accountA = createActiveAccountLifetime('account-a');
        activeAccountLifetimeBoundary.value = accountA;
        passiveSetupBoundary.invoke.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { v: 1, status: 'ready' } },
        });
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const sectionProps = {
            voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web' as const,
            executionMachineId: 'machine-1',
        };
        const screen = await renderScreen(React.createElement(VoiceProviderSection, sectionProps));

        await screen.pressByTestIdAsync('settings.voice.provider.checkSetup');
        expect(screen.findHostByTestId('settings.voice.provider.readiness')).not.toBeNull();

        accountA.retire();
        activeAccountLifetimeBoundary.value = createActiveAccountLifetime('account-a');
        await act(async () => {
            screen.tree.update(React.createElement(VoiceProviderSection, sectionProps));
        });

        expect(screen.findHostByTestId('settings.voice.provider.readiness')).toBeNull();
    }, 120_000);

    it('does not commit a stale passive result after the active Account lifetime restarts', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'connected', kind: 'oauth' }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        const accountA = createActiveAccountLifetime('account-a');
        activeAccountLifetimeBoundary.value = accountA;
        let settlePassiveCheck: ((value: unknown) => void) | null = null;
        const pendingPassiveCheck = new Promise<unknown>((resolve) => {
            settlePassiveCheck = resolve;
        });
        passiveSetupBoundary.invoke.mockImplementation(async () => await pendingPassiveCheck);
        onTestFinished(() => {
            activeAccountLifetimeBoundary.value = null;
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const render = () => React.createElement(VoiceProviderSection, {
            voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            executionMachineId: 'machine-1',
        });
        const screen = await renderScreen(render());

        await screen.pressByTestIdAsync('settings.voice.provider.checkSetup');
        accountA.retire();
        activeAccountLifetimeBoundary.value = createActiveAccountLifetime('account-a');
        await act(async () => {
            screen.tree.update(render());
        });
        await act(async () => {
            settlePassiveCheck?.({
                supported: true,
                response: { ok: true, result: { v: 1, status: 'ready' } },
            });
            await Promise.resolve();
        });

        expect(screen.findHostByTestId('settings.voice.provider.readiness')).toBeNull();
    }, 120_000);

    it('does not commit a delayed passive result after the selected daemon restarts', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'connected', kind: 'oauth' }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        let settlePassiveCheck: ((value: unknown) => void) | null = null;
        const pendingPassiveCheck = new Promise<unknown>((resolve) => {
            settlePassiveCheck = resolve;
        });
        passiveSetupBoundary.invoke.mockImplementation(async () => await pendingPassiveCheck);
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const render = () => React.createElement(VoiceProviderSection, {
            voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            executionMachineId: 'machine-1',
        });
        const screen = await renderScreen(render());

        await screen.pressByTestIdAsync('settings.voice.provider.checkSetup');
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 8, isOnline: true };
        await act(async () => {
            screen.tree.update(render());
        });
        await act(async () => {
            settlePassiveCheck?.({
                supported: true,
                response: { ok: true, result: { v: 1, status: 'ready' } },
            });
            await Promise.resolve();
        });

        expect(screen.findHostByTestId('settings.voice.provider.readiness')).toBeNull();
    }, 120_000);

    it('keeps the first passive setup check visibly and accessibly checking until it settles', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{
                    profileId: 'codex-profile',
                    status: 'connected',
                    kind: 'oauth',
                }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        passiveSetupBoundary.state = { status: 'loading' };
        let settlePassiveCheck: ((value: unknown) => void) | null = null;
        const pendingPassiveCheck = new Promise<unknown>((resolve) => {
            settlePassiveCheck = resolve;
        });
        passiveSetupBoundary.invoke.mockImplementation(async () => await pendingPassiveCheck);
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const render = () => React.createElement(VoiceProviderSection, {
            voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            executionMachineId: 'machine-1',
        });
        const screen = await renderScreen(render());
        const { tree } = screen;

        await screen.pressByTestIdAsync('settings.voice.provider.checkSetup');

        expect(screen.getTextContent()).toContain('settings.updates.checking');
        const checkingAnnouncers = tree.root.findAllByProps({
            statusTestID: 'settings.voice.provider.readiness-status',
        });
        expect(checkingAnnouncers).toHaveLength(1);
        expect(checkingAnnouncers[0]?.props.announcement).toBe('settings.updates.checking');

        expect(screen.findHostByTestId('settings.voice.provider.checkSetup')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('settings.voice.provider.checkSetup');
        expect(passiveSetupBoundary.invoke).toHaveBeenCalledTimes(1);

        passiveSetupBoundary.state = {
            status: 'loaded',
            snapshot: {
                response: {
                    protocolVersion: 1,
                    results: {
                        'cli.codex': {
                            ok: true,
                            checkedAt: 1,
                            data: { available: false },
                        },
                    },
                },
            },
        };
        await act(async () => {
            tree.update(render());
        });

        expect(screen.getTextContent()).toContain('settings.updates.checking');

        await act(async () => {
            settlePassiveCheck?.({
                supported: true,
                response: {
                    ok: true,
                    result: { v: 1, status: 'feature_disabled' },
                },
            });
            await Promise.resolve();
        });

        expect(screen.getTextContent()).toContain('voice.readiness.runtime_missing');
        const announcers = tree.root.findAllByProps({
            statusTestID: 'settings.voice.provider.readiness-status',
        });
        expect(announcers).toHaveLength(1);
        expect(announcers[0]?.props.announcement).toContain('voice.readiness.runtime_missing');

        expect(screen.findHostByTestId('settings.voice.provider.checkSetup')?.props.disabled).toBeFalsy();
        await screen.pressByTestIdAsync('settings.voice.provider.checkSetup');
        expect(passiveSetupBoundary.invoke).toHaveBeenCalledTimes(2);
    }, 120_000);

    it('does not turn a settled passive check back into checking during a CLI refresh', async () => {
        const unavailableRuntimeSnapshot = {
            response: {
                protocolVersion: 1,
                results: {
                    'cli.codex': {
                        ok: true,
                        checkedAt: 1,
                        data: { available: false },
                    },
                },
            },
        } satisfies MachineCapabilitiesSnapshot;
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{
                    profileId: 'codex-profile',
                    status: 'connected',
                    kind: 'oauth',
                }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        passiveSetupBoundary.state = {
            status: 'loaded',
            snapshot: unavailableRuntimeSnapshot,
        };
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const render = () => React.createElement(VoiceProviderSection, {
            voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            executionMachineId: 'machine-1',
        });
        const { tree } = await renderScreen(render());

        await act(async () => {
            findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.checkSetup',
            })?.props.onPress();
        });
        const terminalAnnouncement = tree.root.findAllByProps({
            statusTestID: 'settings.voice.provider.readiness-status',
        })[0];
        expect(terminalAnnouncement?.props.announcement).toContain('voice.readiness.runtime_missing');
        const terminalTransitionKey = terminalAnnouncement?.props.transitionKey;

        passiveSetupBoundary.state = {
            status: 'loading',
            snapshot: unavailableRuntimeSnapshot,
        };
        await act(async () => {
            tree.update(render());
        });
        expect(findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        })?.props.subtitle).toContain('voice.readiness.runtime_missing');
        expect(tree.root.findAllByProps({
            statusTestID: 'settings.voice.provider.readiness-status',
        })[0]?.props.transitionKey).toBe(terminalTransitionKey);

        passiveSetupBoundary.state = {
            status: 'error',
            snapshot: unavailableRuntimeSnapshot,
        };
        await act(async () => {
            tree.update(render());
        });
        expect(findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        })?.props.subtitle).toContain('voice.readiness.runtime_unknown');
        expect(tree.root.findAllByProps({
            statusTestID: 'settings.voice.provider.readiness-status',
        })[0]?.props.transitionKey).not.toBe(terminalTransitionKey);
    }, 120_000);

    it('reports a persisted but unreachable Codex execution target as incompatible', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            executionMachineId: null,
            executionMachineSelectedId: 'machine-offline',
            executionMachineSelectionKind: 'selected_unreachable',
        }));

        const check = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.checkSetup',
        });
        await act(async () => {
            check?.props.onPress();
        });

        const readiness = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        });
        expect(readiness?.props.subtitle).toContain('voice.readiness.execution_machine_incompatible');
        expect(readiness?.props.subtitle).not.toContain('voice.readiness.ready');
        expect(JSON.stringify(readiness?.props)).not.toContain('machine-offline');
        expect(passiveSetupBoundary.invoke).not.toHaveBeenCalled();
    }, 120_000);

    it('exposes a generic passive setup check for selected Codex Live without a live-test action', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();
        const onRecoveryAction = vi.fn();
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: {
                providerId: 'happier.agent.codex/realtime-codex',
                providers: {
                    'happier.agent.codex/realtime-codex': {
                        schemaVersion: 2,
                        config: { globalConnectedServices: null },
                    },
                },
            } as any,
            setVoice,
            happierVoiceSupported: true,
            platformOs: 'web',
            onRecoveryAction,
        }));

        await screen.pressByTestIdAsync('settings.voice.provider.checkSetup');
        expect(screen.getTextContent()).toContain(
            'voice.readiness.settings_missing_required_setting',
        );
        expect(screen.getTextContent()).toContain(
            'voice.readiness.actions.open_provider_settings',
        );
        expect(screen.getTextContent()).not.toContain('voice.readiness.ready');
        expect(screen.findHostByTestId('settings.voice.provider.readiness')?.type).toBe('Pressable');
        await screen.pressByTestIdAsync('settings.voice.provider.readiness');
        expect(onRecoveryAction).toHaveBeenCalledWith('open_provider_settings');

        const withoutRecoveryHandler = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: {
                providerId: 'happier.agent.codex/realtime-codex',
                providers: {
                    'happier.agent.codex/realtime-codex': {
                        schemaVersion: 2,
                        config: { globalConnectedServices: null },
                    },
                },
            } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        await withoutRecoveryHandler.pressByTestIdAsync('settings.voice.provider.checkSetup');
        const passiveOnlyReadiness = withoutRecoveryHandler.findHostByTestId('settings.voice.provider.readiness');
        expect(passiveOnlyReadiness?.type).toBe('View');
        expect(passiveOnlyReadiness?.props.onPress).toBeUndefined();
        expect(withoutRecoveryHandler.findHostByTestId('settings.voice.provider.testLive')).toBeNull();
        expect(setVoice).not.toHaveBeenCalled();
    }, 120_000);

    it.each([
        OPENAI_PROVIDER_ID,
        XAI_PROVIDER_ID,
        ELEVENLABS_PROVIDER_ID,
    ])('uses configured-ready and missing provider credential projections for %s', async (providerId) => {
        const { resolveVoiceProviderCredentialFact: resolveCredentialFact } = await import('./VoiceProviderSection');

        expect(resolveCredentialFact({
            sourceKind: 'bundled',
            projectedCredential: { status: 'ready' },
            hasAccountCredentialSlot: false,
            hasAccountCredentialReference: false,
        }), providerId).toBe('ready');
        expect(resolveCredentialFact({
            sourceKind: 'bundled',
            projectedCredential: { status: 'missing' },
            hasAccountCredentialSlot: false,
            hasAccountCredentialReference: false,
        }), providerId).toBe('missing');
        expect(resolveCredentialFact({
            sourceKind: 'bundled',
            projectedCredential: { status: 'unknown' },
            hasAccountCredentialSlot: false,
            hasAccountCredentialReference: false,
        }), providerId).toBe('unknown');
        expect(resolveCredentialFact({
            sourceKind: 'bundled',
            projectedCredential: null,
            hasAccountCredentialSlot: false,
            hasAccountCredentialReference: false,
        }), providerId).toBe('unknown');
        expect(resolveCredentialFact({
            sourceKind: 'bundled',
            projectedCredential: { status: 'missing' },
            hasAccountCredentialSlot: true,
            hasAccountCredentialReference: false,
            accountCredentialApprovalRequired: true,
        }), providerId).toBe('missing');
    }, 120_000);

    it('keeps a stale recipient-contract review requirement for an external provider', async () => {
        const { resolveVoiceProviderCredentialFact: resolveCredentialFact } = await import('./VoiceProviderSection');

        expect(resolveCredentialFact({
            sourceKind: 'external',
            projectedCredential: { status: 'missing' },
            hasAccountCredentialSlot: true,
            hasAccountCredentialReference: false,
            accountCredentialApprovalRequired: true,
        })).toBe('approval_required');
    }, 120_000);

    it.each([
        ['an online machine', true, 'voice.readiness.ready'],
        ['an offline machine', false, 'voice.readiness.execution_machine_missing'],
    ] as const)('projects an explicitly bound Connected Account through %s', async (_label, machineOnline, expectedReadiness) => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { applyAccountVoiceCredentialSourceSelection } = await import('@/voice/credentials/accountVoiceCredential');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        installCodexConnectedAccountDescriptor();
        const account = {
            ref: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                accountId: 'codex-work',
            },
            status: 'connected' as const,
            configurationReady: false,
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned' as const,
            credentialRevision: 'cred-1',
            configurationRevision: null,
            scopes: ['openid', 'profile', 'email', 'offline_access'],
        };
        const provider = createDefaultVoiceProviderRegistry().get(OPENAI_PROVIDER_ID);
        if (provider?.kind !== 'voice.conversation-provider.v1' || provider.declaration?.kind !== 'conversation') {
            throw new Error('expected OpenAI conversation provider');
        }
        const voice = {
            providerId: OPENAI_PROVIDER_ID,
            providers: {
                [OPENAI_PROVIDER_ID]: {
                    schemaVersion: 1,
                    config: OPENAI_REALTIME_DEFAULT_SETTINGS,
                },
            },
        };
        const selected = applyAccountVoiceCredentialSourceSelection({
            settings: settingsParse({ voice }),
            mutation: {
                contribution: {
                    pluginId: provider.pluginId,
                    localId: provider.declaration.id,
                },
                credentialSlotId: provider.declaration.credentials!.slot.id,
                selection: { kind: 'connectedAccount', target: { kind: 'account', account: account.ref } },
                expectedSettingsVersion: 1,
            },
            currentDeclaration: provider.declaration,
        });
        storageBoundary.settings = selected.settings;
        passiveSetupBoundary.profile = {
            connectedAccountsV4: [account],
            connectedAccountGroupsV4: [],
            connectedServicesV2: [],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 1, isOnline: machineOnline };
        onTestFinished(() => {
            storageBoundary.settings = null;
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            installConnectedAccountDescriptorProjection({
                scopeKey: 'voice-provider-section-test-cleanup',
                status: 'ready',
                descriptors: [],
                conflicts: [],
                errorReason: null,
            });
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { VoiceCredentialSourceField } = await import('./realtime/VoiceCredentialSourceField');
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: selected.settings.voice,
            executionMachineId: machineOnline ? 'machine-online' : 'machine-offline',
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));

        expect(tree.root.findByType(VoiceCredentialSourceField).props.isCurrent()).toBe(true);

        await act(async () => {
            findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.checkSetup',
            })?.props.onPress();
        });
        expect(findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        })?.props.subtitle).toContain(expectedReadiness);
        expect(JSON.stringify(findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        })?.props)).not.toContain(account.ref.accountId);
    }, 120_000);

    it('does not claim a bound Connected Account credential is missing when its descriptor is unavailable', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { applyAccountVoiceCredentialSourceSelection } = await import('@/voice/credentials/accountVoiceCredential');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        installConnectedAccountDescriptorProjection({
            scopeKey: 'voice-provider-section-test-descriptor-unavailable',
            status: 'error',
            descriptors: [],
            conflicts: [],
            errorReason: 'transport',
        });
        const account = {
            ref: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                accountId: 'codex-work',
            },
            status: 'connected' as const,
            configurationReady: false,
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned' as const,
            credentialRevision: 'cred-1',
            configurationRevision: null,
            scopes: ['openid', 'profile', 'email', 'offline_access'],
        };
        const provider = createDefaultVoiceProviderRegistry().get(OPENAI_PROVIDER_ID);
        if (provider?.kind !== 'voice.conversation-provider.v1' || provider.declaration?.kind !== 'conversation') {
            throw new Error('expected OpenAI conversation provider');
        }
        const voice = {
            providerId: OPENAI_PROVIDER_ID,
            providers: {
                [OPENAI_PROVIDER_ID]: {
                    schemaVersion: 1,
                    config: OPENAI_REALTIME_DEFAULT_SETTINGS,
                },
            },
        };
        const selected = applyAccountVoiceCredentialSourceSelection({
            settings: settingsParse({ voice }),
            mutation: {
                contribution: {
                    pluginId: provider.pluginId,
                    localId: provider.declaration.id,
                },
                credentialSlotId: provider.declaration.credentials!.slot.id,
                selection: { kind: 'connectedAccount', target: { kind: 'account', account: account.ref } },
                expectedSettingsVersion: 1,
            },
            currentDeclaration: provider.declaration,
        });
        storageBoundary.settings = selected.settings;
        passiveSetupBoundary.profile = {
            connectedAccountsV4: [account],
            connectedAccountGroupsV4: [],
            connectedServicesV2: [],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 1, isOnline: true };
        onTestFinished(() => {
            storageBoundary.settings = null;
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            installConnectedAccountDescriptorProjection({
                scopeKey: 'voice-provider-section-test-cleanup',
                status: 'ready',
                descriptors: [],
                conflicts: [],
                errorReason: null,
            });
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: selected.settings.voice,
            executionMachineId: 'machine-online',
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));

        const row = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: `settings.voice.provider.${encodeURIComponent(OPENAI_PROVIDER_ID)}.byo`,
        });
        expect(row?.props.detail).toContain('voice.readiness.credential_unknown');
        expect(row?.props.detail).not.toContain('voice.readiness.credential_missing');
        expect(row?.props.disabled).not.toBe(true);

        await act(async () => {
            findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.checkSetup',
            })?.props.onPress();
        });
        const readiness = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        });
        expect(readiness?.props.subtitle).toContain('voice.readiness.credential_unknown');
        expect(readiness?.props.subtitle).not.toContain('voice.readiness.credential_missing');
        expect(readiness?.props.subtitle).not.toContain('voice.readiness.ready');
    }, 120_000);

    it('keeps ordinary OpenAI configurable when an orphaned purpose binding makes current source resolution unknown', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        installCodexConnectedAccountDescriptor();
        const account = {
            ref: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                accountId: 'codex-work',
            },
            status: 'connected' as const,
            configurationReady: false,
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned' as const,
            credentialRevision: 'cred-1',
            configurationRevision: null,
            scopes: ['openid', 'profile', 'email', 'offline_access'],
        };
        storageBoundary.settings = settingsParse({
            secrets: [{
                id: 'surviving-openai-secret',
                name: 'Saved OpenAI key',
                kind: 'apiKey',
                encryptedValue: {
                    _isSecretValue: true,
                    encryptedValue: { t: 'enc-v1', c: 'Y2lwaGVydGV4dA==' },
                },
                createdAt: 1,
                updatedAt: 1,
            }],
            voiceSettingsV1: { credentialBindings: [] },
            connectedAccountPurposeBindingsV1: {
                v: 1,
                bindings: [{
                    purpose: {
                        consumer: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' },
                        purpose: 'voice.client-auth',
                    },
                    target: { kind: 'account', account: account.ref },
                }],
            },
        });
        passiveSetupBoundary.profile = {
            connectedAccountsV4: [account],
            connectedAccountGroupsV4: [],
            connectedServicesV2: [],
        };
        onTestFinished(() => {
            storageBoundary.settings = null;
            passiveSetupBoundary.profile = null;
            installConnectedAccountDescriptorProjection({
                scopeKey: 'voice-provider-section-test-cleanup',
                status: 'ready',
                descriptors: [],
                conflicts: [],
                errorReason: null,
            });
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: { providerId: null } as any,
            setVoice,
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const row = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: `settings.voice.provider.${encodeURIComponent(OPENAI_PROVIDER_ID)}.byo`,
        });

        expect(row?.props.detail).toContain('voice.readiness.credential_unknown');
        expect(row?.props.disabled).not.toBe(true);
        expect(row?.props.onPress).toBeTypeOf('function');
        await act(async () => {
            row?.props.onPress?.();
        });
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            providerId: OPENAI_PROVIDER_ID,
        }));

        const selectedVoice = setVoice.mock.calls[0]?.[0];
        const selected = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: selectedVoice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const sourceField = findTestInstanceByTypeWithProps(selected.tree, 'DropdownMenu' as any, {
            testID: 'voice-credential-source-api_key',
        });
        expect(sourceField?.props.items).toContainEqual(expect.objectContaining({
            title: 'Codex',
            disabled: false,
        }));
        expect(sourceField?.props.items).not.toContainEqual(expect.objectContaining({
            subtitle: 'codex-work',
        }));
        const credentialEditor = selected.tree.root.findAll((node) => (
            node.props.contribution?.pluginId === 'happier.voice.openai'
            && node.props.contribution?.localId === 'realtime-openai'
            && node.props.credentialSlotId === 'api_key'
        ))[0];
        // The source resolver correctly fails closed for the orphaned purpose
        // binding. That must not make an explicit SavedSecret choice take the
        // slot-only mutation path: the existing source/purpose owner is the
        // only path that can repair all three roots atomically.
        expect(credentialEditor?.props.credentialSourcePurpose).toBe('voice.client-auth');
    }, 120_000);

    it('keeps an unresolvable credential snapshot unknown for an external provider instead of reporting it missing', async () => {
        const { resolveVoiceProviderCredentialFact: resolveCredentialFact } = await import('./VoiceProviderSection');

        // An external row whose account-settings snapshot could not be read has
        // no more evidence of absence than a bundled one. Falling back to the
        // reference lookup renders "Add the credential required by this Voice
        // provider" over a credential that is stored and was working.
        expect(resolveCredentialFact({
            sourceKind: 'external',
            projectedCredential: { status: 'unknown' },
            hasAccountCredentialSlot: true,
            hasAccountCredentialReference: false,
        })).toBe('unknown');
        expect(resolveCredentialFact({
            sourceKind: 'external',
            projectedCredential: { status: 'unknown' },
            hasAccountCredentialSlot: true,
            hasAccountCredentialReference: false,
            accountCredentialApprovalRequired: true,
        })).toBe('unknown');
        // A projection that was never produced still falls back, because the
        // external account-credential slot is then the only evidence there is.
        expect(resolveCredentialFact({
            sourceKind: 'external',
            projectedCredential: null,
            hasAccountCredentialSlot: true,
            hasAccountCredentialReference: true,
        })).toBe('ready');
    }, 120_000);

    it('does not let a stale SavedSecret approval override a bundled non-SavedSecret credential projection', async () => {
        const { resolveVoiceProviderCredentialFact: resolveCredentialFact } = await import('./VoiceProviderSection');

        expect(resolveCredentialFact({
            sourceKind: 'bundled',
            projectedCredential: { status: 'unknown' },
            hasAccountCredentialSlot: true,
            hasAccountCredentialReference: false,
            accountCredentialApprovalRequired: true,
        })).toBe('unknown');
    }, 120_000);

    it.each([
        [OPENAI_PROVIDER_ID, 'byo'],
        [XAI_PROVIDER_ID, 'byo'],
        [ELEVENLABS_PROVIDER_ID, 'byo'],
    ] as const)(
        'keeps the real bundled %s %s row selectable from fresh settings so its credential can be configured',
        async (providerId, optionId) => {
            const { VoiceProviderSection } = await import('./VoiceProviderSection');
            const setVoice = vi.fn();
            const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
                voice: { providerId: null } as any,
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
            }));
            const row = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: `settings.voice.provider.${encodeURIComponent(providerId)}.${optionId}`,
            });

            expect(row?.props?.disabled).not.toBe(true);
            expect(row?.props?.onPress).toBeTypeOf('function');
            expect(row?.props?.detail).toContain(
                providerId === ELEVENLABS_PROVIDER_ID
                    ? 'voice.readiness.settings_missing_required_setting'
                    : 'voice.readiness.credential_missing',
            );
            row?.props?.onPress?.();
            expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
                providerId,
                providers: expect.objectContaining({
                    [providerId]: expect.objectContaining({
                        config: expect.any(Object),
                    }),
                }),
            }));
        },
        120_000,
    );

    it('renders localized readiness for the selected provider without exposing its internal id', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const providerId = XAI_PROVIDER_ID;
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: {
                providerId,
                providers: {
                    [providerId]: {
                        schemaVersion: 1,
                        config: XAI_REALTIME_DEFAULT_SETTINGS,
                    },
                },
            } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));

        await act(async () => {
            findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.checkSetup',
            })?.props.onPress();
        });
        const readiness = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        });

        expect(readiness?.props.subtitle).toContain('voice.readiness.credential_missing');
        expect(readiness?.props.detail).toBeUndefined();
        expect(JSON.stringify(readiness?.props)).not.toContain(providerId);
    }, 120_000);

    it('does not require external-publisher re-review for a bundled provider with a stale digest', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        const entry = createDefaultVoiceProviderRegistry().get(XAI_PROVIDER_ID);
        const slot = entry?.accountCredentialSlot;
        if (!slot) throw new Error('expected Grok account credential slot');
        const voice = {
            providerId: XAI_PROVIDER_ID,
            providers: {
                [XAI_PROVIDER_ID]: {
                    schemaVersion: 1,
                    config: XAI_REALTIME_DEFAULT_SETTINGS,
                },
            },
            credentialBindings: [{
                providerId: XAI_PROVIDER_ID,
                approvedRecipientContractDigest: `sha256:${'0'.repeat(64)}`,
                credentialBindings: {
                    account: { [slot.id]: 'grok-secret' },
                },
            }],
        };
        storageBoundary.settings = settingsParse({
            secrets: [{
                id: 'grok-secret',
                name: 'Grok Voice',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'retained' },
                createdAt: 1,
                updatedAt: 1,
            }],
            voice,
        });
        onTestFinished(() => {
            storageBoundary.settings = null;
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: voice as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        await act(async () => {
            findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.checkSetup',
            })?.props.onPress();
        });
        const readiness = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        });
        expect(readiness?.props.subtitle).toContain('voice.readiness.ready');
        expect(readiness?.props.subtitle).not.toContain('voice.readiness.credential_missing');
        expect(readiness?.props.subtitle).not.toContain('voice.readiness.actions.configure_credential');
        expect(readiness?.props.subtitle).not.toContain('voice.readiness.credential_approval_required');
        expect(readiness?.props.subtitle).not.toContain('voice.readiness.actions.review_credential_access');
    }, 120_000);

    it('does not report ElevenLabs ready when its credential is approved but its BYO agent is missing', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        const entry = createDefaultVoiceProviderRegistry().get(ELEVENLABS_PROVIDER_ID);
        const slot = entry?.accountCredentialSlot;
        if (!slot) throw new Error('expected ElevenLabs account credential slot');
        const voice = {
            providerId: ELEVENLABS_PROVIDER_ID,
            providers: {
                [ELEVENLABS_PROVIDER_ID]: {
                    schemaVersion: 2,
                    config: elevenLabsByoConfig(),
                },
            },
            credentialBindings: [{
                providerId: ELEVENLABS_PROVIDER_ID,
                approvedRecipientContractDigest: slot.recipientContractDigest,
                credentialBindings: {
                    account: { [slot.id]: 'elevenlabs-secret' },
                },
            }],
        };
        storageBoundary.settings = settingsParse({
            secrets: [{
                id: 'elevenlabs-secret',
                name: 'ElevenLabs Voice',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'retained' },
                createdAt: 1,
                updatedAt: 1,
            }],
            voice,
        });
        onTestFinished(() => {
            storageBoundary.settings = null;
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: voice as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));

        await act(async () => {
            findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.checkSetup',
            })?.props.onPress();
        });
        const readiness = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        });
        expect(readiness?.props.subtitle).toContain(
            'voice.readiness.settings_missing_required_setting',
        );
        expect(readiness?.props.subtitle).toContain(
            'voice.readiness.actions.open_provider_settings',
        );
        expect(readiness?.props.subtitle).not.toContain('voice.readiness.ready');
        expect(readiness?.props.subtitle).not.toContain('credential');
    }, 120_000);

    it('exposes every provider choice as the same radio control with selected state', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: { providerId: ELEVENLABS_PROVIDER_ID, providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            } } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
        }));
        const providerGroup = tree.findAllByType('ItemGroup' as any)
            .find((group: any) => group.props.accessibilityRole === 'radiogroup');
        const rows = providerGroup?.findAllByType('Item' as any) ?? [];
        expect(providerGroup?.props.accessibilityLabel).toBe('settingsVoice.modeTitle');
        expect(rows.length).toBeGreaterThan(1);
        expect(rows.every((row: any) => row.props.accessibilityRole === 'radio' && row.props.webRole === 'radio')).toBe(true);
        expect(rows.every((row: any) => typeof row.props.testID === 'string')).toBe(true);
        expect(rows.filter((row: any) => row.props.selected === true)).toHaveLength(1);
        expect(rows.filter((row: any) => row.props.selected === false).length).toBe(rows.length - 1);
    });

    it.each([
        {
            label: 'removed provider contribution',
            providerId: 'acme.removed/conversation',
            envelope: {
                schemaVersion: 7,
                config: { futureOpaqueField: 'preserved' },
            },
            expectedReason: 'voice.readiness.contribution_unavailable',
            expectedAction: 'voice.readiness.actions.select_provider',
        },
        {
            label: 'unsupported provider settings schema',
            providerId: CODEX_PROVIDER_ID,
            envelope: {
                schemaVersion: 3,
                config: {
                    globalConnectedServices: null,
                    futureOpaqueField: 'preserved',
                },
            },
            expectedReason: 'voice.readiness.settings_unsupported_version',
            expectedAction: 'voice.readiness.actions.open_provider_settings',
        },
    ])(
        'keeps a persisted $label visibly selected with truthful recovery without rewriting its envelope',
        async ({ providerId, envelope, expectedReason, expectedAction }) => {
            const { VoiceProviderSection } = await import('./VoiceProviderSection');
            const setVoice = vi.fn();
            const voice = {
                providerId,
                providers: { [providerId]: envelope },
            };
            const before = JSON.stringify(voice);
            const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
                voice: voice as any,
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
            }));

            const unavailableRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.selectedUnavailable',
            });
            const offRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.off',
            });
            const selectedRows = tree.findAllByType('Item' as any)
                .filter((row: any) => row.props.accessibilityRole === 'radio' && row.props.selected === true);
            const ordinaryRowsForSelectedProvider = tree.findAllByType('Item' as any)
                .filter((row: any) => row.props.testID?.startsWith(
                    `settings.voice.provider.${encodeURIComponent(providerId)}.`,
                ));
            const otherProviderRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: `settings.voice.provider.${encodeURIComponent(OPENAI_PROVIDER_ID)}.byo`,
            });

            expect(unavailableRow).toBeTruthy();
            expect(unavailableRow?.props.accessibilityRole).toBe('radio');
            expect(unavailableRow?.props.selected).toBe(true);
            expect(unavailableRow?.props.disabled).toBe(true);
            expect(unavailableRow?.props.title).toEqual(expect.any(String));
            expect(unavailableRow?.props.title.length).toBeGreaterThan(0);
            expect(unavailableRow?.props.detail).toContain(expectedReason);
            expect(unavailableRow?.props.detail).toContain(expectedAction);
            expect(selectedRows).toEqual([unavailableRow]);
            expect(ordinaryRowsForSelectedProvider).toHaveLength(0);
            expect(otherProviderRow).toBeTruthy();
            expect(offRow?.props.selected).toBe(false);
            expect(JSON.stringify(voice)).toBe(before);

            offRow?.props.onPress?.();
            expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
                providerId: null,
                providers: expect.objectContaining({ [providerId]: envelope }),
            }));
            expect(setVoice.mock.calls[0]?.[0]?.providers?.[providerId]).toEqual(envelope);
        },
        120_000,
    );

    it('shows the local provider row on web and preserves persisted local selection', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');

        const voice: any = {
            providerId: 'local_conversation',
            providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            },
        };

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice: () => {},
                happierVoiceSupported: true,
            }),
        );

        expect(
            findTestInstanceByTypeWithProps(tree, 'Item' as any, { title: 'settingsVoice.mode.local' })?.props?.rightElement,
        ).toBeTruthy();
        expect(
            findTestInstanceByTypeWithProps(tree, 'Item' as any, { title: 'settingsVoice.mode.byo' })?.props?.rightElement,
        ).toBeFalsy();
    });

    it('keeps hosted Happier Voice visible but disabled when the server does not support it', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();

        const voice: any = {
            providerId: 'off',
            providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            },
        };

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice,
                happierVoiceSupported: false,
            }),
        );
        const hostedRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            title: 'settingsVoice.mode.happier',
        });

        expect(hostedRow?.props?.disabled).toBe(true);
        expect(hostedRow?.props?.onPress).toBeUndefined();
        expect(hostedRow?.props?.detail).toContain('voice.readiness.server_feature_disabled');
        expect(hostedRow?.props?.detail).toContain('voice.readiness.actions.switch_provider');
        expect(
            findTestInstanceByTypeWithProps(tree, 'Item' as any, { title: 'settingsVoice.mode.local' }),
        ).toBeTruthy();
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('uses the runtime platform when no platform override is supplied', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');

        const voice: any = {
            providerId: 'off',
            providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            },
        };

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice: () => {},
                happierVoiceSupported: true,
                localAvailability: {
                    browserSpeech: { support: 'unavailable' },
                    daemon: { featureEnabled: true, route: 'relay_disabled', modelState: 'ready' },
                    nativeDevice: { requested: true },
                },
            }),
        );

        const localRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            title: 'settingsVoice.mode.local',
        });

        expect(localRow?.props?.disabled).toBe(true);
        expect(localRow?.props?.onPress).toBeUndefined();
    });

    it('keeps Local visible but fail-closed on web while detailed browser and daemon availability are still loading', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();

        const voice: any = {
            providerId: 'off',
            providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            },
        };

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice,
                happierVoiceSupported: true,
            }),
        );

        const localRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            title: 'settingsVoice.mode.local',
        });

        expect(localRow).toBeTruthy();
        expect(localRow?.props?.disabled).toBe(true);
        expect(localRow?.props?.onPress).toBeUndefined();
        localRow?.props?.onPress?.();
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('disables Local when browser, daemon, and native execution paths are unavailable', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');

        const voice: any = {
            providerId: 'off',
            providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            },
        };

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice: () => {},
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'unavailable' },
                    daemon: { featureEnabled: true, route: 'relay_disabled', modelState: 'ready' },
                    nativeDevice: { requested: true },
                },
            }),
        );

        const localRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            title: 'settingsVoice.mode.local',
        });

        expect(localRow?.props?.disabled).toBe(true);
        expect(localRow?.props?.onPress).toBeUndefined();
    });

    it('keeps Local selectable on web when browser speech is available', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();

        const voice: any = {
            providerId: 'off',
            providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            },
        };

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'cloud_only' },
                    daemon: { featureEnabled: false, route: 'unavailable', modelState: 'unknown' },
                    nativeDevice: { requested: true },
                },
            }),
        );

        const localRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            title: 'settingsVoice.mode.local',
        });

        expect(localRow?.props?.disabled).not.toBe(true);
        localRow?.props?.onPress?.();
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            providerId: 'local_conversation',
            providers: expect.objectContaining({
                local_conversation: expect.objectContaining({ schemaVersion: 1 }),
            }),
        }));
    });

    it('keeps an installable daemon-backed Local provider selectable so setup is not cyclic', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice: { providerId: 'off' } as any,
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'unavailable' },
                    daemon: {
                        featureEnabled: true,
                        route: 'relay',
                        modelState: 'missing',
                        runtimeState: 'unknown',
                        pcmCapture: 'available',
                    },
                    nativeDevice: { requested: false },
                },
            }),
        );

        const localRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            title: 'settingsVoice.mode.local',
        });
        expect(localRow?.props?.disabled).not.toBe(true);
        localRow?.props?.onPress?.();
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'local_conversation' }));
    });

    it('allows explicit Local selection while its reachable daemon model facts are still loading', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice: { providerId: 'off' } as any,
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'unavailable' },
                    daemon: {
                        featureEnabled: true,
                        route: 'relay',
                        modelState: 'unknown',
                        runtimeState: 'unknown',
                        pcmCapture: 'available',
                    },
                    nativeDevice: { requested: false },
                },
            }),
        );

        const localRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            title: 'settingsVoice.mode.local',
        });
        expect(localRow?.props?.disabled).not.toBe(true);
        localRow?.props?.onPress?.();
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'local_conversation' }));
    });

    it.each([
        {
            label: 'selected daemon machine with an available direct speech route',
            executionMachineId: 'machine-online',
            executionMachine: {
                mode: 'fixed' as const,
                machineId: 'machine-online',
                autoMachineId: null,
            },
            daemon: {
                featureEnabled: true,
                route: 'direct' as const,
                modelState: 'ready' as const,
                runtimeState: 'available' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: null,
        },
        {
            label: 'selected daemon machine without direct heavy audio while relay is disabled',
            executionMachineId: 'machine-online',
            executionMachine: {
                mode: 'fixed' as const,
                machineId: 'machine-online',
                autoMachineId: null,
            },
            daemon: {
                featureEnabled: true,
                route: 'relay_disabled' as const,
                modelState: 'ready' as const,
                runtimeState: 'available' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: 'voice.readiness.daemon_relay_disabled',
        },
        {
            label: 'selected daemon machine with a policy-allowed relay route',
            executionMachineId: 'machine-online',
            executionMachine: {
                mode: 'fixed' as const,
                machineId: 'machine-online',
                autoMachineId: null,
            },
            daemon: {
                featureEnabled: true,
                route: 'relay' as const,
                modelState: 'ready' as const,
                runtimeState: 'available' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: null,
        },
        {
            label: 'selected daemon machine that is offline',
            executionMachineId: null,
            executionMachine: {
                mode: 'fixed' as const,
                machineId: 'machine-offline',
                autoMachineId: null,
            },
            daemon: {
                featureEnabled: true,
                route: 'direct' as const,
                modelState: 'unknown' as const,
                runtimeState: 'unknown' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: 'voice.readiness.execution_machine_incompatible',
        },
        {
            label: 'daemon inference feature disabled before its catalog is available',
            executionMachineId: 'machine-online',
            executionMachine: {
                mode: 'fixed' as const,
                machineId: 'machine-online',
                autoMachineId: null,
            },
            daemon: {
                featureEnabled: false,
                route: 'direct' as const,
                modelState: 'unknown' as const,
                runtimeState: 'unknown' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: 'voice.readiness.server_feature_disabled',
        },
    ])(
        'projects selected Local execution-machine readiness for $label instead of hard-coded placeholders',
        async ({ executionMachineId, executionMachine, daemon, expectedCode }) => {
            const { VoiceProviderSection } = await import('./VoiceProviderSection');
            const {
                readLocalConversationVoiceSettings,
                voiceSettingsDefaults,
                writeLocalConversationVoiceSettings,
            } = await import('@/sync/domains/settings/voiceSettings');
            const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
            const voice = writeLocalConversationVoiceSettings(
                {
                    ...voiceSettingsDefaults,
                    providerId: 'local_conversation',
                    executionMachine,
                },
                {
                    ...local,
                    stt: {
                        ...local.stt,
                        provider: 'local_neural',
                        localNeural: {
                            ...local.stt.localNeural,
                            execution: 'daemon',
                        },
                    },
                    tts: {
                        ...local.tts,
                        provider: 'device',
                    },
                },
            );
            const { tree } = await renderScreen(
                React.createElement(VoiceProviderSection, {
                    voice,
                    executionMachineId,
                    executionMachineSelectionKind: executionMachineId ? 'resolved' : 'selected_unreachable',
                    setVoice: vi.fn(),
                    happierVoiceSupported: true,
                    platformOs: 'web',
                    localAvailability: {
                        browserSpeech: { support: 'unavailable' },
                        daemon,
                        nativeDevice: { requested: false },
                    },
                }),
            );

            const localRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                title: 'settingsVoice.mode.local',
            });
            if (expectedCode === null) {
                expect(localRow?.props?.detail).toBeUndefined();
            } else {
                expect(localRow?.props?.detail).toContain(expectedCode);
            }
        },
        120_000,
    );

    it.each([
        {
            label: 'daemon inference is unavailable',
            daemon: {
                featureEnabled: true,
                route: 'direct' as const,
                modelState: 'unknown' as const,
                runtimeState: 'unavailable' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: 'voice.readiness.runtime_missing',
        },
        {
            label: 'the selected Local Neural model is missing',
            daemon: {
                featureEnabled: true,
                route: 'direct' as const,
                modelState: 'missing' as const,
                runtimeState: 'available' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: 'voice.readiness.model_missing',
        },
    ])(
        'does not let an unrelated runnable browser path make Local Voice ready when $label',
        async ({ daemon, expectedCode }) => {
            const {
                readLocalConversationVoiceSettings,
                voiceSettingsDefaults,
                writeLocalConversationVoiceSettings,
            } = await import('@/sync/domains/settings/voiceSettings');
            const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
            const voice = writeLocalConversationVoiceSettings(
                { ...voiceSettingsDefaults, providerId: 'local_conversation' },
                {
                    ...local,
                    stt: {
                        ...local.stt,
                        provider: 'local_neural',
                        localNeural: {
                            ...local.stt.localNeural,
                            execution: 'daemon',
                        },
                    },
                    tts: {
                        ...local.tts,
                        provider: 'device',
                    },
                },
            );
            const { VoiceProviderSection } = await import('./VoiceProviderSection');
            const { tree } = await renderScreen(
                React.createElement(VoiceProviderSection, {
                    voice,
                    executionMachineId: 'machine-online',
                    setVoice: vi.fn(),
                    happierVoiceSupported: true,
                    platformOs: 'web',
                    localAvailability: {
                        browserSpeech: { support: 'cloud_only', onDevice: 'unsupported' },
                        daemon,
                        nativeDevice: { requested: false },
                    },
                }),
            );

            await act(async () => {
                findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                    testID: 'settings.voice.provider.checkSetup',
                })?.props.onPress();
            });
            const readiness = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.readiness',
            });
            expect(readiness?.props.subtitle).toContain(expectedCode);
            expect(readiness?.props.subtitle).not.toContain('voice.readiness.ready');
        },
        120_000,
    );

    it('does not report selected OpenAI-compatible Local STT as ready without its endpoint', async () => {
        const {
            readLocalConversationVoiceSettings,
            voiceSettingsDefaults,
            writeLocalConversationVoiceSettings,
        } = await import('@/sync/domains/settings/voiceSettings');
        const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const voice = writeLocalConversationVoiceSettings(
            {
                ...voiceSettingsDefaults,
                providerId: 'local_conversation',
                providers: {
                    ...voiceSettingsDefaults.providers,
                    'happier.voice.openai-compat/stt': {
                        schemaVersion: 2,
                        config: {
                            baseUrl: '',
                            insecureLocalOriginConsent: '',
                            insecureLocalConsentMachineId: '',
                            model: 'whisper-1',
                            language: '',
                        },
                    },
                },
            },
            {
                ...local,
                stt: {
                    ...local.stt,
                    provider: 'happier.voice.openai-compat/stt',
                },
                tts: {
                    ...local.tts,
                    provider: 'device',
                },
            },
        );
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                executionMachineId: 'machine-online',
                setVoice: vi.fn(),
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'cloud_only', onDevice: 'unsupported' },
                    daemon: {
                        featureEnabled: true,
                        route: 'direct',
                        modelState: 'ready',
                        runtimeState: 'available',
                        pcmCapture: 'available',
                    },
                    nativeDevice: { requested: false },
                },
            }),
        );

        await act(async () => {
            findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.checkSetup',
            })?.props.onPress();
        });
        const readiness = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        });
        expect(readiness?.props.subtitle).toContain('voice.readiness.endpoint_missing');
        expect(readiness?.props.subtitle).not.toContain('voice.readiness.ready');
    }, 120_000);

    it('passively reports missing selected-machine credentials for nested Local cloud speech', async () => {
        const {
            readLocalConversationVoiceSettings,
            voiceSettingsDefaults,
            writeLocalConversationVoiceSettings,
        } = await import('@/sync/domains/settings/voiceSettings');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const voice = writeLocalConversationVoiceSettings(
            {
                ...voiceSettingsDefaults,
                providerId: 'local_conversation',
                providers: {
                    ...voiceSettingsDefaults.providers,
                    'happier.voice.google/gemini-stt': {
                        schemaVersion: 2,
                        config: { model: 'gemini-2.5-flash', language: '' },
                    },
                    'happier.voice.google/google-cloud-tts': {
                        schemaVersion: 2,
                        config: {
                            voiceName: 'en-US-Wavenet-D',
                            languageCode: 'en-US',
                            format: 'mp3',
                            speakingRate: 1,
                            pitch: 0,
                        },
                    },
                },
            },
            {
                ...local,
                stt: { ...local.stt, provider: 'happier.voice.google/gemini-stt' },
                tts: { ...local.tts, provider: 'happier.voice.google/google-cloud-tts' },
            },
        );
        storageBoundary.settings = settingsParse({ voice });
        onTestFinished(() => {
            storageBoundary.settings = null;
        });

        const setVoice = vi.fn();
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                executionMachineId: 'machine-online',
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'cloud_only', onDevice: 'unsupported' },
                    daemon: {
                        featureEnabled: true,
                        route: 'direct',
                        modelState: 'ready',
                        runtimeState: 'available',
                        pcmCapture: 'available',
                    },
                    nativeDevice: { requested: false },
                },
            }),
        );

        await act(async () => {
            findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.checkSetup',
            })?.props.onPress();
        });
        const readiness = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        });
        expect(readiness?.props.subtitle).toContain('voice.readiness.credential_missing');
        expect(readiness?.props.subtitle).not.toContain('voice.readiness.ready');
        expect(setVoice).not.toHaveBeenCalled();
    }, 120_000);

    it('reprojects a checked Local result when a nested cloud credential is removed', async () => {
        const {
            readLocalConversationVoiceSettings,
            voiceSettingsDefaults,
            writeLocalConversationVoiceSettings,
        } = await import('@/sync/domains/settings/voiceSettings');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { upsertAccountVoiceCredential } = await import('@/voice/credentials/accountVoiceCredential');
        const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const voice = writeLocalConversationVoiceSettings(
            {
                ...voiceSettingsDefaults,
                providerId: 'local_conversation',
                providers: {
                    ...voiceSettingsDefaults.providers,
                    'happier.voice.google/gemini-stt': {
                        schemaVersion: 2,
                        config: { model: 'gemini-2.5-flash', language: '' },
                    },
                    'happier.voice.google/google-cloud-tts': {
                        schemaVersion: 2,
                        config: {
                            voiceName: 'en-US-Wavenet-D',
                            languageCode: 'en-US',
                            format: 'mp3',
                            speakingRate: 1,
                            pitch: 0,
                        },
                    },
                },
            },
            {
                ...local,
                stt: { ...local.stt, provider: 'happier.voice.google/gemini-stt' },
                tts: { ...local.tts, provider: 'happier.voice.google/google-cloud-tts' },
            },
        );
        const sttReady = upsertAccountVoiceCredential({
            settings: settingsParse({ voice }),
            contribution: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
            credentialSlotId: 'api_key',
            machineId: 'machine-online',
            value: 'google-stt-key',
            generateId: () => 'google-stt-secret',
            now: 1,
            expectedSecretId: null,
            expectedSecretUpdatedAt: null,
        }).settings;
        const ready = upsertAccountVoiceCredential({
            settings: sttReady,
            contribution: { pluginId: 'happier.voice.google', localId: 'google-cloud-tts' },
            credentialSlotId: 'api_key',
            machineId: 'machine-online',
            value: 'google-tts-key',
            generateId: () => 'google-tts-secret',
            now: 1,
            expectedSecretId: null,
            expectedSecretUpdatedAt: null,
        }).settings;
        storageBoundary.settings = ready;
        onTestFinished(() => {
            storageBoundary.settings = null;
        });

        const setVoice = vi.fn();
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const render = (nextVoice: typeof ready.voice) => React.createElement(VoiceProviderSection, {
            voice: nextVoice,
            executionMachineId: 'machine-online',
            setVoice,
            happierVoiceSupported: true,
            platformOs: 'web',
            localAvailability: {
                browserSpeech: { support: 'cloud_only' as const, onDevice: 'unsupported' as const },
                daemon: {
                    featureEnabled: true,
                    route: 'direct' as const,
                    modelState: 'ready' as const,
                    runtimeState: 'available' as const,
                    pcmCapture: 'available' as const,
                },
                nativeDevice: { requested: false },
            },
        });
        const { tree } = await renderScreen(render(ready.voice));

        await act(async () => {
            findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.checkSetup',
            })?.props.onPress();
        });
        expect(findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        })?.props.subtitle).toContain('voice.readiness.ready');

        const removed = settingsParse({
            ...ready,
            secrets: ready.secrets.filter((secret) => secret.id !== 'google-stt-secret'),
        });
        storageBoundary.settings = removed;
        await act(async () => {
            tree.update(render(removed.voice));
        });

        expect(findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        })?.props.subtitle).toContain('voice.readiness.credential_missing');
        expect(setVoice).not.toHaveBeenCalled();
    }, 120_000);

    it('updates an already-mounted provider selector when an external activation is added and removed', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'Synthetic Live',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: { turn: { cancelResponse: true, bargeIn: false } },
            client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
        }] }).voiceProviders[0]!;
        if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
        const scope = createExternalVoiceProviderActivationScope({
            pluginId: 'acme.synthetic-live', declarations: [declaration], hostPlatform: 'web',
        });
        const hostLease = createBundledConversationRuntimeHostLease();
        onTestFinished(async () => {
            await scope.unwind();
            hostLease.revoke();
        });
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: { providerId: null } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));

        expect(findTestInstanceByTypeWithProps(tree, 'Item' as any, { title: 'Synthetic Live' })).toBeFalsy();
        await act(async () => {
            scope.api.voiceProviders.register('conversation', {
                kind: 'conversation',
                protocol: {
                    async prepare() {
                        return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
                    },
                    decodeControl: () => [],
                    encodeTurnControl: (action) => action === 'cancel_response' ? { type: 'cancel' } : null,
                },
                async createConnection() {
                    return {
                        kind: 'sdk_handle',
                        async connect() {}, async sendControl() {},
                        controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                        transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                        async close() {}, state: () => 'closed',
                        currentProviderSessionId: () => null, playbackCursorMs: () => null,
                        beginOutputInterruptionCandidate: () => 'unsupported',
                        resolveOutputInterruptionCandidate() {},
                    };
                },
                encodeToolResults: () => [],
                encodeToolContinuation: (responseId) => ({ type: 'continue', responseId }),
                encodeContextUpdate: (text) => [{ type: 'context', text }],
                encodeTextTurn: (text) => [{ type: 'text', text }],
                microphoneMode: 'provider_managed',
                setInputMuted: () => {},
            });
            scope.commit();
        });
        expect(findTestInstanceByTypeWithProps(tree, 'Item' as any, { title: 'Synthetic Live' })).toBeTruthy();

        await act(async () => scope.unwind());
        expect(findTestInstanceByTypeWithProps(tree, 'Item' as any, { title: 'Synthetic Live' })).toBeFalsy();
    });

    it('renders and persists an active external provider select through the canonical qualified envelope', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'Synthetic Configurable',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: { turn: { cancelResponse: true, bargeIn: false } },
            settings: {
                schemaVersion: 1,
                fields: [{
                    id: 'voice',
                    title: 'Provider voice',
                    description: 'Applied to the next provider session.',
                    schema: { type: 'string', enum: ['calm', 'bright'] },
                    default: 'calm',
                    presentation: {
                        control: 'select',
                        options: [
                            { value: 'calm', title: 'Calm' },
                            { value: 'bright', title: 'Bright' },
                        ],
                    },
                }],
            },
            client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
        }] }).voiceProviders[0]!;
        if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
        const scope = createExternalVoiceProviderActivationScope({
            pluginId: 'acme.synthetic-configurable',
            declarations: [declaration],
            hostPlatform: 'web',
        });
        const hostLease = createBundledConversationRuntimeHostLease();
        onTestFinished(async () => {
            await scope.unwind();
            hostLease.revoke();
        });
        scope.api.voiceProviders.register('conversation', {
            kind: 'conversation',
            protocol: {
                async prepare() {
                    return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
                },
                decodeControl: () => [],
                encodeTurnControl: () => null,
            },
            async createConnection() {
                return {
                    kind: 'sdk_handle',
                    async connect() {}, async sendControl() {},
                    controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    async close() {}, state: () => 'closed',
                    currentProviderSessionId: () => null, playbackCursorMs: () => null,
                    beginOutputInterruptionCandidate: () => 'unsupported',
                    resolveOutputInterruptionCandidate() {},
                };
            },
            encodeToolResults: () => [],
            encodeToolContinuation: () => null,
            encodeContextUpdate: () => [],
            encodeTextTurn: () => [],
            microphoneMode: 'provider_managed',
            setInputMuted: () => {},
        });
        await scope.commit();
        const providerId = 'acme.synthetic-configurable/conversation';
        const setVoice = vi.fn();
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: {
                providerId,
                providers: {
                    [providerId]: {
                        schemaVersion: 1,
                        config: { voice: 'calm' },
                    },
                },
            } as any,
            setVoice,
            happierVoiceSupported: true,
            platformOs: 'web',
        }));

        const select = findTestInstanceByTypeWithProps(tree, 'DropdownMenu' as any, {
            selectedId: JSON.stringify('calm'),
        });
        expect(select?.props.itemTrigger.title).toBe('Provider voice');
        await act(async () => select?.props.onSelect(JSON.stringify('bright')));
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            providerId,
            providers: expect.objectContaining({
                [providerId]: {
                    schemaVersion: 1,
                    config: { voice: 'bright' },
                },
            }),
        }));
    });

    it('keeps an externally installed provider selectable when its credential source resolution is unknown', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        installCodexConnectedAccountDescriptor();
        const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'Acme selectable voice',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: { turn: { cancelResponse: false, bargeIn: false } },
            credentials: {
                slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'API key' },
                requirement: { kind: 'always' },
                sources: [{
                    kind: 'savedSecret',
                    secretKinds: ['apiKey'],
                    rawGrants: [{
                        realm: 'web',
                        phase: 'prepare',
                        request: {
                            kind: 'httpHeaders',
                            origin: 'https://voice.example.com',
                            headerNames: ['authorization'],
                        },
                    }],
                }, {
                    kind: 'connectedAccount',
                    service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                    rawGrants: [{
                        realm: 'web',
                        phase: 'prepare',
                        request: {
                            kind: 'httpHeaders',
                            origin: 'https://voice.example.com',
                            headerNames: ['authorization'],
                        },
                    }],
                }],
            },
            settings: {
                schemaVersion: 1,
                fields: [{
                    id: 'voice',
                    title: 'Voice',
                    schema: { type: 'string', minLength: 1, maxLength: 64 },
                    default: 'calm',
                    presentation: { control: 'text' },
                }],
            },
            client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
        }] }).voiceProviders[0]!;
        if (declaration.kind !== 'conversation' || !declaration.credentials) {
            throw new Error('expected credential conversation declaration');
        }
        const scope = createExternalVoiceProviderActivationScope({
            pluginId: 'acme.selectable-voice', declarations: [declaration], hostPlatform: 'web',
        });
        const hostLease = createBundledConversationRuntimeHostLease();
        const account = {
            ref: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                accountId: 'codex-work',
            },
            status: 'connected' as const,
            configurationReady: false,
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned' as const,
            credentialRevision: 'cred-1',
            configurationRevision: null,
            scopes: ['openid', 'profile', 'email', 'offline_access'],
        };
        onTestFinished(async () => {
            storageBoundary.settings = null;
            passiveSetupBoundary.profile = null;
            await scope.unwind();
            hostLease.revoke();
            installConnectedAccountDescriptorProjection({
                scopeKey: 'voice-provider-section-test-cleanup',
                status: 'ready',
                descriptors: [],
                conflicts: [],
                errorReason: null,
            });
        });
        scope.api.voiceProviders.register('conversation', {
            kind: 'conversation',
            protocol: {
                async prepare() {
                    return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
                },
                decodeControl: () => [],
                encodeTurnControl: () => null,
            },
            async createConnection() {
                return {
                    kind: 'sdk_handle',
                    async connect() {}, async sendControl() {},
                    controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    async close() {}, state: () => 'closed',
                    currentProviderSessionId: () => null, playbackCursorMs: () => null,
                    beginOutputInterruptionCandidate: () => 'unsupported',
                    resolveOutputInterruptionCandidate() {},
                };
            },
            encodeToolResults: () => [],
            encodeToolContinuation: () => null,
            encodeContextUpdate: () => [],
            encodeTextTurn: () => [],
            microphoneMode: 'provider_managed',
            setInputMuted: () => {},
        });
        await scope.commit();

        const providerId = 'acme.selectable-voice/conversation';
        storageBoundary.settings = settingsParse({
            secrets: [{
                id: 'surviving-acme-secret',
                name: 'Saved Acme key',
                kind: 'apiKey',
                encryptedValue: {
                    _isSecretValue: true,
                    encryptedValue: { t: 'enc-v1', c: 'Y2lwaGVydGV4dA==' },
                },
                createdAt: 1,
                updatedAt: 1,
            }],
            voiceSettingsV1: { credentialBindings: [] },
            connectedAccountPurposeBindingsV1: {
                v: 1,
                bindings: [{
                    purpose: {
                        consumer: { pluginId: 'acme.selectable-voice', localId: 'conversation' },
                        purpose: 'voice.client-auth',
                    },
                    target: { kind: 'account', account: account.ref },
                }],
            },
        });
        passiveSetupBoundary.profile = {
            connectedAccountsV4: [account],
            connectedAccountGroupsV4: [],
            connectedServicesV2: [],
        };

        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: { providerId: null } as any,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const row = tree.root.findAll((node) => (
            typeof node.props.testID === 'string'
            && node.props.testID.startsWith(`settings.voice.provider.${encodeURIComponent(providerId)}.`)
        ))[0];

        expect(row).toBeTruthy();
        expect(row.props.detail).toContain('voice.readiness.credential_unknown');
        // The declaration names savedSecret and connectedAccount sources, so
        // the credential is configurable once the row can be selected. A
        // bundled row in this exact state stays selectable; provenance is not
        // evidence about whether a credential can be supplied.
        expect(row.props.disabled).not.toBe(true);
    }, 120_000);

    it('keeps a dormant external SavedSecret edit standalone while Connected Account is selected', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { applyAccountVoiceCredentialSourceSelection } = await import('@/voice/credentials/accountVoiceCredential');
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        installCodexConnectedAccountDescriptor();
        const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'External credential voice',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: { turn: { cancelResponse: false, bargeIn: false } },
            credentials: {
                slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'API key' },
                requirement: { kind: 'always' },
                sources: [{
                    kind: 'savedSecret',
                    secretKinds: ['apiKey'],
                    rawGrants: [{
                        realm: 'web',
                        phase: 'prepare',
                        request: {
                            kind: 'httpHeaders',
                            origin: 'https://voice.example.com',
                            headerNames: ['authorization'],
                        },
                    }],
                }, {
                    kind: 'connectedAccount',
                    service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                    rawGrants: [{
                        realm: 'web',
                        phase: 'prepare',
                        request: {
                            kind: 'httpHeaders',
                            origin: 'https://voice.example.com',
                            headerNames: ['authorization'],
                        },
                    }],
                }],
            },
            settings: {
                schemaVersion: 1,
                fields: [{
                    id: 'voice',
                    title: 'Voice',
                    schema: { type: 'string', minLength: 1, maxLength: 64 },
                    default: 'calm',
                    presentation: { control: 'text' },
                }],
            },
            client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
        }] }).voiceProviders[0]!;
        if (declaration.kind !== 'conversation' || !declaration.credentials) {
            throw new Error('expected credential conversation declaration');
        }
        const scope = createExternalVoiceProviderActivationScope({
            pluginId: 'acme.external-credential', declarations: [declaration], hostPlatform: 'web',
        });
        const hostLease = createBundledConversationRuntimeHostLease();
        const account = {
            ref: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                accountId: 'codex-work',
            },
            status: 'connected' as const,
            configurationReady: false,
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned' as const,
            credentialRevision: 'cred-1',
            configurationRevision: null,
            scopes: [],
        };
        onTestFinished(async () => {
            storageBoundary.settings = null;
            passiveSetupBoundary.profile = null;
            await scope.unwind();
            hostLease.revoke();
        });
        scope.api.voiceProviders.register('conversation', {
            kind: 'conversation',
            protocol: {
                async prepare() {
                    return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
                },
                decodeControl: () => [],
                encodeTurnControl: () => null,
            },
            async createConnection() {
                return {
                    kind: 'sdk_handle',
                    async connect() {}, async sendControl() {},
                    controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    async close() {}, state: () => 'closed',
                    currentProviderSessionId: () => null, playbackCursorMs: () => null,
                    beginOutputInterruptionCandidate: () => 'unsupported',
                    resolveOutputInterruptionCandidate() {},
                };
            },
            encodeToolResults: () => [],
            encodeToolContinuation: () => null,
            encodeContextUpdate: () => [],
            encodeTextTurn: () => [],
            microphoneMode: 'provider_managed',
            setInputMuted: () => {},
        });
        await scope.commit();
        const providerId = 'acme.external-credential/conversation';
        const voice = {
            providerId,
            providers: { [providerId]: { schemaVersion: 1, config: { voice: 'calm' } } },
        };
        const selected = applyAccountVoiceCredentialSourceSelection({
            settings: settingsParse({ voice }),
            mutation: {
                contribution: { pluginId: 'acme.external-credential', localId: 'conversation' },
                credentialSlotId: 'api_key',
                selection: { kind: 'connectedAccount', target: { kind: 'account', account: account.ref } },
                expectedSettingsVersion: 1,
            },
            currentDeclaration: declaration,
        });
        storageBoundary.settings = selected.settings;
        passiveSetupBoundary.profile = {
            connectedAccountsV4: [account],
            connectedAccountGroupsV4: [],
            connectedServicesV2: [],
        };
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: selected.settings.voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const credentialEditor = tree.root.findAll((node) => (
            node.props.contribution?.pluginId === 'acme.external-credential'
            && node.props.credentialSlotId === 'api_key'
        ))[0];

        expect(credentialEditor).toBeTruthy();
        expect(credentialEditor.props.credentialSourcePurpose).toBeUndefined();
    });

    it('qualifies a same-plugin shorthand Agent binding before rendering Connected Services settings', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'Installed Agent Voice',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: { turn: { cancelResponse: false, bargeIn: false } },
            execution: {
                kind: 'experimental_agent_session_realtime',
                agent: 'claude',
                supportedRuntimeVersions: ['1.2.3'],
            },
            settings: {
                schemaVersion: 2,
                fields: [],
                privacyDisclosure: {
                    key: 'settingsVoice.realtimeProviders.codex.privacyDisclosure',
                    fallback: 'Installed provider privacy disclosure.',
                },
                connectedServicesBinding: {
                    id: 'globalConnectedServices',
                    title: 'Claude account',
                    description: 'Account for the global Voice session.',
                    agent: 'claude',
                    serviceIds: ['anthropic', 'openai-codex'],
                },
            },
            client: { artifactId: 'voice-runtime-web', modulePath: './voiceRuntime', exportName: 'activate' },
        }] }).voiceProviders[0]!;
        if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
        const scope = createExternalVoiceProviderActivationScope({
            pluginId: 'acme.voice',
            declarations: [declaration],
            hostPlatform: 'web',
        });
        const hostLease = createBundledConversationRuntimeHostLease();
        onTestFinished(async () => {
            await scope.unwind();
            hostLease.revoke();
        });
        scope.api.voiceProviders.register('conversation', {
            kind: 'conversation',
            protocol: {
                async prepare() {
                    return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
                },
                decodeControl: () => [],
                encodeTurnControl: () => null,
            },
            async createConnection() {
                return {
                    kind: 'sdk_handle',
                    async connect() {}, async sendControl() {},
                    controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    async close() {}, state: () => 'closed',
                    currentProviderSessionId: () => null, playbackCursorMs: () => null,
                    beginOutputInterruptionCandidate: () => 'unsupported',
                    resolveOutputInterruptionCandidate() {},
                };
            },
            encodeToolResults: () => [],
            encodeToolContinuation: () => null,
            encodeContextUpdate: () => [],
            encodeTextTurn: () => [],
            microphoneMode: 'provider_managed',
            setInputMuted: () => {},
        });
        await scope.commit();
        const providerId = 'acme.voice/conversation';
        const binding = {
            v: 1 as const,
            bindingsByServiceId: {
                anthropic: {
                    source: 'connected' as const,
                    selection: 'profile' as const,
                    profileId: 'anthropic-account-a',
                },
                'openai-codex': {
                    source: 'connected' as const,
                    selection: 'profile' as const,
                    profileId: 'codex-account-a',
                },
            },
        };
        const setVoice = vi.fn();
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: {
                providerId,
                providers: {
                    [providerId]: {
                        schemaVersion: 2,
                        config: { globalConnectedServices: null },
                    },
                },
            } as any,
            setVoice,
            happierVoiceSupported: true,
            platformOs: 'web',
        }));

        const field = tree.findAllByType('VoiceGlobalConnectedServicesBindingField' as any)
            .find((candidate: any) => candidate.props.title === 'Claude account');
        expect(field).toBeTruthy();
        expect(field?.props.agentId).toEqual({
            pluginId: 'acme.voice',
            localId: 'claude',
        });
        expect(field?.props.serviceIds).toEqual(['anthropic', 'openai-codex']);
        await act(async () => field?.props.onChange(binding));
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            providerId,
            providers: expect.objectContaining({
                [providerId]: {
                    schemaVersion: 2,
                    config: { globalConnectedServices: binding },
                },
            }),
        }));
    });

    it('renders bundled Codex through the same exact qualified public Connected Services declaration', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const binding = {
            v: 1 as const,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected' as const,
                    selection: 'profile' as const,
                    profileId: 'codex-account-b',
                },
            },
        };
        const setVoice = vi.fn();
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: { globalConnectedServices: null },
                    },
                },
            } as any,
            setVoice,
            happierVoiceSupported: true,
            platformOs: 'web',
        }));

        const fields = tree.findAllByType('VoiceGlobalConnectedServicesBindingField' as any)
            .filter((candidate: any) => candidate.props.title === 'Codex account'
                && candidate.props.agentId?.pluginId === 'happier.agent.codex'
                && candidate.props.agentId?.localId === 'codex');
        expect(fields).toHaveLength(1);
        await act(async () => fields[0]?.props.onChange(binding));
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            providerId: CODEX_PROVIDER_ID,
            providers: expect.objectContaining({
                [CODEX_PROVIDER_ID]: {
                    schemaVersion: 2,
                    config: { globalConnectedServices: binding },
                },
            }),
        }));
    });
});
