import type {
  AgentExecutionRunRuntime,
  AgentRuntime,
  AgentRuntimeContext,
  AgentRuntimeFactory,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentSessionUsageLimitRecoveryControl,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import { join } from 'node:path';

import { createPiRuntimeOperations } from './rpc/operations.js';
import { preparePiQualifiedConnectedAccounts } from './qualifiedConnectedAccounts.js';
import {
  preparePiHappierToolsExtension,
  type PreparedPiHappierToolsExtension,
} from '../tools/assets.js';

export {
  piExternalSessionsContribution,
} from '../externalSessions/contribution.js';

const PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS = 600_000;

const piUsageLimitRecovery: AgentSessionUsageLimitRecoveryControl = {
  async execute(request) {
    if (request.kind !== 'checkNow') {
      return {
        status: 'unsupported',
        diagnostic: {
          code: 'pi_reset_credit_unsupported',
          severity: 'error',
        },
      };
    }
    return {
      status: 'waiting',
      retryAfterMs: PI_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS,
    };
  },
};

type ExecutionEventWithoutSequence = Parameters<Parameters<AgentExecutionRunRuntime['watch']>[0]>[0] extends infer Event
  ? Event extends { sequence: number } ? Omit<Event, 'sequence'> : never
  : never;

function readPermissionMode(request: AgentSessionOpenRequest): string | undefined {
  return request.configuration?.permissionIntent.value ?? undefined;
}

function readEnvironment(request: AgentSessionOpenRequest): Readonly<{
  values: Readonly<Record<string, string>>;
  unset: readonly string[];
}> {
  return request.launchEnvironment ?? { values: {}, unset: [] };
}

async function openPiSession(
  request: AgentSessionOpenRequest,
  context: Pick<AgentRuntimeContext, 'services' | 'signal' | 'session'>,
): Promise<AgentSessionRuntime> {
  if (request.kind === 'fork') {
    throw new Error('Pi does not support native session fork');
  }
  const prepared = await preparePiQualifiedConnectedAccounts({
    launchEnvironment: readEnvironment(request),
    context,
  });
  let preparedTools: PreparedPiHappierToolsExtension | null = null;
  let runtime: AgentSessionRuntime;
  try {
    const session = context.session as AgentSessionRuntimeContext['session'] | undefined;
    const models = session && 'services' in session ? session.services.models : null;
    const happierTools = session && 'services' in session ? session.services.happierTools : null;
    if (happierTools) {
      const config = await happierTools.resolveNativeBridge({
        systemPrompt: request.startupInstructions?.instructions,
      }, { signal: context.signal });
      const launchEnv = prepared.launchEnvironment.values;
      const agentDir = launchEnv.PI_CODING_AGENT_DIR?.trim()
        || join(resolveHomeDirFromEnvironment(launchEnv), '.pi', 'agent');
      preparedTools = await preparePiHappierToolsExtension({ agentDir, config });
    }
    if (prepared.isInvalidated()) {
      throw new Error('Pi qualified Connected Account launch was invalidated before opening the runtime.');
    }
    runtime = prepared.bind(await createPiRuntimeOperations({
      services: context.services,
      ...(models ? { models } : {}),
      logger: context.services.logger,
      cwd: request.cwd,
      env: prepared.launchEnvironment.values,
      unsetEnvKeys: prepared.launchEnvironment.unset,
      permissionMode: readPermissionMode(request),
      resumeSessionId: request.kind === 'resume' ? request.providerSessionId : null,
      sessionId: request.sessionId,
      ...(preparedTools ? { happierToolsExtension: preparedTools } : {}),
    }));
    if (preparedTools) {
      const inner = runtime;
      const tools = preparedTools;
      runtime = {
        ...inner,
        async dispose(reason) {
          try {
            await inner.dispose(reason);
          } finally {
            await tools.dispose();
          }
        },
      };
    }
  } catch (error) {
    try {
      await Promise.all([prepared.dispose(), preparedTools?.dispose()]);
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], 'Pi session preparation failed');
    }
    throw error;
  }
  if (request.configuration === undefined) {
    return runtime;
  }
  const result = await runtime.updateConfiguration!(request.configuration);
  if (result.status === 'applied') {
    return runtime;
  }
  const failureCode = 'diagnostic' in result
    ? result.diagnostic.code
    : result.status;
  const failure = new Error(
    `Pi rejected its initial session configuration (${failureCode})`,
  );
  try {
    await runtime.dispose();
  } catch (disposeError) {
    throw new AggregateError([failure, disposeError], failure.message);
  }
  throw failure;
}

async function openPiExecutionRun(
  request: Parameters<NonNullable<AgentRuntime['executionRuns']>['open']>[0],
  context: AgentRuntimeContext,
): Promise<AgentExecutionRunRuntime> {
  if (request.kind !== 'create') {
    throw new Error(`Pi execution runs do not support ${request.kind}`);
  }
  const session = await openPiSession({
    kind: 'create',
    sessionId: request.runId,
    cwd: request.cwd,
    ...(request.launchEnvironment ? { launchEnvironment: request.launchEnvironment } : {}),
  }, context);
  const listeners = new Set<Parameters<AgentExecutionRunRuntime['watch']>[0]>();
  const history: Array<Parameters<Parameters<AgentExecutionRunRuntime['watch']>[0]>[0]> = [];
  let sequence = 0;
  let turnOrdinal = 0;
  let activeTurnId: string | null = null;
  let terminal = false;
  const emit = (event: ExecutionEventWithoutSequence) => {
    if (terminal) return;
    const value = { ...event, sequence: ++sequence } as Parameters<Parameters<AgentExecutionRunRuntime['watch']>[0]>[0];
    history.push(value);
    terminal = event.kind === 'run-complete'
      || event.kind === 'run-failed'
      || event.kind === 'run-cancelled';
    for (const listener of listeners) listener(value);
  };
  const subscription = session.watch((event) => {
    if (event.kind === 'message-delta') {
      emit({
        runId: request.runId,
        emittedAtMs: event.emittedAtMs,
        kind: 'output-delta',
        channel: event.channel,
        text: event.text,
      });
    }
    if (event.kind === 'turn-complete') {
      if (activeTurnId === event.turnId) activeTurnId = null;
      emit({ runId: request.runId, emittedAtMs: event.emittedAtMs, kind: 'run-complete' });
    }
    if (event.kind === 'turn-failed') {
      if (activeTurnId === event.turnId) activeTurnId = null;
      emit({
        runId: request.runId,
        emittedAtMs: event.emittedAtMs,
        kind: 'run-failed',
        diagnostic: event.diagnostic,
      });
    }
    if (event.kind === 'turn-cancelled') {
      if (activeTurnId === event.turnId) activeTurnId = null;
      emit({
        runId: request.runId,
        emittedAtMs: event.emittedAtMs,
        kind: 'run-cancelled',
      });
    }
  });
  const send = async (input: Parameters<AgentExecutionRunRuntime['send']>[0]) => {
    turnOrdinal += 1;
    const turnId = `${request.runId}-turn-${turnOrdinal}`;
    activeTurnId = turnId;
    let result: Awaited<ReturnType<AgentSessionRuntime['send']>>;
    try {
      result = await session.send({
        inputIds: [`${request.runId}-input-${turnOrdinal}`],
        input,
        delivery: { kind: 'newTurn', turnId },
      });
    } catch (error) {
      if (activeTurnId === turnId) activeTurnId = null;
      throw error;
    }
    if (result.status === 'admitted') return { status: 'admitted' as const };
    if (activeTurnId === turnId) activeTurnId = null;
    emit({
      runId: request.runId,
      emittedAtMs: Date.now(),
      kind: 'run-failed',
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
    });
    return { status: result.status, diagnostic: result.diagnostic };
  };
  emit({ runId: request.runId, emittedAtMs: Date.now(), kind: 'run-start' });
  await send(request.input);
  return {
    send,
    async stop(options) {
      if (!activeTurnId) return { status: 'notRunning' };
      const result = await session.cancel?.({ turnId: activeTurnId, reason: 'user' }, options);
      return { status: result?.status ?? 'unsupported' };
    },
    watch(listener) {
      for (const event of history) listener(event);
      if (!terminal) listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    async dispose() {
      subscription.dispose();
      listeners.clear();
      await session.dispose();
    },
  };
}

export const createPiAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open: openPiSession,
    usageLimitRecovery: piUsageLimitRecovery,
  },
  executionRuns: { open: openPiExecutionRun },
});
