import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';

import { projectCopilotPreflightModels } from './modelControls.js';
import { prepareCopilotConnectedAccount } from '../runtime/connectedAccount.js';
import { COPILOT_ACP_COMMAND } from './command.js';

export { COPILOT_ACP_COMMAND } from './command.js';

export const COPILOT_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  async prepareLaunchEnvironment({ environment, connectedAccounts, signal, modelId }) {
    const prepared = await prepareCopilotConnectedAccount({ launchEnvironment: { values: environment, unset: [] } },
      { services: { connectedAccounts }, signal }, modelId);
    return { environment: prepared.request.launchEnvironment.values, unset: prepared.request.launchEnvironment.unset,
      catalogConfidence: prepared.models?.catalogConfidence, dispose: prepared.dispose };
  },
  catalogs: Object.freeze({ kind: 'acp' as const, command: COPILOT_ACP_COMMAND }),
  jsonRpcCommands: [COPILOT_ACP_COMMAND],
  probeModels: (context) => context.withDeclaredJsonRpcClient(COPILOT_ACP_COMMAND, async (client) => {
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return projectCopilotPreflightModels(await client.request('session/new', { cwd: context.cwd, mcpServers: [] }));
  }),
} satisfies AgentPreflightSessionControlsContributionV1);
