import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExternalActionRequestEnvelopeV2Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2, type ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { executeOriginalAccountActionTransport } = await import('./externalActionAccountTransport');
let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
let serverId: string;
const binding: ExternalActionEncryptionBindingV2 = { serverIdentityId: 'srv_spawn_setup', accountId: 'owner',
    authentication: { kind: 'account', tokenEpoch: 0 }, actionId: 'session.spawn_new', requestId: 'spawn-setup',
    target: { kind: 'machine', machineId: 'machine-1' } };
beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Spawn setup', serverUrl: 'https://spawn-setup.test',
        serverIdentityId: binding.serverIdentityId, accountId: binding.accountId, currentAccount: true, active: false });
    account = await captureLazyActionAccountContext(serverId);
});
afterEach(async () => { account?.dispose(); account = null; await homes.reset(); });

describe('original Account encrypted spawn setup transport', () => {
    it('binds private setup presence to the existing encrypted spawn admission projection', async () => {
        if (!account) throw new Error('Expected captured Account');
        const spawnBinding = { ...binding, actionId: 'session.spawn_new', requestId: 'spawn-setup' };
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
        const input = { executionTarget: { serverId: binding.serverIdentityId, machineId: 'machine-1' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            directory: { kind: 'managed' }, machineSetupPlanInput: { homeId: binding.serverIdentityId,
                machineId: 'machine-1', sources: [{ kind: 'direct', setup: { scripts: [{ body: 'private setup' }] } }] } };
        let received: unknown;
        homes.answer(serverId, '/v1/actions/session.spawn_new', { select: body => {
            received = body;
            return { status: 409, body: { error: 'invalid_request', code: 'target_unavailable', requestId: spawnBinding.requestId } };
        } });
        await executeOriginalAccountActionTransport({ account, binding: spawnBinding, input, material });
        const envelope = ExternalActionRequestEnvelopeV2Schema.parse(received);
        expect(envelope.sessionSpawnAdmission).toMatchObject({ machineSetupRequested: true });
        expect(JSON.stringify(envelope)).not.toContain('private setup');
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            envelope, binding: spawnBinding, material })?.input).toEqual(input);
    });
});
