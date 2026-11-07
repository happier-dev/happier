import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';

import { db, initDbPostgres } from '../../../../apps/server/sources/storage/db';
import { createAuthenticatedTestApp } from '../../../../apps/server/sources/app/api/testkit/sqliteFastify';
import { registerAutomationV3Routes } from '../../../../apps/server/sources/app/api/routes/automations/registerAutomationV3Routes';
import { automationAccountCurrentnessSelect, deriveAutomationAccountCurrentnessWitness } from '../../../../apps/server/sources/app/automations/automationAccountCurrentness';
import { claimAutomationRun } from '../../../../apps/server/sources/app/automations/automationClaimService';
import { admitWorkflowRun, cancelWorkflowRun, listWorkflowRunsForRecovery } from '../../../../apps/server/sources/app/workflows/workflowRunService';
import { materializeWorkflowAcceptedSnapshotFixture } from '../../../../apps/server/sources/testkit/workflowAcceptedSnapshot';
import { startAutomationWorker } from '../../../../apps/cli/src/daemon/automation/automationWorker';
import { withConfiguredDaemonTestHome } from '../../../../apps/cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { readOrCreateInstallationIdentity } from '../../../../apps/cli/src/daemon/identity/store';
import { readCurrentMachineInstallation } from '../../../../apps/cli/src/daemon/identity/currentMachineInstallation';
import { updateSettings, writeStoredCredentialsForServerId, readStoredCredentials } from '../../../../apps/cli/src/persistence';
import { configuration } from '../../../../apps/cli/src/configuration';
import { installAxiosFastifyAdapter } from '../../../../apps/cli/src/testkit/http/axiosAdapter';
import { resolveServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { AutomationRunCauseSchema, serializeAutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol';
import { encodeAutomationRunCause } from '../../../../apps/server/sources/app/automations/automationRunCauseCodec';
import { deleteAutomation } from '../../../../apps/server/sources/app/automations/automationCrudService';
import { registerWorkflowRunStorageRoutes } from '../../../../apps/server/sources/app/api/routes/automations/registerWorkflowRunStorageRoutes';
import { createProductionWorkflowRunCoordinator } from '../../../../apps/cli/src/daemon/workflows/production';
import { createWorkflowAcceptedAuthorizationCurrentness } from '../../../../apps/cli/src/daemon/workflows/daemonRuntime';

// Native JS composes the real server and CLI owners without combining their
// incompatible package-local @ aliases in one TypeScript compilation program.
describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Direct Run lease wake composition (PostgreSQL)', () => {
beforeAll(async () => {
    if (process.env.HAPPIER_DB_PROVIDER !== 'postgres' || !process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID) {
        throw new Error('Use the disposable PostgreSQL DB-contract harness');
    }
    initDbPostgres();
    await db.$connect();
});
afterAll(async () => { await db.$disconnect(); });

it.each(['retained', 'other-machine', 'released', 'omitted-deadline'])(
'uses only known retained direct Run deadlines after empty catch-up (%s)', async scenario => {
    await withConfiguredDaemonTestHome({ prefix: 'automation-direct-lease-' }, async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machineId = randomUUID();
        const token = randomUUID();
        await writeStoredCredentialsForServerId(configuration.activeServerId, { token, encryption: null });
        const credentials = await readStoredCredentials();
        if (!credentials) throw new Error('Fixture authentication unavailable');
        await updateSettings(settings => ({ ...settings,
            machineIdByServerId: { ...settings.machineIdByServerId, [configuration.activeServerId]: machineId },
        }));
        const identity = await readOrCreateInstallationIdentity();
        expect((await readCurrentMachineInstallation())?.machineId).toBe(machineId);
        await db.machine.create({ data: { id: machineId, accountId: account.id, metadata: '{}',
            installationId: identity.installationId, installationPublicKey: Buffer.from(identity.publicKey, 'base64url') } });
        const runMachineId = scenario === 'other-machine' ? randomUUID() : machineId;
        const runInstallationId = scenario === 'other-machine' ? randomUUID() : identity.installationId;
        if (runMachineId !== machineId) await db.machine.create({ data: { id: runMachineId, accountId: account.id,
            metadata: '{}', installationId: runInstallationId,
            installationPublicKey: Buffer.from(identity.publicKey, 'base64url') } });
        const accountCurrentness = deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
            where: { id: account.id }, select: automationAccountCurrentnessSelect,
        }));
        if (!accountCurrentness) throw new Error('Fixture currentness unavailable');
        const runId = randomUUID();
        const acceptedSnapshot = await materializeWorkflowAcceptedSnapshotFixture({
            definition: { version: 1, blocks: [{ kind: 'wait', id: 'answer',
                document: { text: 'Answer', references: [], attachments: [] }, result: { kind: 'text' } }] },
            context: { source: { kind: 'inline' }, inputs: {}, machineId: runMachineId,
                executionTarget: { kind: 'session' }, origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } },
                workspaceTarget: { project: { machineId: runMachineId, directory: '/repo', checkoutRootPath: '/repo' } } },
        });
        await admitWorkflowRun({ accountId: account.id, runId, machineId: runMachineId, origin: { kind: 'direct' }, accountCurrentness,
            acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: account.id, runId }, acceptedSnapshot,
            })) });
        const claim = { accountId: account.id, machineId: runMachineId, leaseDurationMs: 30_000, scope: 'workflow',
            recipeFeaturePolicy: { workflowsEnabled: true } };
        const freshRequest = () => ({ machineInstallationId: runInstallationId,
            nonce: randomUUID(), expiresAt: new Date(Date.now() + 30_000) });
        const retained = await claimAutomationRun({ ...claim, claimRequest: freshRequest() });
        expect(retained.run).toMatchObject({ id: runId, state: 'claimed', attempt: 1 });
        const row = await db.automationRun.findUniqueOrThrow({ where: { id: runId } });
        expect(row.leaseExpiresAt).not.toBeNull();
        await expect(listWorkflowRunsForRecovery({ accountId: account.id, machineId,
            pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES })).resolves.toMatchObject({ candidates: [] });

        const app = createAuthenticatedTestApp();
        const paths = [];
        const claimNonces = [];
        const assignmentResponses = [];
        const claimedAttempts = [];
        const claimDecisions = [];
        app.addHook('onRequest', async request => {
            request.headers['x-test-user-id'] = account.id;
            paths.push(request.url.split('?')[0]);
            if (request.url === '/v3/automations/runs/claim') {
                const header = request.headers[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1];
                if (typeof header !== 'string') throw new Error('Missing signed publisher proof');
                const decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
                if (!decoded || typeof decoded !== 'object' || !('proof' in decoded)
                    || !decoded.proof || typeof decoded.proof !== 'object' || !('nonce' in decoded.proof)
                    || typeof decoded.proof.nonce !== 'string') throw new Error('Missing signed claim identity');
                claimNonces.push(decoded.proof.nonce);
            }
        });
        app.addHook('onSend', async (request, _reply, payload) => {
            if (typeof payload !== 'string') return payload;
            if (request.url.split('?')[0] === '/v3/automations/worker/assignments') {
                const response = JSON.parse(payload);
                if (scenario === 'omitted-deadline') delete response.directRunClaimDeadlines;
                assignmentResponses.push(response);
                return JSON.stringify(response);
            }
            if (request.url === '/v3/automations/runs/claim') {
                const response = JSON.parse(payload);
                if (response.run && typeof response.run === 'object') {
                    claimedAttempts.push(response.run.attempt);
                    claimDecisions.push(response.run.attempt);
                } else if (response.run === null) claimDecisions.push(null);
            }
            return payload;
        });
        registerAutomationV3Routes(app);
        await app.ready();
        const restoreHttp = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        let worker;
        try {
            worker = startAutomationWorker({ token, credentials, machineId, env: process.env });
            await worker.catchUp();
            expect(paths.filter(path => path === '/v3/automations/runs/claim')).toHaveLength(1);
            expect(await db.automationWorkerClaimReceipt.count({ where: { accountId: account.id } })).toBe(2);
            const emptyReceipt = await db.automationWorkerClaimReceipt.findFirstOrThrow({
                where: { accountId: account.id }, orderBy: { createdAt: 'desc' },
            });
            if (scenario === 'omitted-deadline') {
                expect(assignmentResponses.at(-1)).not.toHaveProperty('directRunClaimDeadlines');
            } else {
                expect(assignmentResponses.at(-1).directRunClaimDeadlines).toEqual(scenario === 'other-machine' ? [] : [
                    { runId, nextClaimAt: row.leaseExpiresAt.getTime() + 1 },
                ]);
            }
            if (scenario === 'released') {
                await cancelWorkflowRun({ accountId: account.id, runId, expectedRevision: row.revision });
                await worker.catchUp();
                expect(assignmentResponses.at(-1).directRunClaimDeadlines).toEqual([]);
            }
            const readsAfterCatchUp = paths.filter(path => path === '/v3/automations/worker/assignments').length;
            const claimsAfterCatchUp = paths.filter(path => path === '/v3/automations/runs/claim').length;
            // Only the system clock is replaced. The real PG owner, HTTP routes,
            // signed claim client, assignment cache, and worker timer stay real.
            await vi.advanceTimersByTimeAsync(row.leaseExpiresAt.getTime() - Date.now() - 1);
            await worker.liveWorkProducer.read();
            expect(paths.filter(path => path === '/v3/automations/worker/assignments')).toHaveLength(readsAfterCatchUp);
            expect(paths.filter(path => path === '/v3/automations/runs/claim')).toHaveLength(claimsAfterCatchUp);
            await vi.advanceTimersByTimeAsync(1);
            await worker.liveWorkProducer.read();
            await expect(db.automationRun.findUniqueOrThrow({ where: { id: runId } })).resolves.toMatchObject({ attempt: 1 });
            expect(paths.filter(path => path === '/v3/automations/worker/assignments')).toHaveLength(readsAfterCatchUp);
            expect(paths.filter(path => path === '/v3/automations/runs/claim')).toHaveLength(claimsAfterCatchUp);
            await expect(claimAutomationRun({ ...claim, claimRequest: freshRequest() })).resolves.toMatchObject({ run: null });
            await vi.advanceTimersByTimeAsync(1);
            await worker.liveWorkProducer.read();
            const automatic = await db.automationRun.findUniqueOrThrow({ where: { id: runId } });
            expect(automatic.attempt).toBe(scenario === 'retained' ? 2 : 1);
            expect(claimedAttempts).toEqual(scenario === 'retained' ? [2] : []);
            expect(new Set(claimNonces).size).toBe(claimNonces.length);
            // Replaying the signed empty request cannot select the now-due Run.
            await expect(claimAutomationRun({ ...claim, machineId, claimRequest: {
                machineInstallationId: identity.installationId, nonce: claimNonces[0],
                expiresAt: emptyReceipt.expiresAt,
            } })).resolves.toMatchObject({ run: null });
            if (scenario === 'retained') {
                // The real executor has no daemon coordinator in this route
                // composition, so dispatch fails and leaves the new lease held.
                // Its trailing refresh must retain that lease's deadline even
                // while this Run is still in the worker's active execution map.
                await vi.waitFor(async () => {
                    expect(assignmentResponses.at(-1).directRunClaimDeadlines).toEqual([
                        { runId, nextClaimAt: automatic.leaseExpiresAt.getTime() + 1 },
                    ]);
                    expect(await worker.liveWorkProducer.read()).toMatchObject({ items: [] });
                    expect(claimDecisions.slice(claimDecisions.lastIndexOf(2) + 1)).toContain(null);
                });
                await vi.advanceTimersByTimeAsync(0);
                await worker.liveWorkProducer.read();
                const settledReads = paths.filter(path => path === '/v3/automations/worker/assignments').length;
                const settledClaims = paths.filter(path => path === '/v3/automations/runs/claim').length;
                await vi.advanceTimersByTimeAsync(automatic.leaseExpiresAt.getTime() - Date.now() - 1);
                await worker.liveWorkProducer.read();
                expect(paths.filter(path => path === '/v3/automations/worker/assignments')).toHaveLength(settledReads);
                expect(paths.filter(path => path === '/v3/automations/runs/claim')).toHaveLength(settledClaims);
                await vi.advanceTimersByTimeAsync(1);
                await worker.liveWorkProducer.read();
                expect(paths.filter(path => path === '/v3/automations/worker/assignments')).toHaveLength(settledReads);
                expect(paths.filter(path => path === '/v3/automations/runs/claim')).toHaveLength(settledClaims);
                await expect(claimAutomationRun({ ...claim, claimRequest: freshRequest() })).resolves.toMatchObject({ run: null });
                await vi.advanceTimersByTimeAsync(1);
                await worker.liveWorkProducer.read();
                const secondRecovery = await db.automationRun.findUniqueOrThrow({ where: { id: runId } });
                expect(secondRecovery).toMatchObject({ state: 'claimed', attempt: 3 });
                expect(claimedAttempts).toEqual([2, 3]);
                expect(new Set(claimNonces).size).toBe(claimNonces.length);
                // End the retained lease through its canonical lifecycle owner,
                // then prove the learned deadline is cleared before settled idle.
                await cancelWorkflowRun({ accountId: account.id, runId, expectedRevision: secondRecovery.revision });
                await worker.catchUp();
                expect(assignmentResponses.at(-1).directRunClaimDeadlines).toEqual([]);
            }
            const idleReads = paths.filter(path => path === '/v3/automations/worker/assignments').length;
            const idleClaims = paths.filter(path => path === '/v3/automations/runs/claim').length;
            await vi.advanceTimersByTimeAsync(60_000);
            await worker.liveWorkProducer.read();
            expect(paths.filter(path => path === '/v3/automations/worker/assignments')).toHaveLength(idleReads);
            expect(paths.filter(path => path === '/v3/automations/runs/claim')).toHaveLength(idleClaims);
            expect(claimedAttempts).toEqual(scenario === 'retained' ? [2, 3] : []);
        } finally {
            worker?.stop();
            vi.useRealTimers();
            restoreHttp();
            await app.close();
        }
    });
});

it.each(['deleted', 'live'])('reclaims accepted Automation custody after causal source deletion (%s)', async definitionState => {
    await withConfiguredDaemonTestHome({ prefix: 'automation-orphan-wake-' }, async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machineId = randomUUID();
        const otherMachineId = randomUUID();
        const token = randomUUID();
        await writeStoredCredentialsForServerId(configuration.activeServerId, { token, encryption: null });
        const credentials = await readStoredCredentials();
        if (!credentials) throw new Error('Fixture authentication unavailable');
        await updateSettings(settings => ({ ...settings,
            machineIdByServerId: { ...settings.machineIdByServerId, [configuration.activeServerId]: machineId },
        }));
        const identity = await readOrCreateInstallationIdentity();
        await db.machine.createMany({ data: [machineId, otherMachineId].map(id => ({ id, accountId: account.id,
            metadata: '{}', installationId: id === machineId ? identity.installationId : randomUUID(),
            installationPublicKey: Buffer.from(identity.publicKey, 'base64url') })) });
        const definition = { version: 1, blocks: [{ kind: 'wait', id: 'answer',
            document: { text: 'Answer', references: [], attachments: [] }, result: { kind: 'text' } }] };
        const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1,
            workflow: { t: 'plain', v: { workspace: { directory: '/repo' },
                executionTarget: { kind: 'session' }, inlineDefinition: definition } }, triggerEvidence: null });
        expect(recipe.kind).toBe('available');
        const automation = await db.automation.create({ data: { accountId: account.id, name: 'Retained',
            templateVersion: 1, templateCiphertext: recipe.serialized,
            assignments: { create: { machineId, enabled: true, priority: 0 } } } });
        const expired = new Date(Date.now() - 1_000);
        const retained = [];
        for (const assignedMachineId of [machineId, otherMachineId]) {
            const runId = randomUUID();
            const acceptedSnapshot = await materializeWorkflowAcceptedSnapshotFixture({ definition,
                context: { source: { kind: 'automation', automationId: automation.id }, inputs: {}, machineId: assignedMachineId,
                    executionTarget: { kind: 'session' }, authorization: { principal: { kind: 'host' } },
                    workspaceTarget: { project: { machineId: assignedMachineId, directory: '/repo', checkoutRootPath: '/repo' } } },
            });
            // Accepted custody survives the causal Session. Public Automation
            // detail omits input, so reproduce this with valid stored bytes.
            retained.push(await db.automationRun.create({ data: { accountId: account.id, automationId: automation.id,
                id: runId, state: 'running', workflowCustodyState: 'pending',
                executionInputEnvelope: JSON.stringify(recipe.recipe.workflow),
                workflowAcceptedSnapshotEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                    mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: account.id, runId }, acceptedSnapshot,
                })),
                claimedByMachineId: assignedMachineId, leaseExpiresAt: expired, attempt: 1,
                scheduledAt: expired, dueAt: expired,
                assignments: { create: { machineId: assignedMachineId, priority: 0 } },
                ...encodeAutomationRunCause(AutomationRunCauseSchema.parse(assignedMachineId !== machineId
                    ? { kind: 'manual', invokedAt: expired.getTime() } : { kind: 'trigger',
                    triggerKind: 'sessionLifecycle', triggerId: randomUUID(), triggerRevision: 0,
                    occurredAt: expired.getTime(), occurrenceKey: createHash('sha256').update(randomUUID()).digest('base64url'), evidence: {
                        event: 'parentTurnCompleted', sourceSessionId: randomUUID(), sourceTurnId: randomUUID(),
                        policy: { kind: 'everyMatch' },
                    } })),
            } }));
        }
        if (definitionState === 'deleted') await deleteAutomation({ accountId: account.id, automationId: automation.id });
        const resolveAccountEncryption = async () => ({ kind: 'available', witness:
            deriveAutomationAccountCurrentnessWitness(await db.account.findUniqueOrThrow({
                where: { id: account.id }, select: automationAccountCurrentnessSelect,
            })) });
        // A Wait-only snapshot releases no Session/native effects. These
        // unconsumed adapters fail loudly if the fixture starts such an effect.
        const unexpectedEffect = async () => { throw new Error('Unexpected native effect in wait-only fixture'); };
        const coordinateWorkflowRun = createProductionWorkflowRunCoordinator({ token, accountId: account.id, machineId,
            resolveAccountEncryption,
            isAcceptedAuthorizationCurrent: createWorkflowAcceptedAuthorizationCurrentness({ accountId: account.id,
                listAccountApiTokens: unexpectedEffect, resolveCurrentPluginOccurrenceId: unexpectedEffect,
                resolveCurrentPluginSourceCustody: unexpectedEffect, isMediatedSourceCurrent: unexpectedEffect }),
            resolveControllerContext: unexpectedEffect,
            execution: { credentials, serverId: configuration.activeServerId,
                machineAdmissionTransport: unexpectedEffect, resolveExistingSessionConversation: unexpectedEffect,
                detachedRun: { actionExecutor: { execute: unexpectedEffect }, buildActionContext: unexpectedEffect } },
        });
        const app = createAuthenticatedTestApp();
        const paths = [];
        const claimedRunIds = [];
        const claimedDepths = [];
        let pendingRequests = 0;
        let responseSequence = 0;
        let idleProjectionSequence = -1;
        let emptyClaimSequence = -1;
        app.addHook('onRequest', async request => {
            pendingRequests += 1;
            request.headers['x-test-user-id'] = account.id;
            paths.push(request.url.split('?')[0]);
        });
        app.addHook('onResponse', async () => { pendingRequests -= 1; });
        app.addHook('onSend', async (request, _reply, payload) => {
            const sequence = responseSequence++;
            if (request.url.startsWith('/v3/automations/worker/assignments') && typeof payload === 'string') {
                const response = JSON.parse(payload);
                if (response.assignments?.every(assignment => assignment.nextClaimAt === null)
                    && response.directRunClaimDeadlines?.length === 0) idleProjectionSequence = sequence;
            }
            if (request.url === '/v3/automations/runs/claim' && typeof payload === 'string') {
                const response = JSON.parse(payload);
                if (response.run) {
                    claimedRunIds.push(response.run.id);
                    claimedDepths.push(response.run.causeWorkDepth);
                } else if (response.run === null) emptyClaimSequence = sequence;
            }
            return payload;
        });
        registerAutomationV3Routes(app);
        registerWorkflowRunStorageRoutes(app);
        await app.ready();
        const restoreHttp = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        let worker;
        const waitForSettledIdle = async () => {
            // Parking is observable before its final capacity-refill request
            // finishes. Drain that real transition before measuring idle cost.
            await vi.waitFor(async () => {
                await vi.advanceTimersByTimeAsync(0);
                expect(idleProjectionSequence).toBeGreaterThanOrEqual(0);
                expect(emptyClaimSequence).toBeGreaterThan(idleProjectionSequence);
                expect(pendingRequests).toBe(0);
                expect(vi.getTimerCount()).toBe(0);
            }, { timeout: 60_000 }); // vitest.dbcontract.config.ts's containing test budget.
        };
        try {
            worker = startAutomationWorker({ token, credentials, machineId, env: process.env, coordinateWorkflowRun });
            await worker.catchUp();
            expect(claimedRunIds).toEqual([retained[0].id]);
            expect(claimedDepths).toEqual([undefined]);
            await vi.waitFor(async () => {
                expect(await db.automationRun.findUniqueOrThrow({ where: { id: retained[0].id } }))
                    .toMatchObject({ state: 'waiting_for_review', attempt: 2 });
                expect(await worker.liveWorkProducer.read()).toMatchObject({ items: [] });
            }, { timeout: 60_000 });
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: retained[1].id } })).toEqual(retained[1]);
            await waitForSettledIdle();
            const idleReads = paths.filter(path => path === '/v3/automations/worker/assignments').length;
            const idleClaims = paths.filter(path => path === '/v3/automations/runs/claim').length;
            await vi.advanceTimersByTimeAsync(60_000);
            await worker.liveWorkProducer.read();
            expect(paths.filter(path => path === '/v3/automations/worker/assignments')).toHaveLength(idleReads);
            expect(paths.filter(path => path === '/v3/automations/runs/claim')).toHaveLength(idleClaims);
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: retained[1].id } })).toEqual(retained[1]);

            // Positive wiring: a real new due Run under a live definition still
            // reaches the signed worker claim; another Machine's row is untouched.
            const liveAutomation = await db.automation.create({ data: { accountId: account.id, name: 'Live',
                templateVersion: 1, templateCiphertext: recipe.serialized,
                assignments: { create: { machineId, enabled: true, priority: 0 } } } });
            const due = new Date(Date.now() - 1);
            const liveRunId = randomUUID();
            const liveAccepted = await materializeWorkflowAcceptedSnapshotFixture({ definition,
                context: { source: { kind: 'automation', automationId: liveAutomation.id }, inputs: {}, machineId,
                    executionTarget: { kind: 'session' }, authorization: { principal: { kind: 'host' } },
                    workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } } },
            });
            const liveRun = await db.automationRun.create({ data: { accountId: account.id, automationId: liveAutomation.id,
                id: liveRunId,
                state: 'queued', workflowCustodyState: 'pending', scheduledAt: due, dueAt: due,
                executionInputEnvelope: JSON.stringify(recipe.recipe.workflow),
                workflowAcceptedSnapshotEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
                    mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: account.id, runId: liveRunId }, acceptedSnapshot: liveAccepted,
                })),
                assignments: { create: { machineId, priority: 0 } },
                ...encodeAutomationRunCause(AutomationRunCauseSchema.parse({ kind: 'manual', invokedAt: due.getTime() })),
            } });
            idleProjectionSequence = -1;
            emptyClaimSequence = -1;
            await worker.catchUp();
            expect(claimedRunIds).toEqual([retained[0].id, liveRun.id]);
            await vi.waitFor(async () => {
                expect(await db.automationRun.findUniqueOrThrow({ where: { id: liveRun.id } }))
                    .toMatchObject({ state: 'waiting_for_review', attempt: 1 });
                expect(await worker.liveWorkProducer.read()).toMatchObject({ items: [] });
            }, { timeout: 60_000 });
            await waitForSettledIdle();
            const settledReads = paths.filter(path => path === '/v3/automations/worker/assignments').length;
            const settledClaims = paths.filter(path => path === '/v3/automations/runs/claim').length;
            await vi.advanceTimersByTimeAsync(60_000);
            await worker.liveWorkProducer.read();
            expect(paths.filter(path => path === '/v3/automations/worker/assignments')).toHaveLength(settledReads);
            expect(paths.filter(path => path === '/v3/automations/runs/claim')).toHaveLength(settledClaims);
        } finally {
            worker?.stop();
            vi.useRealTimers();
            restoreHttp();
            await app.close();
        }
    });
});
});
