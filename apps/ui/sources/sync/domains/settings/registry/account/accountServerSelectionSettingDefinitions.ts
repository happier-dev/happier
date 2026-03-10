import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

function buildServerSelectionGroupSummaryProperties(value: unknown): Record<string, number> {
    const groups = Array.isArray(value) ? value : [];

    let totalServerRefCount = 0;
    let groupedCount = 0;
    let flatWithBadgeCount = 0;

    for (const group of groups) {
        if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
        const record = group as Record<string, unknown>;
        if (Array.isArray(record.serverIds)) {
            totalServerRefCount += record.serverIds.length;
        }
        if (record.presentation === 'flat-with-badge') {
            flatWithBadgeCount += 1;
        } else {
            groupedCount += 1;
        }
    }

    return {
        groupCount: groups.length,
        totalServerRefCount,
        groupedCount,
        flatWithBadgeCount,
    };
}

export const ServerSelectionGroupSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    serverIds: z.array(z.string()).default([]),
    presentation: z.enum(['grouped', 'flat-with-badge']).default('grouped'),
});

export const ACCOUNT_SERVER_SELECTION_SETTING_DEFINITIONS = defineSettingDefinitions({
    serverSelectionGroups: {
        schema: z.array(ServerSelectionGroupSchema),
        default: [],
        description: 'Saved server selection groups',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'person',
            serializeCurrentProperties: buildServerSelectionGroupSummaryProperties,
        },
    },
    serverSelectionActiveTargetId: {
        schema: z.string().nullable(),
        default: null,
        description: 'Explicit active server selection target id',
        storageScope: 'account',
    },
});

export const ACCOUNT_SERVER_SELECTION_SETTING_ARTIFACTS = buildSettingArtifacts(
    ACCOUNT_SERVER_SELECTION_SETTING_DEFINITIONS,
);
