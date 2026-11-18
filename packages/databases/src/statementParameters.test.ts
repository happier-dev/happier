import { describe, expect, it } from 'vitest';
import { databaseConsoleStatementsV1, databaseStatementRangesV1 } from './statements.js';

describe('Console parameter slots', () => {
    it('orders PostgreSQL positional binds and ignores quoted text, identifiers and comments', () => {
        const sql = `SELECT $2::text, '$3', "$4", $$ $5 $$, $body$ $6 $body$, value$7, /* $8 /* $9 */ */ $1, $2;
-- $10
SELECT $1`;
        const statements = databaseConsoleStatementsV1(sql, 'postgresql');
        expect(statements.map(({ start, end }) => ({ start, end }))).toEqual(databaseStatementRangesV1(sql, 'postgresql'));
        expect(statements.map(statement => statement.parameterSlots)).toEqual([
            [{ index: 1, placeholder: '$1' }, { index: 2, placeholder: '$2' }],
            [{ index: 1, placeholder: '$1' }],
        ]);
    });

    it('counts MySQL question marks per statement and ignores user variables and comments', () => {
        const sql = "SELECT ?, '?', `?`, @name, /* ? */ ? # comment\r, ?\n; SELECT ?";
        expect(databaseConsoleStatementsV1(sql, 'mysql').map(statement => statement.parameterSlots)).toEqual([
            [{ index: 1, placeholder: '?' }, { index: 2, placeholder: '?' }],
            [{ index: 1, placeholder: '?' }],
        ]);
    });

    it('uses SQLite native indices across mixed, repeated and aliased placeholders', () => {
        const sql = "SELECT ?3, :name$part, :name$part, @name, ?, ?1, ?4, $path::value(suffix), ':ignored', [@ignored] -- comment\r, ?\n; SELECT ?";
        expect(databaseConsoleStatementsV1(sql, 'sqlite').map(statement => statement.parameterSlots)).toEqual([
            [{ index: 1, placeholder: '?1' }, { index: 3, placeholder: '?3' }, { index: 4, placeholder: ':name$part' },
                { index: 5, placeholder: '@name' }, { index: 6, placeholder: '?' }, { index: 7, placeholder: '$path::value(suffix)' }],
            [{ index: 1, placeholder: '?' }],
        ]);
    });
});
