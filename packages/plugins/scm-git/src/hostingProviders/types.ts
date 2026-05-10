import type { ScmHostingProviderContribution } from '@happier-dev/protocol';
import type {
    ScmHostingProviderRuntimeAdapter,
    ScmHostingProviderRuntimeRegistration,
} from '@happier-dev/plugin-sdk';

export type ScmHostingProviderAdapter = ScmHostingProviderRuntimeAdapter;

export type ScmHostingProviderDescriptor = Readonly<Omit<ScmHostingProviderContribution, 'urlSafety'> & {
    pluginId?: string;
    urlSafety?: Readonly<{
        allowedSchemes: readonly string[];
        allowedBaseUrls: readonly string[];
        allowedOrigins: readonly string[];
    }>;
}>;

export type ScmHostingProviderRuntimeBinding = Readonly<{
    pluginId: string;
    registration: ScmHostingProviderRuntimeRegistration;
}>;

export type ScmHostingProviderRegistryDiagnostic = Readonly<{
    code: string;
    message: string;
    pluginId?: string;
    providerId?: string;
}>;

export type ResolvedScmHostingProvider = ScmHostingProviderDescriptor & Readonly<{
    runtime?: ScmHostingProviderRuntimeBinding;
}>;

export type ScmHostingProviderRemoteDetectionInput = Readonly<{
    remoteName: string | null;
    remoteUrl: string;
}>;

export type UnresolvedScmHostingProvider = Readonly<{
    id: 'unknown';
    kind: 'unknown';
    displayName: 'Unknown SCM hosting provider';
    remoteName?: string;
    unsupportedReason: 'no_registered_provider_detected';
}>;

export type ScmHostingProviderResolvedRemote = Readonly<{
    id: string;
    kind: string;
    displayName: string;
    baseUrl: string;
    nameWithOwner?: string;
    remoteName?: string | null;
    urlSafety?: Readonly<{
        allowedSchemes: readonly string[];
        allowedBaseUrls?: readonly string[];
        allowedOrigins?: readonly string[];
    }>;
}>;

export type ScmHostingProviderRoutingAdapter = ScmHostingProviderAdapter & Readonly<{
    detectRemote: (input: ScmHostingProviderRemoteDetectionInput) => ScmHostingProviderResolvedRemote | null;
    buildCompareUrl: (input: Readonly<{
        provider: ScmHostingProviderResolvedRemote;
        base: string;
        head: string;
    }>) => string | null;
}>;

export type ScmHostingProviderRemoteDetectionResult =
    | Readonly<{
        kind: 'resolved';
        providerId: string;
        provider: ScmHostingProviderResolvedRemote;
    }>
    | Readonly<{
        kind: 'unknown';
        provider: UnresolvedScmHostingProvider;
    }>;

export type ScmHostingProviderCompareUrlResult =
    | Readonly<{
        kind: 'resolved';
        url: string;
    }>
    | Readonly<{
        kind: 'unsupported';
        reason: 'unknown_provider' | 'adapter_unavailable' | 'unsupported_by_provider';
        provider: ScmHostingProviderResolvedRemote | UnresolvedScmHostingProvider;
    }>;

export type ResolvedScmHostingProviderRegistry = Readonly<{
    providers: readonly ResolvedScmHostingProvider[];
    providersById: ReadonlyMap<string, ResolvedScmHostingProvider>;
    diagnostics: readonly ScmHostingProviderRegistryDiagnostic[];
    getProvider: (id: string) => ResolvedScmHostingProvider | undefined;
    getAdapter: (id: string) => ScmHostingProviderAdapter | undefined;
    detectRemote: (input: ScmHostingProviderRemoteDetectionInput) => ScmHostingProviderRemoteDetectionResult;
    buildCompareUrl: (input: Readonly<{
        provider: ScmHostingProviderResolvedRemote | UnresolvedScmHostingProvider;
        base: string;
        head: string;
    }>) => ScmHostingProviderCompareUrlResult;
}>;
