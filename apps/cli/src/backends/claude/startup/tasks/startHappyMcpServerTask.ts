import type { StartupTask } from '@/agent/runtime/startup/startupSpec';
import type { ClaudeStartupArtifacts } from '../createClaudeStartupSpec';

export function createClaudeStartHappyMcpServerTask(params: {
  startHappyServer: (client: ClaudeStartupArtifacts['deferredSession']) => Promise<NonNullable<ClaudeStartupArtifacts['happyServer']>>;
}): StartupTask<ClaudeStartupArtifacts> {
  return {
    id: 'claude.start_happy_mcp_server',
    phase: 'preSpawn',
    run: async ({ artifacts }) => {
      artifacts.happyServer = await params.startHappyServer(artifacts.deferredSession);
    },
  };
}

