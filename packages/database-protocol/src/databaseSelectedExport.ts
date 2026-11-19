import { FileDownloadDestinationV1ProtocolSchema as FileDownloadDestinationV1Schema } from '@happier-dev/plugin-sdk/protocol';
import { type ProtocolSchemaOutput, defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

import { DatabaseRowsResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { DatabaseCompletenessV1Schema } from '@happier-dev/plugin-sdk/database';
import { DatabaseValueRangeV1Schema } from '@happier-dev/plugin-sdk/database';

/** A person supplies only the selected, already-loaded result; export never fetches more rows. */
export const DatabaseSelectedRowsExportInputV1Fields = {
    format: defineProtocolUnion([defineProtocolLiteral('csv'), defineProtocolLiteral('json')]), result: DatabaseRowsResultV1Schema,
};
export const DatabaseSelectedRowsExportInputV1Schema = defineProtocolObject(DatabaseSelectedRowsExportInputV1Fields, { policy: 'closed' });
export type DatabaseSelectedRowsExportInputV1 = ProtocolSchemaOutput<typeof DatabaseSelectedRowsExportInputV1Schema>;
/** The host supplies the opaque destination after its ordinary Save file flow. */
export const DatabaseSelectedRowsExportDownloadInputV1Schema = defineProtocolObject({ ...DatabaseSelectedRowsExportInputV1Fields, ...{
    destination: FileDownloadDestinationV1Schema,
} }, { policy: 'closed' });
export type DatabaseSelectedRowsExportDownloadInputV1 = ProtocolSchemaOutput<typeof DatabaseSelectedRowsExportDownloadInputV1Schema>;
export const DatabaseSelectedRowsExportDownloadInputV1ProtocolSchema = DatabaseSelectedRowsExportDownloadInputV1Schema;
export const DatabaseSelectedRowsExportResultV1Schema = defineProtocolObject({
    format: defineProtocolUnion([defineProtocolLiteral('csv'), defineProtocolLiteral('json')]), mediaType: defineProtocolUnion([defineProtocolLiteral('text/csv'), defineProtocolLiteral('application/json')]), content: defineProtocolString(),
    rowCount: defineProtocolNumber({ integer: true, minimum: 0 }), completeness: DatabaseCompletenessV1Schema,
    partialCells: defineProtocolArray(defineProtocolObject({ row: defineProtocolNumber({ integer: true, minimum: 0 }), column: defineProtocolNumber({ integer: true, minimum: 0 }), range: DatabaseValueRangeV1Schema }, { policy: 'closed' })),
}, { policy: 'closed' });
export type DatabaseSelectedRowsExportResultV1 = ProtocolSchemaOutput<typeof DatabaseSelectedRowsExportResultV1Schema>;
export const DatabaseSelectedRowsExportInputV1ProtocolSchema = DatabaseSelectedRowsExportInputV1Schema;
export const DatabaseSelectedRowsExportResultV1ProtocolSchema = DatabaseSelectedRowsExportResultV1Schema;
