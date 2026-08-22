import type {
  AgentAcpRuntimeDefinition,
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentRuntimeFactory,
  AgentRuntimeContext,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  resolveOpenCodeBackendMode,
} from './mode.js';
import { OPEN_CODE_SYSTEM_TOOL_ID } from '../systemTool.js';
import { openOpenCodeServerSession } from './server/nativeSession.js';
import {
  createOpenCodeNativeSessionControls,
  type OpenCodeActiveSkillsReaderRegistrar,
} from './controls.js';
import { withOpenCodeProviderConfigLaunchEnvironment } from '../providerBinding/runtime.js';
import { prepareOpenCodeQualifiedConnectedAccounts } from '../auth/services/qualifiedPurposeLaunch.js';
import { openCodeHandoffSurface } from '../surfaces/sessions/handoff/descriptor.js';
import { resolveOpenCodeReplayChildLaunch } from '../surfaces/sessions/fork/descriptor.js';

export {
  openCodeExternalSessionsContribution,
} from '../surfaces/sessions/external/contribution.js';

const OPEN_CODE_ACP_RUNTIME_DEFINITION = {
  mcp: { policy: 'pass_through' },
  timeouts: {
    initMs: 60_000,
    toolCallMs: 120_000,
    idleMs: 1_500,
    idleWithoutAssistantMessageMs: 10_000,
  },
} satisfies AgentAcpRuntimeDefinition;

function readOpenCodeNativeMode(request: AgentSessionOpenRequest): 'server' | 'acp' {
  const modeOption = request.configuration?.options.opencodeBackendMode?.value;
  return resolveOpenCodeBackendMode({
    env: request.launchEnvironment?.values,
    accountSettings: typeof modeOption === 'string'
      ? { opencodeBackendMode: modeOption }
      : null,
  });
}

async function openOpenCodeAcpSession(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
) {
  const launchRequest = await withOpenCodeProviderConfigLaunchEnvironment(request);
  return context.protocols.acp.open(launchRequest, {
    transport: {
      kind: 'stdio',
      executable: {
        kind: 'systemTool',
        id: OPEN_CODE_SYSTEM_TOOL_ID,
      },
      args: ['acp'],
      env: {
        NODE_ENV: 'production',
        DEBUG: '',
      },
      timeouts: {
        initializeMs: 60_000,
        toolCallMs: 120_000,
        idleMs: 1_500,
      },
    },
    definition: OPEN_CODE_ACP_RUNTIME_DEFINITION,
  });
}

type OpenCodeExecutionEventInput = AgentExecutionRunEvent extends infer Event
  ? Event extends AgentExecutionRunEvent
    ? Omit<Event, 'sequence' | 'runId' | 'emittedAtMs'>
    : never
  : never;

async function openOpenCodeSession(
  request: AgentSessionOpenRequest,
  context: AgentSessionRuntimeContext,
  bindActiveSkillsReader: OpenCodeActiveSkillsReaderRegistrar,
): Promise<AgentSessionRuntime> {
  const prepared = await prepareOpenCodeQualifiedConnectedAccounts(request, context);
  try {
    const mode = readOpenCodeNativeMode(prepared.request);
    const session = mode === 'acp'
      ? await openOpenCodeAcpSession(prepared.request, context)
      : await openOpenCodeServerSession(
          prepared.request,
          context,
          context.workState,
          bindActiveSkillsReader,
        );
    return prepared.bind(session);
  } catch (error) {
    await prepared.dispose();
    throw error;
  }
}

function createOpenCodeExecutionRunRuntime(
  request: AgentExecutionRunOpenRequest,
  session: AgentSessionRuntime,
): AgentExecutionRunRuntime {
  const listeners = new Set<(event: AgentExecutionRunEvent) => void>();
  const history: AgentExecutionRunEvent[] = [];
  let sequence = 0;
  let turnOrdinal = 0;
  let activeTurnId: string | null = null;
  const emit = (
    input: OpenCodeExecutionEventInput,
    emittedAtMs = Date.now(),
  ): void => {
    const event = Object.freeze({
      ...input,
      sequence: ++sequence,
      runId: request.runId,
      emittedAtMs,
    }) as AgentExecutionRunEvent;
    history.push(event);
    for (const listener of Array.from(listeners)) listener(event);
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
      emit({
        kind: 'run-failed',
        diagnostic: event.diagnostic,
      }, event.emittedAtMs);
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

async function openOpenCodeExecutionRun(
  request: AgentExecutionRunOpenRequest,
  context: AgentRuntimeContext,
): Promise<AgentExecutionRunRuntime> {
  if (request.kind !== 'create') {
    throw new Error(`OpenCode execution runs do not support ${request.kind}.`);
  }
  const sessionRequest = {
    kind: 'create',
    sessionId: request.runId,
    cwd: request.cwd,
    ...(request.launchEnvironment
      ? { launchEnvironment: request.launchEnvironment }
      : {}),
    ...(request.configuration ? { configuration: request.configuration } : {}),
    ...(request.providerBinding ? { providerBinding: request.providerBinding } : {}),
  } as const;
  const prepared = await prepareOpenCodeQualifiedConnectedAccounts(sessionRequest, context);
  try {
    const session = readOpenCodeNativeMode(prepared.request) === 'acp'
      ? await openOpenCodeAcpSession(prepared.request, context)
      : await openOpenCodeServerSession(prepared.request, context);
    const runtime = createOpenCodeExecutionRunRuntime(request, prepared.bind(session));
    await runtime.send(request.input);
    return runtime;
  } catch (error) {
    await prepared.dispose();
    throw error;
  }
}

export const createOpenCodeAgentRuntime: AgentRuntimeFactory = () => {
  const controlsOwner = createOpenCodeNativeSessionControls();
  return {
    toolExecution: { capability: 'observable' },
    sessions: {
      ...controlsOwner.sessions,
      open: (request, context) => openOpenCodeSession(
        request,
        context,
        controlsOwner.bindActiveSkillsReader,
      ),
    },
    executionRuns: { open: openOpenCodeExecutionRun },
    surfaces: {
      handoff: openCodeHandoffSurface,
      fork: {
        resolveReplayChildLaunch: async ({ parentMetadata }) =>
          await resolveOpenCodeReplayChildLaunch({ parentMetadata }),
      },
    },
  };
};
