import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveSessionHandoffEligibility as resolveActualSessionHandoffEligibility } from '../resolveSessionHandoffEligibility';

const {
    resolveExecutionSurfaces,
    resolveCurrentExecutionSurfacesForCatalogAgent,
    resolveSessionHandoffEligibility,
} = vi.hoisted(() => ({
    resolveExecutionSurfaces: vi.fn(),
    resolveCurrentExecutionSurfacesForCatalogAgent: vi.fn(),
    resolveSessionHandoffEligibility: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
    getSessionHostBridge: () => ({
        resolveExecutionSurfaces,
        resolveCurrentExecutionSurfacesForCatalogAgent,
        resolveSessionHandoffEligibility,
    }),
}));

describe('exportSessionHandoffAgentBundle', () => {
    beforeEach(() => {
        resolveExecutionSurfaces.mockReset();
        resolveCurrentExecutionSurfacesForCatalogAgent.mockReset();
        resolveSessionHandoffEligibility.mockReset();
        resolveSessionHandoffEligibility.mockImplementation(
            resolveActualSessionHandoffEligibility,
        );
    });

    afterEach(() => {
        vi.resetModules();
    });

    it('projects persisted Codex connected-service affinity without exposing its source-machine path', async () => {
        const exportBundle = vi.fn(async (_request: Readonly<{
            sessionId: string;
            metadata: unknown;
            directory: string;
        }>) => ({
            ok: true as const,
            value: {
                bundle: {
                    providerId: 'codex',
                    remoteSessionId: 'codex-persisted-1',
                    files: [],
                },
            },
        }));
        resolveExecutionSurfaces.mockResolvedValueOnce({
            terminalRuntime: null,
            externalSession: null,
            attach: null,
            handoff: {
                exportBundle,
                importBundle: vi.fn(),
            },
            fork: null,
            checkpoint: null,
        });
        const { exportSessionHandoffAgentBundle } = await import('./export');

        await expect(exportSessionHandoffAgentBundle({
            metadata: {
                machineId: 'machine-source',
                path: '/repo',
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    agent: {
                        backendMode: 'appServer',
                        providerSessionId: 'codex-persisted-1',
                        home: 'connectedService',
                        connectedServiceId: 'openai-codex',
                        connectedServiceProfileId: 'profile-1',
                        connectedServiceGroupId: 'group-1',
                        homePath: '/private/source-machine/codex-home',
                    },
                },
            },
            activeServerDir: '/active-server',
        })).resolves.toEqual({
            agentBundle: {
                providerId: 'codex',
                remoteSessionId: 'codex-persisted-1',
                files: [],
            },
            targetPath: '/repo',
        });

        expect(exportBundle).toHaveBeenCalledWith({
            sessionId: 'codex-persisted-1',
            metadata: {
                path: '/repo',
                providerSessionId: 'codex-persisted-1',
                codexSessionId: 'codex-persisted-1',
                codexBackendMode: 'appServer',
                externalSessionSource: {
                    kind: 'codexHome',
                    home: 'connectedService',
                    connectedServiceId: 'openai-codex',
                    connectedServiceProfileId: 'profile-1',
                    connectedServiceGroupId: 'group-1',
                },
            },
            directory: '/active-server',
        });
        expect(JSON.stringify(exportBundle.mock.calls[0]?.[0]?.metadata))
            .not.toContain('/private/source-machine/codex-home');
    });

    it('resolves provider export through the generic backend execution surface for eligible sessions', async () => {
        const externalSessionOperationV1 = {
            v: 1 as const,
            progress: {
                v: 1 as const,
                operationId: 'operation-public-safe-1',
                revision: 4,
                request: {
                    plan: 'materialize' as const,
                    targetStorageMode: 'external-linked' as const,
                    targetRuntimeMode: null,
                },
                status: 'running' as const,
                phase: 'validating' as const,
                timeline: ['validating', 'staging', 'importing', 'publishing'] as const,
                updatedAtMs: 1_700_000_000_004,
                priorStableStorage: { state: 'machine_only' as const },
                currentStorageState: 'machine_only' as const,
                checkpoint: {
                    sourcePagesRead: 0,
                    stagedItemCount: 0,
                    importedItemCount: 0,
                    requiredItemFailures: {
                        total: 0,
                        record: 0,
                        media: 0,
                        conversion: 0,
                        diagnosticsTruncated: false,
                    },
                },
                fence: { kind: 'none' as const },
            },
        };
        const externalSessionOperationPresentationV1 = {
            v: 1 as const,
            operationId: 'operation-public-safe-1',
            revision: 4,
            kind: 'materialize' as const,
            status: 'running' as const,
            phase: 'validating' as const,
        };
        const exportBundle = vi.fn(async (_request: Readonly<{
            sessionId: string;
            metadata: unknown;
            directory: string;
        }>) => ({
            ok: true,
            value: {
                bundle: {
                    providerId: 'codex',
                    remoteSessionId: 'codex_1',
                    files: [],
                },
            },
        }));
        resolveExecutionSurfaces.mockResolvedValueOnce({
            terminalRuntime: null,
            externalSession: null,
            attach: null,
            handoff: {
                exportBundle,
                importBundle: vi.fn(),
            },
            fork: null,
            checkpoint: null,
        });
        const { exportSessionHandoffAgentBundle } = await import('./export');

        await expect(exportSessionHandoffAgentBundle({
            metadata: {
                machineId: 'machine_source',
                path: '/repo',
                codexSessionId: 'codex_1',
                codexBackendMode: 'appServer',
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine_source',
                    remoteSessionId: 'codex_1',
                    source: {
                        kind: 'codexHome',
                        home: 'connectedService',
                        connectedServiceId: 'openai-codex:%',
                        connectedServiceProfileId: 'profile::%/one',
                    },
                    linkedAtMs: 1_700_000_000_000,
                    lastKnownActivityAtMs: 1_700_000_000_001,
                    codexBackendMode: 'appServer',
                },
                externalSessionOperation: { operationClaimId: 'legacy-private-claim' },
                externalSessionOperationV1,
                externalSessionOperationPresentationV1,
                compatibilityMetadata: { owner: 'private' },
                ownerProjection: { owner: 'private' },
                operationClaimId: 'claim-private',
                fence: { token: 'private' },
                paths: { staging: '/private/staging' },
                host: { pid: 123 },
                runtime: { custody: 'private' },
                custody: { generation: 'private' },
                unrelatedOwnerOnlySentinel: 'must-not-reach-agent-code',
            },
            activeServerDir: '/tmp/server',
        })).resolves.toEqual({
            agentBundle: {
                providerId: 'codex',
                remoteSessionId: 'codex_1',
                files: [],
            },
            targetPath: '/repo',
        });

        expect(resolveSessionHandoffEligibility).toHaveBeenCalledWith({
            sourceMachineId: 'machine_source',
            externalSessionLinkResolution: expect.objectContaining({
                ok: true,
                linkedSession: expect.objectContaining({
                    agentId: 'codex',
                    machineId: 'machine_source',
                    remoteSessionId: 'codex_1',
                }),
            }),
            metadata: {
                path: '/repo',
                providerSessionId: 'codex_1',
                codexSessionId: 'codex_1',
                codexBackendMode: 'appServer',
                externalSessionSource: {
                    kind: 'codexHome',
                    home: 'connectedService',
                    connectedServiceId: 'openai-codex:%',
                    connectedServiceProfileId: 'profile::%/one',
                },
            },
        });
        expect(resolveExecutionSurfaces).toHaveBeenCalledWith('codex');
        expect(exportBundle).toHaveBeenCalledWith({
            sessionId: 'codex_1',
            metadata: {
                path: '/repo',
                providerSessionId: 'codex_1',
                codexSessionId: 'codex_1',
                codexBackendMode: 'appServer',
                externalSessionSource: {
                    kind: 'codexHome',
                    home: 'connectedService',
                    connectedServiceId: 'openai-codex:%',
                    connectedServiceProfileId: 'profile::%/one',
                },
            },
            directory: '/tmp/server',
        });
        const exportedMetadata = JSON.stringify(
            exportBundle.mock.calls[0]?.[0]?.metadata,
        );
        expect(exportedMetadata).not.toContain('operation-public-safe-1');
        expect(exportedMetadata).not.toContain('externalSessionOperationV1');
        expect(exportedMetadata).not.toContain('externalSessionV1');
        expect(exportedMetadata).not.toContain('machine_source');
        expect(exportedMetadata).not.toContain('lastKnownActivityAtMs');
        expect(exportedMetadata).not.toContain('linkedAtMs');
        expect(exportedMetadata).not.toContain(
            'externalSessionOperationPresentationV1',
        );
        expect(exportedMetadata).not.toContain('operationClaimId');
        expect(exportedMetadata).not.toContain('canonicalOwnerEvidence');
        expect(exportedMetadata).not.toContain('privateStagingId');
        expect(exportedMetadata).not.toContain('unrelatedOwnerOnlySentinel');
    });

    it('does not resolve or export a bundle when linked-session metadata requires reconciliation', async () => {
        const exportBundle = vi.fn();
        resolveExecutionSurfaces.mockResolvedValueOnce({
            handoff: { exportBundle },
        });
        const { exportSessionHandoffAgentBundle } = await import('./export');

        await expect(exportSessionHandoffAgentBundle({
            metadata: {
                machineId: 'machine_source',
                path: '/repo',
                externalSessionV1: {
                    v: 1,
                    agentId: 'opencode',
                    machineId: 'machine_source',
                    remoteSessionId: 'opencode_conflict',
                    source: { kind: 'opencodeServer', directory: '/repo/current' },
                    linkedAtMs: 1,
                },
                directSessionV1: {
                    v: 1,
                    providerId: 'opencode',
                    machineId: 'machine_source',
                    remoteSessionId: 'opencode_conflict',
                    source: { kind: 'opencodeServer', directory: '/repo/stale' },
                    linkedAtMs: 1,
                },
            },
            activeServerDir: '/tmp/server',
        })).rejects.toThrow(
            'Session is not eligible for handoff: linked_session_reconciliation_required',
        );

        expect(resolveExecutionSurfaces).not.toHaveBeenCalled();
        expect(exportBundle).not.toHaveBeenCalled();
    });

    it('exports an external Agent through its qualified current backend target', async () => {
        const exportBundle = vi.fn(async () => ({
            ok: true as const,
            value: {
                bundle: {
                    providerId: 'acme.handoff',
                    remoteSessionId: 'acme-session-1',
                    files: [],
                },
            },
        }));
        resolveSessionHandoffEligibility.mockResolvedValueOnce({
            eligible: true,
            agentId: 'acme.handoff',
            backendId: 'acme.handoff.backend',
            storageMode: 'persisted',
            sourceMachineId: 'machine-source',
            vendorHandoffId: 'acme-session-1',
        });
        resolveCurrentExecutionSurfacesForCatalogAgent.mockResolvedValueOnce({
            agentId: 'acme.handoff',
            backendId: 'acme.handoff.backend',
            executionSurfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: {
                    exportBundle,
                    importBundle: vi.fn(),
                },
                fork: null,
                checkpoint: null,
            },
        });
        const { exportSessionHandoffAgentBundle } = await import('./export');

        await expect(exportSessionHandoffAgentBundle({
            metadata: {
                machineId: 'machine-source',
                path: '/repo',
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'acme.handoff',
                    agent: { providerSessionId: 'acme-session-1' },
                },
            },
            activeServerDir: '/active-server',
        })).resolves.toEqual({
            agentBundle: {
                providerId: 'acme.handoff',
                remoteSessionId: 'acme-session-1',
                files: [],
            },
            targetPath: '/repo',
        });

        expect(resolveCurrentExecutionSurfacesForCatalogAgent).toHaveBeenCalledWith('acme.handoff');
        expect(resolveExecutionSurfaces).not.toHaveBeenCalled();
        expect(resolveSessionHandoffEligibility).toHaveBeenCalledWith(expect.objectContaining({
            sessionAgentId: 'acme.handoff',
        }));
        expect(exportBundle).toHaveBeenCalledWith({
            sessionId: 'acme-session-1',
            metadata: {
                path: '/repo',
                providerSessionId: 'acme-session-1',
            },
            directory: '/active-server',
        });
    });

    it('does not export through a backend target that no longer belongs to the eligible external Agent', async () => {
        const exportBundle = vi.fn();
        resolveSessionHandoffEligibility.mockResolvedValueOnce({
            eligible: true,
            agentId: 'acme.handoff',
            backendId: 'acme.handoff.backend',
            storageMode: 'persisted',
            sourceMachineId: 'machine-source',
            vendorHandoffId: 'acme-session-1',
        });
        resolveCurrentExecutionSurfacesForCatalogAgent.mockResolvedValueOnce({
            agentId: 'acme.handoff',
            backendId: 'acme.reloaded.backend',
            executionSurfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: {
                    exportBundle,
                    importBundle: vi.fn(),
                },
                fork: null,
                checkpoint: null,
            },
        });
        const { exportSessionHandoffAgentBundle } = await import('./export');

        await expect(exportSessionHandoffAgentBundle({
            metadata: {
                machineId: 'machine-source',
                path: '/repo',
            },
            activeServerDir: '/active-server',
        })).rejects.toThrow('Unsupported handoff provider: acme.handoff');

        expect(exportBundle).not.toHaveBeenCalled();
    });
});
