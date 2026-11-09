import { afterAll, beforeAll, describe } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { workflowReplyCustodyContract } from './sessionMessageReplyWorkflowCustody.testkit';

describe('retained Workflow reply custody (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'reply-workflow-custody-', initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });
    workflowReplyCustodyContract();
});
