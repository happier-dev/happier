import { afterAll, beforeAll, describe, it } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { exerciseManagedCreatorAccess, exerciseManagedCreatorBirth, exerciseManagedCreatorPublication, exerciseManagedCreatorSetupRecovery, exerciseManagedCreatorControllerProjection, exerciseManagedRequesterRetention, exerciseManagedEnrollmentInstallationContext } from './managedCreatorAccess.testkit';

describe('managed creator lifecycle on SQLite', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-creator-', initAuth: false, initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: `srv_${'a'.repeat(32)}` } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });
    it('admits only the exact creator without controller grants', exerciseManagedCreatorAccess);
    it('projects only the exact creator resource controller without private credential references', exerciseManagedCreatorControllerProjection);
    it('publishes pre-enrollment progress to the creator and custodian', exerciseManagedCreatorPublication);
    it('admits creation birth only on the exact resulting guest', exerciseManagedCreatorBirth);
    it('recovers setup only on the same requester-owned guest', exerciseManagedCreatorSetupRecovery);
    it('scopes native retention and readiness publication to the exact requester guest', exerciseManagedRequesterRetention);
    it('does not expand acquisition context custody into private native credential binding reads', exerciseManagedEnrollmentInstallationContext);
});
