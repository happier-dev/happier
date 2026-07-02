import {
    PluginHostedWebContributionV1Schema,
    PluginReactNativeBundleContributionV1Schema,
    PluginSessionHeaderActionDescriptorV1Schema,
    PluginSessionSurfaceDescriptorV1Schema,
    PluginStructuredMessageDescriptorV1Schema,
    PluginUiArtifactContributionV1Schema,
    PluginUiTranslationsContributionV1Schema,
    type PluginHostedWebContributionV1,
    type PluginReactNativeBundleContributionV1,
    type PluginSessionHeaderActionDescriptorV1,
    type PluginSessionSurfaceDescriptorV1,
    type PluginStructuredMessageDescriptorV1,
    type PluginUiArtifactContributionV1,
    type PluginUiTranslationsContributionV1,
} from '@happier-dev/protocol';

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

export function defineSessionSurface<const TContribution extends PluginSessionSurfaceDescriptorV1>(
    contribution: TContribution,
): TContribution {
    return PluginSessionSurfaceDescriptorV1Schema.parse(contribution) as TContribution;
}

export function defineSessionHeaderAction<const TContribution extends PluginSessionHeaderActionDescriptorV1>(
    contribution: TContribution,
): TContribution {
    return PluginSessionHeaderActionDescriptorV1Schema.parse(contribution) as TContribution;
}

export function defineHostedWeb<const TContribution extends PluginHostedWebContributionV1>(
    contribution: TContribution,
): TContribution {
    return PluginHostedWebContributionV1Schema.parse(contribution) as TContribution;
}

export function defineReactNativeBundle<const TContribution extends PluginReactNativeBundleContributionV1>(
    contribution: TContribution,
): TContribution {
    return PluginReactNativeBundleContributionV1Schema.parse(contribution) as TContribution;
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
    PluginSessionSurfaceDescriptorV1,
    PluginStructuredMessageDescriptorV1,
    PluginUiArtifactContributionV1,
    PluginUiTranslationsContributionV1,
} from '@happier-dev/protocol';
