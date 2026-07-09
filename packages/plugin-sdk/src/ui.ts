import {
    PluginSessionHeaderActionDescriptorV1Schema,
    PluginStructuredMessageDescriptorV1Schema,
    PluginUiArtifactContributionV1Schema,
    PluginUiTranslationsContributionV1Schema,
    type PluginHostedWebContributionV1,
    type PluginReactNativeBundleContributionV1,
    type PluginSessionHeaderActionDescriptorV1,
    type PluginSurfacePlacementDescriptorV1,
    type PluginStructuredMessageDescriptorV1,
    type PluginUiArtifactContributionV1,
    type PluginUiTranslationsContributionV1,
} from '@happier-dev/protocol/plugins/contributions/ui';
import type { SettingDefinitionMap } from '@happier-dev/protocol';

export { defineSurfaceContribution } from './ui/surfaceContribution.js';
export type {
    DefineSurfaceContributionInputV1,
    DefineSurfaceContributionResultV1,
} from './ui/surfaceContribution.js';

export function defineUiTranslations<const TContribution extends PluginUiTranslationsContributionV1>(
    contribution: TContribution,
): TContribution {
    return PluginUiTranslationsContributionV1Schema.parse(contribution) as TContribution;
}

export function defineStructuredMessage<const TContribution extends PluginStructuredMessageDescriptorV1>(
    contribution: TContribution,
): TContribution {
    return PluginStructuredMessageDescriptorV1Schema.parse(contribution) as TContribution;
}

export function defineSessionHeaderAction<const TContribution extends PluginSessionHeaderActionDescriptorV1>(
    contribution: TContribution,
): TContribution {
    return PluginSessionHeaderActionDescriptorV1Schema.parse(contribution) as TContribution;
}

export function defineUiArtifact<const TContribution extends PluginUiArtifactContributionV1>(
    contribution: TContribution,
): TContribution {
    return PluginUiArtifactContributionV1Schema.parse(contribution) as TContribution;
}

export type {
    PluginHostedWebContributionV1,
    PluginReactNativeBundleContributionV1,
    PluginSessionHeaderActionDescriptorV1,
    PluginSurfacePlacementDescriptorV1,
    PluginStructuredMessageDescriptorV1,
    PluginUiArtifactContributionV1,
    PluginUiTranslationsContributionV1,
} from '@happier-dev/protocol/plugins/contributions/ui';
export type { SettingDefinitionMap } from '@happier-dev/protocol';
