import { AgentCliNotFoundError } from './agentCliNotFoundError';
import { commandExistsOnPath } from '@happier-dev/cli-common/process';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import {
  buildMissingAgentCliCommandErrorMessage,
  resolveAgentCliRuntimeSpecForLookupId,
  type AgentCliResolutionOptions,
} from './requireAgentCliCommand';
import {
  resolveAgentCliLaunchSpecForRuntime,
  buildAgentCliLaunchSpecFromResolution,
  type AgentCliLaunchSpec,
} from './agentCliLaunchSpec';
export type { AgentCliLaunchSpec } from './agentCliLaunchSpec';

/** Session validation consumes the selected Account definition through its launch owner. */
export async function resolveAgentCliLaunchSpecForSession(agentId: string, opts: AgentCliResolutionOptions & Readonly<{
  options: Pick<SpawnSessionOptions, 'directory' | 'agentTarget' | 'runtimeDescriptorV1'>;
  savedSecretOperationContext?: SavedSecretOperationContextV1;
}>): Promise<AgentCliLaunchSpec | null> {
  const { resolveAccountConfiguredAcpLaunchForAgent } = await import('@/agent/runtime/registry/engineRegistry/accountConfiguredAcp');
  const declaration = (opts.catalogSnapshot ?? readAgentCatalogSnapshot()).agentDefinitionsById.get(agentId);
  const identity = declaration?.identity;
  const configured = identity ? await resolveAccountConfiguredAcpLaunchForAgent({ identity,
    agentTarget: opts.options.agentTarget, startupRuntimeDescriptorV1: opts.options.runtimeDescriptorV1,
    savedSecretOperationContext: opts.savedSecretOperationContext }) : null;
  const launchOptions = { ...opts, cwd: opts.options.directory };
  if (!configured) return declaration?.runtimeSpec ? resolveAgentCliLaunchSpec(agentId, launchOptions) : null;
  const launch = await configured.resolveHostLaunch({ cwd: opts.options.directory });
  if (!commandExistsOnPath(launch.command, { cwd: opts.options.directory,
    env: { ...(opts.processEnv ?? sessionProcessEnvironment()), ...launch.env } })) {
    throw new AgentCliNotFoundError(agentId, `Agent '${configured.configuredBackend.title}' is not installed or its configured command is unavailable.`);
  }
  const spec = buildAgentCliLaunchSpecFromResolution({ command: launch.command,
    source: configured.configuredBackend.launch.kind === 'command' ? 'system' : 'managed' }, launchOptions);
  if (!spec) {
    throw new AgentCliNotFoundError(agentId, `Agent '${configured.configuredBackend.title}' requires an available JavaScript runtime.`);
  }
  return { ...spec, args: [...spec.args, ...launch.args] };
}

export function resolveAgentCliLaunchSpec(
  agentId: string,
  opts: AgentCliResolutionOptions = {},
): AgentCliLaunchSpec | null {
  return resolveAgentCliLaunchSpecForRuntime(
    resolveAgentCliRuntimeSpecForLookupId(agentId, opts),
    opts,
  );
}

export function requireAgentCliLaunchSpec(
  agentId: string,
  opts: AgentCliResolutionOptions = {},
): AgentCliLaunchSpec {
  const resolved = resolveAgentCliLaunchSpec(agentId, opts);
  if (resolved) return resolved;
  throw new AgentCliNotFoundError(agentId, buildMissingAgentCliCommandErrorMessage(agentId, opts));
}
