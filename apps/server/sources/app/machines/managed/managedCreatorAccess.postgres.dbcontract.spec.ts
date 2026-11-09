import { afterAll, beforeAll, describe, it } from 'vitest';
import { db, initDbPostgres } from '@/storage/db';
import { exerciseManagedCreatorAccess, exerciseManagedCreatorBirth, exerciseManagedCreatorPublication, exerciseManagedCreatorSetupRecovery, exerciseManagedCreatorControllerProjection, exerciseManagedRequesterRetention, exerciseManagedEnrollmentInstallationContext, exerciseManagedAcquireRootResource } from './managedCreatorAccess.testkit';

describe('managed creator lifecycle on disposable PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        process.env.HAPPIER_SERVER_IDENTITY_ID = `srv_${'a'.repeat(32)}`;
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });
    it('admits only the exact creator without controller grants', exerciseManagedCreatorAccess);
    it('projects only the exact creator resource controller without private credential references', exerciseManagedCreatorControllerProjection);
    it('publishes pre-enrollment progress to the creator and custodian', exerciseManagedCreatorPublication);
    it('admits creation birth only on the exact resulting guest', exerciseManagedCreatorBirth);
    it('recovers setup only on the same requester-owned guest', exerciseManagedCreatorSetupRecovery);
    it('scopes native retention and readiness publication to the exact requester guest', exerciseManagedRequesterRetention);
    it('projects only the current requester guest installation for creation continuation', exerciseManagedEnrollmentInstallationContext);
    it('binds the acquire HTTP root to one retained requester resource', exerciseManagedAcquireRootResource);
});
