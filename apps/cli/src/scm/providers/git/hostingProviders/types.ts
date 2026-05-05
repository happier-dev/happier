import type { ScmHostingProviderContribution } from '@happier-dev/protocol';
import type {
    ScmHostingProviderRuntimeAdapter,
    ScmHostingProviderRuntimeRegistration,
} from '@happier-dev/plugin-sdk';

export type ScmHostingProviderAdapter = ScmHostingProviderRuntimeAdapter;

export type ScmHostingProviderDescriptor = Readonly<Omit<ScmHostingProviderContribution, 'urlSafety'> & {
    pluginId?: string;
    urlSafety: Readonly<{
        allowedSchemes: readonly string[];
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

export type ResolvedScmHostingProviderRegistry = Readonly<{
    providers: readonly ResolvedScmHostingProvider[];
    providersById: ReadonlyMap<string, ResolvedScmHostingProvider>;
    diagnostics: readonly ScmHostingProviderRegistryDiagnostic[];
    getProvider: (id: string) => ResolvedScmHostingProvider | undefined;
    getAdapter: (id: string) => ScmHostingProviderAdapter | undefined;
}>;
