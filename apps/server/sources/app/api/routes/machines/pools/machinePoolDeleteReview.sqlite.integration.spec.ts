import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import {
    bindExternalActionExecutionAuthorizationHttpPathV1,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    ExternalActionExecutionAuthorizationV1Schema,
    encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { machinePoolActionEndpointPathV1, openMachinePoolActionOutputV1, MachinePoolWireOutputSchemasV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { MachinePoolErrorV1Schema } from '@happier-dev/protocol/machines/pools/v1';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { plainPrivateLabel, storedPlainPrivateLabel } from '@/testkit/privateLabelFixture';
import { auth } from '@/app/auth/auth';
import { withAuthenticatedTestApp } from '../../../testkit/sqliteFastify';
import { registerExternalActionRoutes } from '../../actions/registerExternalActionRoutes';
import { registerMachinePoolRoutes } from './registerMachinePoolRoutes';

describe('Machine Pool delete consent through the Action and Home (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-pool-delete-review-', initAuth: true,
            env: { HAPPIER_FEATURE_MACHINES_POOLS__ENABLED: '1' } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('accepts signed terminal preparation on the admitted delete transport', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keyPair = tweetnacl.sign.keyPair();
        const machine = await db.machine.create({ data: {
            id: crypto.randomUUID(), accountId: owner.id, installationId: crypto.randomUUID(),
            installationPublicKey: Buffer.from(keyPair.publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
            metadataVersion: 1, dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        } });
        const poolId = crypto.randomUUID();
        await db.machinePool.create({ data: { id: poolId, accountId: owner.id, name: storedPlainPrivateLabel('Pool') } });
        const actionId = 'machines.pools.delete';
        const credential = await auth.createToken(owner.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        await withAuthenticatedTestApp(app => {
            registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
            registerMachinePoolRoutes(app, { io: { in: () => ({ fetchSockets: async () => [] }) } });
        }, async app => {
            const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
                headers: { authorization: `Bearer ${credential}` }, payload: { v: 1, machineId: machine.id,
                    envelope: { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: machine.id },
                        input: { poolId, expectedRevision: 0 } } } });
            expect(minted.statusCode, minted.body).toBe(200);
            const { token, binding } = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
            const prepare = (path: string, body: unknown) => app.inject({
                method: 'POST', url: path, payload: body, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(binding.target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: token, effectActionId: actionId, target: binding.target, installationId: machine.installationId!,
                        requestId: binding.requestId, method: 'POST', path, body, privateKey: keyPair.secretKey,
                    }),
                },
            });
            const prepared = await prepare(machinePoolActionEndpointPathV1(actionId), { poolId, prepareDelete: true });
            expect(prepared.statusCode, prepared.body).toBe(200);
            expect(prepared.json()).toEqual({ witness: expect.any(String) });
            expect(await db.machinePool.findUnique({ where: { id: poolId } })).not.toBeNull();
            expect((await prepare(machinePoolActionEndpointPathV1('machines.pools.get'), { poolId })).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it('shares the reviewed consequence with native and Agent approval and refuses same-count replacement', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const visibleTeam = await db.team.create({ data: { name: 'Visible Team' } });
        const hiddenTeam = await db.team.create({ data: { name: 'Departed Team' } });
        await db.teamMembership.create({ data: { teamId: visibleTeam.id, accountId: owner.id, role: 'member' } });
        const register = (app: Parameters<typeof registerMachinePoolRoutes>[0]) =>
            registerMachinePoolRoutes(app, { io: { in: () => ({ fetchSockets: async () => [] }) } });
        await withAuthenticatedTestApp(register, async app => {
            const poolId = crypto.randomUUID();
            const emptyPoolId = crypto.randomUUID();
            const ownerHeaders = { 'x-test-user-id': owner.id };
            for (const id of [poolId, emptyPoolId]) {
                const response = await app.inject({ method: 'POST', url: '/v1/machines/pools/create',
                    headers: ownerHeaders, payload: { poolId: id, name: plainPrivateLabel('Builders'), members: [] } });
                expect(response.statusCode, response.body).toBe(200);
            }
            const assignBroker = (teamId: string) => db.teamCredentialResource.create({ data: {
                teamId, custodianAccountId: owner.id, displayName: 'Brokered source',
                disclosureCeiling: 'direct_allowed', sessionUsePolicy: 'personal_allowed', allMembersDeliveryMode: 'both',
                brokerPoolId: poolId, sourceBindingJson: JSON.stringify({ v: 1, kind: 'provider_connection',
                    connectionId: 'connection', connectionSecurityFingerprint: 'connection-security:v1:test:pool-review',
                    credentialSlotId: 'apiKey' }),
            } });
            const visible = await assignBroker(visibleTeam.id);
            const hidden = await assignBroker(hiddenTeam.id);
            const input = { poolId, expectedRevision: 0 };
            let request: ApprovalRequest | null = null;
            let nativePreview: unknown;
            let confirmNative = false;
            const machinePoolAction: NonNullable<ActionExecutorDeps['machinePoolAction']> = async ({ actionId, input, context }) => {
                const response = await app.inject({ method: 'POST', url: machinePoolActionEndpointPathV1(actionId),
                    headers: { 'x-test-user-id': context.runtimeAccountId ?? owner.id }, payload: input });
                if (response.statusCode !== 200) {
                    const error = MachinePoolErrorV1Schema.parse(response.json());
                    return { ok: false, errorCode: error.code, error: error.code, details: error };
                }
                const wire = MachinePoolWireOutputSchemasV1[actionId].parse(response.json());
                return await openMachinePoolActionOutputV1(wire, view => ({
                    ...view, pool: { ...view.pool, name: 'Builders', description: null },
                }));
            };
            const executor = createActionExecutor({
                machinePoolAction,
                approvalsCreate: async ({ request: next }) => {
                    request = ApprovalRequestV2Schema.parse(next);
                    return { artifactId: 'pool-delete-review' };
                },
                approvalsGet: async () => request,
                approvalsUpdate: async ({ request: next }) => {
                    request = ApprovalRequestV2Schema.parse(next);
                    return { ok: true };
                },
                isApprovalExecutionOriginCurrent: async () => true,
                presentUserActionConfirmation: async ({ preview }) => {
                    nativePreview = preview;
                    return confirmNative;
                },
            });
            const ui = { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: owner.id } as const;
            const agent = { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
                serverId: 'home', runtimeAccountId: owner.id, actionRequestId: 'delete-pool-attempt' } as const;
            await expect(executor.execute('machines.pools.delete', input, ui))
                .resolves.toMatchObject({ ok: false, errorCode: 'approval_canceled' });
            const receipt = await executor.execute('machines.pools.delete', input, agent);
            expect(receipt).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            const stored = ApprovalRequestV2Schema.parse(request);
            const effect = { assignmentCount: 2, visibleTeamNames: [visibleTeam.name] };
            expect(nativePreview).toHaveProperty('teamCredentialBrokerAssignments', effect);
            expect(stored.preview).toHaveProperty('teamCredentialBrokerAssignments', effect);
            expect(JSON.stringify(stored.preview)).not.toContain(hiddenTeam.name);
            await expect(executor.execute('machines.pools.delete', input, { ...ui, runtimeAccountId: outsider.id }))
                .resolves.toMatchObject({ ok: false, errorCode: 'pool_not_found' });

            await db.teamCredentialResource.update({ where: { id: hidden.id }, data: { brokerPoolId: null } });
            const replacement = await assignBroker(hiddenTeam.id);
            request = ApprovalRequestV2Schema.parse({
                ...stored, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 },
            });
            await executor.replayApprovedApprovalRequest({ artifactId: 'pool-delete-review' });
            expect(request).toMatchObject({ status: 'failed', execution: { errorCode: 'pool_changed' } });
            expect(await db.machinePool.findUnique({ where: { id: poolId } })).not.toBeNull();
            expect(await db.teamCredentialResource.count({ where: { brokerPoolId: poolId } })).toBe(2);

            confirmNative = true;
            await expect(executor.execute('machines.pools.delete', input, ui)).resolves.toMatchObject({
                ok: true, result: { poolId, deleted: true },
            });
            for (const row of [visible, replacement]) {
                expect(await db.teamCredentialResource.findUniqueOrThrow({ where: { id: row.id } }))
                    .toMatchObject({ brokerPoolId: null, revision: row.revision + 1 });
            }
            await expect(executor.execute('machines.pools.delete', { ...input, poolId: emptyPoolId }, ui))
                .resolves.toMatchObject({ ok: true, result: { poolId: emptyPoolId, deleted: true } });
            expect(nativePreview).not.toHaveProperty('teamCredentialBrokerAssignments');
        });
    });
});
