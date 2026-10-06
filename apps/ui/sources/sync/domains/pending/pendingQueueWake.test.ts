import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPendingQueueWakeResumeOptions } from './pendingQueueWake';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { attachAgentPluginSettings } from '@/agents/registry/agentUiSettingLookup';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { getStorage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
} from '@/agents/registry/agentUiBehaviorProjection';

const storage = getStorage();
const initialStorageState = storage.getState();

function setCanonicalSessionTarget(machineId: string, path: string): void {
    storage.setState({
        sessions: {
            s1: createSessionFixture({
                id: 's1',
                active: false,
                updatedAt: 10,
                metadata: { machineId, path, homeDir: '/Users/test', host: 'host.local' },
            }),
        },
        machines: {
            [machineId]: createMachineFixture({
                id: machineId,
                active: true,
                activeAt: 20,
                metadata: { ...createMachineFixture().metadata!, host: 'host.local' },
            }),
        },
    });
}

function agentTarget(agentId: string, pluginId = `happier.agent.${agentId}`) {
    return {
        kind: 'agent' as const,
        identity: { pluginId, localId: agentId },
    };
}

beforeEach(() => {
    storage.setState(initialStorageState, true);
    setCanonicalSessionTarget('m1', '/tmp');
});

afterEach(() => {
    storage.setState(initialStorageState, true);
    vi.restoreAllMocks();
});

describe('getPendingQueueWakeResumeOptions', () => {
    it('returns resume options for a resumable idle session', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        expect(readMachineControlTargetForSession('s1')).toEqual({
            machineId: 'm1',
            basePath: '/tmp',
            confidence: 'reachable',
        });
        const res = getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(res).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('claude'),
            resume: 'c1',
        });
    });

    it('uses the current session seq as the pending wake transcript cursor', () => {
        const session: any = {
            seq: 41,
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('claude'),
            resume: 'c1',
            initialTranscriptAfterSeq: 41,
        });
    });

    it('preserves zero as a valid pending wake transcript cursor', () => {
        const session: any = {
            seq: 0,
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('claude'),
            resume: 'c1',
            initialTranscriptAfterSeq: 0,
        });
    });

    it('does not wake an active session while a fresh local outbound message is already pending', () => {
        const session: any = {
            active: true,
            presence: 'online',
            thinking: false,
            thinkingAt: 1,
            optimisticThinkingAt: Date.now(),
            pendingCount: 1,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toBeNull();
    });

    it('does not use raw metadata as a wake target when canonical reachability is unavailable', () => {
        storage.setState({
            sessions: {},
            machines: {},
        });
        const session: any = {
            thinking: false,
            agentState: null,
            presence: 'offline',
            metadata: { machineId: 'm-stale', path: '/tmp/stale', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toBeNull();
    });

    it('prefers a resolved wake target override over stale session metadata', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            presence: 'offline',
            metadata: { machineId: 'm-stale', path: '/tmp/stale', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
            resumeTargetOverride: {
                machineId: 'm-target',
                directory: '/tmp/target',
            },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm-target',
            directory: '/tmp/target',
            agentTarget: agentTarget('claude'),
            resume: 'c1',
        });
    });

    it('uses the canonical reachable wake target when no explicit override is provided', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            presence: 'offline',
            metadata: { machineId: 'm-stale', path: '/tmp/stale', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        storage.setState({
            sessions: {
                s1: createSessionFixture({
                    id: 's1',
                    active: false,
                    updatedAt: 10,
                    metadata: {
                        machineId: 'm-target',
                        path: '/tmp/target',
                        homeDir: '/Users/test',
                        host: 'target.local',
                    },
                }),
            },
            machines: {
                'm-stale': createMachineFixture({
                    id: 'm-stale',
                    active: false,
                    activeAt: 5,
                    metadata: { ...createMachineFixture().metadata!, host: 'stale.local' },
                    replacedByMachineId: 'm-target',
                    replacedAt: 15,
                }),
                'm-target': createMachineFixture({
                    id: 'm-target',
                    active: true,
                    activeAt: 20,
                    metadata: { ...createMachineFixture().metadata!, host: 'target.local' },
                }),
            },
        });

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm-target',
            directory: '/tmp/target',
            agentTarget: agentTarget('claude'),
            resume: 'c1',
        });
    });

    it('returns null when agent is thinking', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const session: any = {
            active: true,
            thinking: true,
            thinkingAt: 999_000,
            agentState: null,
            presence: 'online',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude' },
        };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: {} } })).toBeNull();
    });

    it('returns resume options when a stale thinking flag is not fresh runtime work', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const session: any = {
            active: true,
            presence: 'online',
            thinking: true,
            thinkingAt: 1_000,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('claude'),
            resume: 'c1',
        });
    });

    it('does not wake the queued successor while the canonical turn projection is in progress', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const session: any = {
            active: true,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_000,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toBeNull();
    });

    it('does not block wake for display-only provider runtime activity after foreground completion', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const session: any = {
            active: true,
            presence: 'online',
            thinking: false,
            thinkingAt: 0,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 995_000,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 999_000,
            runtimeActivityRevision: 1_060_000,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('claude'),
            resume: 'c1',
        });
    });

    it('does not block wake for inactive sessions with stale active-turn projection', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const session: any = {
            active: false,
            presence: 'online',
            thinking: true,
            thinkingAt: 999_000,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 999_000,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('claude'),
            resume: 'c1',
        });
    });

    it('returns null when permission is required', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const session: any = {
            active: true,
            thinking: false,
            agentState: {
                requests: {
                    r1: {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: { command: 'pwd' },
                        createdAt: 999_000,
                    },
                },
            },
            presence: 'online',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude' },
        };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: {} } })).toBeNull();
    });

    it('returns null when the caller cannot wake the target machine', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            presence: 'offline',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
            canWakeMachineId: () => false,
        } as any)).toBeNull();
    });

    it('does not block wake for offline sessions with stale thinking state', () => {
        const session: any = {
            thinking: true,
            agentState: null,
            presence: 'offline',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: {} } })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('claude'),
            resume: 'c1',
        });
    });

    it('does not block wake for offline sessions with stale permission requests', () => {
        const session: any = {
            thinking: false,
            agentState: { requests: { r1: { id: 'r1' } } },
            presence: 'offline',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };

        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: {} } })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('claude'),
            resume: 'c1',
        });
    });

    it('returns null when metadata is missing', () => {
        const session: any = { thinking: false, agentState: null, metadata: null };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: {} } })).toBeNull();
    });

    it('returns null when flavor is unsupported', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'unknown' },
        };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: {} } })).toBeNull();
    });

    it('infers the agent from runtimeDescriptorV1 when legacy flavor is missing', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: {
                machineId: 'm1',
                path: '/tmp',
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    provider: {
                        backendMode: 'appServer',
                        providerSessionId: 'x1',
                    },
                },
                codexSessionId: 'x1',
            },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('codex'),
            resume: 'x1',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: {
                    backendMode: 'appServer',
                    providerSessionId: 'x1',
                },
            },
        });
    });

    it('continues codex sessions through the canonical runtime when a legacy account mode is set', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'codex', codexSessionId: 'x1' },
        };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'mcp' } } })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('codex'),
            resume: 'x1',
        });
    });

    it('returns codex options when codex resume is enabled', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'codex', codexSessionId: 'x1' },
        };
        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('codex'),
            resume: 'x1',
        });
    });

    it('canonicalizes codex flavor aliases when building wake options', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'openai', codexSessionId: 'x1' },
        };
        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('codex'),
            resume: 'x1',
        });
    });

    it('prefers runtimeDescriptorV1 over legacy codex metadata when building wake options', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: {
                machineId: 'm1',
                path: '/tmp',
                flavor: 'codex',
                codexSessionId: 'x1',
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    provider: {
                        backendMode: 'appServer',
                        providerSessionId: 'x1',
                    },
                },
                codexBackendMode: 'acp',
            },
        };
        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('codex'),
            resume: 'x1',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: {
                    backendMode: 'appServer',
                    providerSessionId: 'x1',
                },
            },
        });
    });

    it('returns gemini options when metadata contains a gemini resume id', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'gemini', geminiSessionId: 'g1' },
        };
        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('gemini'),
            resume: 'g1',
        });
    });

    it('passes through permission mode override when provided', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' },
        };
        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
            permissionOverride: { permissionMode: 'plan', permissionModeUpdatedAt: 123 },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('claude'),
            resume: 'c1',
            permissionMode: 'plan',
            permissionModeUpdatedAt: 123,
        });
    });

    it('adds Account-configured OpenCode environment variables for wake resumes', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: {
                machineId: 'm1',
                path: '/tmp',
                flavor: 'opencode',
                opencodeSessionId: 'oc-1',
            },
        };
        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: {
                accountSettings: attachAgentPluginSettings(settingsDefaults, {
                    account: {
                        opencodeBackendMode: 'server',
                        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
                    },
                }),
            },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            agentTarget: agentTarget('opencode'),
            resume: 'oc-1',
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'server',
                HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
                HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
            },
        });
    });

    it('uses configured ACP backend backend targets for configured ACP wake resumes', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: {
                machineId: 'm1',
                path: '/tmp',
                flavor: 'acp:custom-kiro',
                acpConfiguredBackendV1: {
                    v: 1,
                    updatedAt: 123,
                    backendId: 'custom-kiro',
                    title: 'Custom Kiro',
                },
            },
        };
        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: {
                // Configured ACP resume requires the Account's own declaration
                // that this exact backend supports `session/load`.
                accountSettings: {
                    acpCatalogSettingsV1: {
                        v: 2,
                        backends: [{
                            id: 'custom-kiro',
                            name: 'custom-kiro',
                            title: 'Custom Kiro',
                            command: 'custom-acp',
                            args: [],
                            env: {},
                            capabilities: { supportsLoadSession: true },
                            createdAt: 1,
                            updatedAt: 2,
                        }],
                    },
                },
            },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        });
    });
    it('carries an externally installed Agent\'s projected wake resume extras', () => {
        const externalAgentId = 'acme.lifecycle/acme-lifecycle';
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: 'm1',
            descriptorsByAgentId: {
                [externalAgentId]: {
                    kind: 'plugin.ui.v1',
                    pluginId: 'acme.lifecycle',
                    agentId: externalAgentId,
                    version: 1,
                    behavior: {
                        payload: {
                            environmentVariables: {
                                providerId: externalAgentId,
                                backendMode: {
                                    envKey: 'ACME_BACKEND_MODE',
                                    settingKey: { scope: 'account', localId: 'acmeBackendMode' },
                                    legacyMetadataKey: 'acmeBackendModeV1',
                                    runtimeDescriptorField: 'backendMode',
                                    defaultValue: 'server',
                                    values: ['server', 'local'],
                                },
                            },
                        },
                    },
                },
            },
        });
        try {
            const session: any = {
                thinking: false,
                agentState: null,
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: externalAgentId,
                        agent: { providerSessionId: 'acme-session-1' },
                    },
                    nativeResumeIdentityV1: { v: 1, vendorResumeId: 'acme-session-1' },
                    externalSessionV1: {
                        v: 1,
                        agentId: externalAgentId,
                        machineId: 'm1',
                        remoteSessionId: 'acme-session-1',
                        source: { kind: 'pluginTranscript' },
                        linkedAtMs: 1,
                        qualifiedIdentity: {
                            v: 1,
                            agent: { pluginId: 'acme.lifecycle', localId: 'acme-lifecycle' },
                            source: { kind: 'pluginTranscript', contractVersion: 1 },
                        },
                    },
                },
            };

            const res = getPendingQueueWakeResumeOptions({
                sessionId: 's1',
                session,
                resumeCapabilityOptions: {
                    accountSettings: {},
                    currentAgentCapabilities: {
                        agentId: externalAgentId,
                        identity: { pluginId: 'acme.lifecycle', localId: 'acme-lifecycle' },
                        generation: 42,
                        capabilities: {
                            sessions: {
                                open: ['create', 'resume', 'fork'],
                                delivery: ['newTurn'],
                                cancel: true,
                            },
                        },
                    },
                } as any,
            });

            expect(res?.agentTarget).toEqual(agentTarget('acme-lifecycle', 'acme.lifecycle'));
            expect(res?.environmentVariables).toEqual({ ACME_BACKEND_MODE: 'server' });
        } finally {
            clearProjectedAgentUiBehaviorDescriptors();
        }
    });
});
