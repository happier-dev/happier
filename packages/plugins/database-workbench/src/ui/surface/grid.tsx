import * as React from 'react';
import type { DatabaseCellV1 } from '@happier-dev/database-protocol';
import type { PluginTranslate } from '@happier-dev/plugin-ui';
import type { CollectionAnatomy, CollectionField } from '@happier-dev/plugin-ui/components';
import type { projectColumn } from '../projections.js';
import { presentCell } from './cells.js';

export type GridColumn = Pick<ReturnType<typeof projectColumn>, 'name' | 'typeLabel' | 'kind'>
    & Partial<Pick<ReturnType<typeof projectColumn>, 'primaryKey' | 'foreignKey'>>;

/** A key or reference column names rows rather than counting anything. */
export function isIdentifierColumn(column: GridColumn | undefined): boolean {
    return column?.primaryKey === true || column?.foreignKey !== undefined;
}
export type GridRow = Readonly<{ rowKey: string; cells: readonly DatabaseCellV1[] }>;

/** Readable widths per kind of value at normal text size; the table scales them with the reader's text. */
const KIND_MIN_WIDTH: Readonly<Record<GridColumn['kind'], number>> = {
    number: 96, bool: 72, time: 176, json: 220, bytes: 104, text: 168,
};

/** How many values a narrow row says under its lead: enough to tell rows apart on one line. */
const BYLINE_VALUES = 3;

export function gridColumnTitle(column: GridColumn): string {
    // The type line belongs under the name (lab dbBrowse/grid); until the table header takes a second line it
    // rides in the title so every column still says what it holds.
    return `${column.name} · ${column.typeLabel}`;
}

/**
 * One anatomy for every database result table (browse and Console): the first column leads as the row's
 * identity, every other column is a field that drops last-first when the table is narrow.
 */
export function useGridAnatomy<Row extends GridRow, Column extends GridColumn = GridColumn>(columns: readonly Column[], translate: PluginTranslate,
    renderCell: (row: Row, column: Column, index: number) => React.ReactNode, sortable: boolean): CollectionAnatomy<Row> {
    return React.useMemo(() => {
        const [lead, ...rest] = columns;
        const fields: CollectionField<Row>[] = rest.map((column, index) => ({
            key: column.name, title: gridColumnTitle(column), minWidth: KIND_MIN_WIDTH[column.kind], priority: rest.length - index,
            align: column.kind === 'number' ? 'end' as const : 'start' as const, sortable,
            render: (row: Row) => renderCell(row, column, index + 1),
        }));
        return {
            glyph: () => null,
            title: row => presentCell(row.cells[0], translate, { identifier: isIdentifierColumn(lead) }).text,
            // Narrow (phone), the fields drop: the first few values that are not keys say what the row is
            // under its lead (lab dbBrowse/gridp).
            byline: (row, layout) => layout?.fieldColumns ? null : rest
                .map((column, index) => ({ column, cell: row.cells[index + 1] }))
                .filter(({ column, cell }) => !isIdentifierColumn(column) && cell !== undefined && cell.type !== 'null')
                .slice(0, BYLINE_VALUES)
                .map(({ cell }) => presentCell(cell, translate).text)
                .join(' · ') || null,
            titleIdentifier: true,
            fields,
            accessibilityLabel: row => presentCell(row.cells[0], translate, { identifier: isIdentifierColumn(lead) }).text,
            columnTitles: { title: lead ? gridColumnTitle(lead) : '' },
        } satisfies CollectionAnatomy<Row>;
    }, [columns, translate, renderCell, sortable]);
}
