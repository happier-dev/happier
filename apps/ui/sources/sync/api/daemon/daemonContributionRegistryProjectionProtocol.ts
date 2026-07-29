import {
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    type DaemonContributionRegistryProjectionV1,
    PluginProjectionV2Schema,
    type PluginProjectionV2,
} from '@happier-dev/protocol';

export type DaemonContributionRegistryProjection =
    | DaemonContributionRegistryProjectionV1Like
    | PluginProjectionV2;

type UnknownRecord = Readonly<Record<string, unknown>>;

export type DaemonContributionRegistryProjectionV1Like = Readonly<{
    v: 1;
    agentsById: DaemonContributionRegistryProjectionV1['agentsById'];
    backendsById: DaemonContributionRegistryProjectionV1['backendsById'];
}> & UnknownRecord;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

export function parseDaemonContributionRegistryProjectionDescribeResponse(
    raw: unknown,
): DaemonContributionRegistryProjection | null {
    const projection = asRecord(raw)?.projection;
    if (asRecord(projection)?.v === 2) {
        const parsedV2 = PluginProjectionV2Schema.safeParse(projection);
        return parsedV2.success ? parsedV2.data : null;
    }

    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data.projection;
}
