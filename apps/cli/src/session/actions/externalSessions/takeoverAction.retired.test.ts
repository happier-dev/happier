import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExternalSessionActionContext } from './externalSessionActionContext';
import { executeExternalSessionTakeoverAction } from './takeoverAction';

describe('executeExternalSessionTakeoverAction retired route', () => {
    const operationDirectory = join(
        tmpdir(),
        `happier-takeover-operation-progress-${process.pid}`,
    );

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
        spawnSession: vi.fn(async () => ({ type: 'success' as const, sessionId: 'linked-session-1' })),
        stopSession: vi.fn(async () => true),
    });

    it('retires legacy persisted takeover before operation mutation, import, or spawn', async () => {
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
        expect(context.followLeaseManager.suspendSession).not.toHaveBeenCalled();
        expect(context.followLeaseManager.resumeSession).not.toHaveBeenCalled();
        expect(context.spawnSession).not.toHaveBeenCalled();
    });

    it('retires legacy external-linked takeover before claim, follow suspension, or spawn', async () => {
        const release = vi.fn(async () => undefined);
        const context = createContext({
            acquire: async () => ({
                status: 'acquired',
                claim: {
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
