import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPendingQueueWakeResumeOptions } from './pendingQueueWake';

let storageState: any = {
    sessions: {},
    machines: {},
    getProjectForSession: () => null,
};

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => storageState,
    },
});
});

function setCanonicalSessionTarget(machineId: string, path: string): void {
    storageState = {
        sessions: {
            s1: {
                active: false,
                updatedAt: 10,
                metadata: { machineId, path, homeDir: '/Users/test', host: 'host.local' },
            },
        },
        machines: {
            [machineId]: {
                id: machineId,
                active: true,
                activeAt: 20,
                metadata: { host: 'host.local' },
            },
        },
        getProjectForSession: (sessionId: string) =>
            sessionId === 's1'
                ? {
                    key: {
                        machineId,
                        path,
                    },
                }
                : null,
    };
}

beforeEach(() => {
    setCanonicalSessionTarget('m1', '/tmp');
});

afterEach(() => {
    storageState = {
        sessions: {},
        machines: {},
        getProjectForSession: () => null,
    };
    vi.restoreAllMocks();
});

describe('getPendingQueueWakeResumeOptions', () => {
    const now = 1_000_000;

    it('returns resume options for a resumable idle session', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
        };

        const res = getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        });

        expect(res).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resume: 'c1',
        });
    });

    it('includes the current transcript seq as an explicit wake cursor', () => {
        const session: any = {
            seq: 9388,
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual(expect.objectContaining({
            initialTranscriptAfterSeq: 9388,
        }));
    });

    it('does not use raw metadata as a wake target when canonical reachability is unavailable', () => {
        storageState = {
            sessions: {},
            machines: {},
            getProjectForSession: () => null,
        };
        const session: any = {
            thinking: false,
            agentState: null,
            presence: 'offline',
            metadata: { machineId: 'm-stale', path: '/tmp/stale', flavor: 'claude', claudeSessionId: 'c1' },
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
            metadata: { machineId: 'm-stale', path: '/tmp/stale', flavor: 'claude', claudeSessionId: 'c1' },
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
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resume: 'c1',
        });
    });

    it('uses the canonical reachable wake target when no explicit override is provided', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            presence: 'offline',
            metadata: { machineId: 'm-stale', path: '/tmp/stale', flavor: 'claude', claudeSessionId: 'c1' },
        };

        storageState = {
            sessions: {
                s1: {
                    active: false,
                    updatedAt: 10,
                    metadata: {
                        machineId: 'm-stale',
                        path: '/tmp/stale',
                        homeDir: '/Users/test',
                        host: 'stale.local',
                    },
                },
            },
            machines: {
                'm-stale': {
                    id: 'm-stale',
                    active: false,
                    activeAt: 5,
                    metadata: { host: 'stale.local' },
                    replacedByMachineId: 'm-target',
                    replacedAt: 15,
                },
                'm-target': {
                    id: 'm-target',
                    active: true,
                    activeAt: 20,
                    metadata: { host: 'target.local' },
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'm-target',
                            path: '/tmp/target',
                        },
                    }
                    : null,
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm-target',
            directory: '/tmp/target',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resume: 'c1',
        });
    });

    it('returns null when agent is thinking', () => {
        const session: any = {
            thinking: true,
            thinkingAt: now,
            active: true,
            agentState: null,
            presence: 'online',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude' },
        };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: {} }, nowMs: now })).toBeNull();
    });

    it('returns null when permission is required', () => {
        const session: any = {
            thinking: false,
            thinkingAt: 0,
            active: true,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now,
            agentState: { requests: { r1: { id: 'r1' } } },
            presence: 'online',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude' },
        };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: {} }, nowMs: now })).toBeNull();
    });

    it('does not block wake for online sessions with stale thinking and stale requests', () => {
        const session: any = {
            thinking: true,
            thinkingAt: now - 120_000,
            active: true,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 1_000,
            agentState: { requests: { r1: { id: 'r1' } } },
            presence: 'online',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
        };

        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: {} }, nowMs: now })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resume: 'c1',
        });
    });

    it('does not let detached runtime activity block a foreground-ready wake', () => {
        const session: any = {
            thinking: false,
            thinkingAt: 0,
            active: true,
            activeAt: now - 10_000,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now - 5_000,
            runtimeActivityState: 'active',
            runtimeActivityRevision: 1,
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: now - 1_000,
            agentState: null,
            presence: 'online',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
            nowMs: now,
        })).toEqual(expect.objectContaining({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
        }));
    });

    it('does not wake an active session while exclusive local control blocks remote writes', () => {
        const session: any = {
            thinking: false,
            active: true,
            presence: 'online',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: now,
            agentState: { controlledByUser: true },
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
            nowMs: now,
        })).toBeNull();
    });

    it('does not block wake for inactive sessions with stale active-turn projection', () => {
        const session: any = {
            active: false,
            presence: 'online',
            thinking: true,
            thinkingAt: now,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: now,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
        };

        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
            nowMs: now,
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resume: 'c1',
        });
    });

    it('returns null when the caller cannot wake the target machine', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            presence: 'offline',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
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
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
        };

        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: {} } })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resume: 'c1',
        });
    });

    it('does not block wake for offline sessions with stale permission requests', () => {
        const session: any = {
            thinking: false,
            agentState: { requests: { r1: { id: 'r1' } } },
            presence: 'offline',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
        };

        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: {} } })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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

    it('infers the agent from agentRuntimeDescriptorV1 when legacy flavor is missing', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: {
                machineId: 'm1',
                path: '/tmp',
                agentRuntimeDescriptorV1: {
                    v: 1,
                    providerId: 'codex',
                    provider: {
                        backendMode: 'appServer',
                        vendorSessionId: 'x1',
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
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'x1',
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    vendorSessionId: 'x1',
                },
            },
            codexBackendMode: 'appServer',
        });
    });

    it('returns null when codex vendor resume is disabled', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'codex', codexSessionId: 'x1' },
        };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'mcp' } } })).toBeNull();
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
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'x1',
            codexBackendMode: 'acp',
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
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'x1',
            codexBackendMode: 'acp',
        });
    });

    it('prefers agentRuntimeDescriptorV1 over legacy codex metadata when building wake options', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: {
                machineId: 'm1',
                path: '/tmp',
                flavor: 'codex',
                codexSessionId: 'x1',
                agentRuntimeDescriptorV1: {
                    v: 1,
                    providerId: 'codex',
                    provider: {
                        backendMode: 'appServer',
                        vendorSessionId: 'x1',
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
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'x1',
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    vendorSessionId: 'x1',
                },
            },
            codexBackendMode: 'appServer',
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
            backendTarget: { kind: 'builtInAgent', agentId: 'gemini' },
            resume: 'g1',
        });
    });

    it('passes through permission mode override when provided', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1' },
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
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            resume: 'c1',
            permissionMode: 'plan',
            permissionModeUpdatedAt: 123,
        });
    });

    it('adds OpenCode environment variables for wake resumes', () => {
        const session: any = {
            thinking: false,
            agentState: null,
            metadata: {
                machineId: 'm1',
                path: '/tmp',
                flavor: 'opencode',
                opencodeSessionId: 'oc-1',
                opencodeBackendMode: 'server',
                opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
                opencodeServerBaseUrlExplicit: true,
            },
        };
        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
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
                customAcpSessionId: 'custom-kiro-session-1',
            },
        };
        expect(getPendingQueueWakeResumeOptions({
            sessionId: 's1',
            session,
            resumeCapabilityOptions: {
                accountSettings: {
                    acpCatalogSettingsV1: {
                        v: 2,
                        backends: [{
                            id: 'custom-kiro',
                            name: 'custom-kiro',
                            title: 'Custom Kiro',
                            command: 'kiro-cli',
                            args: [],
                            env: {},
                            transportProfile: 'generic',
                            capabilities: {
                                supportsLoadSession: true,
                                supportsModes: 'unknown',
                                supportsModels: 'unknown',
                                supportsConfigOptions: 'unknown',
                                promptImageSupport: 'unknown',
                            },
                            createdAt: 1,
                            updatedAt: 1,
                        }],
                    },
                },
            },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
            resume: 'custom-kiro-session-1',
        });
    });
});
