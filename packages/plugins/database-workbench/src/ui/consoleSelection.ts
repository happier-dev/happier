import {
    databaseConsoleStatementsV1, DatabaseStatementError, PostgresqlInputError,
    type DatabaseConsoleStatementV1, type DatabaseStatementParameterSlotV1,
} from '@happier-dev/databases/statements';
import type { ConsoleParameterInput } from './consoleParameters.js';

export type ConsoleSelection = Readonly<{ start: number; end: number }>;
export type SelectedStatement = Readonly<{ sql: string; range: ConsoleSelection }>;
/** Ranges are supplied by P1's dialect lexer. This function only applies editor selection. */
export function selectConsoleStatements(text: string, selection: ConsoleSelection, mode: 'read' | 'write', ranges: readonly ConsoleSelection[]): readonly SelectedStatement[] {
    if (selection.start !== selection.end && mode === 'read') return [{ sql: text.slice(selection.start, selection.end), range: selection }];
    const chosen = mode === 'write'
        ? selection.start === selection.end ? ranges : ranges.filter(range => range.end > selection.start && range.start < selection.end)
            .map(range => ({ start: Math.max(range.start, selection.start), end: Math.min(range.end, selection.end) }))
        : [ranges.find(range => selection.start >= range.start && selection.start <= range.end) ?? ranges.find(range => range.start > selection.start)].filter((range): range is ConsoleSelection => range !== undefined);
    return chosen.map(range => ({ sql: text.slice(range.start, range.end), range }));
}

export type ConsoleParameterSlot = DatabaseStatementParameterSlotV1 & Readonly<{ defaultInput: ConsoleParameterInput }>;

export function readConsoleStatementLayout(text: string, engine: string): readonly DatabaseConsoleStatementV1[] {
    try {
        return databaseConsoleStatementsV1(text, engine);
    } catch (error) {
        // Draft SQL may be incomplete. Run still uses its ordinary execution and error path.
        if (error instanceof DatabaseStatementError || error instanceof PostgresqlInputError) return [];
        throw error;
    }
}

export function projectConsoleParameterSlots(text: string, selection: ConsoleSelection, mode: 'read' | 'write',
    engine: string, layout = readConsoleStatementLayout(text, engine)): readonly (readonly ConsoleParameterSlot[])[] {
    const withDefaultInput = (slot: DatabaseStatementParameterSlotV1): ConsoleParameterSlot => ({ ...slot, defaultInput: { type: 'text', text: '' } });
    const byStart = new Map(layout.map(statement => [statement.start, statement]));
    return selectConsoleStatements(text, selection, mode, layout).map(({ sql, range }) => {
        const whole = byStart.get(range.start);
        if (whole?.end === range.end) return whole.parameterSlots.map(withDefaultInput);
        const fragment = readConsoleStatementLayout(sql, engine);
        return fragment.length === 1 ? fragment[0]!.parameterSlots.map(withDefaultInput) : [];
    });
}
