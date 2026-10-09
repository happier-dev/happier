import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionRequestEnvelopeV2Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
beforeEach(async () => { await harness.reset(); resetScopedHomeActionExecutorsForTests(); });
afterEach(() => standardCleanup());
describe('managed configurator uses the exact Home Action front door', () => {
    it('refuses a catalog qualified for a different controller installation than the requested one', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://qualified-catalog.example', serverIdentityId: 'srv_qualified_catalog', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: envelope.requestId, execution: { ok: true,
                result: { controller: { machineId: 'host', installationId: 'replacement' }, provisioners: [] } } } };
        } });
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        const client = createManagedProvisionerClient({ serverId, accountId: 'owner' }, 'srv_qualified_catalog');
        expect(await client.read('machines.provisioners.list', { homeId: 'srv_qualified_catalog',
            controller: { machineId: 'host', installationId: 'installation' } })).toEqual({ kind: 'failed', code: 'invalid_action_output' });
        expect(harness.requestsFor('/v1/actions/machines.provisioners.list')).toHaveLength(1);
    });
    it('keeps an encrypted offline admission receipt distinct from a completed Action and exposes its waiting row', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://receipt.compute.test', serverIdentityId: 'srv_compute', accountId: 'owner', accountEncryptionMode: 'e2ee' });
        await harness.addHome({ name: 'Other', serverUrl: 'https://receipt.other.test', serverIdentityId: 'srv_other', accountId: 'other' });
        const token = `e30.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'owner', tokenEpoch: 3,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token, secret: encodeBase64(new Uint8Array(32).fill(29), 'base64url') });
        let receipts = 0;
        harness.answer(serverId, '/v1/machines', { body: [{ id: 'host', kind: 'persistent', installationId: 'installation',
                active: false, activeAt: 1, revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
                storageMode: 'e2ee', metadata: 'opaque', metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
                keyBasis: { dataEncryptionKey: null, metadataVersion: 1, daemonStateVersion: 0 }, seq: 1, createdAt: 1, updatedAt: 1,
                access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' } }] });
        harness.answer(serverId, '/v1/actions/machines.managed.acquire', { select: value => {
            const envelope = ExternalActionRequestEnvelopeV2Schema.parse(value);
            receipts++;
            return { status: 409, body: { error: 'invalid_request', code: 'target_unavailable', requestId: envelope.requestId,
                managedAdmission: { managedId: 'waiting-managed' } } };
        } });
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        const client = createManagedProvisionerClient({ serverId, accountId: 'owner' }, 'srv_compute');
        expect(await client.execute('machines.managed.acquire', { selection: { kind: 'one-off', homeId: 'srv_compute',
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'host', installationId: 'installation' }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } }))
            .toEqual({ kind: 'admitted', receipt: { managedId: 'waiting-managed' } });
        expect(receipts).toBe(1);
    });
    it('lists without acquiring and preserves normal Ask-first custody for Create', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner', currentAccount: true });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: envelope.requestId, execution: { ok: true, result: { provisioners: [] } } } };
        } });
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        const client = createManagedProvisionerClient({ serverId, accountId: 'owner' }, 'srv_compute');
        expect(await client.execute('machines.provisioners.list', { homeId: 'srv_compute', controller: { machineId: 'host', installationId: 'installation' } })).toEqual({ kind: 'succeeded', value: { provisioners: [] } });
        expect(harness.requestsFor('/v1/actions/machines.provisioners.list')[0]?.serverId).toBe(serverId);
        expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        harness.answer(serverId, '/v1/machines', { body: [{ id: 'host', kind: 'persistent', installationId: 'installation',
            active: false, revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }] });
        // Native Action admission owns its ordinary Artifact; the UI does not create an outer Ask.
        harness.answer(serverId, '/v1/actions/machines.managed.acquire', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.managed.acquire', requestId: request.requestId, execution: { ok: true,
                result: { kind: 'approval_request_created', artifactId: 'native-approval', actionId: 'machines.managed.acquire' } } } };
        } });
        const result = await client.execute('machines.managed.acquire', { selection: { kind: 'one-off', homeId: 'srv_compute',
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'host', installationId: 'installation' }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        expect(result).toMatchObject({ kind: 'approval_pending', approval: { artifactId: expect.any(String) } });
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(1);
        expect(await client.execute('machines.provisioners.list', { homeId: 'srv_other' })).toEqual({ kind: 'failed', code: 'server_target_mismatch' });
    });
});
