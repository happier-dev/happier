import { afterAll, beforeAll } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { approvalIdentityContract } from './approvalIdentity.contract.testkit';

let harness: LightSqliteHarness | undefined;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-approval-identity-', initEncrypt: true,
        env: { HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: 'none' } });
}, 180_000);
afterAll(async () => { await harness?.close(); });
approvalIdentityContract();
