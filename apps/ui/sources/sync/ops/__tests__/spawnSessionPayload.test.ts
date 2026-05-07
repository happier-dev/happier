import { describe, it, expect } from 'vitest';

import type { SpawnSessionOptions } from '../../domains/session/spawn/spawnSessionPayload';
import { buildSpawnHappySessionRpcParams } from '../../domains/session/spawn/spawnSessionPayload';

describe('buildSpawnHappySessionRpcParams', () => {
    it('includes terminal when provided', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            terminal: null,
        } satisfies SpawnSessionOptions);

        expect('terminal' in params).toBe(false);
    });

    it('includes windowsRemoteSessionLaunchMode when provided', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            windowsRemoteSessionLaunchMode: 'windows_terminal',
        } satisfies SpawnSessionOptions);

        expect(params).toMatchObject({
            windowsRemoteSessionLaunchMode: 'windows_terminal',
        });
    });

    it('includes a configured Windows Terminal window name when provided', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            windowsRemoteSessionLaunchMode: 'windows_terminal',
            windowsTerminalWindowName: 'happier-qa',
        } satisfies SpawnSessionOptions);

        expect(params).toMatchObject({
            windowsRemoteSessionLaunchMode: 'windows_terminal',
            windowsTerminalWindowName: 'happier-qa',
        });
    });

    it('includes model selection when provided', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelId: 'o3',
            modelUpdatedAt: 123,
        } satisfies SpawnSessionOptions);

        expect(params).toMatchObject({
            modelId: 'o3',
            modelUpdatedAt: 123,
        });
    });

    it('includes agent mode when provided', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            agentModeId: 'plan',
        } satisfies SpawnSessionOptions);

        expect(params).toMatchObject({
            agentModeId: 'plan',
        });
    });

    it('includes session config option overrides when provided', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            },
        } satisfies SpawnSessionOptions);

        expect(params).toMatchObject({
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            },
        });
    });

    it('omits model override when updatedAt is present but modelId is missing', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelUpdatedAt: 123,
        } satisfies SpawnSessionOptions);

        expect('modelId' in params).toBe(false);
        expect('modelUpdatedAt' in params).toBe(false);
    });

    it('omits model override when modelId is present but updatedAt is missing', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelId: 'o3',
        } satisfies SpawnSessionOptions);

        expect('modelId' in params).toBe(false);
        expect('modelUpdatedAt' in params).toBe(false);
    });

    it('omits model override when modelId is default', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            modelId: 'default',
            modelUpdatedAt: 123,
        } satisfies SpawnSessionOptions);

        expect('modelId' in params).toBe(false);
        expect('modelUpdatedAt' in params).toBe(false);
    });

    it('includes connectedServices bindings when provided', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: { source: 'connected', profileId: 'work' },
                },
            },
        } satisfies SpawnSessionOptions);

        expect(params).toMatchObject({
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: { source: 'connected', profileId: 'work' },
                },
            },
        });
    });

    it('includes mcpSelection when provided', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable-playwright'],
                forceExcludeServerIds: ['workspace-db'],
            },
        } satisfies SpawnSessionOptions);

        expect(params).toMatchObject({
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['portable-playwright'],
                forceExcludeServerIds: ['workspace-db'],
            },
        });
    });

    it('includes transcriptStorage when provided', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            transcriptStorage: 'persisted',
        } satisfies SpawnSessionOptions);

        expect(params).toMatchObject({
            transcriptStorage: 'persisted',
        });
    });

    it('omits removed workspace linkage identifiers from the machine spawn request', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            workspaceId: 'ws_payments',
            workspaceLocationId: 'loc_local',
            workspaceCheckoutId: 'checkout_feature_auth',
        } as any as SpawnSessionOptions);

        expect(params).not.toHaveProperty('workspaceId');
        expect(params).not.toHaveProperty('workspaceLocationId');
        expect(params).not.toHaveProperty('workspaceCheckoutId');
    });

    it('includes agent mode fields without workspace linkage in the machine spawn request', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'm1',
            directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            agentModeId: 'plan',
            agentModeUpdatedAt: 321,
            codexBackendMode: 'appServer',
        } satisfies SpawnSessionOptions);

        expect(params).toMatchObject({
            agentModeId: 'plan',
            agentModeUpdatedAt: 321,
            codexBackendMode: 'appServer',
        });
        expect(params).not.toHaveProperty('workspaceId');
        expect(params).not.toHaveProperty('workspaceLocationId');
        expect(params).not.toHaveProperty('workspaceCheckoutId');
    });
});
