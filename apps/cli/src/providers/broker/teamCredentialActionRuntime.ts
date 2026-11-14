import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/composition/executableTypes';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';

/** Keep the native credential registry leased for the finite broker Action. */
export async function withTeamCredentialActionRuntime<T>(input: Readonly<{
  native: PluginRuntimeRegistryLease;
  action: PluginContributionIdentityV1;
  resolveAccount(): Promise<ResolvedExecutablePluginRuntimeRegistry>;
}>, read: (registry: ResolvedExecutablePluginRuntimeRegistry) => Promise<T>): Promise<T> {
  const declaration = readResolvedActionContribution(input.native.registry.contributes, input.action);
  if (declaration?.admittedTarget?.declaration.execution.target !== 'account') {
    return await read(input.native.registry);
  }
  const account = await input.resolveAccount();
  try { return await read(account); }
  finally { await account.dispose(); }
}
