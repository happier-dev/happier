import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

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
    resolveAgentUiBehavior,
} from './registryUiBehavior';
import { attachAgentPluginSettings } from './agentUiSettingLookup';
import { makeSettings as makeHostSettings } from './registryUiBehavior.testHelpers';

function makeSettings(account: Readonly<Record<string, unknown>> = {}) {
    return attachAgentPluginSettings(makeHostSettings(), { account });
}

const makeAccountScopedAgentSettings = makeSettings;

describe('buildSpawnSessionExtrasFromUiState', () => {
    it('projects OpenCode settings into strict configuration without a raw spawn environment', () => {
        const settings = makeSettings({
            opencodeBackendMode: 'acp',
            opencodeServerBaseUrlByServerIdV1: { 'server-2': 'https://opencode.example.test/path' },
        });
        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'opencode', settings, environmentVariables: undefined,
            newSessionOptions: { targetServerId: 'server-2' },
        })).toBeUndefined();
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'opencode', settings, resumeSessionId: '', updatedAt: 123,
            newSessionOptions: { targetServerId: 'server-2' },
        })).toEqual({ sessionConfigOptionOverrides: {
            v: 1, updatedAt: 123, overrides: {
                opencodeBackendMode: { value: 'acp', updatedAt: 123 },
                opencodeServerBaseUrl: { value: 'https://opencode.example.test/', updatedAt: 123 },
            },
        } });
    });
    it('projects the normalized Codex backend mode into strict V2 configuration', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeAccountScopedAgentSettings({ codexBackendMode: 'acp' }),
            resumeSessionId: '',
            updatedAt: 123,
        })).toEqual({
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 123,
                overrides: {
                    codexBackendMode: { value: 'acp', updatedAt: 123 },
                },
            },
        });
    });

    it('does not emit legacy experimentalCodexAcp when codexBackendMode is present', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeAccountScopedAgentSettings({ codexBackendMode: 'acp' }),
            resumeSessionId: '',
        })).not.toHaveProperty('experimentalCodexAcp');
    });

    it('maps retired codex mcp setting onto app-server', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeAccountScopedAgentSettings({ codexBackendMode: 'mcp' }),
            resumeSessionId: 'x1',
            updatedAt: 456,
        })).toEqual({
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 456,
                overrides: {
                    codexBackendMode: { value: 'appServer', updatedAt: 456 },
                },
            },
        });
    });

    it('does not enable codex ACP when backend mode is appServer', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeAccountScopedAgentSettings({ codexBackendMode: 'appServer' }),
            resumeSessionId: 'x1',
            updatedAt: 789,
        })).toEqual({
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 789,
                overrides: {
                    codexBackendMode: { value: 'appServer', updatedAt: 789 },
                },
            },
        });
    });

    it('returns an empty object for non-codex agents', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'claude',
            settings: makeAccountScopedAgentSettings({ codexBackendMode: 'acp' }),
            resumeSessionId: 'x1',
        })).toEqual({});
    });
});

describe('provider behavior runtime diagnostics', () => {
    it('does not expose generic Agent runtime-descriptor synthesis', () => {
        expect(resolveAgentUiBehavior('codex').payload).not.toHaveProperty('buildBackendTransportFields');
    });
});

beforeEach(() => {
    getActiveServerSnapshotState().activeServerSnapshot = { serverId: 'server-1', serverUrl: 'http://localhost:3000', generation: 1 };
});

describe('buildResumeSessionExtrasFromUiState', () => {
    it('does not reconstruct Codex runtime descriptors from settings or persisted metadata', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeAccountScopedAgentSettings({ codexBackendMode: 'acp' }),
            session: {
                metadata: {
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        agent: { backendMode: 'appServer', opaqueResumeToken: 'keep-agent-owned' },
                    },
                },
            } as any,
        })).toEqual({});
    });

    it('does not emit legacy experimentalCodexAcp for codex resume extras', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeAccountScopedAgentSettings({ codexBackendMode: 'acp' }),
        })).not.toHaveProperty('experimentalCodexAcp');
    });

    it('returns an empty object for non-codex agents', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'claude',
            settings: makeAccountScopedAgentSettings({ codexBackendMode: 'acp' }),
        })).toEqual({});
    });

    it('uses OpenCode settings without interpreting Session runtime descriptors when resuming', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'opencode',
            settings: makeAccountScopedAgentSettings({
                opencodeBackendMode: 'acp',
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
                HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
                HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4999/',
                HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
            },
        });
    });

    it('ignores non-explicit OpenCode Session affinity when resuming', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'opencode',
            settings: makeAccountScopedAgentSettings({
                opencodeBackendMode: 'acp',
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
                HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
                HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4999/',
                HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
            },
        });
    });

    it('ignores canonical and legacy OpenCode runtime metadata in generic UI resume projection', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'opencode',
            settings: makeSettings({}),
            session: {
                metadata: {
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'opencode',
                        agent: {
                            backendMode: 'acp',
                            serverBaseUrl: 'http://127.0.0.1:4096/',
                            serverBaseUrlExplicit: true,
                        },
                    },
                    opencodeBackendMode: 'server',
                    opencodeServerBaseUrl: 'http://127.0.0.1:4999/',
                    opencodeServerBaseUrlExplicit: true,
                },
            } as any,
        })).toEqual({
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'server',
            },
        });
    });

    it('also ignores legacy OpenCode metadata when the descriptor names another Agent', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'opencode',
            settings: makeSettings({}),
            session: {
                metadata: {
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        agent: { backendMode: 'acp' },
                    },
                    opencodeBackendMode: 'server',
                    opencodeServerBaseUrl: 'http://127.0.0.1:4999/',
                    opencodeServerBaseUrlExplicit: true,
                },
            } as any,
        })).toEqual({
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'server',
            },
        });
    });

});

describe('buildWakeResumeExtras', () => {
    it('does not reconstruct Codex runtime descriptors for wake payloads', () => {
        expect(buildWakeResumeExtras({
            agentId: 'claude',
            resumeCapabilityOptions: { accountSettings: makeAccountScopedAgentSettings({ codexBackendMode: 'acp' }) },
            session: null,
        })).toEqual({});
        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: { accountSettings: makeSettings({ codexBackendMode: 'acp' }) },
            session: {
                metadata: {
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        agent: {
                            backendMode: 'appServer',
                            opaqueResumeToken: 'keep-agent-owned',
                        },
                    },
                },
            } as any,
        })).toEqual({});
    });

    it('uses OpenCode settings without interpreting Session runtime metadata for wake resume', () => {
        expect(buildWakeResumeExtras({
            agentId: 'opencode',
            resumeCapabilityOptions: {
                accountSettings: makeAccountScopedAgentSettings({
                    opencodeBackendMode: 'acp',
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
                HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
                HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4999/',
                HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
            },
        });
    });

    it('does not fall back to the active server scoped URL for OpenCode resume/wake when no target server is specified', () => {
        getActiveServerSnapshotState().activeServerSnapshot = { serverId: 'server-active', serverUrl: 'http://localhost:9999', generation: 1 };

        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'opencode',
            settings: makeAccountScopedAgentSettings({
                opencodeBackendMode: 'server',
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
                accountSettings: makeAccountScopedAgentSettings({
                    opencodeBackendMode: 'server',
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

    it('ignores OpenCode descriptor and legacy metadata when projecting wake environment', () => {
        expect(buildWakeResumeExtras({
            agentId: 'opencode',
            resumeCapabilityOptions: {
                accountSettings: makeAccountScopedAgentSettings({
                    opencodeBackendMode: 'acp',
                }),
            },
            session: {
                metadata: {
                    agentRuntimeDescriptorV1: {
                        v: 1,
                        agentId: 'opencode',
                        provider: {
                            backendMode: 'server',
                            providerSessionId: 'oc1',
                            serverBaseUrl: 'http://127.0.0.1:4096/',
                            serverBaseUrlExplicit: true,
                        },
                    },
                    opencodeBackendMode: 'acp',
                },
            } as any,
        })).toEqual({
            environmentVariables: {
                HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
            },
        });
    });

});

describe('buildSpawnEnvironmentVariablesFromUiState', () => {
    it('preserves caller environment without adding OpenCode settings', () => {
        getActiveServerSnapshotState().activeServerSnapshot = { serverId: 'server-2', serverUrl: 'http://localhost:4000', generation: 2 };

        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'opencode',
            settings: makeAccountScopedAgentSettings({
                opencodeBackendMode: 'acp',
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
        });

        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'opencode',
            settings: makeAccountScopedAgentSettings({ opencodeBackendMode: 'server' }),
            environmentVariables: undefined,
            newSessionOptions: null,
        })).toBeUndefined();
    });

    it('uses the selected new-session target server for OpenCode configuration', () => {
        getActiveServerSnapshotState().activeServerSnapshot = { serverId: 'server-1', serverUrl: 'http://localhost:3000', generation: 1 };

        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'opencode',
            settings: makeAccountScopedAgentSettings({
                opencodeBackendMode: 'server',
                opencodeServerBaseUrlByServerIdV1: {
                    'server-1': 'http://127.0.0.1:4096/',
                    'server-2': ' http://127.0.0.1:4097/ ',
                },
            }),
            resumeSessionId: '',
            updatedAt: 123,
            newSessionOptions: {
                targetServerId: 'server-2',
            },
        })).toEqual({ sessionConfigOptionOverrides: {
            v: 1, updatedAt: 123, overrides: {
                opencodeBackendMode: { value: 'server', updatedAt: 123 },
                opencodeServerBaseUrl: { value: 'http://127.0.0.1:4097/', updatedAt: 123 },
            },
        } });
    });

    it('ignores invalid OpenCode server url overrides', () => {
        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'opencode',
            settings: makeAccountScopedAgentSettings({
                opencodeBackendMode: 'server',
                opencodeServerBaseUrl: 'not-a-url',
            }),
            environmentVariables: { FOO: '1' },
            newSessionOptions: null,
        })).toEqual({
            FOO: '1',
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
        });
    });

    it('returns the input env for non-OpenCode agents', () => {
        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'claude',
            settings: makeAccountScopedAgentSettings({ opencodeBackendMode: 'acp' }),
            environmentVariables: { FOO: '1' },
            newSessionOptions: null,
        })).toEqual({ FOO: '1' });
    });
});
