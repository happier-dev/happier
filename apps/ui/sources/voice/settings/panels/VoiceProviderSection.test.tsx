import React from 'react';
import { act } from 'react-test-renderer';
import { PluginContributesV2Schema } from '@happier-dev/protocol';
import { vi } from 'vitest';
import { describe, expect, it, onTestFinished } from 'vitest';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import {
    ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
} from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import {
    XAI_REALTIME_DEFAULT_SETTINGS,
} from '../../../../../../packages/plugins/xai/src/protocol/voice/settings';

import { installVoiceSettingsPanelCommonModuleMocks } from './voiceSettingsPanelTestHelpers';

const storageBoundary = vi.hoisted(() => ({
    settings: null as unknown,
}));

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
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
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

describe('VoiceProviderSection', () => {
    it('exposes a generic passive setup check for selected Codex Live without a live-test action', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: {
                providerId: 'realtime_codex',
                providers: {
                    realtime_codex: {
                        schemaVersion: 2,
                        config: { globalConnectedServices: null },
                    },
                },
            } as any,
            setVoice,
            happierVoiceSupported: true,
            platformOs: 'web',
        }));

        const check = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.checkSetup',
        });
        expect(check?.props.onPress).toBeTypeOf('function');
        await act(async () => {
            check?.props.onPress();
        });
        expect(findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.readiness',
        })).toBeTruthy();
        expect(findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.testLive',
        })).toBeUndefined();
        expect(setVoice).not.toHaveBeenCalled();
    }, 120_000);

    it.each([
        'realtime_openai',
        'realtime_grok',
        'realtime_elevenlabs',
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
    }, 120_000);

    it.each([
        ['realtime_openai', 'byo'],
        ['realtime_grok', 'byo'],
        ['realtime_elevenlabs', 'byo'],
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
                testID: `settings.voice.provider.${providerId}.${optionId}`,
            });

            expect(row?.props?.disabled).not.toBe(true);
            expect(row?.props?.onPress).toBeTypeOf('function');
            expect(row?.props?.detail).toContain('voice.readiness.credential_missing');
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

    it.each([
        'connected_service_api_key',
        'connected_service_oauth',
    ] as const)(
        'keeps OpenAI %s readiness unknown but directs setup to account selection instead of SavedSecret credentials',
        async (source) => {
            const { OPENAI_REALTIME_DEFAULT_SETTINGS } = await import(
                '../../../../../../packages/plugins/openai/src/protocol/voice/settings'
            );
            const { VoiceProviderSection } = await import('./VoiceProviderSection');
            const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
                voice: {
                    providerId: 'realtime_openai',
                    providers: {
                        realtime_openai: {
                            schemaVersion: 1,
                            config: {
                                ...OPENAI_REALTIME_DEFAULT_SETTINGS,
                                authentication: { source },
                            },
                        },
                    },
                } as any,
                setVoice: vi.fn(),
                happierVoiceSupported: true,
                platformOs: 'web',
            }));
            const row = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.realtime_openai.byo',
            });

            expect(row?.props.disabled).not.toBe(true);
            expect(row?.props.detail).toBe('settingsVoice.realtimeProviders.authentication.chooseAccount');
            expect(row?.props.detail).not.toContain('voice.readiness.credential_unknown');
            expect(row?.props.detail).not.toContain('voice.readiness.actions.configure_credential');
            expect(tree.findAllByType('VoiceCredentialItem' as any)).toHaveLength(0);

            await act(async () => {
                findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                    testID: 'settings.voice.provider.checkSetup',
                })?.props.onPress();
            });
            const readiness = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
                testID: 'settings.voice.provider.readiness',
            });
            expect(readiness?.props.subtitle).toBe('settingsVoice.realtimeProviders.authentication.chooseAccount');
            expect(readiness?.props.subtitle).not.toContain('voice.readiness.actions.configure_credential');
        },
        120_000,
    );

    it('shows review-required instead of add-credential when a bundled provider retains a stale approved recipient digest', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        const entry = createDefaultVoiceProviderRegistry().get('realtime_grok');
        const slot = entry?.accountCredentialSlot;
        if (!slot) throw new Error('expected Grok account credential slot');
        const voice = {
            providerId: 'realtime_grok',
            providers: {
                realtime_grok: {
                    schemaVersion: 1,
                    config: XAI_REALTIME_DEFAULT_SETTINGS,
                },
            },
            credentialBindings: [{
                providerId: 'realtime_grok',
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
        const row = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            testID: 'settings.voice.provider.realtime_grok.byo',
        });

        expect(row?.props?.detail).toBe('settingsVoice.externalCredentials.reviewRequired');
    }, 120_000);

    it('exposes every provider choice as the same radio control with selected state', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { tree } = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: { providerId: 'realtime_elevenlabs', providers: {
                realtime_elevenlabs: { schemaVersion: 2, config: elevenLabsByoConfig() },
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
            providerId: 'realtime_codex',
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
                testID: 'settings.voice.provider.realtime_openai.byo',
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
                realtime_elevenlabs: { schemaVersion: 2, config: elevenLabsByoConfig() },
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
                realtime_elevenlabs: { schemaVersion: 2, config: elevenLabsByoConfig() },
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
                realtime_elevenlabs: { schemaVersion: 2, config: elevenLabsByoConfig() },
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
                realtime_elevenlabs: { schemaVersion: 2, config: elevenLabsByoConfig() },
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
                realtime_elevenlabs: { schemaVersion: 2, config: elevenLabsByoConfig() },
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
                realtime_elevenlabs: { schemaVersion: 2, config: elevenLabsByoConfig() },
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
            label: 'ready selected daemon machine and ready models',
            executionMachineId: 'machine-online',
            executionMachine: {
                mode: 'fixed' as const,
                machineId: 'machine-online',
                autoMachineId: null,
            },
            daemon: {
                featureEnabled: true,
                route: 'unavailable' as const,
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
                modelState: 'ready' as const,
                runtimeState: 'available' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: 'voice.readiness.execution_machine_missing',
        },
    ])(
        'projects selected Local execution-machine readiness for $label instead of hard-coded placeholders',
        async ({ executionMachineId, executionMachine, daemon, expectedCode }) => {
            const { VoiceProviderSection } = await import('./VoiceProviderSection');
            const { tree } = await renderScreen(
                React.createElement(VoiceProviderSection, {
                    voice: {
                        providerId: 'local_conversation',
                        executionMachine,
                    } as any,
                    executionMachineId,
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

    it('updates an already-mounted provider selector when an external activation is added and removed', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'Synthetic Live',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: { readiness: { requirements: [] }, turn: { cancelResponse: true, bargeIn: false } },
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
                requiresMicForConnection: false,
            });
            scope.commit();
        });
        expect(findTestInstanceByTypeWithProps(tree, 'Item' as any, { title: 'Synthetic Live' })).toBeTruthy();

        await act(async () => scope.unwind());
        expect(findTestInstanceByTypeWithProps(tree, 'Item' as any, { title: 'Synthetic Live' })).toBeFalsy();
    });

    it('renders and persists an active external provider select through the canonical qualified envelope', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'Synthetic Configurable',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: { readiness: { requirements: [] }, turn: { cancelResponse: true, bargeIn: false } },
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
            requiresMicForConnection: false,
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
                        config: { mode: 'default', voice: 'calm' },
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
                    config: { mode: 'default', voice: 'bright' },
                },
            }),
        }));
    });

    it('qualifies a same-plugin shorthand Agent binding before rendering Connected Services settings', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'Installed Agent Voice',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: { readiness: { requirements: [] }, turn: { cancelResponse: false, bargeIn: false } },
            execution: {
                kind: 'experimental_agent_session_realtime',
                agent: 'claude',
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
            requiresMicForConnection: false,
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
        expect(tree.findAllByType('ItemGroup' as any)
            .find((candidate: any) => candidate.props.footer === 'Installed provider privacy disclosure.')).toBeTruthy();
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
                providerId: 'realtime_codex',
                providers: {
                    realtime_codex: {
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
        const disclosureFooter = tree.findAllByType('ItemGroup' as any)
            .map((candidate: any) => candidate.props.footer)
            .find((footer: unknown): footer is string => (
                typeof footer === 'string'
                && footer.includes('Codex Live conversation')
                && footer.includes('selected machine')
                && footer.includes('provider-native runtime storage')
                && footer.includes('does not delete or rewrite')
            ));
        expect(disclosureFooter).toBeTruthy();
        await act(async () => fields[0]?.props.onChange(binding));
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            providerId: 'realtime_codex',
            providers: expect.objectContaining({
                realtime_codex: {
                    schemaVersion: 2,
                    config: { globalConnectedServices: binding },
                },
            }),
        }));
    });
});
