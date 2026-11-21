import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { ExternalActionRequestEnvelopeV2Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2, type ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '@/sync/domains/session/spawn/spawnSessionRpcTimeout';
import { projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

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
    it.each(['delivered', 'deadline'] as const)('settles an issued spawn after HTTP 200 headers (%s)', async outcome => {
        if (!account) throw new Error('Expected captured Account');
        const machineId = 'machine-1';
        const executionTarget = { serverId: binding.serverIdentityId, machineId };
        const actionId = SESSION_SPAWN_NEW_ACTION_ID_V1;
        const path = `/v1/actions/${actionId}`;
        const requestId = 'muse-spawn-after-headers';
        const allowBody = createDeferred<void>();
        homes.answer(serverId, path, { status: 200, bodyAfter: allowBody.promise,
            body: { v: 1, actionId, requestId, execution: { ok: true,
                result: projectSessionSpawnNewActionResultV1({
                    type: 'success', disposition: 'created', sessionId: 'created-session', executionTarget,
                    organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' },
                }),
            } },
        });
        vi.useFakeTimers();
        const timeoutMs = readSpawnSessionRpcTimeoutMsFromEnv();
        const pending = executeOriginalAccountActionTransport({ account, binding: { ...binding, actionId, requestId }, timeoutMs,
            input: { executionTarget, creationKey: 'manual:muse-spawn-after-headers',
                directory: { kind: 'path', path: '/project' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.pi', localId: 'pi' } } } });
        const settlement = vi.fn();
        void pending.then(settlement, settlement);
        try {
            await waitForHomeGovernance(() => expect(homes.requestsFor(path)).toHaveLength(1));
            await vi.advanceTimersByTimeAsync(0);
            expect(settlement).not.toHaveBeenCalled();
            if (outcome === 'delivered') {
                allowBody.resolve();
                await expect(pending).resolves.toMatchObject({ ok: true, result: { sessionId: 'created-session' } });
            } else {
                await vi.advanceTimersByTimeAsync(timeoutMs + 1);
                expect(settlement).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'outcome_unknown' }));
            }
            expect(homes.requestsFor(path)).toHaveLength(1);
        } finally {
            allowBody.resolve();
            await pending.catch(() => {});
            vi.useRealTimers();
        }
    });

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
