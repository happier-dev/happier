import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import {
    deriveWorkflowSessionInputLocalIdV2,
    materializeWorkflowAcceptedSnapshotV1,
    openWorkflowProgressStoredEnvelopeV1,
    parseWorkflowStoredContentEnvelopeV1,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    sealWorkflowProgressStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
    type WorkflowDefinitionV1,
} from '@happier-dev/protocol';

import { db } from '../sources/storage/db';
import { auth } from '../sources/app/auth/auth';
import { enableAuthentication } from '../sources/app/api/utils/enableAuthentication';
import { automationRoutes } from '../sources/app/api/routes/automations/automationRoutes';
import { registerAccountEncryptionRoutes } from '../sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from '../sources/testkit/lightSqliteHarness';
import { createTrustedMachineInstallation } from '../sources/testkit/pluginInstallationPublisherTestkit';
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from '../sources/app/automations/automationAccountCurrentness';
import { createProductionWorkflowRunCoordinator } from '../../cli/src/daemon/workflows/production';
import { createWorkflowAcceptedAuthorizationCurrentness } from '../../cli/src/daemon/workflows/daemonRuntime';
import { createWorkflowRunStorageClient } from '../../cli/src/daemon/workflows/workflowRunStorageClient';
import { startAutomationWorker } from '../../cli/src/daemon/automation/automationWorker';
import { resolveAutomationWorkerAccountEncryption } from '../../cli/src/plugins/runtime/automations/automationAccountCurrentness';
import { preflightWorkflowSessionInputAdmissionV2 } from '../../cli/src/daemon/workflows/stepExecution';
import { createCliActionExecutorFromCredentials } from '../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createGitWorkflowWorkspaceTestDependencies } from '../../cli/src/daemon/workflows/workflowWorkspace.testkit';
import { configuration, reloadConfiguration } from '../../cli/src/configuration';
import { updateSettings } from '../../cli/src/persistence';
import { readOrCreateInstallationIdentity } from '../../cli/src/daemon/identity/store';
import { readCurrentMachineInstallation } from '../../cli/src/daemon/identity/currentMachineInstallation';
import type { Update } from '../../cli/src/api/types';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}

describe('review across the real worker, coordinator, opaque store and SQLite owner', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-review-composition-', initAuth: true,
            env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1' } });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it.each([
        { mode: 'use_result', parkFirst: false, dropHint: true, capacityOne: false },
        { mode: 'generate', parkFirst: false, dropHint: true, capacityOne: false },
        { mode: 'use_result', parkFirst: true, dropHint: false, capacityOne: false },
        { mode: 'generate', parkFirst: true, dropHint: false, capacityOne: false },
        { mode: 'use_result', parkFirst: true, dropHint: true, capacityOne: false },
        { mode: 'use_result', parkFirst: true, dropHint: false, capacityOne: true },
    ] as const)('$mode with parkFirst=$parkFirst, dropHint=$dropHint and capacityOne=$capacityOne preserves exact custody without Automation assignments', async ({ mode, parkFirst, dropHint, capacityOne }) => {
        const secondRunId = randomUUID();
        const thirdRunId = randomUUID();
        const secondStarted = deferred<void>();
        const releaseSecond = deferred<void>();
        const releasePark = deferred<void>();
        const secondHeartbeat = deferred<void>();
        const thirdFinished = deferred<void>();
        const parkReached = deferred<void>();
        const parked = deferred<void>();
        const terminal = deferred<void>();
        const heartbeatRuns: string[] = [];
        const completionOrder: string[] = [];
        const capacityTransport: { path: string; status: number; maxActive?: number; runId?: string; scope?: string }[] = [];
        const capacityOutcomes: { runId: string; attempt: number; claimVersion: number; state: string; reason?: string }[] = [];
        const capacityReadings: { mode: string; version: number }[] = [];
        const capacityFailures: { runId: string; phase: string; name: string; code?: string; status?: number; signalAborted?: boolean }[] = [];
        let secondBeforeWake: { state: string; attempt: number; claimedByMachineId: string | null } | undefined;
        const recordFailure = (runId: string, phase: string, error: unknown, signalAborted?: boolean) => {
            if (!capacityOne) return;
            const failure: (typeof capacityFailures)[number] = { runId, phase,
                name: error instanceof Error ? error.name : 'unknown',
                ...(signalAborted === undefined ? {} : { signalAborted }) };
            if (error && typeof error === 'object') {
                if ('code' in error && typeof error.code === 'string') failure.code = error.code;
                if ('response' in error && error.response && typeof error.response === 'object') {
                    if ('status' in error.response && typeof error.response.status === 'number') failure.status = error.response.status;
                    if ('data' in error.response && error.response.data && typeof error.response.data === 'object'
                        && 'error' in error.response.data && typeof error.response.data.error === 'string') failure.code = error.response.data.error;
                }
            }
            capacityFailures.push(failure);
        };
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        const previousEnv = { home: process.env.HAPPIER_HOME_DIR, server: process.env.HAPPIER_SERVER_URL,
            webapp: process.env.HAPPIER_WEBAPP_URL };
        let worker: ReturnType<typeof startAutomationWorker> | undefined;
        let cleanupPromise: Promise<void> | undefined;
        const cleanup = () => cleanupPromise ??= (async () => {
            worker?.stop();
            const finished = new Error('Review composition test finished');
            for (const gate of [parkReached, parked, terminal, secondStarted, secondHeartbeat, thirdFinished]) {
                gate.reject(finished);
            }
            releasePark.resolve();
            releaseSecond.resolve();
            try {
                await app.close();
            } finally {
                for (const [name, value] of [['HAPPIER_HOME_DIR', previousEnv.home], ['HAPPIER_SERVER_URL', previousEnv.server], ['HAPPIER_WEBAPP_URL', previousEnv.webapp]] as const) {
                    if (value === undefined) delete process.env[name]; else process.env[name] = value;
                }
                reloadConfiguration();
            }
        })();
        // Vitest timeouts leave the test body's awaited promise pending.
        onTestFinished(cleanup);
        try {
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        await enableAuthentication(app);
        automationRoutes(app);
        registerAccountEncryptionRoutes(app);
        app.addHook('onSend', async (request, reply, payload) => {
            if (!capacityOne || (!request.url.includes('/assignments') && !request.url.endsWith('/runs/claim'))) return payload;
            const projected: (typeof capacityTransport)[number] = { path: request.url, status: reply.statusCode };
            const body: unknown = request.body;
            if (body && typeof body === 'object' && 'scope' in body && typeof body.scope === 'string') projected.scope = body.scope;
            const response: unknown = typeof payload === 'string' ? JSON.parse(payload) : payload;
            if (response && typeof response === 'object') {
                if ('settings' in response && response.settings && typeof response.settings === 'object'
                    && 'maxActiveRunsPerMachine' in response.settings && typeof response.settings.maxActiveRunsPerMachine === 'number') {
                    projected.maxActive = response.settings.maxActiveRunsPerMachine;
                }
                if ('run' in response && response.run && typeof response.run === 'object'
                    && 'id' in response.run && typeof response.run.id === 'string') projected.runId = response.run.id;
            }
            capacityTransport.push(projected);
            return payload;
        });
        app.addHook('onResponse', async (request) => {
            const heartbeat = /^\/v3\/automations\/runs\/([^/]+)\/heartbeat$/.exec(request.url);
            if (heartbeat) {
                heartbeatRuns.push(heartbeat[1]!);
                if (heartbeat[1] === secondRunId) secondHeartbeat.resolve();
            }
        });
        const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        process.env.HAPPIER_HOME_DIR = join(harness.baseDir, `cli-${randomUUID()}`);
        process.env.HAPPIER_SERVER_URL = baseUrl;
        process.env.HAPPIER_WEBAPP_URL = baseUrl;
        reloadConfiguration();
        expect(configuration.happyHomeDir).toBe(process.env.HAPPIER_HOME_DIR);
        expect(new URL(configuration.apiServerUrl).origin).toBe(new URL(baseUrl).origin);
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain',
            ...(capacityOne ? { automationMaxActiveRunsPerMachine: 1 } : {}) } });
        const accountId = account.id;
        const machineId = randomUUID();
        const runId = randomUUID();
        const sessionId = randomUUID();
        await db.session.create({ data: { id: sessionId, tag: randomUUID(), accountId, metadata: '{}', encryptionMode: 'plain' } });
        await updateSettings((settings) => ({ ...settings,
            machineIdByServerId: { ...settings.machineIdByServerId, [configuration.activeServerId]: machineId },
            machineIdByServerIdByAccountId: { ...settings.machineIdByServerIdByAccountId,
                [configuration.activeServerId]: { [accountId]: machineId } },
            lastTokenSubByServerId: { ...settings.lastTokenSubByServerId, [configuration.activeServerId]: accountId },
        }));
        const identity = await readOrCreateInstallationIdentity();
        expect(await readCurrentMachineInstallation()).toMatchObject({ machineId,
            identity: { installationId: identity.installationId } });
        await createTrustedMachineInstallation({ accountId, machineId, installationId: identity.installationId,
            keyPair: tweetnacl.sign.keyPair.fromSecretKey(Buffer.from(identity.privateKey, 'base64url')) });
        const token = await auth.createToken(accountId, undefined, { kind: 'account', authority: 'present_user' });
        const witness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
            where: { id: accountId }, select: automationAccountCurrentnessSelect }));
        // The composed runner owns the real moving checkout; Git inspection
        // remains real and never writes into it. Only host execution is fake.
        const directory = process.cwd();
        const checkoutRootPath = resolve(directory, '../..');
        const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
            conversation: { kind: 'existing_session', sessionId, machineId },
        }, blocks: [{ kind: 'step', id: 'draft', pauseForReview: true,
            document: { text: 'Draft', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] };
        const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition, admission: { kind: 'user' },
            effects: { resolveTargetAvailability: async () => true }, context: { source: { kind: 'inline' }, inputs: {}, machineId,
                origin: { kind: 'direct' }, executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId, directory, checkoutRootPath } },
                authorization: { principal: { kind: 'host' } } } });
        if (!materialized.ok) throw new Error(materialized.error.code);
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: materialized.snapshot }));
        const storage = createWorkflowRunStorageClient({ token, machineId, serverHttpBaseUrl: baseUrl });
        await storage.execute({ operation: 'admit', runId, machineId, origin: { kind: 'direct' },
            accountCurrentness: witness, recipientKeyEnvelopes: [], acceptedEnvelope });
        let firstPark = true;
        let reviewEntries = 0;
        const inputs: { runId: string; localId: string; text: string }[] = [];
        let secondAborted = false;
        const coordinate = createProductionWorkflowRunCoordinator({ token, accountId, machineId,
          resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
            resolveAccountEncryption: async (signal) => {
                const result = await resolveAutomationWorkerAccountEncryption({ token, signal });
                if (result.kind !== 'available') throw new Error('account_unavailable');
                if (capacityOne && capacityReadings.at(-1)?.version !== result.witness.version) {
                    capacityReadings.push({ mode: result.witness.mode, version: result.witness.version });
                }
                return result;
            }, isAcceptedAuthorizationCurrent: createWorkflowAcceptedAuthorizationCurrentness({ accountId,
                // This fixture admits a host principal. Other credential and
                // plugin-system boundaries must not be reached by that path.
                listAccountApiTokens: async () => { throw new Error('host admission must not read API tokens'); },
                resolveCurrentPluginOccurrenceId: async () => { throw new Error('host admission has no plugin mediator'); },
                resolveCurrentPluginSourceCustody: async () => { throw new Error('host admission has no plugin custody'); },
                isMediatedSourceCurrent: async () => { throw new Error('host admission has no mediated source'); },
            }), workspaceScm: createGitWorkflowWorkspaceTestDependencies(),
            storage: { execute: async (operation, options) => {
                if (operation.operation === 'transition' && operation.state === 'waiting_for_review' && firstPark) {
                    firstPark = false;
                    parkReached.resolve();
                    await releasePark.promise;
                }
                try { return await storage.execute(operation, options); }
                catch (error) {
                    recordFailure(typeof operation.runId === 'string' ? operation.runId : 'unknown', operation.operation, error, options?.signal?.aborted);
                    throw error;
                }
            } }, onReviewEntered: async () => { reviewEntries++; }, onCommittedTransition: async ({ run }) => {
                completionOrder.push(run.id);
                if (run.id === runId) terminal.resolve();
                if (run.id === thirdRunId) thirdFinished.resolve();
            },
            // Agent execution is the genuine external host boundary. All
            // admission identity, Session orchestration and result decoding stay real.
            execution: { credentials: { token, encryption: null }, serverId: 'server',
                resolveMachineOperationProtocolCapabilities: async () => ({ sessionInputAdmission: { protocolVersions: [1, 2] } }),
                machineAdmissionTransport: async () => { throw new Error('session boundary supplied below'); },
                resolveExistingSessionConversation: async () => ({ sessionId, machineId, directory,
                    agentTarget: definition.defaults!.agentTarget }),
                sessionInput: { preflight: preflightWorkflowSessionInputAdmissionV2, enqueue: async (request) => {
                    const localId = deriveWorkflowSessionInputLocalIdV2(request.workflow);
                    inputs.push({ runId: request.workflow.runId, localId, text: request.text });
                    return { status: 'accepted', localId };
                }, observe: async ({ localId, signal }) => {
                    const input = inputs.find((candidate) => candidate.localId === localId)!;
                    if (input.runId === secondRunId) {
                        signal?.addEventListener('abort', () => { secondAborted = true; }, { once: true });
                        secondStarted.resolve();
                        await releaseSecond.promise;
                    }
                    return { ok: true, sessionId, localId, result: { kind: 'final_text',
                        text: input.runId === runId && inputs.filter((candidate) => candidate.runId === runId).length > 1
                            ? 'Generated draft' : 'Initial draft' } };
                } },
                detachedRun: { actionExecutor: createCliActionExecutorFromCredentials({ credentials: { token, encryption: null }, machineId }),
                    buildActionContext: () => ({ surface: 'agent', authority: 'account_automation' }) },
            } });
        worker = startAutomationWorker({ token, machineId, spawnSession: async () => { throw new Error('existing conversation only'); },
            ...(capacityOne ? { env: { ...process.env, HAPPIER_AUTOMATION_LEASE_MS: '5000', HAPPIER_AUTOMATION_HEARTBEAT_MS: '1000' } } : {}),
            coordinateWorkflowRun: async (claim: Parameters<typeof coordinate>[0]) => {
                try {
                    const result = await coordinate(claim);
                    if (capacityOne) capacityOutcomes.push({ runId: claim.runId, attempt: claim.attempt,
                        claimVersion: claim.accountCurrentness.version, state: result.state,
                        ...('reason' in result && typeof result.reason === 'string' ? { reason: result.reason } : {}) });
                    if (result.state === 'waiting_for_review') parked.resolve();
                    else if (result.state !== 'succeeded') throw new Error(`Unexpected coordinator outcome: ${JSON.stringify(result)}`);
                    return result;
                } catch (error) {
                    recordFailure(claim.runId, 'coordinate', error, claim.signal?.aborted);
                    parkReached.reject(error);
                    parked.reject(error);
                    terminal.reject(error);
                    throw error;
                }
            } });
        const queuedWake = async (id = runId) => {
            const run = await db.automationRun.findUniqueOrThrow({ where: { id }, select: { state: true, attempt: true } });
            // Automatic refill may already have claimed this direct Run.
            // A synthetic queued snapshot must not invalidate that live claim.
            if (run.state !== 'queued') return;
            worker!.handleServerUpdate({ id: randomUUID(), seq: 1, createdAt: Date.now(),
                body: { t: 'automation-run-updated', runId: id, automationId: null,
                    state: 'queued', machineId: null, targetMachineId: machineId, attempt: run.attempt } } satisfies Update);
        };
            await queuedWake();
            await parkReached.promise;
            expect(await db.automation.count({ where: { accountId } })).toBe(0);
            if (parkFirst) {
                releasePark.resolve();
                await parked.promise;
                expect(await db.automationRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
                    state: 'waiting_for_review', workflowCustodyState: 'pending', claimedByMachineId: null,
                    claimedAt: null, leaseExpiresAt: null });
            }
            const originalDueAt = (await db.automationRun.findUniqueOrThrow({ where: { id: runId } })).dueAt;
            const parkedHeartbeatCount = heartbeatRuns.filter((id) => id === runId).length;
            if (capacityOne) {
                for (const [id, ordinal] of [[secondRunId, 1], [thirdRunId, 2]] as const) {
                    const ordinaryDefinition: WorkflowDefinitionV1 = { ...definition, blocks: [{ ...definition.blocks[0]!,
                        kind: 'step', id: 'ordinary', pauseForReview: false,
                        document: { text: `Ordinary ${ordinal}`, references: [], attachments: [] }, input: [], result: { kind: 'text' } }] };
                    const ordinary = await materializeWorkflowAcceptedSnapshotV1({ definition: ordinaryDefinition, admission: { kind: 'user' },
                        effects: { resolveTargetAvailability: async () => true }, context: { ...materialized.snapshot,
                            source: { kind: 'inline' }, origin: { kind: 'direct' } } });
                    if (!ordinary.ok) throw new Error(ordinary.error.code);
                    const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: id }, acceptedSnapshot: ordinary.snapshot }));
                    await storage.execute({ operation: 'admit', runId: id, machineId, origin: { kind: 'direct' },
                        accountCurrentness: witness, recipientKeyEnvelopes: [], acceptedEnvelope: envelope });
                    // Persistence is the genuine boundary: freeze a strict
                    // admitted due order A < B < C without a test scheduler.
                    await db.automationRun.update({ where: { id }, data: { dueAt: new Date(originalDueAt.getTime() + ordinal) } });
                }
                secondBeforeWake = await db.automationRun.findUniqueOrThrow({ where: { id: secondRunId },
                    select: { state: true, attempt: true, claimedByMachineId: true } });
                await queuedWake(secondRunId);
                await secondStarted.promise;
                await secondHeartbeat.promise;
                expect(heartbeatRuns.filter((id) => id === runId)).toHaveLength(parkedHeartbeatCount);
            }
            const held = await db.workflowRunInvocation.findFirstOrThrow({ where: { runId, lifecycle: 'waiting_for_review' } });
            const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId, runId, recordId: held.id,
                sequence: String(held.sequence), parentRecordId: held.parentRecordId, memberOrdinal: String(held.memberOrdinal), attempt: String(held.attempt) };
            const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
                envelope: parseWorkflowStoredContentEnvelopeV1(held.contentEnvelope) });
            if (opened.kind !== 'available') throw new Error('held_content_unavailable');
            const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
                progress: { ...opened.content, review: { ...opened.content.review,
                    decision: { kind: mode, requestedFromContentRevision: String(held.contentRevision) } } } }));
            await storage.execute({ operation: 'invocations.complete_review', runId, invocationId: held.id,
                invocationAttempt: String(held.attempt), expectedContentRevision: String(held.contentRevision),
                accountCurrentness: witness, mode, contentEnvelope });
            if (!parkFirst) releasePark.resolve();
            else if (!dropHint) await queuedWake();
            if (capacityOne) {
                expect(secondAborted).toBe(false);
                expect(inputs.map((input) => input.runId), JSON.stringify({ runId, secondRunId, thirdRunId,
                    capacityTransport, capacityOutcomes, capacityReadings, capacityFailures, secondBeforeWake }))
                    .toEqual([runId, secondRunId]);
                expect(await db.automationRun.count({ where: { accountId, state: 'running' } })).toBe(1);
                expect(await db.automationRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ state: 'queued', dueAt: originalDueAt });
                releaseSecond.resolve();
            }
            // The existing worker reconciliation (45s + <=15s jitter) owns
            // recovery from a dropped queued hint, even with zero assignments.
            // No test-owned poll or second scheduler wakes the Run.
            await terminal.promise;
            if (capacityOne) {
                await thirdFinished.promise;
                expect(completionOrder).toEqual([secondRunId, runId, thirdRunId]);
                expect(secondAborted).toBe(false);
            }
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
                state: 'succeeded', workflowCustodyState: 'settled' });
            const leaves = await db.workflowRunInvocation.findMany({ where: { runId, parentRecordId: { not: null } }, orderBy: { attempt: 'asc' } });
            expect(reviewEntries).toBe(1);
            const reviewedInputs = inputs.filter((input) => input.runId === runId);
            expect(reviewedInputs).toHaveLength(mode === 'generate' ? 2 : 1);
            expect(new Set(inputs.map((input) => input.localId)).size).toBe(inputs.length);
            expect(leaves.map((leaf) => leaf.lifecycle)).toEqual(mode === 'generate' ? ['superseded', 'completed'] : ['completed']);
            if (mode === 'generate') {
                const generated = leaves[1]!;
                const content = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                    binding: { ...binding, recordId: generated.id, sequence: String(generated.sequence), attempt: String(generated.attempt) },
                    envelope: parseWorkflowStoredContentEnvelopeV1(generated.contentEnvelope) });
                expect(content).toMatchObject({ kind: 'available', content: { previousAttemptRecordId: held.id, result: 'Generated draft',
                    execution: { kind: 'session', sessionId, localInputId: reviewedInputs[1]!.localId } } });
                expect(reviewedInputs[1]!.text).not.toContain('workflow.run.invocations.publish_draft');
            }
        } finally {
            await cleanup();
        }
    }, 120_000);
});
