import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import {
    createProviderErrorV1} from '@happier-dev/protocol/providers/errors';
import {
    ProviderConnectionIdSchema} from '@happier-dev/protocol/providers/ids';
import {
    ProviderConnectionSecurityFingerprintV1Schema,
} from '@happier-dev/protocol/providers/fingerprints';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createProviderConnectionViewFixture, createProviderConnectionsDescribeFixture, createProviderSettingsHarness, createProviderSettingsAccountHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { ProviderSettingsMachineRowV1 } from '@/providers/hooks/targetMachine';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
const account = createProviderSettingsAccountHarness();
let serverId = '';

function row(machineId: string): ProviderSettingsMachineRowV1 {
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
    it('cancels superseded non-replying reads through the real Action and RPC owners and recovers after pause', async () => {
        let hold = false;
        let requests = 0;
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => {
            requests += 1;
            if (hold) return await new Promise<never>(() => {});
            return success('machine-a');
        });
        const { useTeamCredentialProviderSourceOffers } = await import('./useTeamCredentialProviderSourceOffers');
        const hook = await renderHook((props: { enabled: boolean }) => useTeamCredentialProviderSourceOffers({
            enabled: props.enabled, machines: [row('machine-a')],
        }), { initialProps: { enabled: true } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().offers).toHaveLength(1));
        hold = true;
        let settled = false;
        let pending: Promise<unknown> | undefined;
        await act(async () => { pending = hook.getCurrent().refresh().finally(() => { settled = true; }); });
        await waitForHomeGovernance(() => expect(requests).toBe(2));
        hold = false;
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(settled).toBe(true);
        expect(hook.getCurrent().loading).toBe(false);
        hold = true;
        settled = false;
        await act(async () => { pending = hook.getCurrent().refresh().finally(() => { settled = true; }); });
        await waitForHomeGovernance(() => expect(requests).toBe(4));
        await hook.rerender({ enabled: false });
        await flushHookEffects();
        expect(settled).toBe(true);
        expect(hook.getCurrent().loading).toBe(false);
        hold = false;
        await hook.rerender({ enabled: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().offers).toHaveLength(1));
        hold = true;
        settled = false;
        await act(async () => { pending = hook.getCurrent().refresh().finally(() => { settled = true; }); });
        await waitForHomeGovernance(() => expect(requests).toBe(6));
        await hook.unmount();
        await flushHookEffects();
        expect(settled).toBe(true);
        await pending;
    });

    beforeEach(async () => {
        serverId = (await account.restore({ serverIdentityId: 'srv_team_provider_offers', machines:
            ['machine-a', 'machine-b', 'machine-c'].map(id => createMachineFixture({ id, activeAt: Date.now() })),
        })).serverId;
    });
    afterEach(async () => {
        providerHarness.reset();
        standardCleanup();
        await account.reset();
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
