import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPendingQueueWakeResumeOptions } from './pendingQueueWake';

let storageState: any = {
    sessions: {},
    machines: {},
    getProjectForSession: () => null,
};

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => storageState,
    },
}));

afterEach(() => {
    storageState = {
        sessions: {},
        machines: {},
        getProjectForSession: () => null,
    };
    vi.restoreAllMocks();
});

describe('getPendingQueueWakeResumeOptions', () => {
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
            agentState: null,
            presence: 'online',
            metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude' },
        };
        expect(getPendingQueueWakeResumeOptions({ sessionId: 's1', session, resumeCapabilityOptions: { accountSettings: {} } })).toBeNull();
    });

    it('returns null when permission is required', () => {
        const session: any = {
            thinking: false,
            agentState: { requests: { r1: { id: 'r1' } } },
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
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        });
    });
});
