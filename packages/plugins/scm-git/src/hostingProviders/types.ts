import type {
    ScmHostingProviderRemoteDetectionInput,
    ScmHostingProviderResolvedRemote,
    ScmHostingProviderRuntimeAdapter,
} from '@happier-dev/plugin-sdk/experimental/scm/hostingProvider';

export type {
    ScmHostingProviderCompareUrlResult,
    ScmHostingProviderDescriptor,
    ScmHostingProviderRemoteDetectionInput,
    ScmHostingProviderRemoteDetectionResult,
    ScmHostingProviderResolvedProvider as ResolvedScmHostingProvider,
    ScmHostingProviderResolvedRegistry as ResolvedScmHostingProviderRegistry,
    ScmHostingProviderResolvedRemote,
    ScmHostingProviderRuntimeAdapter as ScmHostingProviderAdapter,
    ScmHostingProviderRuntimeBinding,
    ScmHostingProviderRuntimeRegistration,
    ScmHostingProviderRegistryDiagnostic,
    ScmHostingProviderUnresolvedRemote as UnresolvedScmHostingProvider,
} from '@happier-dev/plugin-sdk/experimental/scm/hostingProvider';

export type ScmHostingProviderRoutingAdapter = ScmHostingProviderRuntimeAdapter & Readonly<{
    detectRemote: (input: ScmHostingProviderRemoteDetectionInput) => ScmHostingProviderResolvedRemote | null;
    buildCompareUrl: (input: Readonly<{
        provider: ScmHostingProviderResolvedRemote;
        base: string;
        head: string;
    }>) => string | null;
}>;
