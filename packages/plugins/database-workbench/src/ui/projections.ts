import type { DatabaseColumnV1, DatabaseRowsResultV1, DatabaseRelationStructureV1 } from '@happier-dev/database-protocol';

const cellKinds = { text: 'text', boolean: 'bool', integer: 'number', decimal: 'number', float: 'number',
    json: 'json', binary: 'bytes', temporal: 'time', unknown: 'text' } as const;
export function projectColumn(column: DatabaseColumnV1, structure?: DatabaseRelationStructureV1) {
    const foreign = structure?.foreignKeys.find(key => key.columns.includes(column.name));
    const foreignColumn = foreign?.targetColumns[foreign.columns.indexOf(column.name)];
    return { name: column.name, typeLabel: column.nativeType, kind: cellKinds[column.semanticType],
        primaryKey: structure?.primaryKey.includes(column.name) ?? false,
        ...(foreign && foreignColumn ? { foreignKey: { schema: foreign.target.schema, table: foreign.target.name, column: foreignColumn } } : {}) };
}
export function projectRelationPage(result: DatabaseRowsResultV1, structure: DatabaseRelationStructureV1) {
    return { columns: result.columns.map(column => projectColumn(column, structure)),
        rows: result.rows.map((row, index) => ({ rowKey: row.identity ? JSON.stringify(row.identity.key) : `position:${index}`, cells: row.cells, identity: row.identity })),
        completeness: result.completeness };
}
