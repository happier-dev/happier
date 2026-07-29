import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveExecutionSurfaces, resolveSessionHandoffEligibility } = vi.hoisted(() => ({
    resolveExecutionSurfaces: vi.fn(),
    resolveSessionHandoffEligibility: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
    getSessionHostBridge: () => ({
        resolveExecutionSurfaces,
        resolveSessionHandoffEligibility,
    }),
}));

describe('exportSessionHandoffAgentBundle', () => {
    beforeEach(() => {
        resolveExecutionSurfaces.mockReset();
        resolveSessionHandoffEligibility.mockReset();
    });

    afterEach(() => {
        vi.resetModules();
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
        resolveSessionHandoffEligibility.mockReturnValueOnce({
            eligible: true,
            agentId: 'codex',
            vendorHandoffId: 'codex_1',
        });
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
                flavor: 'codex',
                machineId: 'machine_source',
                path: '/repo',
                codexSessionId: 'codex_1',
                codexBackendMode: 'appServer',
                externalSessionOperationV1,
                externalSessionOperationPresentationV1,
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
            metadata: {
                flavor: 'codex',
                machineId: 'machine_source',
                path: '/repo',
                codexSessionId: 'codex_1',
                codexBackendMode: 'appServer',
                externalSessionOperationV1,
                externalSessionOperationPresentationV1,
            },
        });
        expect(resolveExecutionSurfaces).toHaveBeenCalledWith('codex');
        expect(exportBundle).toHaveBeenCalledWith({
            sessionId: 'codex_1',
            metadata: {
                flavor: 'codex',
                machineId: 'machine_source',
                path: '/repo',
                codexSessionId: 'codex_1',
                codexBackendMode: 'appServer',
            },
            directory: '/tmp/server',
        });
        const exportedMetadata = JSON.stringify(
            exportBundle.mock.calls[0]?.[0]?.metadata,
        );
        expect(exportedMetadata).not.toContain('operation-public-safe-1');
        expect(exportedMetadata).not.toContain('externalSessionOperationV1');
        expect(exportedMetadata).not.toContain(
            'externalSessionOperationPresentationV1',
        );
        expect(exportedMetadata).not.toContain('operationClaimId');
        expect(exportedMetadata).not.toContain('canonicalOwnerEvidence');
        expect(exportedMetadata).not.toContain('privateStagingId');
    });
});
