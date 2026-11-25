import { z } from 'zod/mini';
import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import type { ProtocolComposableSchema, ProtocolSchemaInput } from '../protocol/protocolFacade.js';
import { DatabaseAccessSummaryV1Schema, DatabaseAgentAccessV1Schema } from './schemas/databaseAccess.js';

/** Machine-local targets carry their stored level. Deployment targets name the Environment that owns it. */
const accessReadResult = z.discriminatedUnion('setBy', [
    z.strictObject({
        setBy: z.literal('machine'),
        agentAccess: DatabaseAgentAccessV1Schema,
        access: DatabaseAccessSummaryV1Schema,
    }),
    z.strictObject({
        setBy: z.literal('environment'),
        serverId: z.string(),
        environmentId: z.string(),
        expectedRevision: z.number(),
        access: DatabaseAccessSummaryV1Schema,
    }),
]);
const readResult = projectZodProtocolSchema(accessReadResult);
export type DatabaseAccessReadResultV1 = ProtocolSchemaInput<typeof readResult>;
export const DatabaseAccessReadResultV1Schema: ProtocolComposableSchema<DatabaseAccessReadResultV1> =
    readResult;
