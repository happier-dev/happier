import type { StartupTask } from '@/agent/runtime/startup/startupSpec';
import type { ClaudeStartupArtifacts } from '../createClaudeStartupSpec';

export function createClaudeRegisterRpcHandlersTask(params: {
  registerRpcHandlers: (args: { artifacts: ClaudeStartupArtifacts }) => void;
}): StartupTask<ClaudeStartupArtifacts> {
  return {
    id: 'claude.register_rpc_handlers',
    phase: 'preSpawn',
    run: async ({ artifacts }) => {
      params.registerRpcHandlers({ artifacts });
    },
  };
}

