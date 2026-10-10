import type { DaemonTerminalLaunchIntent } from '@happier-dev/protocol';

import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { resolveAgentCliLaunchSpecForRuntime } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';

export type TerminalLaunchProcess = Readonly<{
  file: string;
  args: readonly string[];
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Final host-rendered Windows argv; the PTY must not quote it again. */
  windowsVerbatimArguments?: boolean;
  initialInput?: string;
}>;

export class AgentLoginLaunchError extends Error {
  constructor(readonly code: 'agent_login_unsupported' | 'agent_cli_missing') {
    super(code);
  }
}

export function resolveDaemonTerminalLaunch(
  launchRequest: DaemonTerminalLaunchIntent,
  deps: Readonly<{
    buildLaunchSpec?: typeof buildHappyCliSubprocessLaunchSpec;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  }> = {},
): TerminalLaunchProcess {
  const buildLaunchSpec = deps.buildLaunchSpec ?? buildHappyCliSubprocessLaunchSpec;
  switch (launchRequest.kind) {
    case 'package_script':
      // The terminal RPC validates cwd and resolves this intent to shell input
      // through the local-service run-target owner, before executable launch.
      throw new Error('package_script_requires_terminal_cwd');
    case 'agent_login': {
      const agent = readAgentCatalogSnapshot().agentDefinitionsById.get(launchRequest.agentId);
      const auth = agent?.cliMetadata?.auth;
      const declaration = auth?.loginLaunches.find((candidate) => candidate.kind === (launchRequest.launchId ?? 'primary'));
      if (auth?.support !== 'login_terminal' || !declaration) {
        throw new AgentLoginLaunchError('agent_login_unsupported');
      }
      const initialInput = declaration.initialInput ? { initialInput: declaration.initialInput } : {};
      if (declaration.target === 'agent_acp') {
        const launch = buildLaunchSpec(['agents', 'auth', 'login', launchRequest.agentId]);
        return { file: launch.filePath, args: launch.args, env: launch.env, ...initialInput };
      }
      const launch = agent?.runtimeSpec
        ? resolveAgentCliLaunchSpecForRuntime(agent.runtimeSpec, { processEnv: deps.env, platform: deps.platform })
        : null;
      if (!launch) throw new AgentLoginLaunchError('agent_cli_missing');
      return { file: launch.command, args: [...launch.args, ...declaration.args], ...initialInput };
    }
    case 'session_attach': {
      const launch = buildLaunchSpec(['attach', launchRequest.sessionId]);
      return {
        file: launch.filePath,
        args: launch.args,
        env: launch.env,
      };
    }
    case 'happier_cli': {
      const launch = buildLaunchSpec(launchRequest.args);
      return {
        file: launch.filePath,
        args: launch.args,
        env: launch.env,
      };
    }
  }
}
