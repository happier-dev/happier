import { afterAll, beforeAll, it } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { exerciseManagedSessionBirth } from './sessionManagedBirth.testkit';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-birth-',
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
}, 120_000);
afterAll(async () => { if (harness) await harness.close(); });
it('commits and selects unique managed birth without opening 1,000 unrelated Sessions (SQLite)', () => exerciseManagedSessionBirth());
