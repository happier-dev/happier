import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createProviderErrorV1,
    ProviderConnectionIdSchema,
    ProviderConnectionSecurityFingerprintV1Schema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderSettingsHarness,
    flushHookEffects,
    installProviderSettingsRpcBoundary,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';
import type { ProviderSettingsMachineRowV1 } from '@/providers/hooks/targetMachine';

const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);

function row(machineId: string, serverId = 'server-home'): ProviderSettingsMachineRowV1 {
    return {
        target: { serverIdentityId: serverId, machineId },
        serverId,
        displayName: machineId,
        online: true,
    };
}

function success(machineId: string) {
    return createProviderConnectionsDescribeFixture({
        connections: [createProviderConnectionViewFixture({
            connectionId: 'pc-shared',
            teamCredentialSourceOffer: {
                connectionId: ProviderConnectionIdSchema.parse('pc-shared'),
                connectionSecurityFingerprint:
                    ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:same'),
                credentialSlotId: 'apiKey',
                label: `Gateway on ${machineId}`,
            },
        })],
    });
}

describe('useTeamCredentialProviderSourceOffers', () => {
    afterEach(() => {
        providerHarness.reset();
        standardCleanup();
    });

    it('retains every exact Machine offer while preserving the first typed failure', async () => {
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async (request) => {
            const machineId = (request.payload as { machineId: string }).machineId;
            if (machineId === 'machine-a') {
                return {
                    status: 'error',
                    error: createProviderErrorV1('provider_connection_changed', { machineId }),
                };
            }
            return success(machineId);
        });
        const { useTeamCredentialProviderSourceOffers } = await import('./useTeamCredentialProviderSourceOffers');
        const rendered = await renderHook(() => useTeamCredentialProviderSourceOffers({
            enabled: true,
            machines: [row('machine-a'), row('machine-b'), row('machine-c')],
        }));
        await flushHookEffects({ cycles: 2, turns: 3 });

        expect(rendered.getCurrent().offers.map((offer) => offer.machineId)).toEqual(['machine-b', 'machine-c']);
        expect(rendered.getCurrent().error?.code).toBe('provider_connection_changed');
    });

    it('treats thrown failures from every target as failure and keeps last-known offers through retry', async () => {
        let fail = false;
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async (request) => {
            const machineId = (request.payload as { machineId: string }).machineId;
            if (fail) throw new Error('transport unavailable');
            return success(machineId);
        });
        const { useTeamCredentialProviderSourceOffers } = await import('./useTeamCredentialProviderSourceOffers');
        const rendered = await renderHook(() => useTeamCredentialProviderSourceOffers({
            enabled: true,
            machines: [row('machine-a'), row('machine-b')],
        }));
        await flushHookEffects({ cycles: 2, turns: 3 });
        expect(rendered.getCurrent().offers).toHaveLength(2);

        fail = true;
        let refreshed: readonly { machineId: string }[] | null | undefined;
        await act(async () => {
            refreshed = await rendered.getCurrent().refresh();
        });

        expect(refreshed).toBeNull();
        expect(rendered.getCurrent().offers).toHaveLength(2);
        expect(rendered.getCurrent().error).toMatchObject({ code: 'agent_error', machineId: 'machine-a' });
        expect(JSON.stringify(rendered.getCurrent().error)).not.toContain('transport unavailable');
        expect(rendered.getCurrent().loading).toBe(false);
    });
});
