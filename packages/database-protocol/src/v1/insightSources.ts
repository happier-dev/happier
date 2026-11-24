import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolArray, defineProtocolJsonValue, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { DATABASE_INSIGHT_SOURCE_PROTOCOL_ID_V1 } from '@happier-dev/plugin-sdk/database';

export { DATABASE_INSIGHT_SOURCES_POINT_REF_V1, DatabaseInsightSourceOperationSchemasV1 } from '@happier-dev/plugin-sdk/database';

const read = { surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'], dangerLevel: 'safe' } as const;
const name = defineProtocolString({ minLength: 1 });
const closed = { policy: 'closed' } as const;
const value = defineProtocolJsonValue();
const applicable = defineProtocolArray(name, { minItems: 1 }).optional();
const descriptor = defineProtocolObject({
    displayName: name, targetKinds: applicable, engineIds: applicable, evidenceSchema: value,
    changeResourceRef: defineProtocolObject({ pluginId: name, localId: name }, closed),
}, closed);
const list = defineProtocolObject({ target: value }, closed);
const detail = defineProtocolObject({ target: value, recordKey: name }, closed);

/** The registry admits the portable envelope. The source Action's database
 * schemas admit the opaque domain values and preserve typed refusals. */
export const DatabaseInsightSourceContributionProtocolV1 = defineContributionProtocol({
    id: DATABASE_INSIGHT_SOURCE_PROTOCOL_ID_V1,
    version: 1,
    descriptor,
    operations: {
        list: {
            required: true,
            input: { kind: 'protocolDefined', schema: list },
            resultSchema: value,
            action: read,
        },
        detail: {
            required: true,
            input: { kind: 'protocolDefined', schema: detail },
            resultSchema: value,
            action: read,
        },
    },
});
