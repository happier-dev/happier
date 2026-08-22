import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExternalSessionActionContext } from './externalSessionActionContext';
import { executeExternalSessionTakeoverAction } from './takeoverAction';

const updateSessionMetadataWithRetryMock = vi.fn<(args: unknown) => Promise<void>>(async () => undefined);
const processMocks = vi.hoisted(() => ({
    findTrustedExternalSessionOwner: vi.fn(),
    verifySessionMarkerProcessLiveness: vi.fn(),
    resolveExternalLinkedTakeoverWriterSafety: vi.fn(),
}));

vi.mock('@/api/session/external/security/validateExternalMachineSource', () => ({
    validateExternalMachineSource: async (input: Readonly<{ source: unknown }>) => ({ ok: true, source: input.source }),
}));

vi.mock('@/api/session/external/takeover/findTrustedExternalSessionOwner', () => ({
    findTrustedExternalSessionOwner: processMocks.findTrustedExternalSessionOwner,
}));
vi.mock('@/daemon/processLivenessVerifier', () => ({
    verifySessionMarkerProcessLiveness: processMocks.verifySessionMarkerProcessLiveness,
}));

vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
    loadLinkedExternalSession: async () => ({
        ok: true,
        session: {
            rawSession: { id: 'linked-session-1', encryptionMode: 'plain' },
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'opencode',
                    machineId: 'machine-1',
                    remoteSessionId: 'external-session-1',
                    linkedAtMs: 1,
                    source: {
                        kind: 'opencodeServer',
                        baseUrl: 'http://127.0.0.1:4096',
                        directory: '/stale/link/path',
                    },
                    qualifiedIdentity: {
                        v: 1,
                        agent: { pluginId: 'happier.opencode', localId: 'opencode' },
                        source: { kind: 'opencodeServer', contractVersion: 1 },
                    },
                },
            },
            sessionPath: null,
            agentId: 'opencode',
            machineId: 'machine-1',
            remoteSessionId: 'external-session-1',
            linkGeneration: 'linked-at:1',
            source: {
                kind: 'opencodeServer',
                baseUrl: 'http://127.0.0.1:4096',
                directory: '/stale/link/path',
            },
            codexBackendMode: null,
        },
    }),
}));

vi.mock('@/api/session/external/takeover/resolveExternalTakeoverSpawnOptions', () => ({
    resolveExternalTakeoverSpawnOptions: async () => ({
        ok: true,
        value: {
            options: { directory: '/current/spawn/directory' },
            origin: {
                agentId: 'opencode',
                pluginId: 'happier.opencode',
                generation: 'generation-1',
            },
        },
    }),
    spawnResolvedExternalTakeoverSession: async (
        input: Readonly<{
            resolved: Readonly<{ options: Readonly<Record<string, unknown>> }>;
            options: Readonly<Record<string, unknown>>;
            spawnSession(options: Readonly<Record<string, unknown>>): Promise<unknown>;
        }>,
    ) => ({
        ok: true,
        value: await input.spawnSession({
            ...input.resolved.options,
            ...input.options,
        }),
    }),
}));

vi.mock('@/api/session/external/takeover/resolveExternalLinkedTakeoverWriterSafety', () => ({
    resolveExternalLinkedTakeoverWriterSafety:
        processMocks.resolveExternalLinkedTakeoverWriterSafety,
}));

vi.mock('@/daemon/sessionRegistry', () => ({
    listSessionMarkers: async () => [],
}));

vi.mock('@/persistence', () => ({
    readStoredCredentials: async () => ({
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    }),
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
    updateSessionMetadataWithRetry: (args: unknown) => updateSessionMetadataWithRetryMock(args),
}));

describe('executeExternalSessionTakeoverAction persisted import working directory', () => {
    const operationDirectory = join(
        tmpdir(),
        `happier-takeover-operation-progress-${process.pid}`,
    );

    beforeEach(async () => {
        await rm(operationDirectory, { recursive: true, force: true });
        processMocks.findTrustedExternalSessionOwner.mockReset();
        processMocks.findTrustedExternalSessionOwner.mockReturnValue({
            pid: 4_242,
            happySessionId: 'session-other',
            happyHomeDir: '/tmp/happier-home',
            createdAt: 1,
            updatedAt: 2,
            flavor: 'opencode',
            processCommandHash: 'a'.repeat(64),
            processStartTimeMs: 1_717_171_717_000,
            metadata: {
                flavor: 'opencode',
                opencodeSessionId: 'external-session-1',
            },
        });
        processMocks.verifySessionMarkerProcessLiveness.mockReset();
        processMocks.verifySessionMarkerProcessLiveness.mockResolvedValue({
            status: 'verified_stopped',
            pid: 4_242,
            processStartTimeMs: 1_717_171_717_000,
        });
        processMocks.resolveExternalLinkedTakeoverWriterSafety.mockReset();
        processMocks.resolveExternalLinkedTakeoverWriterSafety.mockResolvedValue('unsupported');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const createContext = (
        operationExclusion: { acquire: (request: unknown) => Promise<unknown> },
    ) => ({
        followLeaseManager: {
            suspendSession: vi.fn(async () => undefined),
            resumeSession: vi.fn(async () => undefined),
        },
        operationExclusion: operationExclusion as never,
        operationProgress: {
            activeServerDir: operationDirectory,
            publish: vi.fn(async () => undefined),
        },
        observationProjection: {} as never,
        takeoverReadiness: {
            read: () => null,
            write: () => undefined,
            invalidate: () => undefined,
        },
        spawnSession: vi.fn(async () => ({ type: 'success' as const, sessionId: 'linked-session-1' })),
        stopSession: vi.fn(async () => true),
    });

    it('retires legacy persisted takeover before operation mutation, import, or spawn', async () => {
        updateSessionMetadataWithRetryMock.mockClear();
        const acquire = vi.fn();
        const context = createContext({
            acquire,
        });
        const result = await executeExternalSessionTakeoverAction({
            linkedSessionId: 'linked-session-1',
            targetRuntimeMode: 'terminal',
            storageMode: 'persisted',
            machineId: 'machine-1',
        }, context as unknown as ExternalSessionActionContext);

        expect(result).toEqual({
            ok: false,
            errorCode: 'upgrade_required',
            error: 'durable_external_session_takeover_required',
        });
        expect(acquire).not.toHaveBeenCalled();
        expect(context.operationProgress.publish).not.toHaveBeenCalled();
        expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
        expect(context.followLeaseManager.suspendSession).not.toHaveBeenCalled();
        expect(context.followLeaseManager.resumeSession).not.toHaveBeenCalled();
        expect(context.spawnSession).not.toHaveBeenCalled();
    });

    it('retires legacy external-linked takeover before claim, follow suspension, or spawn', async () => {
        processMocks.resolveExternalLinkedTakeoverWriterSafety.mockResolvedValue('native_prevention');
        const release = vi.fn(async () => undefined);
        const context = createContext({
            acquire: async () => ({
                status: 'acquired',
                claim: {
                    renew: async () => true,
                    release,
                    record: { claimId: 'claim-linked-1' },
                },
            }),
        });

        await expect(executeExternalSessionTakeoverAction({
            linkedSessionId: 'linked-session-1',
            targetRuntimeMode: 'terminal',
            storageMode: 'external-linked',
            machineId: 'machine-1',
        }, context as unknown as ExternalSessionActionContext)).resolves.toEqual({
            ok: false,
            errorCode: 'upgrade_required',
            error: 'durable_external_session_takeover_required',
        });

        expect(context.followLeaseManager.suspendSession).not.toHaveBeenCalled();
        expect(context.spawnSession).not.toHaveBeenCalled();
        expect(context.followLeaseManager.resumeSession).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(context.operationProgress.publish).not.toHaveBeenCalled();
    });

});
