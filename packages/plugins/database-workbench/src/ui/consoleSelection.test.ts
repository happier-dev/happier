import { expect, it } from 'vitest';
import { selectConsoleStatements } from './consoleSelection.js';

it('uses supplied dialect ranges at the caret and keeps an explicit write batch ordered', () => {
    const text = "select ';'; select 2;";
    const ranges = [{ start: 0, end: 11 }, { start: 12, end: 21 }];
    expect(selectConsoleStatements(text, { start: 14, end: 14 }, 'read', ranges)).toEqual([{ sql: 'select 2;', range: ranges[1] }]);
    expect(selectConsoleStatements(text, { start: 0, end: 0 }, 'write', ranges).map(item => item.sql)).toEqual(["select ';';", 'select 2;']);
    expect(selectConsoleStatements(text, { start: 12, end: 20 }, 'read', ranges)).toEqual([{ sql: 'select 2', range: { start: 12, end: 20 } }]);
});
