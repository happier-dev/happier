import { describe, expect, it } from 'vitest';
import { databaseStatementRangesV1 } from './statements.js';

describe('Console statement boundaries', () => {
    it.each([
        ['postgresql', "SELECT $$a;b$$; /* ; */ SELECT 'c;d'"],
        ['mysql', "SELECT 'a;b'; # ;\nSELECT `c;d`"],
        ['sqlite', "SELECT 'a;b'; -- ;\nSELECT [c;d]"],
    ] as const)('keeps quoted and commented separators inside %s statements', (engine, sql) => {
        expect(databaseStatementRangesV1(sql, engine).map(range => sql.slice(range.start, range.end)))
            .toEqual(engine === 'postgresql' ? ['SELECT $$a;b$$', "SELECT 'c;d'"]
                : engine === 'mysql' ? ["SELECT 'a;b'", 'SELECT `c;d`']
                    : ["SELECT 'a;b'", 'SELECT [c;d]']);
    });

    it('keeps whitespace-only editor content empty', () => {
        for (const engine of ['postgresql', 'mysql', 'sqlite'] as const) {
            expect(databaseStatementRangesV1(' \n ', engine)).toEqual([]);
        }
    });
});
