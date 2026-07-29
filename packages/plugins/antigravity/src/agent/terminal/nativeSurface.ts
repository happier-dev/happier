import type { AgentTerminalSurface } from '@happier-dev/plugin-sdk/agent-runtime';

import {
  buildAntigravityTerminalLaunchArgs,
  resolveAntigravityTerminalLaunchArgsInput,
} from './launchArgs.js';

export function createAntigravityNativeTerminalSurface(): AgentTerminalSurface {
  return {
    resolveLaunch(request) {
      return {
        argv: buildAntigravityTerminalLaunchArgs(
          resolveAntigravityTerminalLaunchArgsInput(request.metadata),
        ),
        process: {
          stdio: 'inherit',
          windowsHide: true,
        },
        presentation: {
          onLaunch: {
            target: 'local',
            reason: 'antigravity_terminal_runtime_launcher_start',
          },
          onExit: {
            target: 'remote',
            reason: 'antigravity_terminal_runtime_launcher_exit',
          },
        },
      };
    },
  };
}
