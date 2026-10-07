import {
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    DaemonPluginUiTargetedContributionsReadResponseSchema,
    PluginProjectionV2Schema,
    type DaemonContributionRegistryProjectionAutomationEligibleEventsV1,
    type DaemonPluginUiComposerSurfaceCatalogEntryV1,
    type DaemonPluginUiTargetedContributionsReadResponse,
    type PluginProjectionV2,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';

export type DaemonContributionRegistryProjection = PluginProjectionV2;

/** The one typed response envelope the UI transport may carry forward. */
export type DaemonContributionRegistryProjectionDescribeParsedResponse = Readonly<{
    projection: DaemonContributionRegistryProjection;
    /** Daemon-selected Composer renderers; the UI may only exact-match these rows. */
    composerSurfaceCatalog?: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
    automationEligibleEvents?: DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
}>;

/** The response envelope's siblings; the projection is parsed by its own schema. */
const DescribeResponseSiblingsSchema = DaemonContributionRegistryProjectionDescribeResponseSchema.omit({
    projection: true,
});

/**
 * Parses the machine-wide describe response once: every part by the one
 * schema that owns it, so the projection is validated exactly once.
 */
export function parseDaemonContributionRegistryProjectionDescribeResponse(
    raw: unknown,
): DaemonContributionRegistryProjectionDescribeParsedResponse | null {
    const parsed = DescribeResponseSiblingsSchema.safeParse(raw);
    if (!parsed.success) return null;
    const projection = PluginProjectionV2Schema.safeParse((raw as Readonly<{ projection?: unknown }>).projection);
    if (!projection.success) return null;
    return Object.freeze({
        projection: projection.data,
        ...(parsed.data.composerSurfaceCatalog === undefined
            ? {}
            : { composerSurfaceCatalog: parsed.data.composerSurfaceCatalog }),
        ...(parsed.data.automationEligibleEvents === undefined
            ? {}
            : { automationEligibleEvents: parsed.data.automationEligibleEvents }),
    });
}

export function parseDaemonPluginUiTargetedContributionsReadResponse(
    raw: unknown,
): DaemonPluginUiTargetedContributionsReadResponse | null {
    const parsed = DaemonPluginUiTargetedContributionsReadResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}
