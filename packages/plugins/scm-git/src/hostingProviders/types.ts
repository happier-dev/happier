import type {
    HostingProviderRemoteDetectionInput as ScmHostingProviderRemoteDetectionInput,
    HostingProviderResolvedRemote as ScmHostingProviderResolvedRemote,
    HostingProviderRuntimeAdapter as ScmHostingProviderRuntimeAdapter,
} from '@happier-dev/plugin-sdk/scm/hosting';

export type {
    HostingProviderCompareUrlResult,
    HostingProviderDescriptor,
    HostingProviderRemoteDetectionInput,
    HostingProviderRemoteDetectionResult,
    HostingProviderResolvedProvider as ResolvedScmHostingProvider,
    HostingProviderResolvedRegistry as ResolvedScmHostingProviderRegistry,
    HostingProviderResolvedRemote,
    HostingProviderRuntimeAdapter as ScmHostingProviderAdapter,
    HostingProviderRuntimeRegistration,
    HostingProviderRegistryDiagnostic,
    HostingProviderUnresolvedRemote as UnresolvedScmHostingProvider,
} from '@happier-dev/plugin-sdk/scm/hosting';

export type ScmHostingProviderRoutingAdapter = ScmHostingProviderRuntimeAdapter & Readonly<{
    detectRemote: (input: ScmHostingProviderRemoteDetectionInput) => ScmHostingProviderResolvedRemote | null;
    buildCompareUrl: (input: Readonly<{
        provider: ScmHostingProviderResolvedRemote;
        base: string;
        head: string;
    }>) => string | null;
}>;
