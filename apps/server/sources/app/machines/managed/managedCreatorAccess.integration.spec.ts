import { afterAll, beforeAll, describe, it } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { exerciseManagedCreatorAccess, exerciseManagedCreatorControllerProjection } from './managedCreatorAccess.testkit';

describe('managed creator lifecycle on SQLite', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-creator-', initAuth: false, initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: `srv_${'a'.repeat(32)}` } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });
    it('admits only the exact creator without controller grants', exerciseManagedCreatorAccess);
    it('projects only the exact creator resource controller without private credential references', exerciseManagedCreatorControllerProjection);
});
