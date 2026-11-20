import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentTeardownExecutor } from './teardown';
import { DEPLOYMENT_TEARDOWN_STEPS_V1 } from '@happier-dev/protocol/deployments/deploymentTeardownContentV1';

describe('teardown operation custody', () => {
    it.each([
        { nextOutcome: 'unknown', retrySameStep: false },
        { nextOutcome: 'failed', retrySameStep: false },
        { nextOutcome: 'failed', retrySameStep: true },
    ] as const)('retains an unknown cause on equal replay without attributing it to $nextOutcome (same step retry=$retrySameStep)', async ({ nextOutcome, retrySameStep }) => {
        const environment = createDeploymentEnvironmentDetailV1();
        const link = environment.targetLinks[0].targetLink;
        const member = link.members[0];
        const sample = createDeploymentReceiptDetailV1();
        let receipt = createDeploymentReceiptDetailV1({ deployment: { ...sample.deployment,
            operation: 'teardown', state: 'running', environmentId: environment.environment.id,
            targetLinkId: link.id, actionOperationId: 'remove-operation' }, content: { ...sample.content,
            teardown: { reason: 'manual', targetLinkRevision: link.revision,
                machines: [{ machineId: member.machineId, installationId: member.installationId }], resources: [],
                proofs: DEPLOYMENT_TEARDOWN_STEPS_V1.slice(0, 2).map(step => ({ step,
                    machineId: member.machineId, installationId: member.installationId, state: 'succeeded', resources: [] })) } } });
        let writes = 0;
        let effects = 0;
        let reconciled = false;
        const execute = createDeploymentTeardownExecutor({ serverId: 'home', machineId: member.machineId,
            readEnvironment: async () => environment, readReceipt: async () => receipt,
            writeTransition: async transition => {
                writes++;
                receipt = createDeploymentReceiptDetailV1({ deployment: { ...receipt.deployment,
                    revision: receipt.deployment.revision + 1, state: transition.state }, content: transition.content });
                return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                    deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state };
            },
            boundary: { observe: async operation => reconciled && !retrySameStep
                ? operation.step === 'removeTarget' ? { kind: 'proved', resources: [] }
                    : { kind: nextOutcome, reason: 'domain_removal_failed' }
                : { kind: 'needed' }, execute: async () => {
                effects++;
                if (reconciled) return { kind: 'failed', reason: 'network_removal_failed' };
                throw Object.assign(new Error('private native output'), { code: 'EACCES' });
            } } });
        const request = { actionId: 'deployments.teardown' as const, input: { serverId: 'home',
            environmentId: environment.environment.id, targetLinkId: link.id, expectedRevision: environment.environment.revision,
            expectedTargetLinkRevision: link.revision, requestKey: receipt.deployment.requestKey, reason: 'manual' as const,
            contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
            receipt: { ok: true as const, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state },
            context: { surface: 'cli' as const, operationAcceptance: { operationId: 'remove-operation', accept() {} } } };
        const first = await execute(request);
        expect(first).toMatchObject({ ok: false, errorCode: 'outcome_unknown', failureCause: { errorCode: 'EACCES' } });
        expect(receipt.content.failure?.failureCause).toEqual(first.ok ? undefined : first.failureCause);
        const initialWrites = writes;
        expect(await execute(request)).toMatchObject(first);
        expect(writes).toBe(initialWrites);
        expect(effects).toBe(1);
        expect(JSON.stringify(receipt)).not.toContain('private native output');
        if (retrySameStep) {
            // A persisted known failure can retain a cause from its earlier attempt.
            receipt = createDeploymentReceiptDetailV1({ deployment: { ...receipt.deployment, state: 'failed' },
                content: { ...receipt.content, teardown: { ...receipt.content.teardown!,
                    proofs: receipt.content.teardown!.proofs.map(proof => proof.step === 'removeTarget'
                        ? { ...proof, state: 'failed' } : proof) } } });
        }
        reconciled = true;
        const next = await execute(request);
        expect(next).toMatchObject({ ok: false, errorCode: nextOutcome === 'failed' ? 'deployment_failed' : 'outcome_unknown',
            details: { step: retrySameStep ? 'removeTarget' : 'removeDomain',
                reason: retrySameStep ? 'network_removal_failed' : 'domain_removal_failed' } });
        expect(next).not.toHaveProperty('failureCause');
        expect(receipt.content.failure).toBeUndefined();
        expect(effects).toBe(retrySameStep ? 2 : 1);
    });

    it.each([false, true])('reconciles an unknown step without repeating its effect (absence proved=%s)', async absent => {
        const environment = createDeploymentEnvironmentDetailV1();
        const link = environment.targetLinks[0].targetLink;
        const sample = createDeploymentReceiptDetailV1();
        const member = link.members[0];
        let receipt = createDeploymentReceiptDetailV1({ deployment: { ...sample.deployment,
            operation: 'teardown', state: 'outcome_unknown', environmentId: environment.environment.id,
            targetLinkId: link.id, actionOperationId: 'remove-operation' }, content: { ...sample.content,
            teardown: { reason: 'manual', targetLinkRevision: link.revision,
                machines: [{ machineId: member.machineId, installationId: member.installationId }], resources: [],
                proofs: DEPLOYMENT_TEARDOWN_STEPS_V1.slice(0, 3).map(step => ({ step,
                    machineId: member.machineId, installationId: member.installationId,
                    state: step === 'removeTarget' ? 'outcome_unknown' : 'succeeded', resources: [],
                    ...(step === 'removeTarget' ? { reason: 'action_failed' } : {}) })) } } });
        let writes = 0;
        let effects = 0;
        const observed: string[] = [];
        const execute = createDeploymentTeardownExecutor({ serverId: 'home', machineId: member.machineId,
            readEnvironment: async () => environment, readReceipt: async () => receipt,
            writeTransition: async transition => {
                writes++;
                receipt = createDeploymentReceiptDetailV1({ deployment: { ...receipt.deployment,
                    revision: receipt.deployment.revision + 1, state: transition.state }, content: transition.content });
                return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                    deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state };
            },
            boundary: { observe: async request => { observed.push(request.step); return absent
                ? { kind: 'proved', resources: [] } : { kind: 'needed' }; },
                execute: async () => { effects++; return { kind: 'unknown', reason: 'action_failed' }; } } });
        const request = { actionId: 'deployments.teardown' as const, input: { serverId: 'home',
            environmentId: environment.environment.id, targetLinkId: link.id, expectedRevision: environment.environment.revision,
            expectedTargetLinkRevision: link.revision, requestKey: receipt.deployment.requestKey, reason: 'manual' as const,
            contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
            receipt: { ok: true as const, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state },
            context: { surface: 'cli' as const, operationAcceptance: { operationId: 'remove-operation', accept() {} } } };
        expect(await execute(request)).toMatchObject(absent ? { ok: true, state: 'succeeded' } : { ok: false, errorCode: 'outcome_unknown' });
        expect(effects).toBe(0);
        expect(observed[0]).toBe('removeTarget');
        if (!absent) expect(writes).toBe(0);
    });
    it.each([
        { machineCount: 1, resuming: false, change: undefined },
        { machineCount: 3, resuming: false, change: undefined },
        { machineCount: 1, resuming: true, change: undefined },
        { machineCount: 1, resuming: false, change: 'cancelBeforeEffect' },
        { machineCount: 1, resuming: true, change: 'cancelBeforeEffect' },
        { machineCount: 1, resuming: false, change: 'cancelBetweenSteps' },
        { machineCount: 1, resuming: false, change: 'intentBeforeEffect' },
        { machineCount: 1, resuming: false, change: 'staleRevision' },
    ] as const)('reads Home at each teardown effect boundary ($machineCount Machines, resuming=$resuming, change=$change)', async ({ machineCount, resuming, change }) => {
        const environment = createDeploymentEnvironmentDetailV1();
        const link = environment.targetLinks[0].targetLink;
        link.members = Array.from({ length: machineCount }, (_, index) => ({
            machineId: `machine-${index}`, installationId: `installation-${index}`, state: 'active' as const,
        }));
        link.machines = link.members.map(member => member.machineId);
        const sample = createDeploymentReceiptDetailV1();
        let receipt = createDeploymentReceiptDetailV1({ deployment: { ...sample.deployment,
            operation: 'teardown', state: 'running', environmentId: environment.environment.id,
            targetLinkId: link.id, actionOperationId: 'remove-operation' }, content: { ...sample.content,
            teardown: { reason: 'manual', targetLinkRevision: link.revision,
                machines: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })),
                resources: [], proofs: resuming ? [{ step: DEPLOYMENT_TEARDOWN_STEPS_V1[0],
                    machineId: link.members[0].machineId, installationId: link.members[0].installationId,
                    state: 'running', resources: [] }] : [] } } });
        let reads = 0;
        let effects = 0;
        let updateAfterWrite = false;
        let observations = 0;
        // Home receipt reads/writes and native effects are the system boundaries.
        const execute = createDeploymentTeardownExecutor({ serverId: 'home', machineId: link.machines[0],
            readEnvironment: async () => environment,
            readReceipt: async () => {
                reads++;
                if (updateAfterWrite) {
                    updateAfterWrite = false;
                    if (change === 'intentBeforeEffect') {
                        receipt = { ...receipt, content: { ...receipt.content,
                            teardown: { ...receipt.content.teardown!, targetLinkRevision: link.revision + 1 } } };
                    } else {
                        receipt = { ...receipt, deployment: { ...receipt.deployment, cancelRequestedAtMs: 1000 } };
                    }
                }
                return receipt;
            },
            writeTransition: async transition => {
                if (transition.expectedRevision !== receipt.deployment.revision) {
                    return { ok: false, errorCode: 'deployment_conflict', error: 'Home rejected stale revision' };
                }
                receipt = createDeploymentReceiptDetailV1({ deployment: { ...receipt.deployment,
                    revision: receipt.deployment.revision + 1, state: transition.state }, content: transition.content });
                if (change === 'cancelBetweenSteps' && effects === 1) updateAfterWrite = true;
                return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                    deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state };
            },
            boundary: {
                observe: async () => {
                    observations++;
                    if (change === 'cancelBeforeEffect' || change === 'intentBeforeEffect') updateAfterWrite = true;
                    if (change === 'staleRevision') receipt = { ...receipt, deployment: {
                        ...receipt.deployment, revision: receipt.deployment.revision + 1,
                    } };
                    return { kind: 'needed' };
                },
                execute: async () => { effects++; return { kind: 'proved', resources: [] }; },
            } });
        const result = await execute({ actionId: 'deployments.teardown', input: { serverId: 'home',
            environmentId: environment.environment.id, targetLinkId: link.id, expectedRevision: environment.environment.revision,
            expectedTargetLinkRevision: link.revision, requestKey: receipt.deployment.requestKey, reason: 'manual',
            contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
            receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'running' },
            context: { surface: 'cli', operationAcceptance: { operationId: 'remove-operation', accept() {} } } });
        if (change === 'cancelBeforeEffect' || change === 'cancelBetweenSteps') {
            expect(result).toMatchObject({ ok: false, errorCode: 'cancelled' });
        } else if (change) {
            expect(result).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
        } else {
            expect(result).toMatchObject({ ok: true, state: 'succeeded' });
        }
        const steps = machineCount * DEPLOYMENT_TEARDOWN_STEPS_V1.length;
        expect(effects).toBe(change === 'cancelBetweenSteps' ? 1 : change ? 0 : steps);
        expect(observations).toBe(change ? 1 : steps);
        if (!change) {
            // Initial receipt and first step admission, then one read after
            // each running and completed proof, including across Machines.
            expect(reads).toBe(2 + 2 * steps);
        }
    });
    it.each([true, false])('settles final Environment removal from the signed Home response (accepted=%s)', async accepted => {
        const environment = createDeploymentEnvironmentDetailV1();
        const link = environment.targetLinks[0].targetLink;
        const sample = createDeploymentReceiptDetailV1();
        const machines = link.members.map(({ machineId, installationId }) => ({ machineId, installationId }));
        const receipt = createDeploymentReceiptDetailV1({ deployment: { ...sample.deployment,
            operation: 'teardown', state: 'running', environmentId: environment.environment.id,
            targetLinkId: link.id, actionOperationId: 'remove-operation' }, content: { ...sample.content,
            teardown: { reason: 'manual', targetLinkRevision: link.revision, machines, resources: [],
                proofs: machines.flatMap(member => DEPLOYMENT_TEARDOWN_STEPS_V1.map(step => ({
                    ...member, step, state: 'succeeded' as const, resources: [],
                }))) } } });
        let removed = false;
        // Home persistence is the boundary: after committed deletion its receipt
        // cannot be read through the deleted Environment.
        const execute = createDeploymentTeardownExecutor({ serverId: 'home', machineId: link.machines[0],
            readEnvironment: async () => environment,
            readReceipt: async () => { if (removed) throw new Error('Environment absent'); return receipt; },
            writeTransition: async () => {
                if (!accepted) return { ok: false, errorCode: 'deployment_conflict', error: 'Home removal failed' };
                removed = true;
                return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision + 1,
                    deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision + 1,
                    state: 'succeeded', environmentRemoved: true };
            },
            boundary: { observe: async () => { throw new Error('All native removal already proved'); },
                execute: async () => { throw new Error('All native removal already proved'); } } });
        const result = await execute({ actionId: 'deployments.teardown', input: { serverId: 'home',
            environmentId: environment.environment.id, targetLinkId: link.id, expectedRevision: environment.environment.revision,
            expectedTargetLinkRevision: link.revision, requestKey: receipt.deployment.requestKey, reason: 'manual',
            removeEnvironment: true, contentArtifactId: receipt.deployment.contentArtifactId,
            contentHeaderVersion: 1, contentBodyVersion: 1 },
            receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'running' },
            context: { surface: 'cli', operationAcceptance: { operationId: 'remove-operation', accept() {} } } });
        expect(result).toMatchObject(accepted ? { ok: true, state: 'succeeded', environmentRemoved: true }
            : { ok: false, errorCode: 'deployment_conflict', details: { environmentId: environment.environment.id,
                step: 'removeEnvironment', partial: true, requiredFact: 'environmentRemoval', remedy: expect.any(String) } });
        expect(removed).toBe(accepted);
    });

    it.each([false, true])('replays completed teardown without native effects (subset=%s)', async subset => {
        const environment = createDeploymentEnvironmentDetailV1();
        const link = environment.targetLinks[0].targetLink;
        if (subset) {
            link.members.push({ machineId: 'remaining-machine', installationId: 'remaining-installation', state: 'active' });
            link.machines.push('remaining-machine');
        }
        const machines = subset ? [link.members[0]] : link.members;
        const admittedRevision = link.revision;
        if (!subset) link.revision++;
        const sample = createDeploymentReceiptDetailV1();
        const receipt = createDeploymentReceiptDetailV1({ deployment: { ...sample.deployment,
            operation: 'teardown', state: 'succeeded', environmentId: environment.environment.id,
            targetLinkId: link.id }, content: { ...sample.content,
            teardown: { reason: 'manual', targetLinkRevision: admittedRevision,
                machines: machines.map(({ machineId, installationId }) => ({ machineId, installationId })), resources: [], proofs: [] } } });
        const execute = createDeploymentTeardownExecutor({ serverId: 'home', machineId: link.machines[0],
            readEnvironment: async () => environment, readReceipt: async () => receipt,
            writeTransition: async () => { throw new Error('Completion replay must not write'); },
            boundary: { observe: async () => { throw new Error('Completion replay must not observe native state'); },
                execute: async () => { throw new Error('Completion replay must not remove again'); } } });
        expect(await execute({ actionId: 'deployments.teardown', input: { serverId: 'home',
            environmentId: environment.environment.id, targetLinkId: link.id, expectedRevision: environment.environment.revision,
            expectedTargetLinkRevision: admittedRevision, requestKey: receipt.deployment.requestKey, reason: 'manual',
            ...(subset ? { machines: machines.map(member => member.machineId) } : {}),
            contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
            receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'succeeded' },
            context: { surface: 'cli' } })).toMatchObject({ ok: true, state: 'succeeded' });
    });

    it('refuses a different admitted operation before native removal or receipt mutation', async () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const link = environment.targetLinks[0].targetLink;
        const sample = createDeploymentReceiptDetailV1();
        const receipt = createDeploymentReceiptDetailV1({ deployment: { ...sample.deployment,
            operation: 'teardown', state: 'queued', revision: 1, environmentId: environment.environment.id,
            targetLinkId: link.id, actionOperationId: 'original-operation' }, content: { ...sample.content,
            teardown: { reason: 'manual', targetLinkRevision: link.revision,
                machines: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })), resources: [], proofs: [] } } });
        let writes = 0;
        let nativeEffects = 0;
        // Persisted Home/Artifact reads and native effects are the external ports;
        // receipt parsing, admission and continuation remain the real owner.
        const execute = createDeploymentTeardownExecutor({ serverId: 'home', machineId: link.machines[0],
            readEnvironment: async () => environment, readReceipt: async () => receipt,
            writeTransition: async () => { writes++; return { ok: false, errorCode: 'unexpected_write', error: 'unexpected_write' }; },
            boundary: { observe: async () => ({ kind: 'needed' }),
                execute: async () => { nativeEffects++; return { kind: 'failed', reason: 'unexpected_effect' }; } } });
        expect(await execute({ actionId: 'deployments.teardown', input: { serverId: 'home',
            environmentId: environment.environment.id, targetLinkId: link.id, expectedRevision: environment.environment.revision,
            expectedTargetLinkRevision: link.revision, requestKey: receipt.deployment.requestKey, reason: 'manual',
            contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
            receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: 1, state: 'queued' },
            context: { surface: 'cli', operationAcceptance: { operationId: 'other-operation', accept() {} } } }))
            .toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
        expect({ writes, nativeEffects }).toEqual({ writes: 0, nativeEffects: 0 });
    });
});
