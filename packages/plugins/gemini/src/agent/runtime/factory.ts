import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentRuntimeContext,
  AgentRuntimeFactory,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { GEMINI_ACP_RUNTIME_DEFINITION } from '../acp/definition.js';
import {
  GEMINI_ACP_AUTH_META_ENV,
  GEMINI_ACP_AUTH_METHOD_ENV,
  resolveGeminiAcpFlag,
  resolveGeminiApiKeyFromEnv,
  resolveGeminiAuthConfig,
} from '../auth/resolution.js';
import { prepareGeminiNativeMcpShaping } from '../mcp/shaping.js';

function buildGeminiLaunchEnvironment(
  values: Readonly<Record<string, string>>,
  unset: readonly string[],
): Readonly<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...values };
  for (const key of unset) delete env[key];
  return env;
}

function ignoredGeminiAcpAuthControlEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const overlay: Record<string, string> = {};
  if (Object.prototype.hasOwnProperty.call(env, GEMINI_ACP_AUTH_METHOD_ENV)) overlay[GEMINI_ACP_AUTH_METHOD_ENV] = '';
  if (Object.prototype.hasOwnProperty.call(env, GEMINI_ACP_AUTH_META_ENV)) overlay[GEMINI_ACP_AUTH_META_ENV] = '';
  return overlay;
}

function readServiceAccountProjectId(value: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>;
    if (
      parsed.type !== 'service_account'
      || typeof parsed.project_id !== 'string'
      || !parsed.project_id.trim()
      || typeof parsed.client_email !== 'string'
      || !parsed.client_email.trim()
      || typeof parsed.private_key !== 'string'
      || !parsed.private_key.trim()
    ) {
      return null;
    }
    return parsed.project_id.trim();
  } catch {
    return null;
  }
}

async function openGeminiSession(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
): Promise<AgentSessionRuntime> {
      const requestedLaunchEnvironment = request.launchEnvironment ?? { values: {}, unset: [] };
      const connectedAccountEnv: Record<string, string> = {};
      let connectedServiceAccount: Uint8Array | null = null;
      const binding = await context.services.connectedAccounts.getBinding(
        'model_upstream',
        { signal: context.signal },
      );
      if (binding) {
        const materializedFiles = await context.services.connectedAccounts.materialize(
          'model_upstream',
          { kind: 'files', fileIds: ['google-service-account.json'] },
          { signal: context.signal },
        );
        if (materializedFiles.kind !== 'files') {
          throw new Error('Gemini upstream account returned an invalid file materialization.');
        }
        connectedServiceAccount = materializedFiles.files['google-service-account.json'] ?? null;
        if (connectedServiceAccount) {
          const projectId = readServiceAccountProjectId(connectedServiceAccount);
          if (!projectId) {
            throw new Error('Gemini upstream account returned an invalid service-account credential.');
          }
          connectedAccountEnv.GOOGLE_GENAI_USE_VERTEXAI = '1';
          connectedAccountEnv.GOOGLE_CLOUD_PROJECT = projectId;
          connectedAccountEnv.GOOGLE_CLOUD_LOCATION = 'global';
        } else {
          const materialized = await context.services.connectedAccounts.materialize(
            'model_upstream',
            { kind: 'environment', keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
            { signal: context.signal },
          );
          if (materialized.kind !== 'environment') {
            throw new Error('Gemini upstream account returned an invalid environment materialization.');
          }
          const geminiApiKey = materialized.env.GEMINI_API_KEY?.trim();
          const googleApiKey = materialized.env.GOOGLE_API_KEY?.trim();
          if (geminiApiKey) connectedAccountEnv.GEMINI_API_KEY = geminiApiKey;
          if (googleApiKey) connectedAccountEnv.GOOGLE_API_KEY = googleApiKey;
          if (!geminiApiKey && !googleApiKey) {
            throw new Error('Gemini upstream account did not materialize a supported credential.');
          }
        }
      }
      const sourceEnv: Record<string, string | undefined> = {
        ...buildGeminiLaunchEnvironment(
          requestedLaunchEnvironment.values,
          requestedLaunchEnvironment.unset,
        ),
        ...connectedAccountEnv,
      };
      const auth = resolveGeminiAuthConfig(sourceEnv, resolveGeminiApiKeyFromEnv(sourceEnv));
      const authControlEnv = ignoredGeminiAcpAuthControlEnv(sourceEnv);
      const shaping = await prepareGeminiNativeMcpShaping(sourceEnv);
      try {
        if (connectedServiceAccount) {
          const credentialDirectory = join(shaping.env.HOME, '.config', 'happier');
          const credentialPath = join(credentialDirectory, 'google-service-account.json');
          await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
          await writeFile(credentialPath, connectedServiceAccount, { mode: 0o600, flag: 'wx' });
          connectedAccountEnv.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
          sourceEnv.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
        }
        const flag = await resolveGeminiAcpFlag(context.services.exec, {
          env: {
            ...sourceEnv,
            ...shaping.env,
            ...authControlEnv,
            ...(auth.launchEnv ?? {}),
          },
          signal: context.signal,
        });
        const launchEnvironment = {
          values: {
            ...requestedLaunchEnvironment.values,
            ...connectedAccountEnv,
            ...authControlEnv,
            ...(auth.launchEnv ?? {}),
          },
          unset: requestedLaunchEnvironment.unset.filter(
            (key) => !Object.prototype.hasOwnProperty.call(connectedAccountEnv, key),
          ),
        };
        const session = await context.protocols.acp.open({
          ...request,
          launchEnvironment,
        }, {
          transport: {
            kind: 'stdio',
            executable: { kind: 'systemTool', id: 'gemini-cli' },
            args: [flag],
            env: shaping.env,
            timeouts: {
              initializeMs: GEMINI_ACP_RUNTIME_DEFINITION.timeouts.initMs,
              idleMs: GEMINI_ACP_RUNTIME_DEFINITION.timeouts.idleMs,
              toolCallMs: GEMINI_ACP_RUNTIME_DEFINITION.timeouts.toolCallMs,
            },
          },
          definition: GEMINI_ACP_RUNTIME_DEFINITION,
        });
        let disposed = false;
        return {
          ...session,
          async dispose() {
            if (disposed) return;
            disposed = true;
            try {
              await session.dispose();
            } finally {
              await shaping.cleanup();
            }
          },
        };
      } catch (error) {
        await shaping.cleanup();
        throw error;
      }
}

type GeminiExecutionRunEventInput = AgentExecutionRunEvent extends infer Event
  ? Event extends AgentExecutionRunEvent
    ? Omit<Event, 'sequence' | 'runId' | 'emittedAtMs'>
    : never
  : never;

function createGeminiExecutionRunRuntime(
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>,
  session: AgentSessionRuntime,
): AgentExecutionRunRuntime {
  const listeners = new Set<(event: AgentExecutionRunEvent) => void>();
  const history: AgentExecutionRunEvent[] = [];
  let sequence = 0;
  let turnOrdinal = 0;
  let activeTurnId: string | null = null;
  const emit = (
    input: GeminiExecutionRunEventInput,
    emittedAtMs = Date.now(),
  ): void => {
    const event = Object.freeze({
      ...input,
      sequence: ++sequence,
      runId: request.runId,
      emittedAtMs,
    }) as AgentExecutionRunEvent;
    history.push(event);
    for (const listener of listeners) listener(event);
  };
  const subscription = session.watch((event) => {
    if (event.kind === 'provider-session-id') {
      emit({ kind: 'checkpoint', checkpointId: event.providerSessionId }, event.emittedAtMs);
    } else if (event.kind === 'message-delta') {
      emit({
        kind: 'output-delta',
        channel: event.channel,
        text: event.text,
      }, event.emittedAtMs);
    } else if (event.kind === 'turn-progress') {
      emit({ kind: 'run-progress' }, event.emittedAtMs);
    } else if (event.kind === 'turn-complete') {
      activeTurnId = null;
      emit({ kind: 'run-complete' }, event.emittedAtMs);
    } else if (event.kind === 'turn-failed') {
      activeTurnId = null;
      emit({ kind: 'run-failed', diagnostic: event.diagnostic }, event.emittedAtMs);
    } else if (event.kind === 'turn-cancelled') {
      activeTurnId = null;
      emit({
        kind: 'run-cancelled',
        ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}),
      }, event.emittedAtMs);
    }
  });
  const send: AgentExecutionRunRuntime['send'] = async (input, options) => {
    activeTurnId = `${request.runId}-turn-${++turnOrdinal}`;
    const result = await session.send({
      inputIds: [`${request.runId}-input-${turnOrdinal}`],
      input,
      delivery: { kind: 'newTurn', turnId: activeTurnId },
    }, options);
    if (result.status === 'admitted') return { status: 'admitted' };
    activeTurnId = null;
    emit({
      kind: 'run-failed',
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
    });
    return { status: result.status, diagnostic: result.diagnostic };
  };
  emit({ kind: 'run-start' });
  return {
    send,
    async stop(options) {
      if (!activeTurnId) return { status: 'notRunning' };
      const result = await session.cancel?.({
        turnId: activeTurnId,
        reason: 'user',
      }, options);
      return { status: result?.status ?? 'unsupported' };
    },
    watch(listener) {
      listeners.add(listener);
      for (const event of history) listener(event);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    async dispose() {
      subscription.dispose();
      listeners.clear();
      await session.dispose();
    },
  };
}

export const createGeminiAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open: openGeminiSession,
  },
  executionRuns: {
    async open(request, context) {
      if (request.kind !== 'create') {
        throw new Error(`Gemini execution runs do not support ${request.kind}.`);
      }
      const session = await openGeminiSession({
        kind: 'create',
        sessionId: request.runId,
        cwd: request.cwd,
        ...(request.launchEnvironment ? { launchEnvironment: request.launchEnvironment } : {}),
      }, context);
      const execution = createGeminiExecutionRunRuntime(request, session);
      const result = await execution.send(request.input);
      if (result.status !== 'admitted') await execution.dispose();
      return execution;
    },
  },
});
