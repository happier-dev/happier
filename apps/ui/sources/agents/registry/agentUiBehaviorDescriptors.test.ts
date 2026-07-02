import { describe, expect, it } from 'vitest';

import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import { makeSettings } from './registryUiBehavior.testHelpers';
import { createAgentUiBehaviorFromDescriptor } from './agentUiBehaviorDescriptors';

describe('createAgentUiBehaviorFromDescriptor', () => {
    it('builds generic UI behavior from descriptor data', () => {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'acme',
            agentId: 'acme',
            version: 1,
            display: {},
            behavior: {
                guidance: { includeInSessionGettingStartedCliExamples: true },
                mcpServers: { supportsDetectedConfigScan: true },
                permissions: {
                    footer: {
                        usePermissionUpdates: true,
                        forceReadOnlyAfterStop: false,
                        supportsExecPolicyAmendment: true,
                        stopHandling: 'denyOnly',
                    },
                },
                resume: {
                    experimentSwitches: [
                        { id: 'directStorage', settingKey: 'directTranscriptStorageMode' },
                    ],
                },
                newSession: {
                    relevantInstallableDepKeys: ['acme.cli'],
                    transcriptStorageModes: ['direct'],
                    canSelectWithoutDetectedCli: true,
                },
                payload: {
                    spawnSessionExtras: { kind: 'static', value: { backendMode: 'managed' } },
                },
            },
            session: {},
            message: {},
            components: { slots: [] },
        });

        expect(diagnostics).toEqual([]);
        expect(behavior.guidance?.includeInSessionGettingStartedCliExamples).toBe(true);
        expect(behavior.mcpServers?.supportsDetectedConfigScan).toBe(true);
        expect(behavior.permissions?.footer?.stopHandling).toBe('denyOnly');
        expect(behavior.resume?.experimentSwitches?.[0]?.getValue?.(
            makeSettings({ directTranscriptStorageMode: true }),
        )).toBe(true);
        expect(behavior.newSession?.getRelevantInstallableDepKeys?.({
            agentId: 'acme' as any,
            settings: makeSettings(),
            experiments: { enabled: true, switches: {} },
            resumeSessionId: '',
        })).toEqual(['acme.cli']);
        expect(behavior.newSession?.supportsTranscriptStorageMode?.({
            agentId: 'acme' as any,
            settings: makeSettings(),
            storageMode: 'direct',
        })).toBe(true);
        expect(behavior.newSession?.canSelectWithoutDetectedCli?.({
            agentId: 'acme' as any,
            settings: makeSettings(),
        })).toBe(true);
        expect(behavior.payload?.buildSpawnSessionExtras?.({
            agentId: 'acme' as any,
            settings: makeSettings(),
            experiments: { enabled: true, switches: {} },
            resumeSessionId: '',
        })).toEqual({ backendMode: 'managed' });
    });

    it('materializes first-party session subagent component slots through the host allowlist', () => {
        const session = createSessionFixture();
        const subagent = {
            id: 'subagent-1',
            kind: 'agent_team_member',
            status: 'running',
            display: {
                title: 'Team 1',
                groupKey: 'team-1',
            },
            transcript: {},
            recipient: null,
            capabilities: {
                canOpen: false,
                canSend: false,
                canStop: false,
                canLaunchChild: false,
                canDelete: false,
                canOpenAdvancedRun: false,
            },
            timestamps: {},
        } satisfies SessionSubagent;
        const detailsTab = {
            key: 'claude-subagent-launcher:member:team-1',
            kind: 'claudeSubagentLauncher',
            title: 'Launch teammate',
            resource: {
                kind: 'claudeSubagentLauncher',
                mode: 'member',
                initialTeamId: 'team-1',
            },
        } satisfies DetailsTab;
        const iconTab = {
            key: 'claude-subagent-launcher:member:team-1',
            kind: 'claudeSubagentLauncher',
            title: 'Launch teammate',
            resource: { kind: 'claudeSubagentLauncher', mode: 'member' },
        } satisfies DetailsTab;
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'claude',
            agentId: 'claude',
            version: 1,
            display: {},
            behavior: {},
            session: {},
            message: {},
            components: {
                slots: [
                    {
                        id: 'claude.subagentLaunchCards',
                        slot: 'sessionSubagents.launchCards',
                        componentId: 'firstParty.claude.subagentLaunchCards',
                        props: {
                            teamIds: {
                                kind: 'subagentGroupKeys',
                                subagentKinds: ['agent_team_member'],
                            },
                        },
                    },
                    {
                        id: 'claude.teammateDetailsTab',
                        slot: 'sessionSubagents.teammateDetailsTab',
                        componentId: 'firstParty.claude.teammateDetailsTab',
                        resourceKind: 'claudeSubagentLauncher',
                        iconName: 'people',
                        tab: {
                            keyPrefix: 'claude-subagent-launcher',
                            titleKey: 'session.subagents.panel.launchTeammateAction',
                            subtitleKey: 'session.subagents.panel.launchClaudeTeamsSubtitle',
                        },
                    },
                ],
            },
        });

        expect(diagnostics).toEqual([]);
        expect(behavior.sessionSubagents?.renderLaunchCards?.({
            sessionId: 's1',
            scopeId: 'session:s1',
            session,
            subagents: [subagent],
        })).toHaveLength(1);
        expect(behavior.sessionSubagents?.createTeammateLauncherDetailsTab?.({
            session,
            teamId: 'team-1',
        })).toMatchObject({
            key: 'claude-subagent-launcher:member:team-1',
            kind: 'claudeSubagentLauncher',
            resource: {
                kind: 'claudeSubagentLauncher',
                mode: 'member',
                initialTeamId: 'team-1',
            },
        });
        expect(behavior.sessionSubagents?.renderDetailsTab?.({
            sessionId: 's1',
            scopeId: 'session:s1',
            tab: detailsTab,
        })).toBeTruthy();
        expect(behavior.sessionSubagents?.getDetailsTabIconName?.({
            tab: iconTab,
        })).toBe('people');
    });

    it('fails closed for unsupported descriptor kinds and payload adapter ids', () => {
        const wrongKind = createAgentUiBehaviorFromDescriptor({
            kind: 'agent.uiBehavior.v1',
            agentId: 'acme',
        });
        expect(wrongKind.behavior).toEqual({});
        expect(wrongKind.diagnostics).toContainEqual(expect.objectContaining({
            code: 'A16X1_UNSUPPORTED_DESCRIPTOR_KIND',
            path: 'kind',
        }));

        const unsupportedAdapter = createAgentUiBehaviorFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'acme',
            agentId: 'acme',
            version: 1,
            display: {},
            behavior: {
                payload: {
                    spawnSessionExtras: { kind: 'adapter', adapterId: 'provider.branch.local' },
                },
            },
            session: {},
            message: {},
            components: { slots: [] },
        });
        expect(unsupportedAdapter.behavior.payload?.buildSpawnSessionExtras).toBeUndefined();
        expect(unsupportedAdapter.diagnostics).toContainEqual(expect.objectContaining({
            code: 'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            path: 'payload.spawnSessionExtras',
        }));
    });

    it('fails closed for malformed environment URL descriptors', () => {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            descriptorId: 'opencode.uiBehavior.v1',
            payload: {
                environmentVariables: {
                    providerId: 'opencode',
                    backendMode: {
                        envKey: 'HAPPIER_OPENCODE_BACKEND_MODE',
                        settingKey: 'opencodeBackendMode',
                        legacyMetadataKey: 'opencodeBackendMode',
                        runtimeDescriptorField: 'backendMode',
                        defaultValue: 'server',
                        values: ['server', 'acp'],
                    },
                    serverBaseUrl: {
                        envKey: 'HAPPIER_OPENCODE_SERVER_URL',
                        settingKey: 'opencodeServerBaseUrl',
                        byServerIdSettingKey: 'opencodeServerBaseUrlByServerIdV1',
                        legacyMetadataKey: 'opencodeServerBaseUrl',
                        legacyExplicitMetadataKey: 'opencodeServerBaseUrlExplicit',
                        runtimeDescriptorField: 'serverBaseUrl',
                        runtimeDescriptorExplicitField: 'serverBaseUrlExplicit',
                    },
                },
            },
        });

        expect(diagnostics).toContainEqual(expect.objectContaining({
            code: 'A16X1_MALFORMED_DESCRIPTOR',
            path: 'payload.environmentVariables.serverBaseUrl',
        }));
        expect(behavior.payload?.buildSpawnEnvironmentVariables?.({
            agentId: 'opencode' as any,
            settings: makeSettings({
                opencodeBackendMode: 'server' as any,
                opencodeServerBaseUrlByServerIdV1: {
                    'server-1': 'http://127.0.0.1:4096/',
                },
            } as any),
            environmentVariables: undefined,
            newSessionOptions: { targetServerId: 'server-1' },
        })).toEqual({
            HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        });
    });

    it('builds OpenCode behavior from no-execute descriptor data', () => {
        const openCodeBehaviorDescriptor = {
            guidance: { includeInSessionGettingStartedCliExamples: true },
            mcpServers: { supportsDetectedConfigScan: true },
            externalSessions: {
                supportsBackgroundFollow: false,
                browse: {
                    order: 30,
                    sourceOptions: [
                        {
                            key: 'opencode:default',
                            labelKey: 'externalSessions.browseSourceOpenCodeDefault',
                            source: { kind: 'opencodeServer' },
                        },
                    ],
                    compatibleSource: {
                        sourceKind: 'opencodeServer',
                        optionalFields: ['baseUrl', 'directory'],
                    },
                },
            },
            payload: {
                environmentVariables: {
                    providerId: 'opencode',
                    backendMode: {
                        envKey: 'HAPPIER_OPENCODE_BACKEND_MODE',
                        settingKey: 'opencodeBackendMode',
                        legacyMetadataKey: 'opencodeBackendMode',
                        runtimeDescriptorField: 'backendMode',
                        defaultValue: 'server',
                        values: ['server', 'acp'],
                    },
                    serverBaseUrl: {
                        envKey: 'HAPPIER_OPENCODE_SERVER_URL',
                        explicitEnvKey: 'HAPPIER_OPENCODE_SERVER_URL_EXPLICIT',
                        settingKey: 'opencodeServerBaseUrl',
                        byServerIdSettingKey: 'opencodeServerBaseUrlByServerIdV1',
                        legacyMetadataKey: 'opencodeServerBaseUrl',
                        legacyExplicitMetadataKey: 'opencodeServerBaseUrlExplicit',
                        runtimeDescriptorField: 'serverBaseUrl',
                        runtimeDescriptorExplicitField: 'serverBaseUrlExplicit',
                        allowedProtocols: ['http:', 'https:'],
                        rejectCredentials: true,
                        httpLoopbackOnly: true,
                        originOnly: true,
                    },
                },
            },
        };
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'opencode',
            agentId: 'opencode',
            version: 1,
            display: {},
            behavior: openCodeBehaviorDescriptor,
            session: {},
            message: {},
            components: { slots: [] },
        });
        const generated = createAgentUiBehaviorFromDescriptor({
            descriptorId: 'opencode.uiBehavior.v1',
            ...openCodeBehaviorDescriptor,
        });

        expect(diagnostics).toEqual([]);
        expect(generated.diagnostics).toEqual([]);
        expect(generated.behavior.payload?.buildSpawnEnvironmentVariables).toBeTypeOf('function');
        expect(behavior.guidance?.includeInSessionGettingStartedCliExamples).toBe(true);
        expect(behavior.mcpServers?.supportsDetectedConfigScan).toBe(true);
        expect(behavior.externalSessions?.supportsBackgroundFollow).toBe(false);
        expect(behavior.externalSessions?.browse?.order).toBe(30);
        const sourceOptions = behavior.externalSessions?.browse?.getSourceOptions?.({
            agentId: 'opencode' as any,
            profile: null,
            settings: makeSettings(),
        });
        expect(sourceOptions).toEqual([
            {
                key: 'opencode:default',
                label: expect.any(String),
                source: { kind: 'opencodeServer' },
            },
        ]);
        expect(sourceOptions?.[0]?.label).not.toBe('');
        expect(behavior.externalSessions?.browse?.resolveCompatibleLinkSource?.({
            agentId: 'opencode' as any,
            selectedSource: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' } as any,
            candidateSource: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/', directory: '/repo' } as any,
        })).toEqual({ kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/', directory: '/repo' });
        expect(behavior.payload?.buildSpawnEnvironmentVariables?.({
            agentId: 'opencode' as any,
            settings: makeSettings({
                opencodeBackendMode: 'acp' as any,
                opencodeServerBaseUrlByServerIdV1: {
                    'server-1': 'http://127.0.0.1:4096/path',
                },
            } as any),
            environmentVariables: { FOO: '1' },
            newSessionOptions: { targetServerId: 'server-1' },
        })).toEqual({
            FOO: '1',
            HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
            HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
            HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
        });
        expect(behavior.payload?.buildResumeSessionExtras?.({
            agentId: 'opencode' as any,
            experiments: { enabled: true, switches: {} },
            settings: makeSettings({ opencodeBackendMode: 'acp' as any }),
            session: {
                metadata: {
                    runtimeDescriptorV1: {
                        v: 1,
                        providerId: 'opencode',
                        provider: {
                            backendMode: 'server',
                            serverBaseUrl: 'http://127.0.0.1:4097/path',
                            serverBaseUrlExplicit: true,
                        },
                    },
                },
            } as any,
        })).toEqual({
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'server',
                HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4097/',
                HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
            },
        });
    });

    it('classifies fresh provider config metadata as non-steerable while busy', () => {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'claude',
            agentId: 'claude',
            version: 1,
            display: {},
            behavior: {
                sessionComposer: {
                    nonSteerableWhileBusy: {
                        reason: 'provider_config_change_refused',
                        metaKeys: ['reasoningEffort'],
                        sessionConfigOptionIds: ['reasoning_effort'],
                        freshModelOverride: true,
                    },
                },
            },
            session: {},
            message: {},
            components: { slots: [] },
        });

        expect(diagnostics).toEqual([]);
        expect(behavior.sessionComposer?.classifyNonSteerablePayload?.({
            agentId: 'claude',
            session: {
                metadata: {
                    flavor: 'claude',
                    sessionConfigOptionsV1: {
                        v: 1,
                        provider: 'claude',
                        updatedAt: 10,
                        configOptions: [
                            {
                                id: 'reasoning_effort',
                                name: 'Reasoning effort',
                                type: 'select',
                                currentValue: 'medium',
                            },
                        ],
                    },
                    sessionConfigOptionOverridesV1: {
                        v: 1,
                        updatedAt: 20,
                        overrides: {
                            reasoning_effort: { updatedAt: 20, value: 'high' },
                        },
                    },
                },
            } as any,
            metaOverrides: {},
        })).toBe('provider_config_change_refused');
        expect(behavior.sessionComposer?.classifyNonSteerablePayload?.({
            agentId: 'claude',
            session: {
                metadata: { flavor: 'claude' },
            } as any,
            metaOverrides: { reasoningEffort: 'high' },
        })).toBe('provider_config_change_refused');
        expect(behavior.sessionComposer?.classifyNonSteerablePayload?.({
            agentId: 'claude',
            session: {
                modelMode: 'opus',
                modelModeUpdatedAt: 30,
                metadata: {
                    flavor: 'claude',
                    sessionModelsV1: {
                        v: 1,
                        provider: 'claude',
                        updatedAt: 10,
                        currentModelId: 'sonnet',
                        availableModels: [],
                    },
                },
            } as any,
            metaOverrides: {},
        })).toBe('provider_config_change_refused');
    });
});
