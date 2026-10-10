import type { ManagedExecutableRef } from '@happier-dev/protocol/plugins/contributions/agentAcpTransport';
import type { ProjectNativeAdapterRoleV1 as CanonicalAdapterRole } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';
import type { ProjectDefinitionDetectionV1 as CanonicalDetection, ProjectNativeRefV1 as CanonicalNativeRef, ProjectEnvironmentSelectionV1 as CanonicalEnvironment } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { PluginContributionRef } from './identity.js';
import type { PluginCancellationOptions } from './lifecycle.js';
import type { PluginInvocationContext } from './invocation.js';
import type { ManagedServiceNativeInstanceV1, ManagedServiceNativeLifecycleV1 } from './managed-services/contract.js';

export type ProjectNativeAdapterRoleV1 = CanonicalAdapterRole;
export type ProjectDefinitionDetectionV1 = CanonicalDetection;
export type ProjectNativeRefV1 = CanonicalNativeRef;
export type ProjectEnvironmentSelectionV1 = CanonicalEnvironment;

export type PluginProjectNativeAdapterDeclarationV1 = Readonly<{
    files: readonly string[];
    roles: readonly ProjectNativeAdapterRoleV1[];
}>;
export type PluginProjectNativeFileFactV1 = Readonly<{ file: string; content: string }>;
export type PluginProjectNativeInspectionV1 = Readonly<{
    root: string;
    adapter: PluginContributionRef;
    files: readonly PluginProjectNativeFileFactV1[];
}>;
export type PluginProjectNativeFailureV1 = Readonly<{
    kind: 'unsupported' | 'unavailable' | 'failed' | 'cancelled';
    code: string;
}>;
export type PluginProjectNativeCommandV1 = Readonly<{
    executable: ManagedExecutableRef;
    args: readonly string[];
    cwd: string;
    reviewInputs: readonly PluginProjectNativeFileFactV1[];
    /** Exact environment already applied by native command semantics; never an executable-name heuristic. */
    environmentApplied?: ProjectEnvironmentSelectionV1;
}>;
export type PluginProjectNativeCommandRequestV1 = PluginProjectNativeInspectionV1 & Readonly<{
    source: Extract<ProjectNativeRefV1, { kind: 'pluginNative' }>;
}>;
export type PluginProjectNativeCommandResultV1 = (PluginProjectNativeCommandV1 & Readonly<{
    kind: 'resolved';
    /** Exact native resource, not launcher PID or display target. Requires this adapter's nativeServiceLifecycle role. */
    nativeInstance?: ManagedServiceNativeInstanceV1;
}>) | PluginProjectNativeFailureV1;
export type PluginProjectNativeEnvironmentRequestV1 = PluginProjectNativeInspectionV1 & Readonly<{
    selection: Extract<ProjectEnvironmentSelectionV1, { kind: 'pluginToolchain' }>;
    /** Absent for environment-only preparation; wrapper-only adapters refuse that intent. */
    launch?: Readonly<{ command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }>;
}>;
export type PluginProjectNativeEnvironmentResultV1 = Readonly<{
    kind: 'ready';
    env: Readonly<Record<string, string>>;
    launch?: PluginProjectNativeCommandV1;
    reviewInputs: readonly PluginProjectNativeFileFactV1[];
}> | PluginProjectNativeFailureV1;

/** Passive detection receives no host services or launch capability. */
export interface PluginProjectNativeAdapterRuntimeV1 {
    detect?(request: PluginProjectNativeInspectionV1, options?: PluginCancellationOptions): Promise<ProjectDefinitionDetectionV1>;
    resolveCommand?(request: PluginProjectNativeCommandRequestV1, context: PluginInvocationContext, options?: PluginCancellationOptions): Promise<PluginProjectNativeCommandResultV1>;
    /** Returns the complete native environment, not a patch over the original host environment. */
    produceEnvironment?(request: PluginProjectNativeEnvironmentRequestV1, context: PluginInvocationContext, options?: PluginCancellationOptions): Promise<PluginProjectNativeEnvironmentResultV1>;
    nativeServiceLifecycle?: ManagedServiceNativeLifecycleV1;
}
export type PluginProjectNativeAdapterDefinitionV1 = Readonly<{
    declaration: PluginProjectNativeAdapterDeclarationV1;
    runtime: PluginProjectNativeAdapterRuntimeV1;
}>;
