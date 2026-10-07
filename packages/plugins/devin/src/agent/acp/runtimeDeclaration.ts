import type { PluginHostOwnedAgentDeclaration } from '@happier-dev/plugin-sdk/agents';

import { DEVIN_ACP_COMMAND } from './preflight.js';

type DevinHostOwnedAcpRuntime = Extract<
  PluginHostOwnedAgentDeclaration,
  { runtime: { kind: 'acp' } }
>['runtime'];

/**
 * Devin runs through the host's declarative ACP owner. Everything Devin needs
 * beyond the standard ACP contract is declared as data so the out-of-process
 * Session runner composes the same Session from the attested manifest alone:
 *
 * - `default` deliberately maps to `null`: Devin's own default permission
 *   behavior applies when Happier passes no override, and `safe-yolo` is
 *   Devin's `smart` mode.
 * - Devin reads MCP servers only from its own `mcp_config.json`, so the host
 *   delivers this Session's servers into a session-private config root that
 *   links the user's real Devin state, and `drop` keeps the same servers out
 *   of `session/new` rather than delivering them twice.
 * - Devin advertises one model per reasoning/speed combination
 *   (`<model>-high-fast`), so the host presents one model plus Reasoning and
 *   Speed options whenever the advertised combinations form a complete matrix.
 */
export const DEVIN_ACP_RUNTIME_DECLARATION = {
  kind: 'acp',
  transport: {
    kind: 'stdio',
    executable: { kind: 'systemTool', id: DEVIN_ACP_COMMAND.toolId },
    args: [...DEVIN_ACP_COMMAND.args],
  },
  definition: {
    modelConfigOptionId: 'model',
    permissionModeMapping: {
      default: null,
      'read-only': 'ask',
      'safe-yolo': 'smart',
      yolo: 'bypass',
      plan: 'plan',
    },
    mcp: {
      policy: 'drop',
      nativeSessionConfig: {
        configRootEnvKey: { posix: 'XDG_CONFIG_HOME', win32: 'APPDATA' },
        homeRelativeConfigRoot: { posix: ['.config'], win32: ['AppData', 'Roaming'] },
        directory: 'devin',
        fileName: 'mcp_config.json',
        serversKey: 'mcpServers',
        serverEntryConstants: { transport: 'stdio' },
        linkedConfigRootEntries: ['cognition'],
        projectShadowPaths: ['.devin/mcp_config.json', '.devin/mcp_config.local.json'],
      },
    },
    models: {
      suffixOption: {
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        values: [
          { value: 'none', name: 'None', modelNameWords: ['No', 'None'] },
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
          { value: 'xhigh', name: 'XHigh', modelNameWords: ['XHigh', 'X-High'] },
          { value: 'max', name: 'Max' },
        ],
        trailingOption: {
          id: 'service_tier',
          name: 'Speed',
          defaultValue: { value: 'standard', name: 'Standard' },
          values: [
            { segment: 'fast', value: 'fast', name: 'Fast', modelNameWords: ['Fast'] },
            { segment: 'priority', value: 'priority', name: 'Fast', modelNameWords: ['Fast'] },
          ],
        },
        modelNameFillerWords: ['Thinking'],
      },
    },
  },
} as const satisfies DevinHostOwnedAcpRuntime;
