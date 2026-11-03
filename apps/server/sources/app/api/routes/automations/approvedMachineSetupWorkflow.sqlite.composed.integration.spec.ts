import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
    MachineSetupApplyInputV1Schema, computeActionInputApprovalDigestV1,
    createWorkflowAccountRunActionOwner, getActionSpec, ActionIdSchema,
    encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
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
import { createUnavailableActionTransportDeps } from '../../../../../../cli/src/testkit/actionTransportDeps';
import { registerWorkflowRunStorageRoutes } from './registerWorkflowRunStorageRoutes';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-approved-setup-workflow-', initAuth: true,
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
}, 120_000);
afterAll(async () => { if (harness) await harness.close(); });

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
