import {
    PluginBrowserTargetContributionV1Schema,
    type PluginBrowserTargetContributionInputV1,
    type PluginBrowserTargetContributionV1,
} from '@happier-dev/protocol/plugins/contributions/browser';

export function defineBrowserTarget<const TContribution extends PluginBrowserTargetContributionInputV1>(
    contribution: TContribution,
): PluginBrowserTargetContributionV1 {
    return PluginBrowserTargetContributionV1Schema.parse(contribution);
}

export type {
    PluginBrowserTargetContributionInputV1,
    PluginBrowserTargetContributionV1,
} from '@happier-dev/protocol/plugins/contributions/browser';
