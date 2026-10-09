import type { PluginHostOwnedAgentDeclaration } from '@happier-dev/plugin-sdk/agents';
import { CODEBUDDY_ACP_COMMAND } from './preflight.js';

type CodeBuddyHostOwnedAcpRuntime = Extract<PluginHostOwnedAgentDeclaration, { runtime: { kind: 'acp' } }>['runtime'];

export const CODEBUDDY_ACP_RUNTIME_DECLARATION = {
  kind: 'acp',
  transport: {
    kind: 'stdio',
    executable: { kind: 'systemTool', id: CODEBUDDY_ACP_COMMAND.toolId },
    args: [...CODEBUDDY_ACP_COMMAND.args],
  },
  definition: {
    modelConfigOptionId: 'model',
    // CodeBuddy Code 2.162.0 native approval presets. `dontAsk` denies actions
    // that would require approval; `default` leaves the provider preset unchanged.
    permissionModeMapping: {
      default: null,
      'read-only': 'dontAsk',
      'safe-yolo': 'auto',
      yolo: 'bypassPermissions',
      plan: 'plan',
    },
    mcp: { policy: 'pass_through' },
  },
} as const satisfies CodeBuddyHostOwnedAcpRuntime;
