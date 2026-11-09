import { beforeAll } from 'vitest';
import './activationService.sqlite.composed.integration.spec';

beforeAll(() => {
    if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
        || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
        throw new Error('Use only the disposable PostgreSQL DB-contract harness');
    }
});
