import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getActiveServerSnapshotState } = vi.hoisted(() => {
    const state = {
        activeServerSnapshot: { serverId: 'server-1', serverUrl: 'http://localhost:3000', generation: 1 },
    };
    return {
        getActiveServerSnapshotState: () => state,
    };
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => getActiveServerSnapshotState().activeServerSnapshot,
}));

import {
    buildResumeSessionExtrasFromUiState,
    buildSpawnEnvironmentVariablesFromUiState,
    buildSpawnSessionExtrasFromUiState,
    buildWakeResumeExtras,
} from './registryUiBehavior';
import { makeSettings } from './registryUiBehavior.testHelpers';

describe('buildSpawnSessionExtrasFromUiState', () => {
    it('enables codex ACP only when backend mode is acp', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'acp' }),
            resumeSessionId: '',
        })).toEqual({
            codexBackendMode: 'acp',
        });
    });

    it('does not emit legacy experimentalCodexAcp when codexBackendMode is present', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'acp' }),
            resumeSessionId: '',
        })).not.toHaveProperty('experimentalCodexAcp');
    });

    it('disables codex ACP when backend mode is mcp', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'mcp' }),
            resumeSessionId: 'x1',
        })).toEqual({
            codexBackendMode: 'mcp',
        });
    });

    it('does not enable codex ACP when backend mode is appServer', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'appServer' as any }),
            resumeSessionId: 'x1',
        })).toEqual({
            codexBackendMode: 'appServer',
        });
    });

    it('returns an empty object for non-codex agents', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'claude',
            settings: makeSettings({ codexBackendMode: 'acp' }),
            resumeSessionId: 'x1',
        })).toEqual({});
    });
});

beforeEach(() => {
    getActiveServerSnapshotState().activeServerSnapshot = { serverId: 'server-1', serverUrl: 'http://localhost:3000', generation: 1 };
});

describe('buildResumeSessionExtrasFromUiState', () => {
    it('passes codex mode through to resume extras', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'acp' }),
        })).toEqual({
            codexBackendMode: 'acp',
        });

        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'mcp' }),
        })).toEqual({
            codexBackendMode: 'mcp',
        });

        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'appServer' as any }),
        })).toEqual({
            codexBackendMode: 'appServer',
        });
    });

    it('prefers persisted codex backend metadata over account settings when resuming codex sessions', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'acp' }),
            session: {
                metadata: {
                    codexBackendMode: 'appServer',
                },
            } as any,
        })).toEqual({
            codexBackendMode: 'appServer',
        });
    });

    it('does not emit legacy experimentalCodexAcp for codex resume extras', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'acp' }),
        })).not.toHaveProperty('experimentalCodexAcp');
    });

    it('returns an empty object for non-codex agents', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'claude',
            settings: makeSettings({ codexBackendMode: 'acp' }),
        })).toEqual({});
    });

    it('inherits OpenCode backend mode and server url from session metadata when resuming', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'opencode',
            settings: makeSettings({
                opencodeBackendMode: 'acp' as any,
                opencodeServerBaseUrl: 'http://127.0.0.1:4999/',
            }),
            session: {
                metadata: {
                    opencodeBackendMode: 'server',
                    opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
                    opencodeServerBaseUrlExplicit: true,
                },
            } as any,
        })).toEqual({
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'server',
                HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
                HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
            },
        });
    });

    it('does not inherit non-explicit OpenCode server affinity from session metadata when resuming', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'opencode',
            settings: makeSettings({
                opencodeBackendMode: 'acp' as any,
                opencodeServerBaseUrl: 'http://127.0.0.1:4999/',
            }),
            session: {
                metadata: {
                    opencodeBackendMode: 'server',
                    opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
                },
            } as any,
        })).toEqual({
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'server',
                HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4999/',
                HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
            },
        });
    });

    it('does not add legacy configured ACP extras when resuming custom ACP sessions', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'customAcp',
            settings: makeSettings(),
            session: {
                metadata: {
                    acpConfiguredBackendV1: {
                        v: 1,
                        updatedAt: 123,
                        backendId: 'custom-backend',
                        title: 'Custom Kiro',
                    },
                },
            } as any,
        })).toEqual({});
    });
});

describe('buildWakeResumeExtras', () => {
    it('passes codex backend mode through for codex wake payloads only', () => {
        expect(buildWakeResumeExtras({
            agentId: 'claude',
            resumeCapabilityOptions: { accountSettings: makeSettings({ codexBackendMode: 'acp' }) },
            session: null,
        })).toEqual({});
        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: { accountSettings: makeSettings({ codexBackendMode: 'acp' }) },
            session: null,
        })).toEqual({ codexBackendMode: 'acp' });
        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: { accountSettings: makeSettings({ codexBackendMode: 'mcp' }) },
            session: null,
        })).toEqual({ codexBackendMode: 'mcp' });
        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: { accountSettings: makeSettings({ codexBackendMode: 'appServer' as any }) },
            session: null,
        })).toEqual({ codexBackendMode: 'appServer' });
    });

    it('prefers persisted codex backend metadata over account settings for wake resume', () => {
        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: { accountSettings: makeSettings({ codexBackendMode: 'acp' }) },
            session: {
                metadata: {
                    codexBackendMode: 'appServer',
                },
            } as any,
        })).toEqual({ codexBackendMode: 'appServer' });

        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: { accountSettings: makeSettings({ codexBackendMode: 'acp' }) },
            session: {
                metadata: {
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
            } as any,
        })).toEqual({ codexBackendMode: 'appServer' });

        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: { accountSettings: makeSettings({ codexBackendMode: 'appServer' as any }) },
            session: {
                metadata: {
                    codexBackendMode: 'acp',
                },
            } as any,
        })).toEqual({ codexBackendMode: 'acp' });

        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: { accountSettings: makeSettings({ codexBackendMode: 'acp' }) },
            session: {
                metadata: {
                    directSessionV1: {
                        codexBackendMode: 'appServer',
                    },
                },
            } as any,
        })).toEqual({ codexBackendMode: 'appServer' });
    });

    it('does not emit legacy experimentalCodexAcp for codex wake extras', () => {
        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: { accountSettings: makeSettings({ codexBackendMode: 'acp' }) },
            session: null,
        })).not.toHaveProperty('experimentalCodexAcp');
    });

    it('adds OpenCode backend mode and server url from session metadata for wake resume', () => {
        expect(buildWakeResumeExtras({
            agentId: 'opencode',
            resumeCapabilityOptions: {
                accountSettings: makeSettings({
                    opencodeBackendMode: 'acp' as any,
                    opencodeServerBaseUrl: 'http://127.0.0.1:4999/',
                }),
            },
            session: {
                metadata: {
                    opencodeBackendMode: 'server',
                    opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
                    opencodeServerBaseUrlExplicit: true,
                },
            } as any,
        })).toEqual({
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'server',
                HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
                HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
            },
        });
    });

    it('does not fall back to the active server scoped URL for OpenCode resume/wake when no target server is specified', () => {
        getActiveServerSnapshotState().activeServerSnapshot = { serverId: 'server-active', serverUrl: 'http://localhost:9999', generation: 1 };

        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'opencode',
            settings: makeSettings({
                opencodeBackendMode: 'server' as any,
                opencodeServerBaseUrlByServerIdV1: {
                    'server-active': 'http://127.0.0.1:4096/',
                },
            } as any),
            session: null,
        })).toEqual({
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'server',
            },
        });

        expect(buildWakeResumeExtras({
            agentId: 'opencode',
            resumeCapabilityOptions: {
                accountSettings: makeSettings({
                    opencodeBackendMode: 'server' as any,
                    opencodeServerBaseUrlByServerIdV1: {
                        'server-active': 'http://127.0.0.1:4096/',
                    },
                } as any),
            },
            session: null,
        })).toEqual({
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'server',
            },
        });
    });

    it('prefers OpenCode agentRuntimeDescriptorV1 over legacy metadata for wake resume', () => {
        expect(buildWakeResumeExtras({
            agentId: 'opencode',
            resumeCapabilityOptions: {
                accountSettings: makeSettings({
                    opencodeBackendMode: 'acp' as any,
                }),
            },
            session: {
                metadata: {
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        providerId: 'opencode',
                        provider: {
                            backendMode: 'server',
                            vendorSessionId: 'oc1',
                            serverBaseUrl: 'http://127.0.0.1:4096/',
                            serverBaseUrlExplicit: true,
                        },
                    },
                    opencodeBackendMode: 'acp',
                },
            } as any,
        })).toEqual({
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'server',
                HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
                HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
            },
        });
    });

    it('does not add legacy configured ACP extras for custom ACP wake resumes', () => {
        expect(buildWakeResumeExtras({
            agentId: 'customAcp',
            resumeCapabilityOptions: { accountSettings: makeSettings() },
            session: {
                metadata: {
                    acpConfiguredBackendV1: {
                        v: 1,
                        updatedAt: 123,
                        backendId: 'custom-backend',
                        title: 'Custom Kiro',
                    },
                },
            } as any,
        })).toEqual({});
    });
});

describe('buildSpawnEnvironmentVariablesFromUiState', () => {
    it('injects OpenCode backend mode env var while preserving existing env', () => {
        getActiveServerSnapshotState().activeServerSnapshot = { serverId: 'server-2', serverUrl: 'http://localhost:4000', generation: 2 };

        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'opencode',
            settings: makeSettings({
                opencodeBackendMode: 'acp' as any,
                opencodeServerBaseUrl: ' http://127.0.0.1:4999/ ',
                opencodeServerBaseUrlByServerIdV1: {
                    'server-1': 'http://127.0.0.1:4096/',
                    'server-2': ' http://127.0.0.1:4097/ ',
                },
            }),
            environmentVariables: { FOO: '1' },
            newSessionOptions: null,
        })).toEqual({
            FOO: '1',
            HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
            HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4097/',
            HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
        });

        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'opencode',
            settings: makeSettings({ opencodeBackendMode: 'server' as any }),
            environmentVariables: undefined,
            newSessionOptions: null,
        })).toEqual({
            HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        });
    });

    it('uses the selected new-session target server for OpenCode server-scoped env', () => {
        getActiveServerSnapshotState().activeServerSnapshot = { serverId: 'server-1', serverUrl: 'http://localhost:3000', generation: 1 };

        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'opencode',
            settings: makeSettings({
                opencodeBackendMode: 'server' as any,
                opencodeServerBaseUrlByServerIdV1: {
                    'server-1': 'http://127.0.0.1:4096/',
                    'server-2': ' http://127.0.0.1:4097/ ',
                },
            }),
            environmentVariables: { FOO: '1' },
            newSessionOptions: {
                targetServerId: 'server-2',
            },
        })).toEqual({
            FOO: '1',
            HAPPIER_OPENCODE_BACKEND_MODE: 'server',
            HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4097/',
            HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
        });
    });

    it('ignores invalid OpenCode server url overrides', () => {
        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'opencode',
            settings: makeSettings({
                opencodeBackendMode: 'server' as any,
                opencodeServerBaseUrl: 'not-a-url',
            }),
            environmentVariables: { FOO: '1' },
            newSessionOptions: null,
        })).toEqual({
            FOO: '1',
            HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        });
    });

    it('fails closed when only a legacy account-scoped OpenCode server url is present', () => {
        getActiveServerSnapshotState().activeServerSnapshot = { serverId: 'server-2', serverUrl: 'http://localhost:4000', generation: 2 };

        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'opencode',
            settings: makeSettings({
                opencodeBackendMode: 'server' as any,
                opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
            }),
            environmentVariables: { FOO: '1' },
            newSessionOptions: null,
        })).toEqual({
            FOO: '1',
            HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        });
    });

    it('returns the input env for non-OpenCode agents', () => {
        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'claude',
            settings: makeSettings({ opencodeBackendMode: 'acp' as any }),
            environmentVariables: { FOO: '1' },
            newSessionOptions: null,
        })).toEqual({ FOO: '1' });
    });
});
