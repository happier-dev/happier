import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withPackagedMigrationDatasourceUrl } from './prepareFullRuntimeMigrationSchema.mjs';

describe('withPackagedMigrationDatasourceUrl', () => {
    it.each([
        ['postgres', join('prisma', 'schema.prisma'), 'postgresql'],
        ['mysql', join('prisma', 'mysql', 'schema.prisma'), 'mysql'],
    ])('gives the packaged Prisma 6 migration CLI the %s datasource URL from its env', async (_name, path, provider) => {
        const source = await readFile(join(process.cwd(), path), 'utf8');
        const staged = withPackagedMigrationDatasourceUrl(source);

        expect(staged).toMatch(new RegExp(
            `datasource db \\{\\s*provider = "${provider}"\\s*url\\s*= env\\("DATABASE_URL"\\)\\s*\\}`,
        ));
        // Only the datasource block changes; models and generators stay byte-identical.
        expect(staged.replace(/\n\s*url\s*= env\("DATABASE_URL"\)/, '')).toBe(source);
    });

    it('refuses a schema whose datasource it cannot place the URL in', () => {
        expect(() => withPackagedMigrationDatasourceUrl('model A { id Int @id }\n')).toThrow(/datasource/);
        expect(() => withPackagedMigrationDatasourceUrl(
            'datasource db {\n    provider = "postgresql"\n    url = env("DATABASE_URL")\n}\n',
        )).toThrow(/datasource/);
    });
});
