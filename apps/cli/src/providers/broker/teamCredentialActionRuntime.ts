import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/composition/executableTypes';
import { resolveAccountExecutionRuntime, type AccountExecutionRuntimeInput } from '@/plugins/runtime/accountExecutionRuntime';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';

/**
 * Keep the native credential registry leased for the finite broker Action. An
 * Account Action runs in the custodian's Account host, composed by the same
 * owner as every other Account execution.
 */
export async function withTeamCredentialActionRuntime<T>(input: Readonly<{
  native: PluginRuntimeRegistryLease;
  action: PluginContributionIdentityV1;
  account: AccountExecutionRuntimeInput;
}>, read: (registry: ResolvedExecutablePluginRuntimeRegistry) => Promise<T>): Promise<T> {
  const declaration = readResolvedActionContribution(input.native.registry.contributes, input.action);
  if (declaration?.admittedTarget?.declaration.execution.target !== 'account') {
    return await read(input.native.registry);
  }
  const { registry } = await resolveAccountExecutionRuntime(input.account);
  try { return await read(registry); }
  finally { await registry.dispose(); }
}
