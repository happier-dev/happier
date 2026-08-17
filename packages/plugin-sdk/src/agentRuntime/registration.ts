import type { AgentProviderBindingAdapter } from './providerBinding.js';

/**
 * Immutable-generation-relative identity of the named Agent factory leaf that
 * a Session runner is allowed to load. The host validates the selected leaf
 * against the factory object registered through the one activation ABI.
 */
export type AgentSessionRunnerFactoryLocatorV1 = Readonly<{
  module: string;
  export: string;
  runtimeApiVersion: 1;
  /**
   * Optional named `AgentExternalSessionsContribution` export from the same
   * authenticated module as the primary Agent factory.
   */
  externalSessionsExport?: string;
}>;

/**
 * Static correspondence carried by the canonical Agent registration. A
 * registration-owned Session-capable Agent must supply `sessionRunnerFactory`;
 * an execution-only Agent must not. Host-owned declarative ACP runtimes have
 * no plugin registration. The registration transaction enforces that
 * declaration correspondence before publishing the generation.
 */
export type AgentRuntimeRegistrationOptions = Readonly<{
  providerBinding?: AgentProviderBindingAdapter;
  sessionRunnerFactory?: AgentSessionRunnerFactoryLocatorV1;
}>;
