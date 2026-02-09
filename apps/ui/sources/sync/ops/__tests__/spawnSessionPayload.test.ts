import { describe, it, expect } from 'vitest';

import type { SpawnSessionOptions } from '../../domains/session/spawn/spawnSessionPayload';
import { buildSpawnHappySessionRpcParams } from '../../domains/session/spawn/spawnSessionPayload';

describe('buildSpawnHappySessionRpcParams', () => {
    it('includes terminal when provided', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            terminal: {
                mode: 'tmux',
                tmux: {
                    sessionName: '',
                    isolated: true,
                    tmpDir: null,
                },
            },
        } satisfies SpawnSessionOptions);

        expect(params).toMatchObject({
            type: 'spawn-in-directory',
            directory: '/tmp',
            terminal: {
                mode: 'tmux',
                tmux: {
                    sessionName: '',
                    isolated: true,
                    tmpDir: null,
                },
            },
        });
    });

    it('omits terminal when null/undefined', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            terminal: null,
        } satisfies SpawnSessionOptions);

        expect('terminal' in params).toBe(false);
    });

    it('includes windowsRemoteSessionConsole when provided', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            windowsRemoteSessionConsole: 'visible',
        } satisfies SpawnSessionOptions);

        expect(params).toMatchObject({
            windowsRemoteSessionConsole: 'visible',
        });
    });

    it('includes model selection when provided', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            modelId: 'o3',
            modelUpdatedAt: 123,
        } satisfies SpawnSessionOptions);

        expect(params).toMatchObject({
            modelId: 'o3',
            modelUpdatedAt: 123,
        });
    });

    it('omits model override when updatedAt is present but modelId is missing', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            modelUpdatedAt: 123,
        } satisfies SpawnSessionOptions);

        expect('modelId' in params).toBe(false);
        expect('modelUpdatedAt' in params).toBe(false);
    });

    it('omits model override when modelId is present but updatedAt is missing', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            modelId: 'o3',
        } satisfies SpawnSessionOptions);

        expect('modelId' in params).toBe(false);
        expect('modelUpdatedAt' in params).toBe(false);
    });

    it('omits model override when modelId is default', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            modelId: 'default',
            modelUpdatedAt: 123,
        } satisfies SpawnSessionOptions);

        expect('modelId' in params).toBe(false);
        expect('modelUpdatedAt' in params).toBe(false);
    });
});
