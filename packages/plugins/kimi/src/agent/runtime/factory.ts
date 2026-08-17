import type {
  AgentRuntimeFactory,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { buildKimiAcpArgv, buildKimiAcpEnv } from '../acp/callbacks.js';
import { KIMI_ACP_RUNTIME_DEFINITION } from '../acp/definition.js';

function withoutPythonPathLaunchEnvironment(request: AgentSessionOpenRequest): AgentSessionOpenRequest {
  const values = request.launchEnvironment?.values;
  if (!values || !Object.prototype.hasOwnProperty.call(values, 'PYTHONPATH')) {
    return request;
  }
  const { PYTHONPATH: _pythonPath, ...remainingValues } = values;
  return {
    ...request,
    launchEnvironment: {
      ...request.launchEnvironment,
      values: remainingValues,
    },
  };
}

export const createKimiAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open(request, context) {
      if (!request.configuration) {
        throw new Error('Kimi requires the host-projected Agent session configuration');
      }
      return context.protocols.acp.open(withoutPythonPathLaunchEnvironment(request), {
        transport: {
          kind: 'stdio',
          executable: { kind: 'systemTool', id: 'kimi-cli' },
          args: buildKimiAcpArgv({
            baseArgs: ['acp'],
            cwd: request.cwd,
            permissionIntent: request.configuration.permissionIntent.value,
          }),
          env: buildKimiAcpEnv({ launchEnvironment: request.launchEnvironment }),
        },
        definition: KIMI_ACP_RUNTIME_DEFINITION,
      });
    },
  },
});
