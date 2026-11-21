import * as React from 'react';
import type { DatabaseCellV1 } from '@happier-dev/plugin-sdk/database';
import type { PluginTranslate } from '@happier-dev/plugin-ui';
import type { CollectionAnatomy, CollectionField } from '@happier-dev/plugin-ui/components';
import type { projectColumn } from '../projections.js';
import { presentCell } from './cells.js';

export type GridColumn = Pick<ReturnType<typeof projectColumn>, 'name' | 'typeLabel' | 'kind'>
    & Partial<Pick<ReturnType<typeof projectColumn>, 'primaryKey' | 'foreignKey' | 'identifierLabel'>>;

/** A key or reference column names rows rather than counting anything. */
export function isIdentifierColumn(column: GridColumn | undefined): boolean {
    return column?.primaryKey === true || column?.foreignKey !== undefined || column?.identifierLabel === true;
}
export type GridRow = Readonly<{ rowKey: string; cells: readonly DatabaseCellV1[] }>;

/** Readable widths per kind of value at normal text size; the table scales them with the reader's text. */
const KIND_MIN_WIDTH: Readonly<Record<GridColumn['kind'], number>> = {
    number: 96, bool: 72, time: 176, json: 220, bytes: 104, text: 168,
};

/** How many values a narrow row says under its lead: enough to tell rows apart on one line. */
const BYLINE_VALUES = 3;

/**
 * A column is never narrower than its header: the name over its type, at about one en per character of the header's
 * text plus the sort arrow's room (lab dbBrowse/grid shows every header whole).
 */
const HEADER_CHARACTER_WIDTH = 7.5;
const HEADER_SORT_ROOM = 20;
function gridColumnMinWidth(column: GridColumn): number {
    const header = Math.max(column.name.length, column.typeLabel.length) * HEADER_CHARACTER_WIDTH + HEADER_SORT_ROOM;
    return Math.ceil(Math.max(KIND_MIN_WIDTH[column.kind], header));
}

/**
 * One anatomy for every database result table (browse and Console): a data grid. Every column stays, each as wide as
 * its kind of value and its header need (the first, the row's identity, no wider), the type under each name, and a
 * table wider than its room scrolls sideways. A phone's rows say the first values under their lead instead.
 */
export function useGridAnatomy<Row extends GridRow, Column extends GridColumn = GridColumn>(columns: readonly Column[], translate: PluginTranslate,
    renderCell: (row: Row, column: Column, index: number) => React.ReactNode, sortable: boolean): CollectionAnatomy<Row> {
    return React.useMemo(() => {
        const [lead, ...rest] = columns;
        const fields: CollectionField<Row>[] = rest.map((column, index) => ({
            key: column.name, title: column.name, subtitle: column.typeLabel, minWidth: gridColumnMinWidth(column), priority: rest.length - index,
            align: column.kind === 'number' ? 'end' as const : 'start' as const, sortable,
            render: (row: Row) => renderCell(row, column, index + 1),
        }));
        return {
            // A result row has no mark: the grid reserves no glyph column for it.
            glyph: () => null,
            loadingGlyph: false,
            columnsOverflow: 'scroll',
            ...(lead ? { titleMinWidth: gridColumnMinWidth(lead), titleSubtitle: lead.typeLabel } : {}),
            title: row => presentCell(row.cells[0], translate, { identifier: isIdentifierColumn(lead) }).text,
            // Narrow (phone), the fields drop: the first few values that are not keys say what the row is
            // under its lead (lab dbBrowse/gridp).
            byline: (row, layout) => layout?.fieldColumns ? null : rest
                .map((column, index) => ({ column, cell: row.cells[index + 1] }))
                .filter(({ column, cell }) => (column.primaryKey === undefined || !isIdentifierColumn(column))
                    && cell !== undefined && cell.type !== 'null')
                .slice(0, BYLINE_VALUES)
                .map(({ column, cell }) => presentCell(cell, translate, { identifier: isIdentifierColumn(column) }).text)
                .join(' · ') || null,
            titleIdentifier: true,
            fields,
            accessibilityLabel: row => presentCell(row.cells[0], translate, { identifier: isIdentifierColumn(lead) }).text,
            columnTitles: { title: lead ? lead.name : '' },
        } satisfies CollectionAnatomy<Row>;
    }, [columns, translate, renderCell, sortable]);
}
