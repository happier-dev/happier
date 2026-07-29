import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderModelProjectionFixture,
    createProviderModelsFixture,
    createProviderSettingsHarness,
} from './providerSettingsHarness';

describe('providerSettingsHarness', () => {
    it('serves schema-complete Provider responses at the server-scoped transport boundary', async () => {
        const harness = createProviderSettingsHarness();
        const connection = createProviderConnectionViewFixture({ displayName: 'Boundary connection' });
        harness.setResponse(
            RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
            createProviderConnectionsDescribeFixture({ connections: [connection] }),
        );
        harness.setResponse(
            RPC_METHODS.DAEMON_PROVIDERS_MODELS,
            createProviderModelsFixture({ connectionId: connection.connectionId }),
        );
        harness.setResponse(
            RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
            createProviderModelProjectionFixture({ agentTargetKey: 'backend:codex' }),
        );

        await expect(harness.machineRpc({
            machineId: 'machine-a',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
            payload: { machineId: 'machine-a' },
        })).resolves.toMatchObject({
            status: 'success',
            connections: [{ displayName: 'Boundary connection' }],
        });
    });

    it('returns a duplicated connection at the caller-provided new identity', async () => {
        const harness = createProviderSettingsHarness();

        await expect(harness.machineRpc({
            machineId: 'machine-a',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE,
            payload: {
                action: 'duplicate',
                machineId: 'machine-a',
                connectionId: 'pc_a',
                newConnectionId: 'pc_copy',
                displayName: 'Copy',
                mode: 'sameSource',
            },
        })).resolves.toMatchObject({
            status: 'success',
            action: 'duplicate',
            connection: { connectionId: 'pc_copy' },
        });
    });
});
