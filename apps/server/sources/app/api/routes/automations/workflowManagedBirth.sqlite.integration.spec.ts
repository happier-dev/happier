import { afterAll, beforeAll, it } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { exerciseManagedWorkflowBirth } from './workflowManagedBirth.testkit';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-workflow-managed-birth-',
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
}, 120_000);
afterAll(async () => { if (harness) await harness.close(); });
it('admits immutable managed Run birth and selects only its id amid unrelated Runs and Sessions', () => exerciseManagedWorkflowBirth());
