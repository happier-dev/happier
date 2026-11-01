import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import nacl from 'tweetnacl';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1,
    bindExternalActionExecutionAuthorizationVerifyHttpPathV1, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    type ExternalActionRequestEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { createLightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from '@/app/automations/automationAccountCurrentness';
import { claimAutomationRun } from '@/app/automations/automationClaimService';
import { decodeBase64, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import { admitWorkflowRun } from '@/app/workflows/workflowRunService';
import { hasCurrentExternalActionWorkflowOriginInTx, verifyCurrentExternalActionPrincipal,
    verifyCurrentExternalActionPrincipalInTx } from '@/app/auth/externalActionExecutionAuthorization';
import { db } from '@/storage/db';

// Reuse the committed database/auth boundary; this test needs no deployment/socket fixture.
async function startSessionChildServer() {
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'workflow-session-child-', initAuth: true, initEncrypt: true,
        env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_SERVER_IDENTITY_ID: `srv_${randomUUID().replaceAll('-', '')}`,
            HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    try {
        enableSchemaValidation(app); enableErrorHandlers(app); enableAuthentication(app);
        registerExternalActionRoutes(app);
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'leaf', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier' }),
            dataEncryptionKey: Uint8Array.from(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)), active: true,
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
            installationId: randomUUID(), installationPublicKey: Uint8Array.from(keys.publicKey) } });
        const currentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({ where: { id: account.id },
            select: automationAccountCurrentnessSelect }));
        if (!currentness) throw new Error('workflow_test_account_currentness_unavailable');
        return { accountId: account.id, token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }),
            machines: [{ id: machine.id, installationId: machine.installationId!, keys }],
            currentness, homeId: await getOrCreateServerIdentityId(),
            baseUrl: await app.listen({ host: '127.0.0.1', port: 0 }),
            claim: async (machineId: string) => {
                const result = await claimAutomationRun({ accountId: account.id, machineId, leaseDurationMs: 30_000, scope: 'workflow' });
                if (!result.run) throw new Error('workflow_test_claim_unavailable');
            },
            createForeignAccount: async () => {
                const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
                return { accountId: foreign.id, token: await auth.createToken(foreign.id, undefined, { kind: 'account', authority: 'present_user' }) };
            },
            close: async () => { try { await app.close(); } finally { await harness.close(); } } };
    } catch (error) {
        try { await app.close(); } finally { await harness.close(); }
        throw error;
    }
}
let server: Awaited<ReturnType<typeof startSessionChildServer>>;
beforeAll(async () => { server = await startSessionChildServer(); }, 120_000);
afterAll(async () => { if (server) await server.close(); });

it('admits the signed Session child only under its own active admitted Run and preserves attribution', async () => {
    const [publisher] = server.machines;
    const runId: string = randomUUID();
    const snapshot = await materializeWorkflowAcceptedSnapshotFixture({
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'leaf',
            document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: publisher.id, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: publisher.id, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
    });
    await admitWorkflowRun({ accountId: server.accountId, machineId: publisher.id, runId,
        accountCurrentness: server.currentness, origin: { kind: 'direct' },
        acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: server.accountId, runId }, acceptedSnapshot: snapshot })) });
    await server.claim(publisher.id);
    const actionId = 'workflow.definition.create';
    const target = { kind: 'machine' as const, machineId: publisher.id };
    const envelope: ExternalActionRequestEnvelopeV1 = { v: 1, requestId: randomUUID(), target, input: { name: 'Child' } };
    const origin = { runId, requestId: envelope.requestId!, sessionLeaf: { invocationId: 'admitted-leaf',
        caller: { kind: 'session' as const, sessionId: 'leaf-session', starterDepth: 1, turnDepth: 2 },
        authorization: snapshot.authorization, workspaceWrites: 'deny' as const,
        actionRequestAttributionV1: { requestRef: 'retained-input', requester: { serverId: server.homeId, accountId: server.accountId },
            persona: { serverId: server.homeId, sessionId: 'original-session' }, origin: null } } };
    const mint = async (signedOrigin = origin, sentOrigin = signedOrigin,
        requester = { accountId: server.accountId, token: server.token }) => {
        const installationProof = signMachineInstallationProof({ privateKey: publisher.keys.secretKey, payload: {
            version: 1, machineId: publisher.id, installationId: publisher.installationId, accountId: requester.accountId,
            externalActionOrigin: { homeId: server.homeId, actionId, requestId: envelope.requestId!,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: signedOrigin } } });
        return fetch(`${server.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`, { method: 'POST',
            headers: { Authorization: `Bearer ${requester.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ v: 1, machineId: publisher.id, envelope, workflowActionOrigin: sentOrigin, installationProof }) });
    };
    const response = await mint();
    expect(response.status, await response.clone().text()).toBe(200);
    const admitted = ExternalActionExecutionAuthorizationV1Schema.parse(await response.json());
    expect(admitted.binding.workflowActionOrigin).toEqual(origin);
    const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId);
    const body = { v: 1, ...('admittedMachineRole' in admitted.binding ? { admittedMachineRole: admitted.binding.admittedMachineRole } : {}) };
    const verify = () => fetch(`${server.baseUrl}${path}`, { method: 'POST', body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: admitted.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: admitted.token,
                effectActionId: actionId, target, installationId: publisher.installationId,
                requestId: envelope.requestId!, privateKey: publisher.keys.secretKey, method: 'POST', path, body }) } });
    expect((await verify()).status).toBe(200);
    expect((await mint(origin, { ...origin, sessionLeaf: { ...origin.sessionLeaf,
        caller: { ...origin.sessionLeaf.caller, sessionId: 'wrong-session' } } })).status).toBe(401);
    expect((await mint({ ...origin, runId: 'unadmitted-run' })).status).toBe(401);
    expect((await mint(origin, origin, await server.createForeignAccount())).status).toBe(401);
    const binding = { ...admitted.binding, accountId: 'foreign-account' };
    expect(await hasCurrentExternalActionWorkflowOriginInTx(db, binding)).toBe(false);
    // Withdrawal governs the next admission. Existing child work reads only its Run.
    await db.account.update({ where: { id: server.accountId }, data: { tokenEpoch: { increment: 1 }, status: 'disabled' } });
    expect((await verify()).status).toBe(200);
    for (let index = 0; index < 3; index++) {
        expect(await verifyCurrentExternalActionPrincipal(admitted.binding)).toMatchObject({ accountId: server.accountId,
            authority: 'account_automation', workflowActionOrigin: origin });
    }
    const observed = observePrismaReads(db, ['automationRun', 'account', 'accountApiToken', 'machine', 'automationTrigger']);
    for (let index = 0; index < 3; index++) {
        expect(await verifyCurrentExternalActionPrincipalInTx(observed.tx, admitted.binding)).not.toBeNull();
    }
    expect(observed.reads).toEqual(Array(3).fill('automationRun.findFirst'));
    await db.automationRun.update({ where: { id: runId }, data: { state: 'cancelled' } });
    expect(await hasCurrentExternalActionWorkflowOriginInTx(db, admitted.binding)).toBe(false);
    expect((await verify()).status).toBe(401);
});
