import { randomBytes, randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
    MachineSetupApplyInputV1Schema, computeActionInputApprovalDigestV1,
    createWorkflowAccountRunActionOwner, getActionSpec, ActionIdSchema,
    encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    createActionExecutor, ExternalActionExecutionAuthorizationV1Schema,
    type ActionExecutorContext,
} from '@happier-dev/protocol';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { installAxiosFastifyAdapter } from '../../../../../../cli/src/testkit/http/axiosAdapter';
import { createCombinedMachineSetupActionDeps } from '../../../../../../cli/src/machines/setup/composeMachineSetup';
import { createWorkflowRunStorageClient } from '../../../../../../cli/src/daemon/workflows/workflowRunStorageClient';
import { signPluginInstallationPublisherHeader } from '../../../../../../cli/src/plugins/installations/publisherProof';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { deriveAccountEncryptionMigrationKeyFingerprints } from '@/app/encryption/accountEncryptionTransition';
import { resolveWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { createUnavailableActionTransportDeps } from '../../../../../../cli/src/testkit/actionTransportDeps';
import { RpcHandlerManager } from '../../../../../../cli/src/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '../../../../../../cli/src/api/machine/machineRpcAuthorization';
import { registerActionSpecRpcHandlers } from '../../../../../../cli/src/rpc/handlers/registerActionSpecRpcHandlers';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import { registerMachineAdmissionRoutes } from '../machines/registerMachineAdmissionRoutes';
import { registerWorkflowRunStorageRoutes } from './registerWorkflowRunStorageRoutes';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-approved-setup-workflow-', initAuth: true,
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
}, 120_000);
afterAll(async () => { if (harness) await harness.close(); });

it('refuses a Use grantee Workflow Software Apply step at daemon ingress for missing Manage', async () => {
    const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const actor = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const keys = tweetnacl.sign.keyPair();
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, active: true,
        installationId: randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey),
        operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
        operationProtocolCapabilitiesRevision: 1,
        metadata: encodePlainMachineStoredContent({ host: 'shared-setup', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/setup', happyHomeDir: '/home/setup/.happier' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
    await db.machineGrant.create({ data: { principalKind: 'account', machineId: machine.id, accountId: actor.id,
        accessLevel: 'view', createdByAccountId: owner.id } });
    const admission = await resolveMachineAdmission({ actorAccountId: actor.id, machineId: machine.id, requiredRole: 'use' });
    expect(admission).toMatchObject({ kind: 'admitted', role: 'use' });
    if (admission.kind !== 'admitted') throw new Error('Shared Workflow actor must have Use');
    const { kind: _kind, ...context } = admission;
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: machine.id, targets: [{
        homeId: 'home', machineId: machine.id, desiredRevision: 0,
        sources: [{ kind: 'direct', setup: {} }], exclusions: [], recipePlans: [],
    }] });
    const target = { kind: 'machine' as const, machineId: machine.id };
    const requestId = randomUUID();
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-workflow-step', binding: {
        accountId: actor.id, custodianAccountId: owner.id, authentication: { kind: 'account', tokenEpoch: actor.tokenEpoch },
        accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: machine.id,
        installationId: context.installationId, admittedMachineRole: 'use', actionId: 'machines.setup.apply', requestId, target,
        workflowActionOrigin: { runId: randomUUID(), requestId },
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input }),
    } });
    const token = await auth.createToken(owner.id, undefined, { kind: 'terminal', authority: 'account_automation' });
    await withAuthenticatedTestApp(app => registerMachineAdmissionRoutes(app), async app => {
        // Only Home HTTP is adapted. Daemon RPC parsing, installation signatures,
        // persisted grants and the named Action's Manage policy remain real.
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://shared-setup-home.test' });
        const verify = (request: Omit<Parameters<typeof verifyMachineRpcAdmissionCurrent>[0],
            'privateKey' | 'daemonToken' | 'serverHttpBaseUrl'>) => verifyMachineRpcAdmissionCurrent({
            ...request, privateKey: keys.secretKey, daemonToken: token, serverHttpBaseUrl: 'http://shared-setup-home.test' });
        const decisions: Awaited<ReturnType<typeof authorizeMachineRpcRequest>>[] = [];
        const manager = new RpcHandlerManager({ scopePrefix: machine.id, localMachineId: machine.id, encryptionMode: 'plain',
            authorizeRequest: async request => {
                const result = await authorizeMachineRpcRequest(request, { machineId: machine.id,
                    resolveCustodianAccountId: async () => owner.id, resolveInstallationId: () => context.installationId,
                    verifyMachineAdmission: verify });
                decisions.push(result);
                return result;
            },
        });
        registerActionSpecRpcHandlers({ rpcHandlerManager: manager, actionIds: ['machines.setup.apply'],
            actionExecutor: createActionExecutor(createUnavailableActionTransportDeps()) });
        const method = `${machine.id}:${getActionSpec('machines.setup.apply').bindings?.rpcMethod}`;
        try {
            expect(await manager.handleRequest({ method, params: input, requestId, callerAuthority: 'account_automation',
                callerInputAuthorization: authorization, machineAdmission: context }))
                .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN, effectAttempted: false });
            expect(decisions).toContainEqual(expect.objectContaining({ ok: false, admissionPredicate: 'machine_currentness' }));
            expect(await verify({ context, method })).toBe(false);
            // The same signer, Account and method work once Manage is granted.
            await db.machineGrant.update({ where: { principalKind: 'account', machineId_accountId: { machineId: machine.id, accountId: actor.id } },
                data: { accessLevel: 'admin' } });
            expect(await verify({ context: { ...context, role: 'manage' }, method })).toBe(true);
        } finally { restore(); }
    }, { authentication: 'real' });
});

it('starts an encrypted Wait through the recording HTTP transport in two storage round trips and rejoins the same sealed Run', async () => {
    const machineKey = randomBytes(32);
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'dataKey', machineKey }, dataKeyPublicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey });
    const account = await db.account.create({ data: { encryptionMode: 'e2ee',
        ...createSignedAccountContentBinding(tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey) } });
    const keys = tweetnacl.sign.keyPair();
    const identity = { version: 1 as const, installationId: randomUUID(), createdAt: Date.now(),
        publicKey: encodeBase64(keys.publicKey, 'base64url'), privateKey: encodeBase64(keys.secretKey, 'base64url') };
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, active: true,
        installationId: identity.installationId, installationPublicKey: new Uint8Array(keys.publicKey), metadata: '{}' } });
    const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
    const encryption = { kind: 'available' as const, material, witness: { mode: 'e2ee' as const, version: account.seq,
        contentKeyFingerprint: deriveAccountEncryptionMigrationKeyFingerprints(account).contentKeyFingerprint! } };
    const requests: string[] = [];
    const preparedGets: unknown[] = [];
    const refusals: Array<{ operation: string; status: number; error: string }> = [];
    let encryptionReads = 0;
    let beforeAdmit: (() => Promise<void>) | undefined;
    await withAuthenticatedTestApp(app => {
        app.addHook('preHandler', async request => {
            if (request.url === '/v3/automations/runs/workflow-storage') {
                const body = request.body as { operation: string; prepareAdmission?: unknown };
                requests.push(body.operation);
                if (body.operation === 'get' && body.prepareAdmission !== undefined) preparedGets.push(body.prepareAdmission);
                if (body.operation === 'admit') await beforeAdmit?.();
            }
        });
        app.addHook('onSend', async (request, reply, payload) => {
            if (request.url === '/v3/automations/runs/workflow-storage' && reply.statusCode >= 400 && typeof payload === 'string') {
                const body = request.body as { operation: string };
                const response = JSON.parse(payload) as { error: string };
                refusals.push({ operation: body.operation, status: reply.statusCode, error: response.error });
            }
            return payload;
        });
        registerWorkflowRunStorageRoutes(app);
    }, async app => {
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://wait-home.test' });
        try {
            const storage = createWorkflowRunStorageClient({ token, serverHttpBaseUrl: 'http://wait-home.test', machineId: machine.id,
                createPublisherHeader: request => signPluginInstallationPublisherHeader({ ...request, identity, machineId: machine.id }) });
            const ownerDeps: Parameters<typeof createWorkflowAccountRunActionOwner>[0] = { storage, resolveAccountId: async () => account.id,
                definitions: { get: async ({ definitionId }) => ({ definitionId, revision: { headerVersion: 1, bodyVersion: 1 },
                    definition: start.input.source.definition, metadata: { title: 'Private Wait' } }) },
                resolveEncryption: async () => { encryptionReads++; return encryption; }, normalizeAbsolutePath: directory => directory, randomBytes,
                prepareWorkspace: async ({ projectTarget }) => ({ ok: true, workspaceTarget: { project: {
                    ...projectTarget, checkoutRootPath: projectTarget.directory,
                } } }),
                resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
            };
            const owner = createWorkflowAccountRunActionOwner(ownerDeps);
            const runId = randomUUID();
            const start = { actionId: 'workflow.run.start' as const, input: { runId, source: { kind: 'inline' as const,
                definition: { version: 1 as const, blocks: [{ kind: 'wait' as const, id: 'review',
                    document: { text: 'Review this private result', references: [], attachments: [] } }] } } },
                context: { surface: 'ui' as const, authority: 'present_user' as const, callerPermissionMode: 'default' as const,
                    externalActionTarget: { kind: 'machine' as const, machineId: machine.id,
                        project: { machineId: machine.id, directory: '/repo' } } } };
            await expect(owner.execute(start)).resolves.toMatchObject({ admission: 'created', run: { id: runId, state: 'queued' } });
            expect(requests).toEqual(['get', 'admit']);
            expect(preparedGets).toEqual([{ sourceArtifactId: null }]);
            expect(encryptionReads).toBe(1);
            const stored = await storage.execute({ operation: 'get', runId,
                prepareAdmission: { sourceArtifactId: randomUUID(), visibleTeamId: randomUUID() } });
            const snapshot = stored as { acceptedEnvelope: string; keyCensus: Parameters<typeof resolveWorkflowRunDataKeyV1>[0]['census'] };
            const openedKey = resolveWorkflowRunDataKeyV1({ encryption, census: snapshot.keyCensus });
            expect(openedKey.kind).toBe('available');
            if (openedKey.kind !== 'available' || openedKey.encryption.runCrypto.mode !== 'e2ee') throw new Error('encrypted_run_key_unavailable');
            expect(snapshot.acceptedEnvelope).not.toContain('Review this private result');
            expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'e2ee', runDataKey: openedKey.encryption.runCrypto.runDataKey,
                binding: { v: 1, purpose: 'accepted_snapshot', accountId: account.id, runId },
                envelope: parseWorkflowStoredContentEnvelopeV1(snapshot.acceptedEnvelope) }))
                .toMatchObject({ kind: 'available', content: { materializedLeaves: [{ kind: 'wait', blockId: 'review' }] } });
            requests.length = 0;
            await expect(owner.execute(start)).resolves.toMatchObject({ admission: 'existing', run: { id: runId } });
            expect(requests).toEqual(['get']);
            expect((await db.automationRun.findUniqueOrThrow({ where: { id: runId } })).workflowAcceptedSnapshotEnvelope)
                .toBe(snapshot.acceptedEnvelope);

            const missingRunId = randomUUID();
            await expect(storage.execute({ operation: 'get', runId: missingRunId }))
                .rejects.toMatchObject({ response: { status: 404 } });
            const foreign = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
            const foreignToken = await auth.createToken(foreign.id, undefined, { kind: 'account', authority: 'present_user' });
            const foreignStorage = createWorkflowRunStorageClient({ token: foreignToken, serverHttpBaseUrl: 'http://wait-home.test' });
            // Preparation cannot turn another person's existing private id into
            // a missing Run, even when the caller supplies a different audience.
            await expect(foreignStorage.execute({ operation: 'get', runId, prepareAdmission: {} }))
                .rejects.toMatchObject({ response: { status: 404 } });
            const deniedSourceRunId = randomUUID();
            requests.length = 0;
            await expect(owner.execute({ ...start, input: { ...start.input, runId: deniedSourceRunId,
                source: { ...start.input.source, sourceArtifactId: randomUUID() } } }))
                .rejects.toMatchObject({ code: 'run_not_found' });
            expect(requests).toEqual(['get']);
            const deniedTeamRunId = randomUUID();
            requests.length = 0;
            await expect(owner.execute({ ...start, input: { ...start.input, runId: deniedTeamRunId,
                source: { ...start.input.source, visibleTeamId: randomUUID() } } }))
                .rejects.toBeDefined();
            expect(requests).toEqual(['get']);
            expect(refusals.at(-1)).toEqual({ operation: 'get', status: 422, error: 'visible_team_not_granted' });

            const source = await db.artifact.create({ data: { id: randomUUID(), accountId: foreign.id,
                header: randomBytes(32), body: randomBytes(32), dataEncryptionKey: randomBytes(32) } });
            await db.artifactGrant.create({ data: { principalKind: 'account' as const, artifactId: source.id, accountId: account.id,
                accessLevel: 'view', createdByAccountId: foreign.id } });
            const changedSourceRunId = randomUUID();
            requests.length = 0;
            beforeAdmit = async () => { await db.artifactGrant.deleteMany({ where: { principalKind: 'account', artifactId: source.id, accountId: account.id } }); };
            await expect(owner.execute({ ...start, input: { ...start.input, runId: changedSourceRunId,
                source: { ...start.input.source, sourceArtifactId: source.id } } })).rejects.toBeDefined();
            expect(requests).toEqual(['get', 'admit']);
            expect(refusals.at(-1)).toEqual({ operation: 'admit', status: 404, error: 'run_not_found' });

            const team = await db.team.create({ data: { name: 'Prepared Run audience' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: account.id, role: 'owner' } });
            const teamSource = await db.artifact.create({ data: { id: randomUUID(), accountId: account.id,
                header: randomBytes(32), body: randomBytes(32), dataEncryptionKey: randomBytes(32) } });
            await db.artifactGrant.create({ data: { principalKind: 'team' as const, artifactId: teamSource.id, teamId: team.id,
                accessLevel: 'view', createdByAccountId: account.id } });
            const changedTeamRunId = randomUUID();
            requests.length = 0;
            beforeAdmit = async () => { await db.artifactGrant.deleteMany({ where: { principalKind: 'team', artifactId: teamSource.id, teamId: team.id } }); };
            await expect(owner.execute({ ...start, input: { ...start.input, runId: changedTeamRunId,
                source: { ...start.input.source, sourceArtifactId: teamSource.id, visibleTeamId: team.id } } })).rejects.toBeDefined();
            expect(requests).toEqual(['get', 'admit']);
            expect(refusals.at(-1)).toEqual({ operation: 'admit', status: 422, error: 'visible_team_not_granted' });

            const changedModeRunId = randomUUID();
            requests.length = 0;
            beforeAdmit = async () => { await db.account.update({ where: { id: account.id }, data: { encryptionMode: 'plain' } }); };
            await expect(owner.execute({ ...start, input: { ...start.input, runId: changedModeRunId } }))
                .rejects.toBeDefined();
            expect(requests).toEqual(['get', 'admit', 'get']);
            expect(refusals).toContainEqual({ operation: 'admit', status: 409, error: 'currentness_conflict' });
            expect(await db.automationRun.count({ where: { id: { in: [deniedSourceRunId, deniedTeamRunId,
                changedSourceRunId, changedTeamRunId, changedModeRunId] } } })).toBe(0);

            beforeAdmit = undefined;
            requests.length = 0;
            preparedGets.length = 0;
            let plainWitnessReads = 0;
            const plainOwner = createWorkflowAccountRunActionOwner({ ...ownerDeps,
                resolveEncryption: async () => {
                    plainWitnessReads++;
                    if (plainWitnessReads > 1) throw new Error('fresh_start_must_reuse_its_mode_witness');
                    return { kind: 'available', witness: { mode: 'plain', version: account.seq, contentKeyFingerprint: null } };
                },
                randomBytes: () => { throw new Error('plain_start_must_not_allocate_keys'); },
            });
            const plainRunId = randomUUID();
            const plainStart = { ...start, input: { ...start.input, runId: plainRunId } };
            await expect(plainOwner.execute(plainStart)).resolves.toMatchObject({ admission: 'created', run: { id: plainRunId } });
            expect(requests).toEqual(['get', 'admit']);
            expect(preparedGets).toEqual([]);
            expect(plainWitnessReads).toBe(1);
            const plainSnapshot = await db.automationRun.findUniqueOrThrow({ where: { id: plainRunId } });
            expect(parseWorkflowStoredContentEnvelopeV1(plainSnapshot.workflowAcceptedSnapshotEnvelope)).toMatchObject({ t: 'plain' });
            requests.length = 0;
            const rejoinOwner = createWorkflowAccountRunActionOwner({ ...ownerDeps,
                resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: account.seq, contentKeyFingerprint: null } }),
            });
            await expect(rejoinOwner.execute(plainStart)).resolves.toMatchObject({ admission: 'existing', run: { id: plainRunId } });
            expect(requests).toEqual(['get']);
            expect(preparedGets).toEqual([]);
            expect((await db.automationRun.findUniqueOrThrow({ where: { id: plainRunId } })).workflowAcceptedSnapshotEnvelope)
                .toBe(plainSnapshot.workflowAcceptedSnapshotEnvelope);

            requests.length = 0;
            const unavailableRunId = randomUUID();
            const unavailableOwner = createWorkflowAccountRunActionOwner({ ...ownerDeps,
                resolveEncryption: async () => { throw new Error('account_mode_unavailable'); },
            });
            await expect(unavailableOwner.execute({ ...start, input: { ...start.input, runId: unavailableRunId } }))
                .rejects.toThrow('account_mode_unavailable');
            expect(requests).toEqual([]);
            expect(await db.automationRun.findUnique({ where: { id: unavailableRunId } })).toBeNull();
        } finally { restore(); }
    }, { authentication: 'real' });
});

it('starts the approved Setup child Run before an assignment exists and reads it independently of worker assignment', async () => {
    const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const foreign = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const keys = tweetnacl.sign.keyPair();
    const identity = { version: 1 as const, installationId: randomUUID(), createdAt: Date.now(),
        publicKey: encodeBase64(keys.publicKey, 'base64url'), privateKey: encodeBase64(keys.secretKey, 'base64url') };
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, active: true,
        installationId: identity.installationId, installationPublicKey: new Uint8Array(keys.publicKey),
        metadata: encodePlainMachineStoredContent({ host: 'setup', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/setup', happyHomeDir: '/home/setup/.happier' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
    const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
    const foreignToken = await auth.createToken(foreign.id, undefined, { kind: 'account', authority: 'present_user' });
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: machine.id, targets: [{
        homeId: 'home', machineId: machine.id, desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }],
        exclusions: [], recipePlans: [],
    }] });
    const requestId = randomUUID(), approvalId = randomUUID(), operationId = randomUUID();
    let accepted: unknown;
    const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
        callerPermissionMode: 'yolo', serverId: input.homeId, runtimeAccountId: account.id, actionRequestId: requestId,
        approvedActionReplay: { artifactId: approvalId }, presentUserApproval: { artifactId: approvalId,
            actionId: 'machines.setup.apply', requestId, decidingAccountId: account.id,
            inputDigest: computeActionInputApprovalDigestV1('machines.setup.apply', input) },
        operationAcceptance: { actionId: 'machines.setup.apply', operationId, accept: value => { accepted = value; } } };
    await withAuthenticatedTestApp(app => registerWorkflowRunStorageRoutes(app), async app => {
        // Only HTTP is adapted. Authentication, publisher signatures, Run access,
        // admission, approved-operation sealing and Setup composition remain real.
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://setup-home.test' });
        try {
            const client = (bearer = token) => createWorkflowRunStorageClient({ token: bearer,
                serverHttpBaseUrl: 'http://setup-home.test', machineId: machine.id,
                createPublisherHeader: request => signPluginInstallationPublisherHeader({ ...request, identity, machineId: machine.id }) });
            const storage = { execute: (operation: Parameters<ReturnType<typeof client>['execute']>[0]) =>
                client().execute(operation, { publisherMachineId: machine.id }) };
            const owner = createWorkflowAccountRunActionOwner({ storage, resolveAccountId: async () => account.id,
                definitions: { get: async () => { throw new Error('inline_setup_has_no_saved_definition'); } },
                resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
                normalizeAbsolutePath: directory => directory,
                randomBytes: () => { throw new Error('plain_account_has_no_keys'); },
                prepareWorkspace: async ({ projectTarget }) => ({ ok: true, workspaceTarget: { project: {
                    ...projectTarget, checkoutRootPath: projectTarget.directory,
                } } }),
                resolveMaterializationContext: async () => ({ context: {}, effects: {
                    resolveTargetAvailability: async () => true,
                    readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))),
                } }),
            });
            const setup = createCombinedMachineSetupActionDeps({ readDeps: createUnavailableActionTransportDeps,
                targetPlan: async () => { throw new Error('reviewed_exclusions_already_present'); },
                readHostFacts: async () => ({ machines: [{ machineId: machine.id, online: true }] }),
                orchestrationDirectory: '/setup', startCombined: owner.startCombined,
                waitForRun: request => owner.execute({ actionId: 'workflow.run.wait',
                    input: { runId: request.start.runId, conditions: ['terminal'], timeoutSeconds: 0 }, context }),
                readInvocations: (_request, query) => owner.execute({ actionId: 'workflow.run.invocations.list', input: query, context }),
            });
            // No native executor runs in this test. The real zero-deadline wait
            // leaves the successfully admitted Run queued for its worker.
            await expect(setup.machineSetupApply!({ input, context })).resolves.toMatchObject({ errorCode: 'outcome_unknown' });
            expect(accepted).toMatchObject({ operationId, runId: expect.any(String) });
            const run = await db.automationRun.findFirstOrThrow({ where: { accountId: account.id } });
            expect(accepted).toMatchObject({ runId: run.id });
            expect(run.state).toBe('queued');

            // An Account reader is not an executor. A different current local
            // installation must not need this Run's worker assignment to read it.
            const reader = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
                metadata: '{}', installationId: identity.installationId, installationPublicKey: new Uint8Array(keys.publicKey) } });
            const readClient = createWorkflowRunStorageClient({ token, serverHttpBaseUrl: 'http://setup-home.test',
                createPublisherHeader: request => signPluginInstallationPublisherHeader({ ...request, identity, machineId: reader.id }) });
            const read = (operation: 'get' | 'wait', bearer = token) => {
                const body = { operation, runId: run.id, publisherMachineId: reader.id };
                return app.inject({ method: 'POST', url: '/v3/automations/runs/workflow-storage', payload: body,
                    headers: { authorization: `Bearer ${bearer}`, 'x-happier-plugin-installation-manifest-publisher':
                        signPluginInstallationPublisherHeader({ identity, machineId: reader.id,
                            path: '/v3/automations/runs/workflow-storage', body }) } });
            };
            // Transparent instrumentation at the real database boundary; the
            // optional proof must add no Machine queries to either Account read.
            let machineReads = 0;
            const originals = { findUnique: db.machine.findUnique, findFirst: db.machine.findFirst };
            for (const method of ['findUnique', 'findFirst'] as const) {
                Object.assign(db.machine, { [method]: new Proxy(db.machine[method], { apply(target, receiver, args) {
                    machineReads++;
                    return Reflect.apply(target, receiver, args);
                } }) });
            }
            try {
                for (const operation of ['get', 'wait'] as const) {
                    machineReads = 0;
                    const response = await read(operation);
                    expect.soft(response.statusCode).toBe(200);
                    expect.soft(machineReads, `${operation} Machine DB reads`).toBe(0);
                }
            } finally { Object.assign(db.machine, originals); }
            await expect(readClient.execute({ operation: 'recovery.list', runId: run.id, pageByteLimit: 4096 }, { publisherMachineId: reader.id }))
                .rejects.toMatchObject({ response: { status: 401 } });

            // The reader still signs with its old installation after replacement.
            await db.machine.update({ where: { id: reader.id }, data: { installationId: randomUUID() } });
            for (const operation of ['get', 'wait'] as const) {
                const sameAccount = await read(operation);
                expect.soft(sameAccount.statusCode, `${operation} with stale proof`).toBe(200);
                if (sameAccount.statusCode === 200) expect(sameAccount.json()).toMatchObject({ run: { id: run.id } });
                const foreignAccount = await read(operation, foreignToken);
                expect.soft(foreignAccount.statusCode, `${operation} foreign Account`).toBe(404);
                expect.soft(foreignAccount.json()).toMatchObject({ error: 'run_not_found' });
            }
            await expect(readClient.execute({ operation: 'recovery.list', runId: run.id, pageByteLimit: 4096 }, { publisherMachineId: reader.id }))
                .rejects.toMatchObject({ response: { status: 401 } });
        } finally { restore(); }
    }, { authentication: 'real' });
});
