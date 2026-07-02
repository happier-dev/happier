import type {
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import type {
  BundledBackendEngineV1,
  BundledSessionRuntimeCreateResultV1,
} from '@happier-dev/plugin-sdk/internal/runtime/session';

import { createPiExecutionRunBackend } from '../executionRuns/backend.js';
import { createPiRuntimeOperations, PI_RUNTIME_CAPABILITIES } from './rpc/operations.js';

type HostSessionRuntimeFactoryParams = Readonly<{
  directory?: string;
  session?: Readonly<{ sessionId?: string }>;
  getPermissionMode?: () => string | undefined;
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readEnv(sessionParams: CreateSessionRuntimeParamsV1): Readonly<Record<string, string>> {
  const env = sessionParams.isolation?.env ?? sessionParams.env ?? {};
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

function readRuntimeHappierSessionId(runtimeParams: HostSessionRuntimeFactoryParams): string | null {
  return readString(runtimeParams.session?.sessionId);
}

function readPermissionMode(sessionParams: CreateSessionRuntimeParamsV1): string | undefined {
  return readString(sessionParams.permissionMode) ?? undefined;
}

type HostSessionRuntimePlan = Extract<BundledSessionRuntimeCreateResultV1, { kind: 'hostSessionRuntimePlan' }>;

export function createPiBackendEngine(ctx: PluginContextV1): BundledBackendEngineV1 {
  return {
    runtimeCore: {
      createSessionRuntime: async (sessionParams: CreateSessionRuntimeParamsV1) => {
        const initialDirectory = readDirectory(sessionParams);
        const env = readEnv(sessionParams);
        const initialSessionId = readInitialSessionId(sessionParams);
        const initialHappierSessionId = readHappierSessionId(sessionParams);
        const initialPermissionMode = readPermissionMode(sessionParams);
        return Object.freeze({
          kind: 'hostSessionRuntimePlan',
          providerId: 'pi',
          opts: Object.freeze({
            directory: initialDirectory,
            backendId: 'pi',
          }),
          config: Object.freeze({
            flavor: 'pi',
            policyAgentId: 'pi',
            backendDisplayName: 'Pi',
            uiLogPrefix: '[Pi]',
            providerName: 'pi',
            waitingForCommandLabel: 'Pi',
            agentMessageType: 'pi',
            checkpointToolProtocol: 'acp',
            supportsMcpServers: false,
            machineMetadata: Object.freeze({}),
            terminalDisplay: () => null,
            formatPromptErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
            createSessionRuntime: async (runtimeParams: HostSessionRuntimeFactoryParams) => {
              const permissionMode = runtimeParams.getPermissionMode?.() ?? initialPermissionMode;
              return await createPiRuntimeOperations({
                ctx,
                cwd: readString(runtimeParams.directory) ?? initialDirectory,
                env,
                permissionMode,
                initialSessionId,
                happierSessionId: readRuntimeHappierSessionId(runtimeParams) ?? initialHappierSessionId,
              });
            },
            runtimeCapabilities: PI_RUNTIME_CAPABILITIES,
          }),
        } satisfies HostSessionRuntimePlan);
      },
      createExecutionRunBackend: (executionRunParams) => createPiExecutionRunBackend({ ctx, executionRunParams }),
    },
  };
}
