import type { BackendRuntimeRegistration as ScmBackendRuntimeRegistration } from '@happier-dev/plugin-sdk/scm/backend';
import type { HostingProviderRuntimeRegistration as ScmHostingProviderRuntimeRegistration } from '@happier-dev/plugin-sdk/scm/hosting';

export type PluginDisposable = (() => void | Promise<void>) | Readonly<{
    dispose(): void | Promise<void>;
}>;

export type PluginApiScmHostingProviderRegistration = ScmHostingProviderRuntimeRegistration;
export type PluginApiScmBackendRegistration = ScmBackendRuntimeRegistration;
