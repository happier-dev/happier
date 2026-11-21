import { describe, expect, it } from 'vitest';
import { databaseStatementRangesV1, displayDatabaseStatementShape } from './statements.js';
import { normalizePostgresqlStatement } from './postgresql/statement.js';

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

describe('Statement shape display', () => {
    it('reads a fingerprint shape as SQL, while the spaced shape stays the key', () => {
        const { shape } = normalizePostgresqlStatement(
            "SELECT a.pid::text AS key, count(*) FROM pg_stat_activity a WHERE a.state IN ('active', 'idle') GROUP BY a.pid");
        // The key keeps every token apart; only the person-facing text reads as SQL.
        expect(shape).toBe('select a . pid : : text as key , count ( * ) from pg_stat_activity a where a . state in ( ? , ? ) group by a . pid');
        expect(displayDatabaseStatementShape(shape))
            .toBe('select a.pid::text as key, count(*) from pg_stat_activity a where a.state in (?, ?) group by a.pid');
        // A quoted name keeps its own spaces.
        expect(displayDatabaseStatementShape('select "first name" , x . y from t')).toBe('select "first name", x.y from t');
    });
});
