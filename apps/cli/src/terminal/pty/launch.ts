import type { DaemonTerminalLaunchIntent } from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';

import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { resolveAgentCliLaunchSpecForRuntime } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import { resolveMemberRunnableAgentCliLaunch, type MemberAgentCliLaunchContext } from '@/plugins/runtime/exec/system/tools/memberAgentCliLaunch';
import { isHomeSelectionFlag } from '@/cli/commands/shared/argvFlags';
import { resolveTerminalShell } from './shells';
import { readSystemToolAuthentication, systemToolAuthenticationEnvironment, createSystemToolAuthenticationResolver } from '@/capabilities/cliAuth/systemToolAuthentication';

export type TerminalLaunchProcess = Readonly<{
  file: string;
  args: readonly string[];
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Final host-rendered Windows argv; the PTY must not quote it again. */
  windowsVerbatimArguments?: boolean;
  initialInput?: string;
}>;

export type MemberTerminalLaunchContext = MemberAgentCliLaunchContext & Readonly<{ homeApplicationUrl?: string }>;

export class AgentLoginLaunchError extends Error {
  constructor(readonly code: 'agent_login_unsupported' | 'agent_cli_missing') {
    super(code);
  }
}

export async function resolveDaemonTerminalLaunch(
  launchRequest: DaemonTerminalLaunchIntent,
  deps: Readonly<{
    buildLaunchSpec?: typeof buildHappyCliSubprocessLaunchSpec;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    /** Admitted native launch material for a separated member. */
    memberLaunch?: MemberTerminalLaunchContext;
  }> = {},
): Promise<TerminalLaunchProcess> {
  const buildLaunchSpec = deps.buildLaunchSpec ?? buildHappyCliSubprocessLaunchSpec;
  const resolveHappierCli = (args: string[]): TerminalLaunchProcess => {
    if (deps.memberLaunch) {
      const { managedHappierBinaryPath, homeApplicationUrl } = deps.memberLaunch;
      if (!homeApplicationUrl) throw new PluginError({
        code: 'requester_home_unavailable',
        message: 'The admitted Home has no application address for this terminal launch.',
        retryable: false,
      });
      if (launchRequest.kind === 'happier_cli' && args.some(isHomeSelectionFlag)) {
        throw new PluginError({
          code: 'terminal_invalid_request',
          message: 'This terminal launch selects the admitted Home. Remove Home selection flags from the command.',
          retryable: false,
        });
      }
      return { file: managedHappierBinaryPath, args: ['--server-url', homeApplicationUrl, ...args] };
    }
    const launch = buildLaunchSpec(args);
    return { file: launch.filePath, args: launch.args, env: launch.env };
  };
  switch (launchRequest.kind) {
    case 'shell_command': {
      const command = launchRequest.command;
      return {
        ...resolveTerminalShell(deps.env ?? process.env, deps.platform ?? process.platform),
        // Preserve 0.2's blank/no-op and existing-newline behavior. The shared
        // PTY owner writes this once; there is no legacy launch path.
        ...(command.trim() ? { initialInput: command.endsWith('\n') ? command : `${command}\n` } : {}),
      };
    }
    case 'package_script':
      // The terminal RPC validates cwd and resolves this intent to shell input
      // through the local-service run-target owner, before executable launch.
      throw new Error('package_script_requires_terminal_cwd');
    case 'service_shell':
      // The managed service owner lends the exact current Compose launch.
      // Generic shell resolution has no service generation or native custody.
      throw new Error('service_shell_requires_native_admission');
    case 'agent_login': {
      const tool = readSystemToolAuthentication(launchRequest.agentId);
      if (tool) {
        const declaration = tool.authentication.loginLaunches.find(candidate => candidate.kind === (launchRequest.launchId ?? 'primary'));
        if (!declaration) throw new AgentLoginLaunchError('agent_login_unsupported');
        const env = systemToolAuthenticationEnvironment(tool, deps.env ?? process.env);
        try {
          const resolved = await createSystemToolAuthenticationResolver(tool, env, deps.platform).resolve({
            toolId: tool.tool.definition.id, purpose: 'Sign this machine CLI in',
          });
          return { file: resolved.launch.executablePath, args: [...resolved.launch.args, ...declaration.args],
            env: { ...env, ...resolved.launch.env } };
        } catch { throw new AgentLoginLaunchError('agent_cli_missing'); }
      }
      const agent = readAgentCatalogSnapshot().agentDefinitionsById.get(launchRequest.agentId);
      const auth = agent?.cliMetadata?.auth;
      const declaration = auth?.loginLaunches.find((candidate) => candidate.kind === (launchRequest.launchId ?? 'primary'));
      if (auth?.support !== 'login_terminal' || !declaration) {
        throw new AgentLoginLaunchError('agent_login_unsupported');
      }
      const initialInput = declaration.initialInput ? { initialInput: declaration.initialInput } : {};
      if (declaration.target === 'agent_acp') {
        return { ...resolveHappierCli(['agents', 'auth', 'login', launchRequest.agentId]), ...initialInput };
      }
      const runtimeSpec = agent?.runtimeSpec;
      const launch = !runtimeSpec ? null : deps.memberLaunch
        ? await resolveMemberRunnableAgentCliLaunch({ agentId: launchRequest.agentId, runtimeSpec,
          processEnv: deps.env ?? process.env, memberLaunch: deps.memberLaunch }).catch((error: unknown) => {
            // Only the member resolver's own "not runnable" answer means the CLI is missing.
            if (isPluginError(error) && error.code === 'agent_cli_not_runnable') return null;
            throw error;
          })
        : resolveAgentCliLaunchSpecForRuntime(runtimeSpec, { processEnv: deps.env, platform: deps.platform });
      if (!launch) throw new AgentLoginLaunchError('agent_cli_missing');
      return { file: launch.command, args: [...launch.args, ...declaration.args], ...initialInput };
    }
    case 'session_attach':
      return resolveHappierCli(['attach', launchRequest.sessionId]);
    case 'happier_cli':
      return resolveHappierCli(launchRequest.args);
  }
}
