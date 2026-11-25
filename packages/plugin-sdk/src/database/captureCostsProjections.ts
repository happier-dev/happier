import * as native from './databaseCaptureCosts.js';
import type { ProtocolComposableSchema, ProtocolJsonValue } from '../protocol/protocolFacade.js';
import type { DatabaseCaptureCostOperandV1, DatabaseCaptureCostsReadInputV1, DatabaseCaptureCostsReadResultV1, SchemaInput } from './schemaTypes.js';
import type { UsageObservationTokens } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

export const DATABASE_CAPTURE_COST_TOKEN_FIELDS_V1: Array<keyof UsageObservationTokens> = native.DATABASE_CAPTURE_COST_TOKEN_FIELDS_V1;
export const DatabaseCaptureCostsReadInputV1ProtocolSchema: ProtocolComposableSchema<
    SchemaInput<'databaseCaptureCostsReadInputV1'>, DatabaseCaptureCostsReadInputV1 & ProtocolJsonValue
> = native.DatabaseCaptureCostsReadInputV1ProtocolSchema;
export const DatabaseCaptureCostOperandV1ProtocolSchema: ProtocolComposableSchema<
    SchemaInput<'databaseCaptureCostOperandV1'>, DatabaseCaptureCostOperandV1 & ProtocolJsonValue
> = native.DatabaseCaptureCostOperandV1ProtocolSchema;
export const DatabaseCaptureCostsReadResultV1ProtocolSchema: ProtocolComposableSchema<
    SchemaInput<'databaseCaptureCostsReadResultV1'>, DatabaseCaptureCostsReadResultV1 & ProtocolJsonValue
> = native.DatabaseCaptureCostsReadResultV1ProtocolSchema;
export type {
    DatabaseCaptureCostsReadInputV1,
    DatabaseCaptureCostOperandV1,
    DatabaseCaptureCostMetadataV1,
    DatabaseCaptureCostsReadResultV1,
} from './schemaTypes.js';
