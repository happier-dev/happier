import { DeferredApiSessionClient } from '@/agent/runtime/startup/DeferredApiSessionClient';
import type { BackendStartupSpec, StartupTask } from '@/agent/runtime/startup/startupSpec';
import { configuration } from '@/configuration';
import { createClaudeInitializeSessionInBackgroundTask } from './tasks/initializeSessionInBackgroundTask';
import { createClaudeRegisterRpcHandlersTask } from './tasks/registerRpcHandlersTask';
import { createClaudeStartHookServerTask } from './tasks/startHookServerTask';

type HookServer = Readonly<{ port: number; stop: () => void }>;

export type ClaudeStartupArtifacts = {
  deferredSession: DeferredApiSessionClient;
  hookServer: HookServer | null;
  hookSettingsPath: string | null;
  exitCode: number | null;
};

type CreateClaudeStartupSpecDeps = Readonly<{
  startHookServer: () => Promise<HookServer>;
  generateHookSettingsFile: (port: number) => string;
  cleanupHookSettingsFile: (path: string) => void;
  registerRpcHandlers: (args: { artifacts: ClaudeStartupArtifacts }) => void;
  initializeSessionInBackground: (args: { artifacts: ClaudeStartupArtifacts; signal: AbortSignal }) => Promise<void>;
  spawnLoop: (args: { artifacts: ClaudeStartupArtifacts; signal: AbortSignal }) => Promise<number>;
}>;

const defaultDeps: CreateClaudeStartupSpecDeps = {
  startHookServer: async () => {
    throw new Error('startHookServer not wired');
  },
  generateHookSettingsFile: () => {
    throw new Error('generateHookSettingsFile not wired');
  },
  cleanupHookSettingsFile: () => {},
  registerRpcHandlers: () => {},
  initializeSessionInBackground: async () => {},
  spawnLoop: async () => 0,
};

export function createClaudeStartupSpec(params: { deps?: Partial<CreateClaudeStartupSpecDeps> }): BackendStartupSpec<ClaudeStartupArtifacts> {
  const deps: CreateClaudeStartupSpecDeps = { ...defaultDeps, ...(params.deps ?? {}) };

  const tasks: Array<StartupTask<ClaudeStartupArtifacts>> = [
    createClaudeRegisterRpcHandlersTask({ registerRpcHandlers: deps.registerRpcHandlers }),
    createClaudeStartHookServerTask({
      startHookServer: deps.startHookServer,
      generateHookSettingsFile: deps.generateHookSettingsFile,
    }),
    createClaudeInitializeSessionInBackgroundTask({ initializeSessionInBackground: deps.initializeSessionInBackground }),
  ];

  return {
    backendId: 'claude',
    createArtifacts: () => {
      const placeholderSessionId = `PID-${process.pid}`;
      const deferredSession = new DeferredApiSessionClient({
        placeholderSessionId,
        limits: {
          maxEntries: configuration.startupDeferredSessionBufferMaxEntries,
          maxBytes: configuration.startupDeferredSessionBufferMaxBytes,
        },
      });

      return {
        deferredSession,
        hookServer: null,
        hookSettingsPath: null,
        exitCode: null,
      };
    },
    tasks,
    spawnVendor: async ({ artifacts, signal }) => {
      artifacts.exitCode = await deps.spawnLoop({ artifacts, signal });
    },
  };
}
