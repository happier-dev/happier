import type { AgentTerminalSurface } from '@happier-dev/plugin-sdk/agents/runtime';
import { prepareFxConnectedAccount } from '../auth/connectedAccount.js';

/**
 * FX has no terminal-only flags: the ordinary interactive `fx` command is the
 * whole surface. `argv` carries only the arguments appended after the
 * host-resolved Agent CLI executable, so naming the executable here would run
 * `fx fx`.
 */
export const FX_TERMINAL_CONTRIBUTION: AgentTerminalSurface = Object.freeze({
  async resolveLaunch(request: Parameters<AgentTerminalSurface['resolveLaunch']>[0]) {
    const environment = await prepareFxConnectedAccount(request.launchEnvironment, undefined, request.configuration?.model);
    return {
      argv: [],
      ...(environment ? { environment } : {}),
      process: { stdio: 'inherit' as const, windowsHide: true },
      presentation: {
        onLaunch: { target: 'local' as const, reason: 'fx_terminal_launch' },
        onExit: { target: 'remote' as const, reason: 'fx_terminal_exit' },
      },
    };
  },
});
