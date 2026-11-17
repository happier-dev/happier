import { describe, expect, it } from 'vitest';
import { mysqlConnectionOptions, mysqlFailureCause, mysqlNativeResult } from './mysql.js';

describe('mysql2 transport boundary projection', () => {
    it('pins statement and lossless decoding options even when URL query options conflict', () => {
        const options = mysqlConnectionOptions('mysql://user:secret@localhost/db?multipleStatements=true&decimalNumbers=true&nestTables=true&debug=true&ssl=%7B%22rejectUnauthorized%22%3Atrue%7D');
        expect(options).toMatchObject({ multipleStatements: false, decimalNumbers: false, nestTables: false, debug: false,
            supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true, dateStrings: true, rowsAsArray: true,
            flags: ['FOUND_ROWS', '-MULTI_STATEMENTS'] });
        const uri = new URL(options.uri!);
        expect(uri.searchParams.has('multipleStatements')).toBe(false);
        expect(uri.searchParams.has('decimalNumbers')).toBe(false);
        expect(uri.searchParams.has('nestTables')).toBe(false);
        expect(uri.searchParams.has('debug')).toBe(false);
        expect(uri.searchParams.get('ssl')).toBe('{"rejectUnauthorized":true}');
        expect(uri.password).toBe('secret');
    });

    it('preserves the ordered native frame and rejects driver shapes that have already lost label identity', () => {
        const fields = [{ name: 'x', columnType: 8, characterSet: 63 }, { name: 'x', columnType: 253, characterSet: 45 }];
        expect(mysqlNativeResult([['18446744073709551615', null]], fields)).toEqual({ fields, rows: [['18446744073709551615', null]] });
        expect(mysqlNativeResult([], fields)).toEqual({ fields, rows: [] });
        expect(mysqlNativeResult({ affectedRows: 1 }, [])).toEqual({ fields: [], rows: [], affectedRows: 1 });
        expect(() => mysqlNativeResult([{ x: 'lost first label' }], fields)).toThrow();
        expect(() => mysqlNativeResult([[1]], fields)).toThrow();
    });

    it('keeps native MySQL code and SQLSTATE distinct from transport failures', () => {
        expect(mysqlFailureCause(Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR', sqlState: '42000' })))
            .toMatchObject({ source: 'engine', code: 'ER_TABLEACCESS_DENIED_ERROR' });
        expect(mysqlFailureCause(Object.assign(new Error('closed'), { code: 'ECONNRESET' })))
            .toMatchObject({ source: 'transport', code: 'ECONNRESET' });
    });
});
