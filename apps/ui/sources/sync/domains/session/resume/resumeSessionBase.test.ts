import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as catalog from '@/agents/catalog/catalog';
import { buildResumeSessionBaseOptionsFromSession } from './resumeSessionBase';

let storageState: any = {
    sessions: {},
    machines: {},
    getProjectForSession: () => null,
};

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: { getState: () => storageState },
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    storageState = {
        sessions: {},
        machines: {},
        getProjectForSession: () => null,
    };
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
                        rootPath: path,
                    },
                }
                : null,
    };
}

beforeEach(() => {
    setCanonicalSessionTarget('m1', '/tmp');
});

describe('buildResumeSessionBaseOptionsFromSession', () => {
    const connectedServices = {
        v: 1,
        bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId: 'codex-work' },
        },
    } as const;

    it('returns null when session metadata is missing', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: null } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toBeNull();
    });

    it('returns null when vendor resume is not allowed', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm1', path: '/tmp', flavor: 'openai', codexSessionId: 'x1' } } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'mcp' } }, // codex not enabled
        })).toBeNull();
    });

    it('builds fresh-spawn continuation options WITHOUT a vendor resume id for a pre-start death (QA A-F5)', () => {
        // A session that died before the provider recorded a vendor resume id has no provider
        // context to restore: it must remain continuable by a fresh spawn, not a dead-end.
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude' } } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        });
    });

    it('does not build fresh-spawn options for a replay fork after the replay seed was consumed without a vendor resume id', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'claude',
                    forkV1: {
                        v: 1,
                        parentSessionId: 'parent-session',
                        parentCutoffSeqInclusive: 7,
                        createdAtMs: 1000,
                        strategy: 'replay',
                        providerHint: { providerId: 'claude' },
                    },
                    replaySeedV1: {
                        v: 1,
                        seedText: '',
                        sourceSessionId: 'parent-session',
                        sourceCutoffSeqInclusive: 7,
                        createdAtMs: 1000,
                        appliedToLocalId: 'local-1',
                        appliedAtMs: 2000,
                    },
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toBeNull();
    });

    it('returns base options when vendor resume is allowed and present', () => {
        setCanonicalSessionTarget('m1', '/tmp');
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm1', path: '/tmp', flavor: 'openai', codexSessionId: 'x1', connectedServices, connectedServicesUpdatedAt: 2468 } } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'x1',
            connectedServices,
            connectedServicesUpdatedAt: 2468,
        });
    });

    it('includes persisted connected services and freshness when resuming a configured ACP backend', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'acp:custom-claude',
                    acpConfiguredBackendV1: { backendId: 'custom-claude' },
                    connectedServices,
                    connectedServicesUpdatedAt: 1357,
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-claude' },
            connectedServices,
            connectedServicesUpdatedAt: 1357,
        });
    });

    it('does not use raw metadata as a live resume target when canonical reachability is unavailable', () => {
        storageState = {
            sessions: {},
            machines: {},
            getProjectForSession: () => null,
        };
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm-stale', path: '/tmp/stale', flavor: 'openai', codexSessionId: 'x1' } } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' } },
        })).toBeNull();
    });

    it('prefers a resolved resume target override over stale session metadata', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm-stale', path: '/tmp/stale', flavor: 'openai', codexSessionId: 'x1' } } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' } },
            resumeTargetOverride: {
                machineId: 'm-target',
                directory: '/tmp/target',
            },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm-target',
            directory: '/tmp/target',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'x1',
        });
    });

    it('uses the canonical reachable target when no explicit override is provided', () => {
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
                            rootPath: '/tmp/target',
                        },
                    }
                    : null,
        };

        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm-stale', path: '/tmp/stale', flavor: 'openai', codexSessionId: 'x1' } } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm-target',
            directory: '/tmp/target',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'x1',
        });
    });

    it('prefers the persisted Codex runtime descriptor over account settings when resuming', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'openai',
                    codexSessionId: 'x1',
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        agent: {
                            backendMode: 'appServer',
                            providerSessionId: 'x1',
                        },
                    },
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'mcp' } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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

    it('carries canonical runtimeDescriptorV1 through resume base options and ignores the legacy alias when both are present', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'openai',
                    codexSessionId: 'x1',
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        provider: {
                            backendMode: 'appServer',
                            providerSessionId: 'x1',
                        },
                    },
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        provider: {
                            backendMode: 'acp',
                            providerSessionId: 'legacy-x1',
                        },
                    },
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'mcp' } },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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

    it('builds an external Agent resume from its current declaration and generic runtime descriptor', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'acme-lifecycle',
                        provider: { providerSessionId: 'acme-session-1' },
                    },
                },
            } as any,
            resumeCapabilityOptions: {
                currentAgentCapabilities: {
                    agentId: 'acme-lifecycle',
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
            },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'backend', backendId: 'acme-lifecycle' },
            resume: 'acme-session-1',
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'acme-lifecycle',
                agent: { providerSessionId: 'acme-session-1' },
            },
        });
    });

    it('passes through permission mode overrides', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: { metadata: { machineId: 'm1', path: '/tmp', flavor: 'claude', claudeSessionId: 'c1', claudeTranscriptPath: '/tmp/c1.jsonl' } } as any,
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

    it('resolves configured ACP sessions to configured backend targets', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'acp:custom-kiro',
                    acpConfiguredBackendV1: {
                        v: 1,
                        updatedAt: 123,
                        backendId: 'custom-backend',
                        title: 'Custom Kiro',
                    },
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-backend' },
        });
    });

    it('infers configured ACP backend id from the flavor when metadata backend id is missing', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'acp:custom-kiro',
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        });
    });

    it('infers configured ACP backend id from the flavor when metadata backend id is blank', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'acp:custom-kiro',
                    acpConfiguredBackendV1: {
                        v: 1,
                        updatedAt: 123,
                        backendId: '   ',
                        title: 'Custom Kiro',
                    },
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        });
    });

    it('resumes configured ACP sessions even when built-in agent resolution is unavailable', () => {
        const actualResolveAgentIdFromFlavor = catalog.resolveAgentIdFromFlavor;
        vi.spyOn(catalog, 'resolveAgentIdFromFlavor').mockImplementation(flavor =>
            flavor === 'acp:custom-kiro' ? null : actualResolveAgentIdFromFlavor(flavor),
        );

        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'acp:custom-kiro',
                    acpConfiguredBackendV1: {
                        v: 1,
                        updatedAt: 123,
                        backendId: 'custom-backend',
                        title: 'Custom Kiro',
                    },
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toEqual({
            sessionId: 's1',
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-backend' },
        });
    });

    it('fails closed for ACP flavors when the preset id cannot be derived', () => {
        expect(buildResumeSessionBaseOptionsFromSession({
            sessionId: 's1',
            session: {
                metadata: {
                    machineId: 'm1',
                    path: '/tmp',
                    flavor: 'acp:',
                },
            } as any,
            resumeCapabilityOptions: { accountSettings: {} },
        })).toBeNull();
    });
});
