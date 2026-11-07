import {
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    DaemonPluginUiTargetedContributionsReadResponseSchema,
    type DaemonContributionRegistryProjectionAutomationEligibleEventsV1,
    type DaemonPluginUiComposerSurfaceCatalogEntryV1,
    type DaemonPluginUiTargetedContributionsReadResponse,
    type PluginProjectionV2,
    type MachineRecipeReadTargetV1,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';

export type DaemonContributionRegistryProjection = PluginProjectionV2;

/** The one typed response envelope the UI transport may carry forward. */
export type DaemonContributionRegistryProjectionDescribeParsedResponse = Readonly<{
    projection: DaemonContributionRegistryProjection;
    projectionDigest?: string;
    /** Daemon-selected Composer renderers; the UI may only exact-match these rows. */
    composerSurfaceCatalog?: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
    automationEligibleEvents?: DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
    machineRecipeTarget?: MachineRecipeReadTargetV1;
}>;

/**
 * Admits the machine-wide describe response through its Protocol owner.
 */
export function parseDaemonContributionRegistryProjectionDescribeResponse(
    raw: unknown,
): DaemonContributionRegistryProjectionDescribeParsedResponse | null {
    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(raw);
    if (!parsed.success) return null;
    return Object.freeze({
        projection: parsed.data.projection,
        ...(parsed.data.projectionDigest === undefined ? {} : { projectionDigest: parsed.data.projectionDigest }),
        ...(parsed.data.composerSurfaceCatalog === undefined
            ? {}
            : { composerSurfaceCatalog: parsed.data.composerSurfaceCatalog }),
        ...(parsed.data.automationEligibleEvents === undefined
            ? {}
            : { automationEligibleEvents: parsed.data.automationEligibleEvents }),
        ...(parsed.data.machineRecipeTarget === undefined
            ? {}
            : { machineRecipeTarget: parsed.data.machineRecipeTarget }),
    });
}

export function parseDaemonPluginUiTargetedContributionsReadResponse(
    raw: unknown,
): DaemonPluginUiTargetedContributionsReadResponse | null {
    const parsed = DaemonPluginUiTargetedContributionsReadResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}
