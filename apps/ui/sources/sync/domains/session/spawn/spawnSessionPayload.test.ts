import { describe, expect, it } from 'vitest';

import {
    buildCompatibleSpawnHappySessionRpcParams,
    buildSpawnHappySessionRpcParams,
    shouldUseLegacySpawnHappySessionRpcParams,
} from './spawnSessionPayload';

describe('buildSpawnHappySessionRpcParams', () => {
    it('includes configured ACP backend targets and omits removed workspace linkage fields', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            workspaceId: 'ws_payments',
            workspaceLocationId: 'loc_local',
            workspaceCheckoutId: 'checkout_feature_auth',
            backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
        } as any);

        expect(params).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'backend', backendId: 'custom-kiro', configuredBackendId: 'custom-kiro', sourceKind: 'configured' },
        }));
        expect(params).not.toHaveProperty('workspaceId');
        expect(params).not.toHaveProperty('workspaceLocationId');
        expect(params).not.toHaveProperty('workspaceCheckoutId');
    });

    it('prefers codexBackendMode over legacy experimentalCodexAcp when provided together', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
            experimentalCodexAcp: true,
        } as any);

        expect(params).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            codexBackendMode: 'appServer',
        }));
        expect(params).not.toHaveProperty('experimentalCodexAcp');
    });

    it('normalizes legacy experimentalCodexAcp onto canonical codexBackendMode when codexBackendMode is absent', () => {
        expect(buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            experimentalCodexAcp: true,
        } as any)).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            codexBackendMode: 'acp',
            runtimeDescriptorV1: expect.objectContaining({
                v: 1,
                providerId: 'codex',
                provider: expect.objectContaining({
                    backendMode: 'acp',
                }),
            }),
        }));
    });

    it('prefers runtimeDescriptorV1 over legacy experimentalCodexAcp when codexBackendMode is absent', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            experimentalCodexAcp: true,
            runtimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    providerSessionId: 'codex-session-2',
                },
            },
        } as any);

        expect(params).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            codexBackendMode: 'appServer',
            runtimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    providerSessionId: 'codex-session-2',
                },
            },
        }));
        expect(params).not.toHaveProperty('experimentalCodexAcp');
    });

    it('ignores legacy agentRuntimeDescriptorV1 input when building the canonical spawn payload', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'codex',
                provider: {
                    backendMode: 'appServer',
                    providerSessionId: 'legacy-thread',
                },
            },
        } as any);

        expect(params).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        }));
        expect(params).not.toHaveProperty('codexBackendMode');
        expect(params).not.toHaveProperty('runtimeDescriptorV1');
        expect(params).not.toHaveProperty('agentRuntimeDescriptorV1');
    });

    it('derives runtimeDescriptorV1 for codex spawn requests when codexBackendMode is set', () => {
        expect(buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            resume: 'codex-session-1',
            codexBackendMode: 'appServer',
        } as any)).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            codexBackendMode: 'appServer',
            runtimeDescriptorV1: expect.objectContaining({
                v: 1,
                providerId: 'codex',
                provider: expect.objectContaining({
                    backendMode: 'appServer',
                    providerSessionId: 'codex-session-1',
                }),
            }),
        }));
    });

    it('does not emit codex transport fields when the target backend is not codex', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            codexBackendMode: 'acp',
            experimentalCodexAcp: true,
        } as any);

        expect(params).not.toHaveProperty('codexBackendMode');
        expect(params).not.toHaveProperty('runtimeDescriptorV1');
    });

    it('derives codex runtime descriptor for canonical codex backend targets', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: {
                kind: 'backend',
                backendId: 'codex',
                sourceKind: 'built_in',
            },
            resume: 'codex-session-canonical',
            codexBackendMode: 'acp',
        } as any);

        expect(params).toEqual(expect.objectContaining({
            codexBackendMode: 'acp',
            runtimeDescriptorV1: expect.objectContaining({
                v: 1,
                providerId: 'codex',
                provider: expect.objectContaining({
                    backendMode: 'acp',
                    providerSessionId: 'codex-session-canonical',
                }),
            }),
        }));
    });

    it('preserves account settings version hints for modern daemon spawn payloads', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            accountSettingsVersionHint: 14,
        } as any);

        expect(params).toEqual(expect.objectContaining({
            accountSettingsVersionHint: 14,
        }));
    });

    it('omits legacy spawn token passthrough when present on a compatibility-shaped input', () => {
        const params = buildSpawnHappySessionRpcParams({
            machineId: 'machine-1',
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            token: 'legacy-spawn-token',
        } as any);

        expect(params).not.toHaveProperty('token');
    });

    it('uses the legacy spawn payload shape for older daemon CLI versions', () => {
        const params = buildCompatibleSpawnHappySessionRpcParams({
            daemonCliVersion: '0.0.9',
            options: {
                machineId: 'machine-1',
                directory: '/tmp/workspace',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                permissionMode: 'safe-yolo',
                permissionModeUpdatedAt: 123,
                modelId: 'o3',
                modelUpdatedAt: 456,
                windowsRemoteSessionLaunchMode: 'console',
            },
        });

        expect(params).toEqual(expect.objectContaining({
            type: 'spawn-in-directory',
            directory: '/tmp/workspace',
            agent: 'claude',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
            modelId: 'o3',
            modelUpdatedAt: 456,
            windowsRemoteSessionConsole: 'visible',
        }));
        expect(params).not.toHaveProperty('backendTarget');
    });

    it('detects older daemon versions that still require the legacy spawn contract', () => {
        expect(shouldUseLegacySpawnHappySessionRpcParams('0.0.9')).toBe(true);
        expect(shouldUseLegacySpawnHappySessionRpcParams('0.1.0-dev.5')).toBe(false);
        expect(shouldUseLegacySpawnHappySessionRpcParams('0.2.0')).toBe(false);
        expect(shouldUseLegacySpawnHappySessionRpcParams(null)).toBe(false);
    });
});
