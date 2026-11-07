import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTeardownExecutor } from './teardown';
import { DEPLOYMENT_TEARDOWN_STEPS_V1 } from '@happier-dev/deployment-protocol';

describe('teardown operation custody', () => {
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

    it('replays completion after Home advances the target link without repeating native effects', async () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const link = environment.targetLinks[0].targetLink;
        const admittedRevision = link.revision;
        link.revision++;
        const sample = createDeploymentReceiptDetailV1();
        const receipt = createDeploymentReceiptDetailV1({ deployment: { ...sample.deployment,
            operation: 'teardown', state: 'succeeded', environmentId: environment.environment.id,
            targetLinkId: link.id }, content: { ...sample.content,
            teardown: { reason: 'manual', targetLinkRevision: admittedRevision,
                machines: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })), resources: [], proofs: [] } } });
        const execute = createDeploymentTeardownExecutor({ serverId: 'home', machineId: link.machines[0],
            readEnvironment: async () => environment, readReceipt: async () => receipt,
            writeTransition: async () => { throw new Error('Completion replay must not write'); },
            boundary: { observe: async () => { throw new Error('Completion replay must not observe native state'); },
                execute: async () => { throw new Error('Completion replay must not remove again'); } } });
        expect(await execute({ actionId: 'deployments.teardown', input: { serverId: 'home',
            environmentId: environment.environment.id, targetLinkId: link.id, expectedRevision: environment.environment.revision,
            expectedTargetLinkRevision: admittedRevision, requestKey: receipt.deployment.requestKey, reason: 'manual',
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
