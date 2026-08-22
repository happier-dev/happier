import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol';

export function parseRnwArtifactDeliveryProjectionDescribeResponse(value: unknown) {
    if (
        typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && Object.keys(value).length === 1
        && Object.hasOwn(value, 'error')
        && 'error' in value
        && typeof value.error === 'string'
    ) {
        throw new Error(value.error);
    }

    return DaemonContributionRegistryProjectionDescribeResponseSchema.parse(value);
}
