import type { AgentSignInStatusResponse } from '@happier-dev/protocol';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import { projectPluginSystemToolContributions } from '@/plugins/runtime/exec/system/tools/definitions';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { resolveCliSnapshotProbeTimeoutMs } from '@/capabilities/snapshots/cliSnapshotProbeTimeout';
import type { CliAuthNativeExecution } from './types';

/** Machine CLIs and Agents share sign-in Actions; tool command facts stay with the plugin declaration. */
export function readSystemToolAuthentication(id: string) {
  const tool = readCurrentContributionRegistry().systemToolsById?.get(id);
  const authentication = tool?.definition.authentication;
  return tool && authentication ? { tool, authentication } : null;
}

type Declaration = NonNullable<ReturnType<typeof readSystemToolAuthentication>>;

export function systemToolAuthenticationEnvironment(declaration: Declaration,
  inherited: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const { authentication } = declaration;
  return Object.fromEntries(Object.entries({ ...inherited, ...authentication.environment }).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
      && !authentication.unsetEnvironmentKeys?.includes(entry[0])
      && !authentication.unsetEnvironmentKeyPrefixes?.some(prefix => entry[0].startsWith(prefix)),
  ));
}

export function createSystemToolAuthenticationResolver(declaration: Declaration,
  environment: Readonly<Record<string, string>>, platform?: NodeJS.Platform) {
  return createPluginExecSystemToolResolver({
    definitions: projectPluginSystemToolContributions([declaration.tool.definition]),
    baseEnv: environment,
    platform,
    // The command is consumed immediately by the native terminal/Exec owner.
    registerGrant() {},
  });
}

export async function probeSystemToolAuthentication(declaration: Declaration,
  nativeExecution?: CliAuthNativeExecution | null): Promise<AgentSignInStatusResponse['status']> {
  if (nativeExecution === null) return 'unknown';
  const environment = systemToolAuthenticationEnvironment(declaration,
    nativeExecution?.processEnv ?? sessionProcessEnvironment());
  const cwd = nativeExecution?.cwd ?? sessionWorkingDirectory();
  const signal = nativeExecution?.signal ?? new AbortController().signal;
  const tools = createSystemToolAuthenticationResolver(declaration, environment);
  try {
    const exec = createStablePluginExecService({
      ...(nativeExecution ? { agentIsolation: nativeExecution.agentIsolation } : {}),
      environment: {}, signal, defaultCwd: cwd, isOccurrenceCurrent: () => !signal.aborted,
      systemTools: tools,
      async resolveExecutable(executable) {
        if (executable.kind !== 'systemTool' || executable.id !== declaration.tool.definition.id) {
          throw new Error('Machine CLI authentication requires its declared executable');
        }
        const resolved = await tools.resolve({ toolId: executable.id, purpose: 'Read machine CLI sign-in state', cwd, signal });
        return { command: resolved.launch.executablePath, args: resolved.launch.args, env: resolved.launch.env,
          ...(resolved.allowedArguments ? { allowedArguments: resolved.allowedArguments } : {}) };
      },
      async resolvePath() { return cwd; },
    });
    const result = await exec.run({ executable: { kind: 'systemTool', id: declaration.tool.definition.id },
      args: declaration.authentication.status.args, env: environment,
      timeoutMs: resolveCliSnapshotProbeTimeoutMs(true, environment) });
    const observed = result.termination.observed;
    if (observed.kind !== 'exit') return 'unknown';
    return observed.exitCode === 0 ? 'signedIn'
      : typeof observed.exitCode === 'number' && declaration.authentication.status.signedOutExitCodes.includes(observed.exitCode)
        ? 'signedOut' : 'unknown';
  } catch { return 'unknown'; }
}
