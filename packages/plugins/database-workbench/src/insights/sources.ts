import { defineContributionPoint, defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import {
    DatabaseInsightSourceDescriptorV1ProtocolSchema,
    DatabaseFindingsListResultV1ProtocolSchema,
    DatabaseFindingReadResultV1ProtocolSchema,
    DATABASE_INSIGHT_SOURCE_PROTOCOL_ID_V1,
} from '@happier-dev/database-protocol';
export { DATABASE_INSIGHT_SOURCES_POINT_ID_V1, DATABASE_INSIGHT_SOURCE_PROTOCOL_ID_V1,
    DATABASE_INSIGHT_SOURCES_POINT_REF_V1 } from '@happier-dev/database-protocol';

/** Source-owned selectors preserve capture/third-party admission. Every source
 * returns the same finding envelope without acquiring database execution. */
export const databaseInsightSourceProtocolV1 = defineContributionProtocol({
    id: DATABASE_INSIGHT_SOURCE_PROTOCOL_ID_V1,
    version: 1,
    descriptor: DatabaseInsightSourceDescriptorV1ProtocolSchema,
    operations: {
        list: {
            required: true,
            input: { kind: 'contributorDefined' },
            resultSchema: DatabaseFindingsListResultV1ProtocolSchema,
            action: { surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'], dangerLevel: 'safe' },
        },
        detail: {
            required: true,
            input: { kind: 'contributorDefined' },
            resultSchema: DatabaseFindingReadResultV1ProtocolSchema,
            action: { surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'], dangerLevel: 'safe' },
        },
    },
});

export const databaseInsightSourcesPointV1 = defineContributionPoint([databaseInsightSourceProtocolV1]);
