import {
    PluginBrowserTargetContributionV1Schema,
    type PluginBrowserTargetContributionV1,
} from '@happier-dev/protocol/plugins/contributions/browser';

export function defineBrowserTarget<const TContribution extends PluginBrowserTargetContributionV1>(
    contribution: TContribution,
): TContribution {
    return PluginBrowserTargetContributionV1Schema.parse(contribution) as TContribution;
}

export type {
    PluginBrowserTargetContributionV1,
} from '@happier-dev/protocol/plugins/contributions/browser';
