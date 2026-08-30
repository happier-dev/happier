import { describe, expect, it } from 'vitest';
import { resolveMigrationDeployArgs } from './migrate.deploy';

describe('resolveMigrationDeployArgs', () => {
    it.each([
        ['postgres', ['prisma', 'migrate', 'deploy']],
        ['postgresql', ['prisma', 'migrate', 'deploy']],
        ['mysql', ['-s', 'migrate:mysql:deploy']],
        ['pglite', ['-s', 'migrate:light:deploy']],
        ['sqlite', ['-s', 'migrate:sqlite:deploy']],
    ])('maps %s to the existing migration implementation', (provider, args) => {
        expect(resolveMigrationDeployArgs({ HAPPIER_DB_PROVIDER: provider })).toEqual(args);
    });

    it('rejects an explicit unsupported provider instead of migrating the fallback database', () => {
        expect(() => resolveMigrationDeployArgs({ HAPPIER_DB_PROVIDER: 'postgress' })).toThrow(/Unsupported/);
    });
});
