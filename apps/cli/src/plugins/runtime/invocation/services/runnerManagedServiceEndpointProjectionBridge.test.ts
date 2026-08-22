import { describe, expect, it, vi } from 'vitest';

import {
    executeRunnerManagedServiceEndpointProjectionBridgeOperation,
    parseRunnerManagedServiceEndpointProjectionBridgeOperation,
    type RunnerManagedServiceEndpointProjectionOwner,
} from './runnerManagedServiceEndpointProjectionBridge';

const immutableGenerationId = 'immutable-generation-1';
const projectionToken = 'b'.repeat(64);

function createProjection() {
    return {
        sessionId: 'session-1',
        pluginId: 'happier.agent.acme',
        contributionId: 'acme',
        serverId: 'opencode',
        instanceId: 'instance-1',
        immutableGenerationId,
        custodyOwner: 'sessionRunner' as const,
        mode: 'managedSpawn' as const,
        endpoint: {
            baseUrl: 'http://127.0.0.1:3210',
            host: '127.0.0.1' as const,
            port: 3210,
        },
        process: {
            pid: 1234,
            startIdentity: 'process-start-1',
        },
        createdAtMs: 1,
    };
}

describe('runner managed-server endpoint projection bridge', () => {
    it('accepts only strict session-runner custody operations', () => {
        expect(
            parseRunnerManagedServiceEndpointProjectionBridgeOperation({
                kind: 'managed_server_endpoint_publish',
                projection: createProjection(),
            }),
        ).toMatchObject({
            kind: 'managed_server_endpoint_publish',
            projection: {
                custodyOwner: 'sessionRunner',
                sessionId: 'session-1',
            },
        });
        expect(
            parseRunnerManagedServiceEndpointProjectionBridgeOperation({
                kind: 'managed_server_endpoint_publish',
                projection: {
                    ...createProjection(),
                    custodyOwner: 'daemon',
                },
            }),
        ).toBeNull();
        expect(
            parseRunnerManagedServiceEndpointProjectionBridgeOperation({
                kind: 'managed_server_endpoint_release',
                instanceId: 'instance-1',
                projectionToken,
                unexpected: true,
            }),
        ).toBeNull();
    });

    it('binds publish and release to the authenticated session and plugin', async () => {
        const owner: RunnerManagedServiceEndpointProjectionOwner = {
            publishEndpointProjection: vi.fn(
                async () => projectionToken,
            ),
            releaseEndpointProjection: vi.fn(async () => true),
        };
        const publish =
            parseRunnerManagedServiceEndpointProjectionBridgeOperation({
                kind: 'managed_server_endpoint_publish',
                projection: createProjection(),
            });
        if (!publish) throw new Error('expected publish operation');

        await expect(
            executeRunnerManagedServiceEndpointProjectionBridgeOperation({
                authority: {
                    sessionId: 'session-1',
                    pluginId: 'happier.agent.acme',
                },
                operation: publish,
                owner,
            }),
        ).resolves.toEqual({
            kind: 'managed_server_endpoint_published',
            projectionToken,
        });
        await expect(
            executeRunnerManagedServiceEndpointProjectionBridgeOperation({
                authority: {
                    sessionId: 'other-session',
                    pluginId: 'happier.agent.acme',
                },
                operation: publish,
                owner,
            }),
        ).rejects.toMatchObject({
            code: 'runner_managed_server_projection_authority_mismatch',
        });

        const release =
            parseRunnerManagedServiceEndpointProjectionBridgeOperation({
                kind: 'managed_server_endpoint_release',
                instanceId: 'instance-1',
                projectionToken,
            });
        if (!release) throw new Error('expected release operation');
        await executeRunnerManagedServiceEndpointProjectionBridgeOperation({
            authority: {
                sessionId: 'session-1',
                pluginId: 'happier.agent.acme',
            },
            operation: release,
            owner,
        });
        expect(owner.releaseEndpointProjection).toHaveBeenCalledWith({
            sessionId: 'session-1',
            pluginId: 'happier.agent.acme',
            instanceId: 'instance-1',
            projectionToken,
        });
    });
});
