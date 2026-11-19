import type { DatabaseCellV1 } from '@happier-dev/plugin-sdk/database';
import type {
    DatabaseSelectedRowsExportInputV1,
    DatabaseSelectedRowsExportResultV1,
} from '@happier-dev/database-protocol';

/** Quoted empty text differs from the SQL NULL marker; exact numbers and JSON retain their text. */
function csvCell(cell: DatabaseCellV1): string {
    if (cell.type === 'null') return '\\N';
    const value = String(cell.value);
    return value === '' || value === '\\N' || /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
const csvName = (name: string): string => /[",\r\n]/u.test(name) ? `"${name.replaceAll('"', '""')}"` : name;

/** One serialization owner shared by UI and agent Action callers; no database operation or storage. */
export function exportSelectedRows(input: DatabaseSelectedRowsExportInputV1): DatabaseSelectedRowsExportResultV1 {
    const { result, format } = input;
    const partialCells = result.rows.flatMap((row, rowIndex) => row.cells.flatMap((cell, column) => cell.type === 'partial'
        ? [{ row: rowIndex, column, range: cell.range }] : []));
    // Typed JSON retains SQL NULL, bytes, decimals, oversized integers and duplicate column labels.
    const content = format === 'json' ? JSON.stringify({ columns: result.columns, rows: result.rows.map(({ cells }) => ({ cells })), completeness: result.completeness }, null, 2)
        : [result.columns.map(({ name }) => csvName(name)).join(','), ...result.rows.map(row => row.cells.map(csvCell).join(','))].join('\r\n');
    return { format, mediaType: format === 'json' ? 'application/json' : 'text/csv', content, rowCount: result.rows.length,
        completeness: result.completeness, partialCells };
}
