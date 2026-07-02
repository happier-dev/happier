import {
    PluginReactNativeBundleContributionV1Schema,
    type PluginReactNativeBundleContributionV1,
} from '@happier-dev/protocol';

export function defineReactNativeBundleUi<const TContribution extends PluginReactNativeBundleContributionV1>(
    contribution: TContribution,
): TContribution {
    return PluginReactNativeBundleContributionV1Schema.parse(contribution) as TContribution;
}

export type {
    PluginReactNativeBundleContributionV1,
} from '@happier-dev/protocol';
