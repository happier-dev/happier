import {
    PluginBrowserActionContributionV1Schema,
    type PluginBrowserActionContributionInputV1,
    type PluginBrowserActionContributionV1,
} from '@happier-dev/protocol/plugins/contributions/browser';

export function defineBrowserAction<const TContribution extends PluginBrowserActionContributionInputV1>(
    contribution: TContribution,
): PluginBrowserActionContributionV1 {
    return PluginBrowserActionContributionV1Schema.parse(contribution);
}

export type {
    PluginBrowserActionContributionInputV1,
    PluginBrowserActionContributionV1,
} from '@happier-dev/protocol/plugins/contributions/browser';
