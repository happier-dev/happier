import { describe, expect, it } from 'vitest';
import { resolveMigrationDeployScript } from './migrate.deploy';

describe('resolveMigrationDeployScript', () => {
    it.each([
        ['postgres', 'migrate:full:deploy'],
        ['postgresql', 'migrate:full:deploy'],
        ['mysql', 'migrate:mysql:deploy'],
        ['pglite', 'migrate:light:deploy'],
        ['sqlite', 'migrate:sqlite:deploy'],
    ])('maps %s to the canonical migration implementation', (provider, script) => {
        expect(resolveMigrationDeployScript({ HAPPIER_DB_PROVIDER: provider })).toBe(script);
    });

    it('defaults to Postgres for direct full-runtime use', () => {
        expect(resolveMigrationDeployScript({})).toBe('migrate:full:deploy');
    });

    it('rejects an explicit unsupported provider instead of migrating the fallback database', () => {
        expect(() => resolveMigrationDeployScript({ HAPPIER_DB_PROVIDER: 'postgress' })).toThrow(/Unsupported/);
    });
});
