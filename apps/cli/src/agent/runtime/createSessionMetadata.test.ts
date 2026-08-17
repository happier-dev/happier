import { describe, expect, it } from 'vitest';

import { createSessionMetadata } from './createSessionMetadata';
import { HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY } from './sessionConnectedServicesBindingsEnv';

const HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY =
    'HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON';

describe('createSessionMetadata', () => {
    it('does not seed legacy messageQueueV1 metadata', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-1',
            startedBy: 'terminal',
        });

        expect((metadata as any).messageQueueV1).toBeUndefined();
    });

    it('seeds acpSessionModeOverrideV1 when agentModeId is provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'opencode',
            machineId: 'machine-1',
            startedBy: 'terminal',
            agentModeId: 'plan',
            agentModeUpdatedAt: 123,
        } as any);

        expect((metadata as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 123, modeId: 'plan' });
        expect((metadata as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 123, modeId: 'plan' });
    });

    it('seeds modelOverrideV1 when modelId is provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'terminal',
            modelId: 'gpt-5-codex-high',
            modelUpdatedAt: 123,
        } as any);

        expect((metadata as any).modelOverrideV1).toEqual({ v: 1, updatedAt: 123, modelId: 'gpt-5-codex-high' });
    });

    it('preserves exact nonblank opaque mode and model identifiers', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'cursor',
            machineId: 'machine-1',
            startedBy: 'daemon',
            agentModeId: ' plan ',
            agentModeUpdatedAt: 122,
            modelId: ' model-a ',
            modelUpdatedAt: 123,
        } as any);

        expect((metadata as any).sessionModeOverrideV1.modeId).toBe(' plan ');
        expect((metadata as any).modelOverrideV1.modelId).toBe(' model-a ');
    });

    it('seeds sessionConfigOptionOverridesV1 from the daemon-provided environment override', () => {
        const previous = process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON;
        process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = JSON.stringify({
            v: 1,
            updatedAt: 123,
            overrides: {
                speed: { updatedAt: 123, value: 'fast' },
            },
        });

        try {
            const { metadata } = createSessionMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            } as any);

            expect((metadata as any).sessionConfigOptionOverridesV1).toEqual({
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            });
            expect((metadata as any).acpConfigOptionOverridesV1).toEqual({
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            });
            expect(process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON).toBeUndefined();
        } finally {
            if (previous === undefined) {
                delete process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON;
            } else {
                process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = previous;
            }
        }
    });

    it('ignores non-string config option values when seeding daemon-provided overrides', () => {
        const previous = process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON;
        process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = JSON.stringify({
            v: 1,
            updatedAt: 123,
            overrides: {
                speed: { updatedAt: 123, value: 'fast' },
                telemetry: { updatedAt: 124, value: true },
            },
        });

        try {
            const { metadata } = createSessionMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            } as any);

            expect((metadata as any).sessionConfigOptionOverridesV1).toEqual({
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            });
            expect((metadata as any).acpConfigOptionOverridesV1).toEqual({
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            });
        } finally {
            if (previous === undefined) {
                delete process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON;
            } else {
                process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = previous;
            }
        }
    });

    it('seeds sessionLogPath for developer log discovery', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-1',
            startedBy: 'terminal',
        } as any);

        expect(typeof (metadata as any).sessionLogPath).toBe('string');
        expect((metadata as any).sessionLogPath).toContain('/logs/');
        expect((metadata as any).sessionLogPath).toContain('.log');
    });

    it('seeds mcpSelectionV1 from the daemon-provided environment override', () => {
        const previous = process.env.HAPPIER_SESSION_MCP_SELECTION_JSON;
        process.env.HAPPIER_SESSION_MCP_SELECTION_JSON = JSON.stringify({
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['server-a'],
            forceExcludeServerIds: ['server-b'],
        });

        try {
            const { metadata } = createSessionMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            } as any);

            expect((metadata as any).mcpSelectionV1).toEqual({
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['server-a'],
                forceExcludeServerIds: ['server-b'],
            });
            expect(process.env.HAPPIER_SESSION_MCP_SELECTION_JSON).toBeUndefined();
        } finally {
            if (previous === undefined) {
                delete process.env.HAPPIER_SESSION_MCP_SELECTION_JSON;
            } else {
                process.env.HAPPIER_SESSION_MCP_SELECTION_JSON = previous;
            }
        }
    });

    it('seeds connected service bindings from the daemon-provided environment override', () => {
        const previous = process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY];
        process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY] = JSON.stringify({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'happier',
                },
            },
        });

        try {
            const { metadata } = createSessionMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            });

            expect((metadata as Record<string, unknown>).connectedServices).toEqual({
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'happier',
                    },
                },
            });
            expect(process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY]).toBeUndefined();
        } finally {
            if (previous === undefined) {
                delete process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY];
            } else {
                process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY] = previous;
            }
        }
    });

    it('ignores invalid connected service bindings from the daemon-provided environment override', () => {
        const previous = process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY];
        process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY] = JSON.stringify({
            v: 1,
            bindingsByServiceId: {
                'not-a-service': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'happier',
                },
            },
        });

        try {
            const { metadata } = createSessionMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            });

            expect((metadata as Record<string, unknown>).connectedServices).toBeUndefined();
            expect(process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY]).toBeUndefined();
        } finally {
            if (previous === undefined) {
                delete process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY];
            } else {
                process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY] = previous;
            }
        }
    });

    it('seeds connected service materialization identity from the daemon-provided environment override', () => {
        const previous = process.env[HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY];
        process.env[HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY] = JSON.stringify({
            v: 1,
            id: 'csm_metadata_1',
            createdAtMs: 123,
        });

        try {
            const { metadata } = createSessionMetadata({
                flavor: 'opencode',
                machineId: 'machine-1',
                startedBy: 'daemon',
            });

            expect((metadata as Record<string, unknown>).connectedServiceMaterializationIdentityV1).toEqual({
                v: 1,
                id: 'csm_metadata_1',
                createdAtMs: 123,
            });
            expect(process.env[HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]).toBeUndefined();
        } finally {
            if (previous === undefined) {
                delete process.env[HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY];
            } else {
                process.env[HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY] = previous;
            }
        }
    });

    it('publishes the broker selection identity needed to authorize terminal-started connected sessions', () => {
        const envKey = 'HAPPIER_SESSION_CONNECTED_SERVICE_BROKER_SELECTION_IDENTITY';
        const previous = process.env[envKey];
        process.env[envKey] = 'opencode|connected|broker:1|openai-codex:work:acct-1|group:team';

        try {
            const { metadata } = createSessionMetadata({
                flavor: 'opencode',
                machineId: 'machine-1',
                startedBy: 'terminal',
            });

            expect((metadata as Record<string, unknown>).connectedServiceBrokerSelectionIdentityV1).toBe(
                'opencode|connected|broker:1|openai-codex:work:acct-1|group:team',
            );
            expect(process.env[envKey]).toBeUndefined();
        } finally {
            if (previous === undefined) {
                delete process.env[envKey];
            } else {
                process.env[envKey] = previous;
            }
        }
    });

    it('seeds acpTransportV1 when acpProviderId is provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'opencode',
            machineId: 'machine-1',
            startedBy: 'terminal',
            acpProviderId: 'opencode',
        } as any);

        expect((metadata as any).acpTransportV1).toEqual({
            v: 1,
            provider: 'opencode',
        });
    });

    it('preserves arbitrary configured ACP flavor ids', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'acp:custom-kiro',
            machineId: 'machine-1',
            startedBy: 'terminal',
        } as any);

        expect(metadata.flavor).toBe('acp:custom-kiro');
    });

    it('uses the explicit directory for the session path when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'terminal',
            directory: '/tmp/happier-explicit-directory',
        } as any);

        expect(metadata.path).toBe('/tmp/happier-explicit-directory');
    });

    it('prefers the daemon-seeded requested directory over a canonicalized cwd', () => {
        const previousRequestedDirectory = process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY;
        const previousPwd = process.env.PWD;
        process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY = '/tmp/happier-requested-directory';
        process.env.PWD = '/private/tmp/happier-requested-directory';

        try {
            const { metadata } = createSessionMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            } as any);

            expect(metadata.path).toBe('/tmp/happier-requested-directory');
            expect(process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY).toBeUndefined();
        } finally {
            if (previousRequestedDirectory === undefined) {
                delete process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY;
            } else {
                process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY = previousRequestedDirectory;
            }

            if (previousPwd === undefined) {
                delete process.env.PWD;
            } else {
                process.env.PWD = previousPwd;
            }
        }
    });

    it('publishes the agent and machine workspace roots as one machine-bound mapping', () => {
        const previousRequestedDirectory = process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY;
        const previousMachineDirectory = process.env.HAPPIER_SESSION_MACHINE_WORKSPACE_PATH;
        process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY = '/home/coder/project';
        process.env.HAPPIER_SESSION_MACHINE_WORKSPACE_PATH = '/Users/alice/project';

        try {
            const { metadata } = createSessionMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            });

            expect(metadata.path).toBe('/home/coder/project');
            expect(metadata.sessionWorkspaceLocationV1).toEqual({
                v: 1,
                machineId: 'machine-1',
                agentPath: '/home/coder/project',
                machinePath: '/Users/alice/project',
            });
            expect(process.env.HAPPIER_SESSION_MACHINE_WORKSPACE_PATH).toBeUndefined();
        } finally {
            if (previousRequestedDirectory === undefined) {
                delete process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY;
            } else {
                process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY = previousRequestedDirectory;
            }
            if (previousMachineDirectory === undefined) {
                delete process.env.HAPPIER_SESSION_MACHINE_WORKSPACE_PATH;
            } else {
                process.env.HAPPIER_SESSION_MACHINE_WORKSPACE_PATH = previousMachineDirectory;
            }
        }
    });
});
