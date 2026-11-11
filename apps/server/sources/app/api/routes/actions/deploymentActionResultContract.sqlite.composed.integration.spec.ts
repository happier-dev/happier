import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEPLOYMENT_ACTION_IDS_V1, DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { getActionSpec, listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { inTx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { readDeploymentEnvironmentInTx, listDeploymentEnvironmentsInTx, readDeploymentReceiptInTx, listDeploymentReceiptsInTx } from '@/app/deployments/deploymentReadService';

const serverReadProducers = {
    'deployments.environments.get': (actor: string, serverId: string) => inTx(tx => readDeploymentEnvironmentInTx(tx, actor, {
        serverId, environmentId: 'missing-environment',
    })),
    'deployments.environments.list': (actor: string, serverId: string) => inTx(tx => listDeploymentEnvironmentsInTx(tx, actor, {
        serverId,
    })),
    'deployments.receipts.get': (actor: string, serverId: string) => inTx(tx => readDeploymentReceiptInTx(tx, actor, {
        serverId, deploymentId: 'missing-deployment',
    })),
    'deployments.receipts.list': (actor: string, serverId: string) => inTx(tx => listDeploymentReceiptsInTx(tx, actor, {
        serverId, environmentId: 'missing-environment',
    })),
} as const;

type ServerReadActionId = keyof typeof serverReadProducers;
const SERVER_READ_ACTION_IDS = Object.keys(serverReadProducers) as ServerReadActionId[];

/**
 * These are real producer paths, but the existing SQLite harness cannot reach
 * them without a live daemon/installed deployment. Keep the exclusion typed so
 * a newly added deployment Action is visible in this contract test immediately.
 */
const machineProducerExclusions = DEPLOYMENT_ACTION_IDS_V1
    .filter((actionId) => !getActionSpec(actionId).serverTransport || !SERVER_READ_ACTION_IDS.includes(actionId as ServerReadActionId))
    .map((actionId) => ({ actionId, reason: 'machine-produced result requires a live daemon or installed deployment in the existing harness' } as const));

describe('deployment Action producer result contract', () => {
    let harness: LightSqliteHarness;
    const actor = 'deployment-contract-test-account';
    const serverId = `srv_${'c'.repeat(32)}`;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-deployment-action-contract-', initEncrypt: true, initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
        await db.account.create({ data: { id: actor, encryptionMode: 'plain' } });
    }, 180_000);

    afterAll(async () => { await harness?.close(); });

    it('derives the complete Action family from the owner catalog and records typed unreachable producers', () => {
        const catalogIds = new Set(listActionSpecs().map(spec => spec.id));
        expect(DEPLOYMENT_ACTION_IDS_V1.every(actionId => catalogIds.has(actionId))).toBe(true);
        expect(new Set(machineProducerExclusions.map(row => row.actionId)).size + SERVER_READ_ACTION_IDS.length)
            .toBe(DEPLOYMENT_ACTION_IDS_V1.length);
        for (const row of machineProducerExclusions) expect(row.reason).toMatch(/live daemon|installed deployment/);
    });

    it.each(SERVER_READ_ACTION_IDS)('passes the real SQLite producer result for %s through its canonical strict schema', async (actionId) => {
        const result = await serverReadProducers[actionId](actor, serverId);
        expect(DeploymentActionOutputSchemasV1[actionId].safeParse(result), actionId).toMatchObject({ success: true });
    });

    it('rejects an undeclared producer key at the canonical schema boundary', () => {
        const result = { ok: false as const, error: 'deployment_unavailable' as const, producerMutation: true };
        expect(DeploymentActionOutputSchemasV1['deployments.environments.get'].safeParse(result).success).toBe(false);
    });
});
