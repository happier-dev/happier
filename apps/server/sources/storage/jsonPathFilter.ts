import type { Prisma } from '@prisma/client';
import { getDbProviderFromEnv } from './prisma';

/** Adapt Prisma's JSON-path filter to the active generated client's dialect. */
export function jsonPathEquals(path: readonly string[], value: Prisma.InputJsonValue): Prisma.JsonFilter {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const filter = { path: provider === 'sqlite' || provider === 'mysql'
        ? `$${path.map(segment => `.${JSON.stringify(segment)}`).join('')}` : [...path], equals: value };
    // The public Prisma namespace describes PostgreSQL; the active SQLite/MySQL
    // generated clients accept JSONPath strings at this same library boundary.
    return filter as Prisma.JsonFilter;
}
