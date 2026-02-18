import type { StartupTask } from '@/agent/runtime/startup/startupSpec';
import type { ClaudeStartupArtifacts } from '../createClaudeStartupSpec';

export function createClaudeInitializeSessionInBackgroundTask(params: {
  initializeSessionInBackground: (args: { artifacts: ClaudeStartupArtifacts; signal: AbortSignal }) => Promise<void>;
}): StartupTask<ClaudeStartupArtifacts> {
  return {
    id: 'claude.initialize_session_background',
    phase: 'background',
    run: async ({ artifacts, signal }) => {
      if (signal.aborted) return;
      try {
        await params.initializeSessionInBackground({ artifacts, signal });
      } catch {
        try {
          artifacts.deferredSession.sendSessionEvent({
            type: 'message',
            message:
              '[startup-background-error] Failed to initialize Happy session in the background. Local mode may continue, but remote sync/switching could be unavailable.',
          });
        } catch {
          // ignore
        }
      }
    },
  };
}
