import {
    PluginBrowserActionContributionV1Schema,
    type PluginBrowserActionContributionV1,
} from '@happier-dev/protocol/plugins/contributions/browser';

export function defineBrowserAction<const TContribution extends PluginBrowserActionContributionV1>(
    contribution: TContribution,
): TContribution {
    return PluginBrowserActionContributionV1Schema.parse(contribution) as TContribution;
}

export type {
    PluginBrowserActionContributionV1,
} from '@happier-dev/protocol/plugins/contributions/browser';
