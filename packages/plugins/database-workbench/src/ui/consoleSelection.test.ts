import { expect, it } from 'vitest';
import { projectConsoleParameterSlots, selectConsoleStatements } from './consoleSelection.js';

it('uses supplied dialect ranges at the caret and keeps an explicit write batch ordered', () => {
    const text = "select ';'; select 2;";
    const ranges = [{ start: 0, end: 11 }, { start: 12, end: 21 }];
    expect(selectConsoleStatements(text, { start: 14, end: 14 }, 'read', ranges)).toEqual([{ sql: 'select 2;', range: ranges[1] }]);
    expect(selectConsoleStatements(text, { start: 0, end: 0 }, 'write', ranges).map(item => item.sql)).toEqual(["select ';';", 'select 2;']);
    expect(selectConsoleStatements(text, { start: 12, end: 20 }, 'read', ranges)).toEqual([{ sql: 'select 2', range: { start: 12, end: 20 } }]);
});

it('projects text-defaulted slots for the caret statement and exact read selection', () => {
    const sql = "select $1; select '$1', $2, $1, $2;";
    const second = sql.indexOf('select', 1);
    expect(projectConsoleParameterSlots(sql, { start: second, end: second }, 'read', 'postgresql')).toEqual([[
        { index: 1, placeholder: '$1', defaultInput: { type: 'text', text: '' } },
        { index: 2, placeholder: '$2', defaultInput: { type: 'text', text: '' } },
    ]]);
    expect(projectConsoleParameterSlots(sql, { start: 0, end: sql.indexOf(';') }, 'read', 'postgresql')).toEqual([[
        { index: 1, placeholder: '$1', defaultInput: { type: 'text', text: '' } },
    ]]);
    expect(projectConsoleParameterSlots(sql, { start: 0, end: sql.length }, 'read', 'postgresql')).toEqual([[]]);
    expect(projectConsoleParameterSlots("select 'unfinished", { start: 0, end: 0 }, 'read', 'postgresql')).toEqual([]);
});
