import {
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    type DaemonContributionRegistryProjectionAutomationEligibleEventsV1,
    type DaemonContributionRegistryProjectionV1,
    type DaemonPluginUiComposerSurfaceCatalogEntryV1,
    type DaemonPluginUiTargetedSurfaceMountV1,
    PluginProjectionV2Schema,
    type PluginProjectionV2,
} from '@happier-dev/protocol';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';

export type DaemonContributionRegistryProjection =
    | DaemonContributionRegistryProjectionV1Like
    | PluginProjectionV2;

type UnknownRecord = Readonly<Record<string, unknown>>;

/** The one typed response envelope the UI transport may carry forward. */
export type DaemonContributionRegistryProjectionDescribeParsedResponse = Readonly<{
    projection: DaemonContributionRegistryProjection;
    /** Daemon-selected Composer renderers; the UI may only exact-match these rows. */
    composerSurfaceCatalog?: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
    targetedContributions?: PluginUiTargetedContributionsV1;
    /** Host-private mounts correlated to the same exact targeted contribution snapshot. */
    targetedSurfaceMounts?: readonly DaemonPluginUiTargetedSurfaceMountV1[];
    automationEligibleEvents?: DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
}>;

export type DaemonContributionRegistryProjectionV1Like = Readonly<{
    v: 1;
    agentsById: DaemonContributionRegistryProjectionV1['agentsById'];
    backendsById: DaemonContributionRegistryProjectionV1['backendsById'];
}> & UnknownRecord;

export function parseDaemonContributionRegistryProjectionDescribeResponse(
    raw: unknown,
): DaemonContributionRegistryProjectionDescribeParsedResponse | null {
    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(raw);
    if (!parsed.success) return null;
    if (parsed.data.projection.v === 2) {
        // Keep the incumbent narrow V2 projection parser as its owner, while
        // preserving the response sibling that arrived with it.
        const projection = PluginProjectionV2Schema.safeParse(parsed.data.projection);
        if (!projection.success) return null;
        return Object.freeze({
            projection: projection.data,
            ...(parsed.data.composerSurfaceCatalog === undefined
                ? {}
                : { composerSurfaceCatalog: parsed.data.composerSurfaceCatalog }),
            ...(parsed.data.targetedContributions === undefined
                ? {}
                : { targetedContributions: parsed.data.targetedContributions }),
            ...(parsed.data.targetedSurfaceMounts === undefined
                ? {}
                : { targetedSurfaceMounts: parsed.data.targetedSurfaceMounts }),
            ...(parsed.data.automationEligibleEvents === undefined
                ? {}
                : { automationEligibleEvents: parsed.data.automationEligibleEvents }),
        });
    }
    return Object.freeze({
        projection: parsed.data.projection,
        ...(parsed.data.composerSurfaceCatalog === undefined
            ? {}
            : { composerSurfaceCatalog: parsed.data.composerSurfaceCatalog }),
        ...(parsed.data.targetedContributions === undefined
            ? {}
            : { targetedContributions: parsed.data.targetedContributions }),
        ...(parsed.data.targetedSurfaceMounts === undefined
            ? {}
            : { targetedSurfaceMounts: parsed.data.targetedSurfaceMounts }),
        ...(parsed.data.automationEligibleEvents === undefined
            ? {}
            : { automationEligibleEvents: parsed.data.automationEligibleEvents }),
    });
}
