import { PluginManagedDependencyContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/managedDependencies';
import type { AccountSettings, InstallablesRegistry } from '@happier-dev/protocol';

import { authenticateAcpAgent } from './authenticateAcpAgent';
import { normalizePluginDeclarativeAcpRuntime } from './runtime/definition/plugin';
import { resolveAcpTransportLaunch } from './runtime/launch/acpTransportLaunch';
import { readAgentPrimaryRuntime } from '@/plugins/projection/registry/agentContributionDefinition';
import { ensureRuntimeInstallablesForLaunch } from '@/packagedRuntime/installables/ensureForLaunch';
import {
  getRuntimeInstallableAdapter,
  type RuntimeInstallableAdapter,
} from '@/packagedRuntime/installables/registry';
import { readSettings } from '@/persistence';
import { resolveExecutableManagedDependenciesRegistry } from '@/plugins/projection/registry/managedDependencyExecutables';
import type {
  ResolvedContributionRegistry,
  ResolvedInstallableContribution,
} from '@/plugins/projection/registry/types';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

type Dependencies = Readonly<{
  ensureRuntimeInstallablesForLaunch: typeof ensureRuntimeInstallablesForLaunch;
  getRuntimeInstallableAdapter: (
    key: Parameters<typeof getRuntimeInstallableAdapter>[0],
    options: Readonly<{ installablesRegistry: InstallablesRegistry }>,
  ) => Promise<RuntimeInstallableAdapter>;
  readSettings: typeof readSettings;
  readAccountSettings: () => AccountSettings | null;
  resolveInstallablesRegistry: typeof resolveExecutableManagedDependenciesRegistry;
  authenticateAcpAgent: typeof authenticateAcpAgent;
}>;

function readManagedDependencyId(
  executableId: string | Readonly<{ pluginId: string; localId: string }>,
  pluginId: string,
): string {
  if (typeof executableId === 'string') return executableId;
  if (executableId.pluginId !== pluginId) {
    throw new Error('ACP login cannot authenticate another plugin\'s managed dependency');
  }
  return executableId.localId;
}

function findManagedDependency(params: Readonly<{
  contributions: readonly ResolvedInstallableContribution[];
  pluginId: string;
  dependencyId: string;
}>): ResolvedInstallableContribution {
  const contribution = params.contributions.find((candidate) => {
    if (candidate.pluginId !== params.pluginId) return false;
    const parsed = PluginManagedDependencyContributionV2Schema.safeParse(candidate.definition);
    return parsed.success && parsed.data.id === params.dependencyId;
  });
  if (!contribution) {
    throw new Error(`ACP managed dependency '${params.dependencyId}' is not declared by '${params.pluginId}'`);
  }
  return contribution;
}

export async function authenticateDeclaredAcpAgent(params: Readonly<{
  registry: ResolvedContributionRegistry;
  agentId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStderr: (text: string) => void;
  signal?: AbortSignal;
}>, dependencyOverrides: Partial<Dependencies> = {}): Promise<void> {
  const dependencies: Dependencies = {
    ensureRuntimeInstallablesForLaunch,
    getRuntimeInstallableAdapter,
    readSettings,
    readAccountSettings: () => getActiveAccountSettingsSnapshot()?.settings ?? null,
    resolveInstallablesRegistry: resolveExecutableManagedDependenciesRegistry,
    authenticateAcpAgent,
    ...dependencyOverrides,
  };
  const agent = params.registry.agents.find((candidate) => candidate.id === params.agentId);
  const declaredRuntime = readAgentPrimaryRuntime(agent?.richDefinition?.definition);
  if (!agent?.pluginId || !declaredRuntime) {
    throw new Error(`Agent '${params.agentId}' does not declare host-managed ACP authentication`);
  }
  const runtime = normalizePluginDeclarativeAcpRuntime(declaredRuntime);
  const authentication = runtime.definition?.auth;
  if (!authentication || !('methodId' in authentication)) {
    throw new Error(`Agent '${params.agentId}' does not declare a static ACP authentication method`);
  }
  if (runtime.transport.kind !== 'stdio' || runtime.transport.executable.kind !== 'managedDependency') {
    throw new Error(`Agent '${params.agentId}' does not use a managed ACP stdio transport`);
  }

  const dependencyId = readManagedDependencyId(runtime.transport.executable.id, agent.pluginId);
  const contribution = findManagedDependency({
    contributions: params.registry.managedDependencies ?? [],
    pluginId: agent.pluginId,
    dependencyId,
  });
  const installablesRegistry = dependencies.resolveInstallablesRegistry([contribution]);
  const descriptor = installablesRegistry.descriptors.find(
    (candidate) => candidate.owner.pluginId === agent.pluginId,
  )?.descriptor;
  if (!descriptor) {
    throw new Error(`ACP managed dependency '${dependencyId}' is unavailable on this host`);
  }

  const settings = await dependencies.readSettings();
  const ensured = await dependencies.ensureRuntimeInstallablesForLaunch({
    installableKeys: [descriptor.key],
    settings: dependencies.readAccountSettings(),
    machineId: settings.machineId ?? '',
    env: params.env,
    installablesRegistry,
  });
  if (!ensured.ok) {
    const detail = ensured.logPath
      ? `${ensured.errorMessage} (install log: ${ensured.logPath})`
      : ensured.errorMessage;
    throw new Error(`ACP managed dependency '${dependencyId}' is unavailable: ${detail}`);
  }

  const adapter = await dependencies.getRuntimeInstallableAdapter(descriptor.key, { installablesRegistry });
  if (!adapter.resolveLaunchCommand) {
    throw new Error(`ACP managed dependency '${dependencyId}' has no launch command`);
  }
  const resolved = await adapter.resolveLaunchCommand({ env: params.env, sourcePreference: 'managed-first' });
  if (!resolved.ok) throw new Error(resolved.errorMessage);

  const transport = await resolveAcpTransportLaunch({
    transport: runtime.transport,
    pluginId: agent.pluginId,
    purpose: 'interactive ACP authentication',
    cwd: params.cwd,
    signal: params.signal ?? new AbortController().signal,
    systemTools: {
      resolve: async () => { throw new Error('ACP login expected a managed dependency'); },
    },
    managedDependencies: {
      resolve: async (request) => {
        if (request.pluginId !== agent.pluginId || request.dependencyId !== dependencyId) {
          throw new Error('ACP login resolved a different managed dependency');
        }
        return {
          command: resolved.command,
          args: resolved.args,
          release: () => {},
        };
      },
    },
  });
  if (transport.kind !== 'stdio') throw new Error('ACP login requires a stdio transport');

  const env: NodeJS.ProcessEnv = { ...params.env, ...transport.env };
  for (const key of transport.unsetEnv) delete env[key];
  try {
    await dependencies.authenticateAcpAgent({
      agentName: params.agentId,
      command: transport.command,
      args: transport.args,
      cwd: params.cwd,
      env,
      methodId: authentication.methodId,
      onStderr: params.onStderr,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } finally {
    transport.release?.();
  }
}
