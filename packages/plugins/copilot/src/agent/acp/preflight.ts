import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { projectCopilotPreflightModels } from './modelControls.js';

export const COPILOT_ACP_COMMAND = Object.freeze({ toolId: 'copilot-cli', args: Object.freeze(['--acp']) });

export const COPILOT_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  catalogs: Object.freeze({ kind: 'acp' as const, command: COPILOT_ACP_COMMAND }),
  jsonRpcCommands: [COPILOT_ACP_COMMAND],
  probeModels: (context) => context.withDeclaredJsonRpcClient(COPILOT_ACP_COMMAND, async (client) => {
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return projectCopilotPreflightModels(await client.request('session/new', { cwd: context.cwd, mcpServers: [] }));
  }),
} satisfies AgentPreflightSessionControlsContributionV1);
