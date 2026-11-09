import type { AgentTerminalSurface } from '@happier-dev/plugin-sdk/agents/runtime';

/**
 * The ordinary interactive `droid` command is the terminal surface; the ACP
 * entry point stays with the Session runtime launch leaf. `argv` carries only
 * the arguments appended after the host-resolved Agent CLI executable, so
 * naming the executable here would run `droid droid`.
 */
export const DROID_TERMINAL_CONTRIBUTION: AgentTerminalSurface = Object.freeze({
  async resolveLaunch() {
    return {
      argv: [],
      process: { stdio: 'inherit' as const, windowsHide: true },
      presentation: {
        onLaunch: { target: 'local' as const, reason: 'droid_terminal_launch' },
        onExit: { target: 'remote' as const, reason: 'droid_terminal_exit' },
      },
    };
  },
});
