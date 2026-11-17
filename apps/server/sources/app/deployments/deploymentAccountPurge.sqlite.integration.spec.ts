import { afterAll, beforeAll, describe } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { deploymentAccountPurgeCases } from './deploymentAccountPurge.testkit';

describe('Account deployment purge (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'deployment-purge-',
        initAuth: false, initEncrypt: false, initFiles: false }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    deploymentAccountPurgeCases();
});
