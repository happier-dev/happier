import { agentCliPathRequiresJavaScriptRuntime, resolveAgentCliCommandForRuntime, resolveManagedToolsRoot, type AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { managedJavaScriptRuntimeBinPath, resolveDirectJavaScriptRuntimeCommand } from '@happier-dev/cli-common/agents/managedJavaScriptRuntime';
import { FIRST_PARTY_INSTALL_HOME_ENV_KEY, MANAGED_TOOLS_ROOT_ENV_KEY } from '@happier-dev/cli-common/firstPartyRuntime';

import { buildAgentCliLaunchSpecFromResolution, type AgentCliLaunchSpec } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';

/** Only explicitly published code roots are shareable; daemon state is private. */
export function readMemberAgentSharedManagedToolsRoot(environment: NodeJS.ProcessEnv): string | undefined {
  if (!environment[MANAGED_TOOLS_ROOT_ENV_KEY]?.trim() && !environment[FIRST_PARTY_INSTALL_HOME_ENV_KEY]?.trim()) return undefined;
  return resolveManagedToolsRoot({
    [MANAGED_TOOLS_ROOT_ENV_KEY]: environment[MANAGED_TOOLS_ROOT_ENV_KEY],
    [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: environment[FIRST_PARTY_INSTALL_HOME_ENV_KEY],
    HOME: environment.HOME,
    USERPROFILE: environment.USERPROFILE,
  });
}

/** Resolution and version probes share the same managed JavaScript selection. */
export function buildMemberAgentCliResolutionEnvironment(environment: NodeJS.ProcessEnv,
  sharedManagedToolsRoot?: string): NodeJS.ProcessEnv {
  const localEnvironment = { ...environment, PATH: '',
    HAPPIER_JS_RUNTIME_PATH: managedJavaScriptRuntimeBinPath(environment),
    HAPPIER_MANAGED_NODE_BIN: undefined, HAPPIER_NODE_PATH: undefined };
  const localRuntime = resolveDirectJavaScriptRuntimeCommand({ processEnv: localEnvironment, isBunRuntime: false });
  const sharedEnvironment = sharedManagedToolsRoot ? { ...localEnvironment,
    HAPPIER_MANAGED_TOOLS_ROOT: sharedManagedToolsRoot } : undefined;
  const sharedRuntime = !localRuntime && sharedEnvironment
    ? resolveDirectJavaScriptRuntimeCommand({ processEnv: { ...sharedEnvironment,
      HAPPIER_JS_RUNTIME_PATH: managedJavaScriptRuntimeBinPath(sharedEnvironment) }, isBunRuntime: false }) : null;
  return { ...localEnvironment, HAPPIER_JS_RUNTIME_PATH: localRuntime ?? sharedRuntime ?? localEnvironment.HAPPIER_JS_RUNTIME_PATH };
}

/** Runs inside the existing native member child, so access checks use its UID. */
export function resolveMemberAgentInstallCli(input: Readonly<{
  runtimeSpec: AgentCliRuntimeDescriptor;
  sharedManagedToolsRoot?: string;
}>, environment: NodeJS.ProcessEnv): AgentCliLaunchSpec | null {
  const processEnv = buildMemberAgentCliResolutionEnvironment(environment, input.sharedManagedToolsRoot);
  const resolved = resolveAgentCliCommandForRuntime(input.runtimeSpec, { processEnv, sourcePolicy: 'member',
    memberSharedManagedToolsRoot: input.sharedManagedToolsRoot });
  if (!resolved) return null;
  const launch = buildAgentCliLaunchSpecFromResolution(resolved, { processEnv });
  if (launch && agentCliPathRequiresJavaScriptRuntime(resolved.command)
    && launch.command !== processEnv.HAPPIER_JS_RUNTIME_PATH) return null;
  return launch;
}
