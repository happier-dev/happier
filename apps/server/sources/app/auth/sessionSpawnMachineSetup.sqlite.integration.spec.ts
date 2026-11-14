import { Server } from 'socket.io';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { resolveExternalActionExecutionMachineAdmissionInTx, verifyCurrentExternalActionPrincipal, verifyWorkflowExternalActionRequesterAuthorization } from './externalActionExecutionAuthorization';
import { randomUUID } from 'node:crypto';
import { projectSessionSpawnNewApiRequest } from '@happier-dev/protocol/actions/specs/session/lifecycle';
import { admitSessionSpawnNewActionInputV2, SessionSpawnNewActionInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { BotTemplateInstantiateInputV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { buildBotTemplateMachineSetupPlanInputV1, prepareBotTemplateSetupV1 } from '@happier-dev/protocol/bots/templates/templateSetupV1';
import { computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1,
    encodeReviewedActionChildHttpProofV1, signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    EXTERNAL_ACTION_REVIEWED_CHILD_HEADER, ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1,
    projectExternalActionDeploymentPreparationEnvelopeAdmissionV1, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { auth } from './auth';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedDiscussionHttpFixture } from '@/app/api/routes/actions/discussionExecutionAuthorization.testkit';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { db } from '@/storage/db';
import { MachineOperationProtocolCapabilitiesV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { inTx } from '@/storage/inTx';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { admitWorkflowRun } from '@/app/workflows/workflowRunService';
import { claimAutomationRun } from '@/app/automations/automationClaimService';
import { fetchAutomationAccountCurrentnessWitnessTx } from '@/app/automations/automationAccountCurrentness';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { preparePlainAccountApiTokenLabel } from "@/testkit/privateLabelFixture";

describe('spawn-reviewed Machine software setup HTTP authority', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-spawn-setup-auth-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('admits the real public PAT spawn projection before reviewing Machine setup', async () => {
        const f = await createSignedDiscussionHttpFixture(undefined, [], false, undefined, {
            allowedActionIds: ['session.spawn_new', ...Object.values(SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1).map(child => child.action)],
        });
        try {
            const homeId = await getOrCreateServerIdentityId();
            const canonical = SessionSpawnNewActionInputV2Schema.parse({ creationKey: randomUUID(),
                executionTarget: { serverId: homeId, machineId: f.machine.id }, directory: { kind: 'managed' },
                memoryEnabled: false,
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                connectedServices: { v: 2, bindingsByServiceId: {} },
                organizationPlacement: { sectionId: 'leads', tagIds: ['inbound'] },
                machineSetupPlanInput: { homeId, machineId: f.machine.id, sources: [{ kind: 'direct', setup: {} }] },
            });
            const projected = projectSessionSpawnNewApiRequest(canonical);
            const envelope = { v: 1 as const, requestId: randomUUID(), ...projected };
            const mint = (envelope: unknown, token = f.pat.token) => f.app.inject({ method: 'POST',
                url: bindExternalActionExecutionAuthorizationHttpPathV1('session.spawn_new'),
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, machineId: f.machine.id, envelope } });
            const response = await mint(envelope);
            expect(response.statusCode, response.body).toBe(200);
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            expect(authorization.binding).toMatchObject({ accountId: f.account.id, credentialId: f.pat.tokenId,
                actionId: 'session.spawn_new', machineId: f.machine.id, target: projected.target,
                admittedMachineRole: 'manage', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(ExternalActionRequestEnvelopeSchema.parse(envelope)) });
            expect(await auth.verifyExternalActionExecutionAuthorization(authorization.token)).toEqual(authorization.binding);
            expect(authorization.binding).toMatchObject({ grant: f.pat.grant });
            const creationGrant = ApiTokenGrantV1Schema.parse({ ...f.pat.grant, create: {
                machineId: f.machine.id, agentTargetKey: 'agent:happier.agent.codex/codex', directory: 'managed',
                placement: admitSessionSpawnNewActionInputV2(canonical).organizationPlacement, connectedServices: canonical.connectedServices,
            } });
            const constrained = await auth.createApiToken({ accountId: f.account.id, tokenId: randomUUID(),
                label: await preparePlainAccountApiTokenLabel(f.account.id, 'Public spawn creation ceiling'), grant: creationGrant,
                authenticationEvidence: [{ kind: 'home_method', methodId: 'email_password' }] });
            const publicConstrained = await mint({ ...envelope, requestId: randomUUID() }, constrained.token);
            expect(publicConstrained.statusCode, publicConstrained.body).toBe(200);
            expect(ExternalActionExecutionAuthorizationV1Schema.parse(publicConstrained.json()).binding)
                .toMatchObject({ credentialId: constrained.tokenId, grant: creationGrant });
            const internal = await mint({ ...envelope, requestId: randomUUID(), input: canonical }, constrained.token);
            expect(internal.statusCode, internal.body).toBe(200);
            expect(ExternalActionExecutionAuthorizationV1Schema.parse(internal.json()).binding)
                .toMatchObject({ credentialId: constrained.tokenId, grant: creationGrant });
            const changedPlacement = await mint({ ...envelope, requestId: randomUUID(), input: {
                ...projected.input, organizationPlacement: { sectionId: 'other', tagIds: ['inbound'] },
            } }, constrained.token);
            expect(changedPlacement.statusCode, changedPlacement.body).toBe(403);
            expect(changedPlacement.json()).toMatchObject({ error: 'credential_scope_denied' });
            const mismatchedTarget = await mint({ ...envelope, target: { kind: 'machine', machineId: randomUUID() } });
            expect(mismatchedTarget.statusCode, mismatchedTarget.body).toBe(400);
            expect(mismatchedTarget.json()).toMatchObject({ code: 'invalid_envelope' });
            const malformed = await mint({ ...envelope, input: { ...projected.input, requesterAccountId: 'another-account' } });
            expect(malformed.statusCode, malformed.body).toBe(409);
            expect(malformed.json()).toMatchObject({ code: 'target_unavailable' });
        } finally { await f.app.close(); }
    });

    it.each<{ credential: string; presentUser: boolean; allowedSetupActions?: readonly ActionId[] }>([
        { credential: 'Account', presentUser: true },
        { credential: 'unrestricted PAT', presentUser: false },
        { credential: 'spawn-only PAT', presentUser: false, allowedSetupActions: [] },
        { credential: 'spawn and Plan PAT', presentUser: false, allowedSetupActions: [SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action] },
        { credential: 'spawn and Apply PAT', presentUser: false, allowedSetupActions: [SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action] },
    ])('spends signed Manage spawn admission only within the credential ceiling ($credential)', async ({ presentUser, allowedSetupActions }) => {
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const f = await createSignedDiscussionHttpFixture(undefined, [], false, custodian.id, { machineReads: true,
            ...(allowedSetupActions === undefined ? {} : { allowedActionIds: ['session.spawn_new', ...allowedSetupActions] }) });
        try {
            await db.machine.update({ where: { id: f.machine.id }, data: { active: true, operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({
                    requesterExecutionIsolation: { protocolVersions: [1] } }) } });
            const homeId = await getOrCreateServerIdentityId();
            const target = { kind: 'machine' as const, machineId: f.machine.id };
            const sources = [{ kind: 'direct' as const, setup: {} }];
            const plan = { homeId, machineId: f.machine.id, sources };
            const envelope = { v: 1 as const, requestId: randomUUID(), target, input: {
                executionTarget: { serverId: homeId, machineId: f.machine.id }, directory: { kind: 'path', path: '/workspace' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, machineSetupPlanInput: plan } };
            const principal = (await auth.verifyToken(f.pat.token))?.apiTokenPrincipal;
            if (!principal) throw new Error('Expected the real API credential');
            if (allowedSetupActions !== undefined) {
                expect(principal.grant.actions).toEqual({ families: [], ids: ['session.spawn_new', ...allowedSetupActions] });
            }
            const mint = (admittedMachineRole: 'use' | 'manage') => auth.mintExternalActionExecutionAuthorization({
                accountId: f.account.id, principalId: principal.principalId,
                credentialId: principal.credentialId, grant: principal.grant,
                serverIdentityId: homeId, actionId: 'session.spawn_new', machineId: f.machine.id, target,
                requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                admittedMachineRole });
            const authorization = await f.mint('session.spawn_new', envelope.input, presentUser);
            expect(authorization.binding.admittedMachineRole).toBe('manage');
            expect(await auth.verifyExternalActionExecutionAuthorization(authorization.token)).toEqual(authorization.binding);
            if (presentUser) {
                await db.machine.update({ where: { id: f.machine.id }, data: { operationProtocolCapabilities:
                    MachineOperationProtocolCapabilitiesV1Schema.parse({ requesterExecutionIsolation: { protocolVersions: [1] },
                        externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
                const principal = await verifyCurrentExternalActionPrincipal(authorization.binding);
                if (!principal) throw new Error('Expected signed Account requester');
                let capturedAuthorization: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
                let admittedDaemonReachable = false;
                const dispatch = createExternalActionDaemonDispatcher({ io: new Server(), forwardRpc: async request => {
                    if (!request.callParams || typeof request.callParams !== 'object') throw new Error('Expected daemon request');
                    capturedAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(Reflect.get(request.callParams, 'executionAuthorization'));
                    expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                        machineId: f.machine.id, principal: { kind: 'account', accountId: f.account.id } }))).toMatchObject({ kind: 'removed' });
                    const target = { id: 'admitted-daemon', data: { clientType: 'machine-scoped', userId: custodian.id,
                        machineId: f.machine.id, verifiedMachineInstallationId: f.machine.installationId },
                        timeout: () => { throw new Error('Boundary fixture does not send Socket events'); } };
                    const targets = await request.targetGuard?.filterTargets([target]);
                    admittedDaemonReachable = targets?.[0] === target;
                    expect(await request.targetGuard?.filterTargets([{ ...target, data: { ...target.data, machineId: randomUUID() } }])).toEqual([]);
                    expect(await request.targetGuard?.filterTargets([{ ...target, data: { ...target.data, verifiedMachineInstallationId: randomUUID() } }])).toEqual([]);
                    return { ok: false, error: 'Boundary observation complete' };
                } });
                await dispatch({ actionId: 'session.spawn_new', principal, envelope });
                expect(capturedAuthorization?.binding.admittedMachineRole).toBe('manage');
                expect(admittedDaemonReachable).toBe(true);
                if (!capturedAuthorization) throw new Error('Expected outgoing signed root');
                expect(await dispatch({ actionId: 'session.spawn_new', principal, executionAuthorization: capturedAuthorization,
                    envelope: { ...envelope, input: { ...envelope.input, directory: { kind: 'path', path: '/tampered' } } } }))
                    .toMatchObject({ kind: 'placement_error', code: 'credential_scope_denied' });
                // The admitted root delivers only to its own Machine: redirecting it to another target is refused.
                const elsewhere = { kind: 'machine' as const, machineId: randomUUID() };
                expect(await dispatch({ actionId: 'session.spawn_new', principal, executionAuthorization: capturedAuthorization,
                    envelope: { ...envelope, target: elsewhere, input: { ...envelope.input,
                        executionTarget: { serverId: homeId, machineId: elsewhere.machineId } } } }))
                    .toMatchObject({ kind: 'placement_error' });
            } else {
                expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                    machineId: f.machine.id, principal: { kind: 'account', accountId: f.account.id } }))).toMatchObject({ kind: 'removed' });
            }
            const fresh = await f.app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.spawn_new'),
                headers: { authorization: `Bearer ${presentUser ? f.presentUserToken : f.pat.token}` },
                payload: { v: 1, machineId: f.machine.id, envelope: { ...envelope, requestId: randomUUID() } } });
            expect(fresh.statusCode).not.toBe(200);
            const resolve = { homeId, machineId: f.machine.id, sources };
            const report = { homeId, machineId: f.machine.id, managedId: randomUUID(), presetId: randomUUID(), presetRevision: 1,
                state: 'running' as const, operation: { operationId: randomUUID() } };
            for (const { action: effectActionId, role } of Object.values(SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1)) {
                const reviewedChild = { actionId: effectActionId, role,
                    inputDigest: computeActionInputApprovalDigestV1(effectActionId, effectActionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action ? { ...plan, mode: 'effects' }
                        : { homeId, machineId: f.machine.id, sources, recipePlans: [] }) };
                const request = { method: 'POST', path: '/v1/machines/setup/resolve', body: resolve, reviewedChild };
                const verified = await f.verify(authorization, request, effectActionId);
                const headers = { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, installationId: f.machine.installationId!, requestId: authorization.binding.requestId,
                        target, effectActionId, method: request.method, path: request.path, body: resolve, reviewedChild,
                        privateKey: f.keyPair.secretKey }) };
                const response = await f.app.inject({ method: 'POST', url: request.path, payload: resolve, headers });
                const allowedEffect = allowedSetupActions === undefined || allowedSetupActions.includes(effectActionId);
                expect(response.statusCode, response.body).toBe(allowedEffect ? 200 : 401);
                if (!allowedEffect) {
                    expect(response.json()).toMatchObject({ error: 'invalid_token' });
                    expect(verified).toBeNull();
                    continue;
                }
                expect(verified).toMatchObject({
                    binding: { actionId: 'session.spawn_new', admittedMachineRole: 'manage' },
                    effectActionId, reviewedChildAdmission: reviewedChild });
                expect(response.json()).toEqual({ sources });
                const unsigned = await f.app.inject({ method: 'POST', url: request.path, payload: resolve,
                    headers: { ...headers, [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: 'A'.repeat(86) } });
                expect(unsigned.statusCode).toBe(401);
                expect(unsigned.json()).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'machine_signature' });
                // The generic reviewed-child owner binds the signed child action; role labels are descriptive.
                for (const changedRole of ['unreviewed', effectActionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action
                    ? SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.role : SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.role]) {
                    const child = { ...reviewedChild, role: changedRole };
                    await expect(f.verify(authorization, { ...request, reviewedChild: child }, effectActionId))
                        .resolves.toMatchObject({ effectActionId, reviewedChildAdmission: child });
                    const tampered = await f.app.inject({ method: 'POST', url: request.path, payload: resolve,
                        headers: { ...headers, [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(child) } });
                    expect(tampered.statusCode).toBe(401);
                    expect(tampered.json()).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'machine_signature' });
                }
                for (const changed of [
                    { ...request, reviewedChild: undefined },
                    { ...request, reviewedChild: { ...reviewedChild, actionId: effectActionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action
                        ? SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action : SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action } },
                    { ...request, body: { ...resolve, machineId: randomUUID() } },
                    { ...request, body: { ...resolve, homeId: randomUUID() } },
                    { ...request, path: '/v1/machines/managed/controller/context' },
                ]) await expect(f.verify(authorization, changed, effectActionId)).resolves.toBeNull();
                await expect(f.verify(await mint('use'), request, effectActionId)).resolves.toBeNull();
                for (const path of ['/v1/account/encryption/currentness', `/v1/machines/${f.machine.id}`]) {
                    await expect(f.verify(authorization, { method: 'GET', path, reviewedChild }, effectActionId)).resolves.not.toBeNull();
                }
                await expect(f.verify(authorization, { method: 'GET', path: '/v1/machines', reviewedChild }, effectActionId)).resolves.toBeNull();
                await expect(f.verify(authorization, { method: 'GET', path: `/v1/machines/${randomUUID()}`, reviewedChild }, effectActionId)).resolves.toBeNull();
                const verifiedReport = await f.verify(authorization, { method: 'POST', path: '/v1/machines/setup/report',
                    body: report, reviewedChild }, effectActionId);
                expect(verifiedReport !== null).toBe(effectActionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action);
            }
        } finally { await f.app.close(); }
    });

    it('refuses Use spawn with setup at admission and explains the Manage remedy', async () => {
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const f = await createSignedDiscussionHttpFixture(undefined, [], false, custodian.id);
        try {
            await db.machine.update({ where: { id: f.machine.id }, data: { active: true, operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({
                    requesterExecutionIsolation: { protocolVersions: [1] }, externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
            expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                machineId: f.machine.id, principal: { kind: 'account', accountId: f.account.id }, level: 'view' })))
                .toMatchObject({ kind: 'saved' });
            const homeId = await getOrCreateServerIdentityId();
            const input = { executionTarget: { serverId: homeId, machineId: f.machine.id },
                directory: { kind: 'path', path: '/workspace' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
            const ordinary = await f.mint('session.spawn_new', input, true);
            expect(ordinary.binding.admittedMachineRole).toBe('use');
            const response = await f.app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('session.spawn_new'),
                headers: { authorization: `Bearer ${f.presentUserToken}` }, payload: { v: 1, machineId: f.machine.id,
                    envelope: { v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId: f.machine.id },
                        input: { ...input, machineSetupPlanInput: { homeId, machineId: f.machine.id,
                            sources: [{ kind: 'direct', setup: {} }] } } } } });
            expect(response.statusCode).toBe(409);
            expect(response.json()).toMatchObject({ error: 'invalid_request', code: 'target_unavailable', diagnostic: {
                reason: 'machine_setup_requires_manage', requiredFact: 'machine_manage_role', remedy: 'request_machine_manage_access' } });
            const principal = await verifyCurrentExternalActionPrincipal(ordinary.binding);
            if (!principal) throw new Error('Expected ordinary signed Account principal');
            expect(await resolveExternalActionExecutionMachineAdmissionInTx(db, { actorAccountId: f.account.id, machineId: f.machine.id,
                actionId: 'session.spawn_new', callerAuthority: principal.authority, envelope: { v: 1, requestId: randomUUID(),
                    target: { kind: 'machine', machineId: f.machine.id }, input: { ...input, machineSetupPlanInput: { homeId, machineId: f.machine.id,
                        sources: [{ kind: 'direct', setup: {} }] } } } }))
                .toMatchObject({ kind: 'denied', diagnostic: { reason: 'machine_setup_requires_manage' } });
            const dispatch = createExternalActionDaemonDispatcher({ io: new Server(),
                forwardRpc: async () => { throw new Error('Use setup reached the daemon transport'); } });
            expect(await dispatch({ actionId: 'session.spawn_new', principal, envelope: { v: 1, requestId: randomUUID(),
                target: { kind: 'machine', machineId: f.machine.id }, input: { ...input,
                    machineSetupPlanInput: { homeId, machineId: f.machine.id, sources: [{ kind: 'direct', setup: {} }] } } } }))
                .toMatchObject({ kind: 'placement_error', code: 'target_unavailable', machineAvailabilityDiagnostic: {
                    reason: 'machine_setup_requires_manage', requiredFact: 'machine_manage_role', remedy: 'request_machine_manage_access' } });
        } finally { await f.app.close(); }
    });

    it('retains shared Manage through installed Workflow setup without lending the grant to another Account', async () => {
        const custodian = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const f = await createSignedDiscussionHttpFixture(undefined, [], false, custodian.id);
        try {
            await db.machine.update({ where: { id: f.machine.id }, data: { active: true, operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({
                    requesterExecutionIsolation: { protocolVersions: [1] }, externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
            const homeId = await getOrCreateServerIdentityId();
            const target = { kind: 'machine' as const, machineId: f.machine.id };
            const sources = [{ kind: 'direct' as const, setup: {} }];
            const parent = await f.mint('session.spawn_new', { executionTarget: { serverId: homeId, machineId: f.machine.id },
                directory: { kind: 'path', path: '/workspace' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                machineSetupPlanInput: { homeId, machineId: f.machine.id, sources } }, true);
            expect(parent.binding).toMatchObject({ accountId: f.account.id, custodianAccountId: custodian.id, admittedMachineRole: 'manage' });
            const reviewedChild = { actionId: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action,
                role: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.role,
                inputDigest: computeActionInputApprovalDigestV1(SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action,
                    { homeId, machineId: f.machine.id, sources, recipePlans: [] }) };
            const runId = deriveMachineSetupCombinedRunIdV1({ homeId, accountId: f.account.id,
                requestId: parent.binding.requestId, reviewedChild });
            const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
                definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'review',
                    document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] },
                context: { source: { kind: 'inline' }, inputs: {}, machineId: f.machine.id, executionTarget: { kind: 'session' },
                    workspaceTarget: { project: { machineId: f.machine.id, directory: '/workspace', checkoutRootPath: '/workspace' } },
                    origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
            });
            const accountCurrentness = await fetchAutomationAccountCurrentnessWitnessTx(db, f.account.id);
            if (!accountCurrentness) throw new Error('Expected Account currentness');
            await admitWorkflowRun({ accountId: f.account.id, machineId: f.machine.id, runId, accountCurrentness,
                origin: { kind: 'direct' }, acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                    mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: f.account.id, runId }, acceptedSnapshot: snapshot })) });
            expect((await claimAutomationRun({ accountId: f.account.id, machineId: f.machine.id,
                leaseDurationMs: 30_000, scope: 'workflow', claimRequest: { machineInstallationId: f.machine.installationId!,
                    nonce: randomUUID(), expiresAt: new Date(Date.now() + 30_000) } })).run?.id).toBe(runId);
            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                machineId: f.machine.id, principal: { kind: 'account', accountId: f.account.id } }))).toMatchObject({ kind: 'removed' });
            const requestId = `${runId}/${randomUUID()}/0`;
            const envelope = { v: 1 as const, requestId, target, input: { homeId, machineId: f.machine.id,
                targets: [{ homeId, machineId: f.machine.id, desiredRevision: 0, sources, recipePlans: [] }] } };
            const workflowActionOrigin = { runId, requestId, reviewedChild };
            const buildRequest = (accountId: string, origin = workflowActionOrigin, installationId = f.machine.installationId!) => ({ v: 1, machineId: f.machine.id, envelope,
                executionAuthorization: parent, workflowActionOrigin: origin,
                installationProof: signMachineInstallationProof({ privateKey: f.keyPair.secretKey,
                    payload: { version: 1, accountId, machineId: f.machine.id, installationId,
                        externalActionOrigin: { homeId, actionId: 'machines.setup.apply', requestId,
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin } } }) });
            const path = bindExternalActionExecutionAuthorizationHttpPathV1('machines.setup.apply');
            const foreign = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
            const foreignToken = await auth.createToken(foreign.id, undefined, { kind: 'account', authority: 'present_user' });
            const refused = await f.app.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${foreignToken}` },
                payload: buildRequest(foreign.id) });
            expect(refused.statusCode).toBe(403);
            const invalidProof = await f.app.inject({ method: 'POST', url: path,
                headers: { authorization: `Bearer ${f.presentUserToken}` }, payload: { ...buildRequest(f.account.id),
                    installationProof: { ...buildRequest(f.account.id).installationProof, signature: 'A'.repeat(86) } } });
            expect(invalidProof.statusCode).not.toBe(200);
            for (const payload of [
                buildRequest(f.account.id, { ...workflowActionOrigin, runId: randomUUID() }),
                buildRequest(f.account.id, workflowActionOrigin, randomUUID()),
                { ...buildRequest(f.account.id), executionAuthorization: { ...parent,
                    binding: { ...parent.binding, admittedMachineRole: 'use' } } },
            ]) {
                const refused = await f.app.inject({ method: 'POST', url: path,
                    headers: { authorization: `Bearer ${f.presentUserToken}` }, payload });
                expect(refused.statusCode, refused.body).toBe(403);
            }
            const response = await f.app.inject({ method: 'POST', url: path,
                headers: { authorization: `Bearer ${f.presentUserToken}` }, payload: buildRequest(f.account.id) });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ binding: { accountId: f.account.id, custodianAccountId: custodian.id,
                machineId: f.machine.id, admittedMachineRole: 'manage', workflowActionOrigin } });
            const leaf = ExternalActionExecutionAuthorizationV1Schema.parse(response.json());
            const principal = await verifyCurrentExternalActionPrincipal(leaf.binding);
            const workflowAdmission = await verifyWorkflowExternalActionRequesterAuthorization({ authorization: parent,
                origin: workflowActionOrigin, publisherAccountId: f.account.id, publisherCustodianAccountId: custodian.id,
                publisherMachineId: f.machine.id, publisherInstallationId: f.machine.installationId!, target,
                // The route spends the child's exact Setup operands against the parent scope (72105c7511a).
                preparationAdmission: projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId: 'machines.setup.apply', envelope }) });
            if (!principal || !workflowAdmission) throw new Error('Expected verified retained Workflow requester');
            let guardedTarget = false;
            const dispatch = createExternalActionDaemonDispatcher({ io: new Server(), forwardRpc: async request => {
                const target = { id: 'admitted-daemon', data: { clientType: 'machine-scoped', userId: custodian.id,
                    machineId: f.machine.id, verifiedMachineInstallationId: f.machine.installationId },
                    timeout: () => { throw new Error('Boundary fixture does not send Socket events'); } };
                const targets = await request.targetGuard?.filterTargets([target]);
                guardedTarget = targets?.[0] === target;
                return { ok: false, error: 'Boundary observation complete' };
            } });
            await dispatch({ actionId: 'machines.setup.apply', principal, envelope, executionAuthorization: leaf, workflowAdmission });
            expect(guardedTarget).toBe(true);
            await db.automationRun.update({ where: { id: runId }, data: { state: 'cancelled' } });
            const completed = await f.app.inject({ method: 'POST', url: path,
                headers: { authorization: `Bearer ${f.presentUserToken}` }, payload: buildRequest(f.account.id) });
            expect(completed.statusCode).toBe(403);
            expect(await db.machine.findUniqueOrThrow({ where: { id: f.machine.id }, select: { accountId: true } }))
                .toEqual({ accountId: custodian.id });
        } finally { await f.app.close(); }
    });

    it('resolves the generic reviewed setup Plan used by template instantiation', async () => {
        const f = await createSignedDiscussionHttpFixture(undefined, [], false, undefined, { machineReads: true });
        try {
            await db.machine.update({ where: { id: f.machine.id }, data: { active: true, operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({
                    requesterExecutionIsolation: { protocolVersions: [1] } }) } });
            const homeId = await getOrCreateServerIdentityId();
            const input = BotTemplateInstantiateInputV1Schema.parse({
                source: { kind: 'artifact', serverId: homeId, artifactId: randomUUID() }, expectedVersion: '1.0.0',
                expectedRevision: { headerVersion: 1, bodyVersion: 1 },
                creation: { creationKey: randomUUID(), executionTarget: { serverId: homeId, machineId: f.machine.id },
                    directory: { kind: 'path', path: '/workspace' },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
                setup: { software: [{ key: 'git', selection: { action: 'install', inputs: {} } }], accounts: [], mcpServers: [] },
            });
            const setup = prepareBotTemplateSetupV1({ software: [{ key: 'git', name: 'Git', requirement: 'required',
                purpose: 'Read changes', skipConsequence: '', recipe: { pluginId: 'test.tools', recipeId: 'git', revision: '1' } }],
                connectedAccounts: [], mcpServers: [] }, input.setup);
            if (!setup.machineSetup) throw new Error('Expected the selected template software');
            const plan = buildBotTemplateMachineSetupPlanInputV1({ homeId, machineId: f.machine.id }, setup.machineSetup);
            const authorization = await f.mint('template.instantiate', input);
            expect(authorization.binding.admittedMachineRole).toBe('manage');
            const effectActionId = 'machines.setup.plan' as const;
            const reviewedChild = { actionId: effectActionId, role: 'template_setup_plan',
                inputDigest: computeActionInputApprovalDigestV1(effectActionId, plan) };
            const body = { homeId, machineId: f.machine.id, sources: plan.sources };
            const path = '/v1/machines/setup/resolve';
            await expect(f.verify(authorization, { method: 'POST', path, body, reviewedChild }, effectActionId))
                .resolves.toMatchObject({ effectActionId, reviewedChildAdmission: reviewedChild });
            const headers = { [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
                [EXTERNAL_ACTION_REVIEWED_CHILD_HEADER]: encodeReviewedActionChildHttpProofV1(reviewedChild),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, installationId: f.machine.installationId!, requestId: authorization.binding.requestId,
                    target: authorization.binding.target, effectActionId, method: 'POST', path, body, reviewedChild,
                    privateKey: f.keyPair.secretKey }) };
            const response = await f.app.inject({ method: 'POST', url: path, payload: body, headers });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ sources: plan.sources });
        } finally { await f.app.close(); }
    });
});
