import type { StartupTask } from '@/agent/runtime/startup/startupSpec';
import type { ClaudeStartupArtifacts } from '../createClaudeStartupSpec';

type HookServer = Readonly<{ port: number; stop: () => void }>;

export function createClaudeStartHookServerTask(params: {
  startHookServer: () => Promise<HookServer>;
  generateHookSettingsFile: (port: number) => string;
}): StartupTask<ClaudeStartupArtifacts> {
  return {
    id: 'claude.start_hook_server',
    phase: 'preSpawn',
    run: async ({ artifacts }) => {
      const hookServer = await params.startHookServer();
      artifacts.hookServer = hookServer;
      artifacts.hookSettingsPath = params.generateHookSettingsFile(hookServer.port);
    },
  };
}

