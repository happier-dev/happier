import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveExecutionSurfaces } = vi.hoisted(() => ({
    resolveExecutionSurfaces: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
    getSessionHostBridge: () => ({
        resolveExecutionSurfaces,
    }),
}));

describe('importSessionHandoffAgentBundle', () => {
    beforeEach(() => {
        resolveExecutionSurfaces.mockReset();
    });

    afterEach(() => {
        vi.resetModules();
    });

    it('resolves provider import through the generic backend execution surface for supported bundles', async () => {
        const importBundle = vi.fn(async () => ({
            ok: true,
            value: {
                providerSessionId: 'codex_1',
                source: {
                    kind: 'codexHome',
                    home: 'user',
                    homePath: '/tmp/codex',
                },
                launch: {
                    directory: '/repo',
                    environmentVariables: { CODEX_HOME: '/tmp/codex' },
                    resumePlanOptions: {
                        codexBackendMode: 'appServer',
                    },
                    sessionStateUpdates: [
                        {
                            fieldId: 'identity.runtimeDescriptor',
                            value: {
                                v: 1,
                                agentId: 'codex',
                                agent: {
                                    backendMode: 'appServer',
                                    providerSessionId: 'codex_1',
                                },
                            },
                        },
                    ],
                },
            },
        }));
        resolveExecutionSurfaces.mockResolvedValueOnce({
            terminalRuntime: null,
            externalSession: null,
            attach: null,
            handoff: {
                exportBundle: vi.fn(),
                importBundle,
            },
            fork: null,
            checkpoint: null,
        });
        const { importSessionHandoffAgentBundle } = await import('./import');

        await expect(importSessionHandoffAgentBundle({
            bundle: {
                agentId: 'codex',
                remoteSessionId: 'codex_1',
                files: [],
            },
            targetPath: '/repo',
            sessionStorageMode: 'persisted',
        })).resolves.toEqual({
            remoteSessionId: 'codex_1',
            directSource: {
                kind: 'codexHome',
                home: 'user',
                homePath: '/tmp/codex',
            },
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: {
                    backendMode: 'appServer',
                    providerSessionId: 'codex_1',
                },
            },
            resume: {
                directory: '/repo',
                agent: 'codex',
                resume: 'codex_1',
                codexBackendMode: 'appServer',
                environmentVariables: { CODEX_HOME: '/tmp/codex' },
                transcriptStorage: 'persisted',
                approvedNewDirectoryCreation: true,
            },
        });

        expect(resolveExecutionSurfaces).toHaveBeenCalledWith('codex');
        expect(importBundle).toHaveBeenCalledWith({
            bundle: {
                agentId: 'codex',
                remoteSessionId: 'codex_1',
                files: [],
            },
            targetDirectory: '/repo',
        });
    });

    it('uses provider-owned resume options from the handoff import surface without host provider branches', async () => {
        const importBundle = vi.fn(async () => ({
            ok: true,
            value: {
                providerSessionId: 'future-session-1',
                source: {
                    kind: 'opencodeServer',
                    baseUrl: 'https://provider.example.test/',
                    directory: '/repo',
                },
                launch: {
                    directory: '/repo',
                    resumePlanOptions: {
                        providerRuntimeSelection: {
                            mode: 'cloud',
                        },
                    },
                },
            },
        }));
        resolveExecutionSurfaces.mockResolvedValueOnce({
            terminalRuntime: null,
            externalSession: null,
            attach: null,
            handoff: {
                exportBundle: vi.fn(),
                importBundle,
            },
            fork: null,
            checkpoint: null,
        });
        const { importSessionHandoffAgentBundle } = await import('./import');

        await expect(importSessionHandoffAgentBundle({
            bundle: {
                agentId: 'acme.sample.backend',
                remoteSessionId: 'future-session-1',
                providerPayloadV1: { opaque: true },
            } as unknown as Parameters<typeof importSessionHandoffAgentBundle>[0]['bundle'],
            targetPath: '/repo',
            sessionStorageMode: 'direct',
        })).resolves.toMatchObject({
            remoteSessionId: 'future-session-1',
            resume: {
                directory: '/repo',
                agent: 'acme.sample.backend',
                resume: 'future-session-1',
                transcriptStorage: 'direct',
                approvedNewDirectoryCreation: true,
                providerRuntimeSelection: {
                    mode: 'cloud',
                },
            },
        });

        expect(resolveExecutionSurfaces).toHaveBeenCalledWith('acme.sample.backend');
        expect(importBundle).toHaveBeenCalledWith({
            bundle: {
                agentId: 'acme.sample.backend',
                remoteSessionId: 'future-session-1',
                providerPayloadV1: { opaque: true },
            },
            targetDirectory: '/repo',
        });
    });

    it('fails closed when handoff import returns owner-private Session state', async () => {
        const importBundle = vi.fn(async () => ({
            ok: true as const,
            value: {
                providerSessionId: 'private-session-1',
                source: {
                    kind: 'codexHome',
                    home: 'user',
                },
                launch: {
                    sessionStateUpdates: [{
                        fieldId: 'runtime.externalSessionOperation',
                        value: 'private-operation',
                    }],
                },
            },
        }));
        resolveExecutionSurfaces.mockResolvedValueOnce({
            terminalRuntime: null,
            externalSession: null,
            attach: null,
            handoff: {
                exportBundle: vi.fn(),
                importBundle,
            },
            fork: null,
            checkpoint: null,
        });
        const { importSessionHandoffAgentBundle } = await import('./import');

        await expect(importSessionHandoffAgentBundle({
            bundle: {
                agentId: 'codex',
                remoteSessionId: 'private-session-1',
                files: [],
            },
            targetPath: '/repo',
        })).rejects.toThrow(/unsupported field.*runtime\.externalSessionOperation/i);
        expect(importBundle).toHaveBeenCalledOnce();
    });

    it.each([
        'target_identity_conflict',
        'agent_version_unsupported',
    ] as const)('preserves the bounded typed leaf failure %s', async (code) => {
        resolveExecutionSurfaces.mockResolvedValueOnce({
            terminalRuntime: null,
            externalSession: null,
            attach: null,
            handoff: {
                exportBundle: vi.fn(),
                importBundle: vi.fn(async () => ({
                    ok: false as const,
                    code,
                    message: 'safe handoff failure',
                })),
            },
            fork: null,
            checkpoint: null,
        });
        const { importSessionHandoffAgentBundle } = await import('./import');

        await expect(importSessionHandoffAgentBundle({
            bundle: {
                agentId: 'codex',
                remoteSessionId: 'codex_1',
                files: [],
            },
            targetPath: '/repo',
        })).rejects.toMatchObject({
            code,
            message: 'safe handoff failure',
        });
    });

    it.each([
        'target_identity_conflict',
        'agent_version_unsupported',
    ] as const)('preserves the bounded typed thrown leaf failure %s', async (code) => {
        resolveExecutionSurfaces.mockResolvedValueOnce({
            terminalRuntime: null,
            externalSession: null,
            attach: null,
            handoff: {
                exportBundle: vi.fn(),
                importBundle: vi.fn(async () => {
                    throw Object.assign(new Error('safe thrown handoff failure'), { code });
                }),
            },
            fork: null,
            checkpoint: null,
        });
        const { importSessionHandoffAgentBundle } = await import('./import');

        await expect(importSessionHandoffAgentBundle({
            bundle: {
                agentId: 'codex',
                remoteSessionId: 'codex_1',
                files: [],
            },
            targetPath: '/repo',
        })).rejects.toMatchObject({
            code,
            message: 'safe thrown handoff failure',
        });
    });
});
