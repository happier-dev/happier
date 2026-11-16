import type { AgentTerminalLaunchRequest, AgentTerminalSurface } from '@happier-dev/plugin-sdk/agents/runtime';
import { codeBuddyNativeSandboxSettings } from '../runtime/launchSettings.js';

/**
 * CodeBuddy's interactive terminal is the bare `codebuddy` command. The launch plan is
 * arguments only: the host resolves the declared CodeBuddy CLI executable and
 * appends these, so naming the binary here would launch it twice.
 */
export const CODEBUDDY_TERMINAL_SURFACE: AgentTerminalSurface = Object.freeze({
  resolveLaunch(request: AgentTerminalLaunchRequest) {
    return {
      argv: request.configuration?.nativeSandbox === undefined ? []
        : ['--settings', JSON.stringify(codeBuddyNativeSandboxSettings(request.configuration.nativeSandbox))],
      process: { stdio: 'inherit' as const, windowsHide: true },
      presentation: {
        onLaunch: { target: 'local' as const, reason: 'codebuddy_terminal_launch' },
        onExit: { target: 'remote' as const, reason: 'codebuddy_terminal_exit' },
      },
    };
  },
});
