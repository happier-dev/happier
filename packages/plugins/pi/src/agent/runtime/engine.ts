import type {
  AgentRuntimeV1,
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import { composeSessionIsolationEnvironment } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { createPiExecutionRunBackend } from '../executionRuns/backend.js';
import { createPiRuntimeOperations } from './rpc/operations.js';

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readEnv(sessionParams: CreateSessionRuntimeParamsV1): Readonly<Record<string, string>> {
  const env = composeSessionIsolationEnvironment({
    isolationEnvironment: sessionParams.isolation?.env,
    environment: sessionParams.env,
    unsetEnvKeys: sessionParams.isolation?.unsetEnvKeys,
  });
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function readDirectory(sessionParams: CreateSessionRuntimeParamsV1): string {
  return readString(sessionParams.cwd)
    ?? readString(sessionParams.directory)
    ?? process.cwd();
}

function readInitialSessionId(sessionParams: CreateSessionRuntimeParamsV1): string | null {
  const state = sessionParams.initialRuntimeState;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const record = state as Readonly<Record<string, unknown>>;
  return readString(record.piSessionId) ?? readString(record.providerSessionId);
}

function readHappierSessionId(sessionParams: CreateSessionRuntimeParamsV1): string | null {
  return readString(sessionParams.sessionId);
}

function readPermissionMode(sessionParams: CreateSessionRuntimeParamsV1): string | undefined {
  return readString(sessionParams.permissionMode) ?? undefined;
}

export function createPiBackendEngine(ctx: PluginContextV1): AgentRuntimeV1 {
  return {
    runtimeCore: {
      createSessionRuntime: async (sessionParams: CreateSessionRuntimeParamsV1) => {
        const initialDirectory = readDirectory(sessionParams);
        const env = readEnv(sessionParams);
        const initialSessionId = readInitialSessionId(sessionParams);
        const initialHappierSessionId = readHappierSessionId(sessionParams);
        const initialPermissionMode = readPermissionMode(sessionParams);
        return await createPiRuntimeOperations({
          ctx,
          cwd: initialDirectory,
          env,
          permissionMode: initialPermissionMode,
          initialSessionId,
          happierSessionId: initialHappierSessionId,
        });
      },
      createExecutionRunBackend: (executionRunParams) => createPiExecutionRunBackend({ ctx, executionRunParams }),
    },
  };
}
