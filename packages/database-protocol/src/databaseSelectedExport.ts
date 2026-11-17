import { z } from 'zod/mini';
import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import { DatabaseRowsResultV1Schema } from './databaseOperations.js';
import { DatabaseCompletenessV1Schema } from './databaseContinuations.js';
import { DatabaseValueRangeV1Schema } from './databaseValues.js';

/** A person supplies only the selected, already-loaded result; export never fetches more rows. */
export const DatabaseSelectedRowsExportInputV1Schema = z.strictObject({
    format: z.enum(['csv', 'json']), result: DatabaseRowsResultV1Schema,
});
export type DatabaseSelectedRowsExportInputV1 = z.infer<typeof DatabaseSelectedRowsExportInputV1Schema>;
export const DatabaseSelectedRowsExportResultV1Schema = z.strictObject({
    format: z.enum(['csv', 'json']), mediaType: z.enum(['text/csv', 'application/json']), content: z.string(),
    rowCount: z.number().check(z.int(), z.nonnegative()), completeness: DatabaseCompletenessV1Schema,
    partialCells: z.array(z.strictObject({ row: z.number().check(z.int(), z.nonnegative()), column: z.number().check(z.int(), z.nonnegative()), range: DatabaseValueRangeV1Schema })),
});
export type DatabaseSelectedRowsExportResultV1 = z.infer<typeof DatabaseSelectedRowsExportResultV1Schema>;
export const DatabaseSelectedRowsExportInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseSelectedRowsExportInputV1Schema);
export const DatabaseSelectedRowsExportResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseSelectedRowsExportResultV1Schema);
