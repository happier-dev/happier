import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import { makeSettings } from './registryUiBehavior.testHelpers';
import { createAgentUiBehaviorFromDescriptor } from './agentUiBehaviorDescriptors';
import { BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS } from './generatedBundledPluginEntries.uiBehaviorOverrides';

function readObjectField(value: unknown, key: string): unknown {
    return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

describe('createAgentUiBehaviorFromDescriptor', () => {
    it('materializes a closed AskUserQuestion dialog declaration without an Agent-specific adapter', () => {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'acme.review',
            agentId: 'review',
            version: 1,
            display: {},
            behavior: {
                askUserQuestion: {
                    dialogs: [{
                        dialogId: 'review_scope_confirmation',
                        settingMutation: {
                            settingId: 'reviewScopePreference',
                            allowedValues: ['ask_every_time', 'always_include'],
                        },
                        terminalNotice: {
                            headerKey: 'tools.askUserQuestion.reviewScope.header',
                            questionKey: 'tools.askUserQuestion.reviewScope.question',
                        },
                        terminalSecondaryAction: {
                            kind: 'openAttachedTerminal',
                            labelKey: 'tools.askUserQuestion.reviewScope.openTerminal',
                            descriptionKey: 'tools.askUserQuestion.reviewScope.description',
                        },
                    }],
                },
            },
            session: {},
            message: {},
            components: { slots: [] },
        });

        expect(diagnostics).toEqual([]);
        expect(behavior.askUserQuestion).toEqual({
            dialogs: [{
                dialogId: 'review_scope_confirmation',
                settingMutation: {
                    settingId: 'reviewScopePreference',
                    allowedValues: ['ask_every_time', 'always_include'],
                },
                terminalNotice: {
                    headerKey: 'tools.askUserQuestion.reviewScope.header',
                    questionKey: 'tools.askUserQuestion.reviewScope.question',
                },
                terminalSecondaryAction: {
                    kind: 'openAttachedTerminal',
                    labelKey: 'tools.askUserQuestion.reviewScope.openTerminal',
                    descriptionKey: 'tools.askUserQuestion.reviewScope.description',
                },
            }],
        });
    });

    it('materializes declarative context-window behavior without a provider adapter branch', () => {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            contextWindow: {
                defaultTokens: 200_000,
                modelRules: [
                    {
                        idSuffix: '[1m]',
                        descriptionIncludesAny: ['1 million', '1m context'],
                        tokens: 1_000_000,
                    },
                ],
                observedUsageBumpTokens: [200_000, 1_000_000],
                trustObservedUsageBeyondKnown: true,
            },
        });

        expect(diagnostics).toEqual([]);
        expect(behavior.contextWindow?.getDefaultContextWindowTokens?.()).toBe(200_000);
        expect(behavior.contextWindow?.getContextWindowTokensForModel?.({
            modelId: 'claude-sonnet-4-6[1m]',
        })).toBe(1_000_000);
        expect(behavior.contextWindow?.getContextWindowTokensForModel?.({
            modelId: 'claude-sonnet-4-6',
            description: '1 million token context',
        })).toBe(1_000_000);
        expect(behavior.contextWindow?.bumpContextWindowTokensForObservedUsage?.({
            contextWindowTokens: 200_000,
            observedUsedTokens: 733_000,
        })).toBe(1_000_000);
        expect(behavior.contextWindow?.bumpContextWindowTokensForObservedUsage?.({
            contextWindowTokens: 1_000_000,
            observedUsedTokens: 1_200_000,
        })).toBe(1_200_000);
    });

    it('keeps provider-specific context-window code out of generic descriptor adapters', () => {
        const source = readFileSync(new URL('./agentUiBehaviorDescriptorAdapters.ts', import.meta.url), 'utf8');

        expect(source).not.toContain('providers/claude/contextWindowBehavior');
        expect(source).not.toContain('claude.uiBehavior.v1');
        expect(source).not.toContain('claude.sessionHandoff.v1');
    });

    it('materializes descriptor-owned session handoff metadata cleanup without provider-id branching', () => {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            externalSessions: {
                sessionHandoff: {
                    clearMetadataKeys: [
                        'providerTranscriptPath',
                        'providerCheckpointId',
                    ],
                },
            },
        });

        expect(diagnostics).toEqual([]);
        expect(behavior.sessionHandoff?.buildProviderPatch?.({
            agentId: 'codex',
            metadata: {},
            targetRemoteSessionId: 'remote-session-1',
            targetDirectSource: { kind: 'codexHome', home: 'user' },
        })).toEqual({
            clearMetadataKeys: [
                'providerTranscriptPath',
                'providerCheckpointId',
            ],
        });
    });

    it('materializes Codex generated no-execute behavior facts without a host Codex adapter', () => {
        const generated = BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS.codex?.descriptor;
        expect(generated).toMatchObject({
            guidance: { includeInSessionGettingStartedCliExamples: true },
            externalSessions: {
                browse: {
                    order: 10,
                    sourceOptions: [
                        {
                            key: 'codex:user',
                            labelKey: 'externalSessions.browseSourceCodexUserHome',
                            source: { kind: 'codexHome', home: 'user' },
                        },
                    ],
                    connectedServiceProfileSources: [
                        {
                            serviceId: 'openai-codex',
                            keyPrefix: 'codex:connected-service',
                            detailSettingsKey: 'connectedServicesProfileLabelByKey',
                            source: { kind: 'codexHome', home: 'connectedService' },
                        },
                    ],
                    linkEnsureRequestExtras: {
                        runtimeDescriptorFromCandidate: {
                            providerId: 'codex',
                            legacyModeOutputKey: 'codexBackendMode',
                            backendMode: {
                                values: ['acp', 'appServer'],
                            },
                        },
                    },
                },
            },
            permissions: {
                footer: {
                    usePermissionUpdates: false,
                    forceReadOnlyAfterStop: false,
                    supportsExecPolicyAmendment: true,
                    stopHandling: 'denyOnly',
                },
            },
        });
        const externalSessions = readObjectField(generated, 'externalSessions');
        const browse = readObjectField(externalSessions, 'browse');
        const linkEnsureRequestExtras = readObjectField(browse, 'linkEnsureRequestExtras');
        const runtimeDescriptorFromCandidate = readObjectField(linkEnsureRequestExtras, 'runtimeDescriptorFromCandidate');
        const backendMode = readObjectField(runtimeDescriptorFromCandidate, 'backendMode');
        const workState = readObjectField(generated, 'workState');
        const editableGoals = readObjectField(workState, 'editableGoals');
        const payload = readObjectField(generated, 'payload');
        const sessionExtras = readObjectField(payload, 'sessionExtras');
        expect(runtimeDescriptorFromCandidate).not.toHaveProperty('providerSessionIdPaths');
        expect(backendMode).not.toHaveProperty('candidatePaths');
        expect(editableGoals).not.toHaveProperty('modeCandidates');
        expect(sessionExtras).not.toHaveProperty('settingsCandidates');
        expect(sessionExtras).not.toHaveProperty('metadataCandidates');
        expect(JSON.stringify(generated)).not.toContain('agentRuntimeDescriptorV1');
        expect(JSON.stringify(generated)).not.toContain('providerExtra');

        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor(generated, 'codex');

        expect(diagnostics).toEqual([]);
        expect(behavior.guidance?.includeInSessionGettingStartedCliExamples).toBe(true);
        expect(behavior.externalSessions?.browse?.order).toBe(10);
        expect(behavior.externalSessions?.browse?.getSourceOptions?.({
            agentId: 'codex',
            profile: {
                connectedServicesV2: [{
                    serviceId: 'openai-codex',
                    profiles: [
                        {
                            profileId: 'work',
                            status: 'connected',
                            kind: null,
                            providerEmail: null,
                            providerAccountId: null,
                            expiresAt: null,
                            lastUsedAt: null,
                            health: null,
                        },
                    ],
                    groups: [],
                }],
            },
            settings: makeSettings({
                connectedServicesProfileLabelByKey: {
                    'openai-codex/work': 'Work Profile',
                },
            }),
        })).toEqual([
            {
                key: 'codex:user',
                label: expect.any(String),
                source: { kind: 'codexHome', home: 'user' },
            },
            {
                key: 'codex:connected-service:openai-codex:work',
                label: expect.any(String),
                detail: 'Work Profile',
                source: {
                    kind: 'codexHome',
                    home: 'connectedService',
                    connectedServiceId: 'openai-codex',
                    connectedServiceProfileId: 'work',
                },
            },
        ]);
        expect(behavior.externalSessions?.browse?.buildLinkEnsureRequestExtras?.({
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            candidate: {
                details: {
                    codexBackendMode: 'appServer',
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        provider: {
                            backendMode: 'appServer',
                            providerSessionId: 'thread-1',
                        },
                    },
                    source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
                },
            },
        })).toEqual({
            codexBackendMode: 'appServer',
            source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: {
                    backendMode: 'appServer',
                    providerSessionId: 'thread-1',
                    home: 'user',
                    homePath: '/tmp/custom-home',
                    agentExtra: {
                        owner: 'codex',
                        schemaId: 'codex.agentRuntimeDescriptorExtra',
                        v: 1,
                        runtimeHandle: {
                            backendMode: 'appServer',
                            providerSessionId: 'thread-1',
                            home: 'user',
                            homePath: '/tmp/custom-home',
                        },
                    },
                },
            },
        });
        expect(behavior.permissions?.footer).toMatchObject({
            usePermissionUpdates: false,
            forceReadOnlyAfterStop: false,
            supportsExecPolicyAmendment: true,
            stopHandling: 'denyOnly',
        });
        expect(behavior.resume?.experimentSwitches?.[0]?.id).toBe('resumeAcp');
        expect(behavior.resume?.experimentSwitches?.[0]?.getValue?.(
            makeSettings({ codexBackendMode: 'acp' }),
        )).toBe(true);
        expect(behavior.resume?.experimentSwitches?.[0]?.getValue?.(
            makeSettings({ codexBackendMode: 'appServer' as any }),
        )).toBe(false);
        expect(behavior.newSession?.getRelevantInstallableDepKeys?.({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'acp' }),
            experiments: { enabled: true, switches: {} },
            resumeSessionId: '',
        })).toEqual(['codex-acp']);
        expect(behavior.newSession?.getRelevantInstallableDepKeys?.({
            agentId: 'codex',
            settings: makeSettings({ experimentalCodexAcp: true }),
            experiments: { enabled: true, switches: {} },
            resumeSessionId: '',
        })).toEqual(['codex-acp']);
        expect(behavior.newSession?.getRelevantInstallableDepKeys?.({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'appServer' as any }),
            experiments: { enabled: true, switches: {} },
            resumeSessionId: '',
        })).toEqual([]);
        expect(behavior.newSession?.getRelevantInstallableDepKeys?.({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'acp' }),
            experiments: { enabled: false, switches: {} },
            resumeSessionId: '',
        })).toEqual([]);
        // The retired `mcp` spelling normalizes to `appServer`, and the spawn
        // envelope carries it both as the legacy output key and as the canonical
        // config-option override the runtime reads.
        expect(behavior.payload?.buildSpawnSessionExtras?.({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'mcp' }),
            experiments: { enabled: true, switches: {} },
            resumeSessionId: '',
            updatedAt: 4242,
        })).toEqual({
            codexBackendMode: 'appServer',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 4242,
                overrides: {
                    codexBackendMode: { value: 'appServer', updatedAt: 4242 },
                },
            },
        });
        expect(behavior.payload?.buildResumeSessionExtras?.({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'acp' }),
            experiments: { enabled: true, switches: {} },
            session: {
                metadata: {
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        provider: {
                            backendMode: 'appServer',
                        },
                    },
                },
            } as any,
        })).toEqual({ codexBackendMode: 'appServer' });
        expect(behavior.workState?.supportsEditableGoals?.({
            agentId: 'codex',
            session: {
                active: false,
                metadata: {
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        provider: { backendMode: 'appServer' },
                    },
                },
            } as any,
        })).toBe(true);
        expect(behavior.workState?.supportsEditableGoals?.({
            agentId: 'codex',
            session: {
                active: false,
                metadata: {
                    sessionWorkStateV1: {
                        v: 1,
                        agentId: 'codex',
                        items: [{ kind: 'goal' }],
                    },
                },
            } as any,
        })).toBe(true);
    });

    it('intersects capability-driven goal semantics with active runner controls', () => {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            descriptorId: 'claude.uiBehavior.v1',
            workState: {
                editableGoals: {
                    capabilityDriven: true,
                    persistedGoalSnapshot: {
                        path: ['sessionWorkStateV1'],
                        itemKind: 'goal',
                        providerFields: ['agentId', 'backendId'],
                    },
                },
            },
        }, 'claude');

        expect(diagnostics).toEqual([]);

        // No goal item → not editable.
        expect(behavior.workState?.supportsEditableGoals?.({
            agentId: 'claude',
            session: { active: true, metadata: {} } as any,
        })).toBe(false);

        // Goal item WITHOUT canEdit capability → not editable (fail-closed).
        expect(behavior.workState?.supportsEditableGoals?.({
            agentId: 'claude',
            session: {
                active: true,
                metadata: { sessionWorkStateV1: { v: 1, agentId: 'claude', items: [{ kind: 'goal' }] } },
            } as any,
        })).toBe(false);

        // Persisted goal semantics are not enough to promise a live RPC on an active session.
        const withCapability = {
            metadata: { sessionWorkStateV1: { v: 1, agentId: 'claude', items: [{ kind: 'goal', goalCapabilities: { canEdit: true, canClear: true } }] } },
        };
        expect(behavior.workState?.supportsEditableGoals?.({ agentId: 'claude', session: { active: true, ...withCapability } as any })).toBe(false);
        expect(behavior.workState?.supportsEditableGoals?.({
            agentId: 'claude',
            session: {
                active: true,
                ...withCapability,
                agentState: { capabilities: { sessionGoalSetSupported: true } },
            } as any,
        })).toBe(true);
        // Detached sessions retain their existing inactive-control path.
        expect(behavior.workState?.supportsEditableGoals?.({ agentId: 'claude', session: { active: false, ...withCapability } as any })).toBe(true);

        // Wrong provider id → not editable.
        expect(behavior.workState?.supportsEditableGoals?.({ agentId: 'codex', session: { active: true, ...withCapability } as any })).toBe(false);
    });

    it('uses the attached runner control capability for a fresh active Claude session', () => {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            descriptorId: 'claude.uiBehavior.v1',
            workState: {
                editableGoals: {
                    capabilityDriven: true,
                    persistedGoalSnapshot: {
                        path: ['sessionWorkStateV1'],
                        itemKind: 'goal',
                        providerFields: ['agentId', 'backendId'],
                    },
                },
            },
        }, 'claude');
        expect(diagnostics).toEqual([]);

        // Provider command metadata is semantic support, not proof that the session RPC exists.
        expect(behavior.workState?.supportsEditableGoals?.({
            agentId: 'claude',
            session: { active: true, metadata: { slashCommands: ['help', 'compact', 'goal'] } } as any,
        })).toBe(false);

        // The live session-control registry is the execution-reachability owner and enables the
        // first-goal entry point before a goal item exists.
        expect(behavior.workState?.supportsEditableGoals?.({
            agentId: 'claude',
            session: {
                active: true,
                metadata: { slashCommands: ['help', '/goal'] },
                agentState: { capabilities: { sessionGoalSetSupported: true } },
            } as any,
        })).toBe(true);

        // ACTIVE session whose slash_commands LACK `goal` → not editable (fail-closed).
        expect(behavior.workState?.supportsEditableGoals?.({
            agentId: 'claude',
            session: { active: true, metadata: { slashCommands: ['help', 'compact'] } } as any,
        })).toBe(false);

        // INACTIVE session with the capability but no goal item → not editable (the `/goal` command is
        // injected live; inactive sessions seed through the goal-item path instead).
        expect(behavior.workState?.supportsEditableGoals?.({
            agentId: 'claude',
            session: { active: false, metadata: { slashCommands: ['help', 'goal'] } } as any,
        })).toBe(false);

        // INACTIVE (detached) session carrying a prior goal item with canEdit → still editable via the
        // goal-item fallback (resumable), even without slash_commands re-published.
        expect(behavior.workState?.supportsEditableGoals?.({
            agentId: 'claude',
            session: {
                active: false,
                metadata: { sessionWorkStateV1: { v: 1, agentId: 'claude', items: [{ kind: 'goal', goalCapabilities: { canEdit: true, canClear: true } }] } },
            } as any,
        })).toBe(true);
    });

    it('supplies a Claude goal-action capability profile (edit/clear only) when goal-editable (QA-CHIP-2)', () => {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            descriptorId: 'claude.uiBehavior.v1',
            workState: {
                editableGoals: {
                    capabilityDriven: true,
                    persistedGoalSnapshot: {
                        path: ['sessionWorkStateV1'],
                        itemKind: 'goal',
                        providerFields: ['agentId', 'backendId'],
                    },
                },
            },
        }, 'claude');
        expect(diagnostics).toEqual([]);

        // Active controls are projected independently so the UI never advertises clear merely
        // because set is reachable (or vice versa).
        expect(behavior.workState?.resolveGoalActionCapabilityProfile?.({
            agentId: 'claude',
            session: {
                active: true,
                metadata: { slashCommands: ['help', 'goal'] },
                agentState: {
                    capabilities: {
                        sessionGoalSetSupported: true,
                        sessionGoalClearSupported: false,
                    },
                },
            } as any,
        })).toEqual({ canEdit: true, canStop: false, canClear: false, canConfigureBudget: false });

        // NOT goal-editable (no live goal control, no goal item) → null (no profile; the gate keeps the
        // chip hidden, so the profile is irrelevant; null = full legacy surface for safety).
        expect(behavior.workState?.resolveGoalActionCapabilityProfile?.({
            agentId: 'claude',
            session: { active: true, metadata: { slashCommands: ['help'] } } as any,
        })).toBeNull();

        // Wrong provider id → null.
        expect(behavior.workState?.resolveGoalActionCapabilityProfile?.({
            agentId: 'codex',
            session: { active: true, metadata: { slashCommands: ['help', 'goal'] } } as any,
        })).toBeNull();
    });

    it('ignores foreign runtime descriptor details when building Codex external-session link extras', () => {
        const generated = BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS.codex?.descriptor;
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor(generated, 'codex');
        const buildExtras = behavior.externalSessions?.browse?.buildLinkEnsureRequestExtras;

        expect(diagnostics).toEqual([]);
        expect(buildExtras?.({
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            candidate: {
                details: {
                    source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        agentId: 'claude',
                        provider: {
                            backendMode: 'appServer',
                            providerSessionId: 'foreign-session',
                        },
                    },
                },
            },
        })).toEqual({
            source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
        });

        expect(buildExtras?.({
            agentId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            candidate: {
                details: {
                    codexBackendMode: 'appServer',
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'claude',
                        provider: {
                            backendMode: 'appServer',
                            providerSessionId: 'foreign-session',
                        },
                    },
                    source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
                },
            },
        })).toEqual({
            codexBackendMode: 'appServer',
            source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: {
                    backendMode: 'appServer',
                    home: 'user',
                    homePath: '/tmp/custom-home',
                    agentExtra: {
                        owner: 'codex',
                        schemaId: 'codex.agentRuntimeDescriptorExtra',
                        v: 1,
                        runtimeHandle: {
                            backendMode: 'appServer',
                            home: 'user',
                            homePath: '/tmp/custom-home',
                        },
                    },
                },
            },
        });
    });

    it('materializes OhMyPi generated browse behavior from descriptor data', () => {
        const generated = BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS.ohMyPi?.descriptor;
        expect(generated).toMatchObject({
            externalSessions: {
                browse: {
                    order: 25,
                    sourceOptions: [
                        {
                            key: 'ohMyPi:default-agent-dir',
                            labelKey: 'agentInput.agent.ohMyPi',
                            detail: '~/.omp/agent',
                            source: { kind: 'ohMyPiAgentDir' },
                        },
                    ],
                    linkEnsureRequestExtras: {
                        sourceFromCandidate: {
                            sourceKind: 'ohMyPiAgentDir',
                            optionalFields: ['agentDir'],
                        },
                    },
                },
            },
        });

        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor(generated);

        expect(diagnostics).toEqual([]);
        // ohMyPi contributes no MCP discovery source, so the derived scan offer is
        // absent: the settings screen must not offer a scan with nothing behind it.
        expect(generated).not.toHaveProperty('mcpServers');
        expect(behavior.externalSessions?.browse?.order).toBe(25);
        expect(behavior.externalSessions?.browse?.getSourceOptions?.({
            agentId: 'ohMyPi',
            profile: null,
            settings: makeSettings(),
        })).toEqual([
            {
                key: 'ohMyPi:default-agent-dir',
                label: expect.any(String),
                detail: '~/.omp/agent',
                source: { kind: 'ohMyPiAgentDir' },
            },
        ]);
        expect(behavior.externalSessions?.browse?.buildLinkEnsureRequestExtras?.({
            agentId: 'ohMyPi',
            source: { kind: 'ohMyPiAgentDir' },
            candidate: {
                details: {
                    source: { kind: 'ohMyPiAgentDir', agentDir: '/tmp/omp-agent' },
                },
            },
        })).toEqual({
            source: { kind: 'ohMyPiAgentDir', agentDir: '/tmp/omp-agent' },
        });
        expect(behavior.externalSessions?.browse?.buildLinkEnsureRequestExtras?.({
            agentId: 'ohMyPi',
            source: { kind: 'ohMyPiAgentDir', agentDir: '/tmp/other-agent' } as any,
            candidate: {
                details: {
                    source: { kind: 'ohMyPiAgentDir', agentDir: '/tmp/omp-agent' },
                },
            },
        })).toEqual({});
    });

    it('builds generic UI behavior from descriptor data', () => {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            kind: 'plugin.ui.v1',
            pluginId: 'acme',
            agentId: 'acme',
            version: 1,
            display: {},
            behavior: {
                guidance: { includeInSessionGettingStartedCliExamples: true },
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

    it('materializes declared backend transport fields for an Agent that names no host adapter', () => {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            payload: {
                backendTransport: {
                    runtimeDescriptorOutputKey: 'runtimeDescriptorV1',
                    legacyModeOutputKey: 'codexBackendMode',
                    backendMode: {
                        values: ['acp', 'appServer'],
                        aliases: { mcp: 'appServer', mcp_resume: 'acp' },
                        legacyExperimentalValue: 'acp',
                    },
                    runtimeHandleFields: ['backendMode', 'providerSessionId'],
                    agentExtra: {
                        owner: 'codex',
                        schemaId: 'codex.agentRuntimeDescriptorExtra',
                        v: 1,
                    },
                },
            },
        }, 'codex');

        expect(diagnostics).toEqual([]);
        expect(behavior.payload?.buildBackendTransportFields?.({
            agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            providerMode: 'appServer',
            providerSessionId: 'codex-session-1',
        } as any)).toEqual({
            codexBackendMode: 'appServer',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: {
                    backendMode: 'appServer',
                    providerSessionId: 'codex-session-1',
                    agentExtra: {
                        owner: 'codex',
                        schemaId: 'codex.agentRuntimeDescriptorExtra',
                        v: 1,
                        runtimeHandle: {
                            backendMode: 'appServer',
                            providerSessionId: 'codex-session-1',
                        },
                    },
                },
            },
        });

        // The retired setting spelling and the legacy experiment flag both still
        // resolve, and a mode nobody can resolve contributes nothing.
        expect(behavior.payload?.buildBackendTransportFields?.({
            agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            providerMode: 'mcp',
        } as any).codexBackendMode).toBe('appServer');
        expect(behavior.payload?.buildBackendTransportFields?.({
            agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            legacyExperimentalMode: true,
        } as any).codexBackendMode).toBe('acp');
        expect(behavior.payload?.buildBackendTransportFields?.({
            agentId: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        } as any)).toEqual({});
        // Another Agent's spawn never picks up this declaration.
        expect(behavior.payload?.buildBackendTransportFields?.({
            agentId: 'claude',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            providerMode: 'appServer',
        } as any)).toEqual({});
    });

    it('materializes session subagent slots through same-plugin public inline surfaces', () => {
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
                        surfaceId: 'subagent-launch',
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
                        surfaceId: 'subagent-details',
                        resourceKind: 'claudeSubagentLauncher',
                        iconName: 'users',
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
        const renderedLaunchSurfaces: unknown[] = [];
        expect(behavior.sessionSubagents?.renderLaunchCards?.({
            sessionId: 's1',
            scopeId: 'session:s1',
            session,
            subagents: [subagent],
            renderInlineSurface: (surface) => {
                renderedLaunchSurfaces.push(surface);
                return `rendered:${surface.slotId}`;
            },
        })).toEqual(['rendered:claude.subagentLaunchCards']);
        expect(renderedLaunchSurfaces).toEqual([expect.objectContaining({
            slotId: 'claude.subagentLaunchCards',
            pluginId: 'claude',
            surfaceId: 'subagent-launch',
            sessionId: 's1',
            agentId: 'claude',
            launchInput: { teamIds: ['team-1'] },
        })]);
        const detailsTab = behavior.sessionSubagents?.createTeammateLauncherDetailsTab?.({
            session,
            teamId: 'team-1',
        });
        expect(detailsTab).toMatchObject({
            key: 'claude-subagent-launcher:member:team-1',
            kind: 'claudeSubagentLauncher',
            resource: {
                kind: 'claudeSubagentLauncher',
                mode: 'member',
                initialTeamId: 'team-1',
            },
        });
        if (!detailsTab) throw new Error('Expected teammate launcher details tab.');
        expect(detailsTab.resource).toMatchObject({
            pluginInlineSurface: {
                pluginId: 'claude',
                agentId: 'claude',
                surfaceId: 'subagent-details',
                iconName: 'users',
            },
        });
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
        }, 'opencode');

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
            externalSessions: {
                browse: {
                    order: 30,
                    sourceOptions: [
                        {
                            key: 'opencode:default',
                            labelKey: 'externalSessions.browseSourceOpenCodeDefault',
                            detail: 'http://127.0.0.1:4096',
                            source: { kind: 'opencodeServer' },
                        },
                    ],
                    compatibleSource: {
                        sourceKind: 'opencodeServer',
                        optionalFields: ['baseUrl', 'directory'],
                    },
                    linkEnsureRequestExtras: {
                        sourceFromCandidate: {
                            sourceKind: 'opencodeServer',
                            optionalFields: ['baseUrl', 'directory'],
                        },
                    },
                },
            },
            payload: {
                environmentVariables: {
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
        }, 'opencode');

        expect(diagnostics).toEqual([]);
        expect(generated.diagnostics).toEqual([]);
        expect(generated.behavior.payload?.buildSpawnEnvironmentVariables).toBeTypeOf('function');
        expect(behavior.guidance?.includeInSessionGettingStartedCliExamples).toBe(true);
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
                detail: 'http://127.0.0.1:4096',
                source: { kind: 'opencodeServer' },
            },
        ]);
        expect(sourceOptions?.[0]?.label).not.toBe('');
        expect(behavior.externalSessions?.browse?.resolveCompatibleLinkSource?.({
            agentId: 'opencode' as any,
            selectedSource: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' } as any,
            candidateSource: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/', directory: '/repo' } as any,
        })).toEqual({ kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/', directory: '/repo' });
        expect(behavior.externalSessions?.browse?.buildLinkEnsureRequestExtras?.({
            agentId: 'opencode' as any,
            source: { kind: 'opencodeServer' } as any,
            candidate: {
                details: {
                    source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/', directory: '/repo' },
                },
            },
        })).toEqual({
            source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/', directory: '/repo' },
        });
        expect(behavior.externalSessions?.browse?.buildLinkEnsureRequestExtras?.({
            agentId: 'opencode' as any,
            source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:5000/' } as any,
            candidate: {
                details: {
                    source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
                },
            },
        })).toEqual({});
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
                        agentId: 'opencode',
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
            agentTargetKey: 'backend:claude',
            session: {
                metadata: {
                    flavor: 'claude',
                    sessionConfigOptionsV1: {
                        v: 1,
                        agentId: 'claude',
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
            currentRunnerProcessIdentity: null,
        })).toBe('provider_config_change_refused');
        expect(behavior.sessionComposer?.classifyNonSteerablePayload?.({
            agentId: 'claude',
            agentTargetKey: 'backend:claude',
            session: {
                metadata: { flavor: 'claude' },
            } as any,
            metaOverrides: { reasoningEffort: 'high' },
            currentRunnerProcessIdentity: null,
        })).toBe('provider_config_change_refused');
        expect(behavior.sessionComposer?.classifyNonSteerablePayload?.({
            agentId: 'claude',
            agentTargetKey: 'backend:claude',
            session: {
                active: true,
                modelMode: 'opus',
                modelModeUpdatedAt: 30,
                metadata: {
                    flavor: 'claude',
                    sessionModelsV1: {
                        v: 1,
                        agentId: 'claude',
                        updatedAt: 10,
                        currentModelId: 'sonnet',
                        activeSelectionV1: {
                            v: 1,
                            selection: {
                                agentTargetKey: 'backend:claude',
                                providerConnectionId: null,
                                modelId: 'sonnet',
                            },
                            source: 'runtime_readback',
                            runner: {
                                pid: 123,
                                processStartTimeMs: 1_000,
                            },
                        },
                        availableModels: [
                            { id: 'sonnet', name: 'Sonnet' },
                        ],
                    },
                },
            } as any,
            metaOverrides: {},
            currentRunnerProcessIdentity: {
                pid: 123,
                processStartTimeMs: 1_000,
            },
        })).toBe('provider_config_change_refused');
        expect(behavior.sessionComposer?.classifyNonSteerablePayload?.({
            agentId: 'claude',
            agentTargetKey: 'backend:claude',
            session: {
                active: true,
                modelMode: 'opus',
                modelModeUpdatedAt: 30,
                metadata: {
                    flavor: 'claude',
                    sessionModelsV1: {
                        v: 1,
                        agentId: 'claude',
                        updatedAt: 10,
                        currentModelId: 'sonnet',
                        availableModels: [],
                    },
                },
            } as any,
            metaOverrides: {},
            currentRunnerProcessIdentity: null,
        })).toBeNull();
        expect(behavior.sessionComposer?.classifyNonSteerablePayload?.({
            agentId: 'claude',
            agentTargetKey: 'backend:claude',
            session: {
                active: true,
                metadata: {
                    flavor: 'claude',
                    modelSelectionIntentV1: {
                        v: 1,
                        updatedAt: 20,
                        selection: {
                            agentTargetKey: 'backend:claude',
                            providerConnectionId: null,
                            modelId: 'opus',
                        },
                    },
                    sessionModelsV1: {
                        v: 1,
                        agentId: 'claude',
                        updatedAt: 10,
                        currentModelId: 'sonnet',
                        availableModels: [],
                    },
                },
            } as any,
            metaOverrides: {},
            currentRunnerProcessIdentity: null,
        })).toBe('provider_config_change_refused');
        const sharedPrivateLookalike = {
            flavor: 'claude',
            sessionConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 20,
                overrides: {
                    reasoning_effort: { updatedAt: 20, value: 'high' },
                },
            },
        };
        const layoutV1Session = {
            metadataLayoutVersion: 1,
            metadata: {
                v: 1,
                ...sharedPrivateLookalike,
            },
            ownerMetadataView: { flavor: 'claude' },
        };
        expect(behavior.sessionComposer?.classifyNonSteerablePayload?.({
            agentId: 'claude',
            agentTargetKey: 'backend:claude',
            session: layoutV1Session as any,
            metaOverrides: {},
            currentRunnerProcessIdentity: null,
        })).toBeNull();
        expect(behavior.sessionComposer?.classifyNonSteerablePayload?.({
            agentId: 'claude',
            agentTargetKey: 'backend:claude',
            session: {
                ...layoutV1Session,
                ownerMetadataView: sharedPrivateLookalike,
            } as any,
            metaOverrides: {},
            currentRunnerProcessIdentity: null,
        })).toBe('provider_config_change_refused');
    });
});
