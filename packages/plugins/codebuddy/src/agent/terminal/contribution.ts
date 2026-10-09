import type { AgentTerminalSurface } from '@happier-dev/plugin-sdk/agents/runtime';

/**
 * CodeBuddy's interactive terminal is the bare `codebuddy` command. The launch plan is
 * arguments only: the host resolves the declared CodeBuddy CLI executable and
 * appends these, so naming the binary here would launch it twice.
 */
export const CODEBUDDY_TERMINAL_SURFACE: AgentTerminalSurface = Object.freeze({
  resolveLaunch() {
    return {
      argv: [],
      process: { stdio: 'inherit' as const, windowsHide: true },
      presentation: {
        onLaunch: { target: 'local' as const, reason: 'codebuddy_terminal_launch' },
        onExit: { target: 'remote' as const, reason: 'codebuddy_terminal_exit' },
      },
    };
  },
});
