import {
  SYSTEM_TASK_PROTOCOL_VERSION,
  type SystemTaskEvent,
  type SystemTaskJsonObject,
  type SystemTaskJsonValue,
  type SystemTaskResult,
} from '@happier-dev/protocol';

import { SystemTaskExecutionError } from './runSystemTask.js';

export type InteractiveSystemTaskEventInput = Readonly<{
  type: string;
  stepId?: string;
  message?: string;
  data?: unknown;
}>;

export type InteractiveSystemTaskPromptRequest = Readonly<{
  kind: string;
  stepId?: string;
  message: string;
  data: SystemTaskJsonValue;
}>;

export type InteractiveSystemTaskContext = Readonly<{
  params: SystemTaskJsonValue;
  signal?: AbortSignal;
  emit: (event: InteractiveSystemTaskEventInput) => void;
  prompt: (prompt: InteractiveSystemTaskPromptRequest) => Promise<unknown>;
}>;

export type InteractiveSystemTaskKind<TResult extends SystemTaskJsonValue = SystemTaskJsonValue> = Readonly<{
  run: (context: InteractiveSystemTaskContext) => Promise<TResult>;
}>;

export type InteractiveSystemTaskKindMap = Readonly<Record<string, InteractiveSystemTaskKind>>;

type PromptEnvelope = Readonly<{
  kind: string;
  data: SystemTaskJsonValue;
}>;

type RunnerState = {
  events: SystemTaskEvent[];
  result: SystemTaskResult | null;
  pendingPrompt: PromptEnvelope | null;
  resolvePrompt: ((answer: unknown) => void) | null;
};

export function createSystemTasksRunner(params: Readonly<{
  now?: () => number;
  kinds: InteractiveSystemTaskKindMap;
}>): Readonly<{
  start: (params: Readonly<{ taskId: string; kind: string; params: SystemTaskJsonValue }>) => Promise<Readonly<{ taskId: string }>>;
  poll: (params: Readonly<{ taskId: string; cursor: number }>) => Promise<Readonly<{
    events: SystemTaskEvent[];
    nextCursor: number;
    result: SystemTaskResult | null;
    pendingPrompt: PromptEnvelope | null;
  }>>;
  respond: (params: Readonly<{ taskId: string; answer: unknown }>) => Promise<void>;
}> {
  const now = params.now ?? (() => Date.now());
  const states = new Map<string, RunnerState>();

  function readState(taskId: string): RunnerState {
    const state = states.get(taskId);
    if (!state) {
      throw new Error(`Unknown system task: ${taskId}`);
    }
    return state;
  }

  function appendEvent(taskId: string, input: InteractiveSystemTaskEventInput): void {
    const state = readState(taskId);
    state.events.push({
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId,
      tsMs: now(),
      type: input.type,
      ...(input.stepId ? { stepId: input.stepId } : {}),
      ...(input.message ? { message: input.message } : {}),
      ...(typeof input.data !== 'undefined' ? { data: redactSensitiveSystemTaskJsonValue(input.data) as never } : {}),
    });
  }

  return {
    async start(startParams) {
      const kind = params.kinds[startParams.kind];
      if (!kind) {
        throw new Error(`Unsupported system task kind: ${startParams.kind}`);
      }

      states.set(startParams.taskId, {
        events: [],
        result: null,
        pendingPrompt: null,
        resolvePrompt: null,
      });

      void kind.run({
        params: startParams.params,
        emit: (event) => {
          appendEvent(startParams.taskId, event);
        },
        prompt: async (prompt) => {
          const state = readState(startParams.taskId);
          state.pendingPrompt = {
            kind: prompt.kind,
            data: redactSensitiveSystemTaskJsonValue(prompt.data),
          };
          appendEvent(startParams.taskId, {
            type: 'prompt',
            ...(prompt.stepId ? { stepId: prompt.stepId } : {}),
            message: prompt.message,
            data: buildPromptEventData(prompt),
          });
          return await new Promise((resolve) => {
            state.resolvePrompt = (answer) => {
              state.pendingPrompt = null;
              state.resolvePrompt = null;
              resolve(answer);
            };
          });
        },
      }).then(
        (data) => {
          const state = readState(startParams.taskId);
          state.result = {
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            taskId: startParams.taskId,
            ok: true,
            ...(typeof data !== 'undefined' ? { data: data as never } : {}),
          };
        },
        (error) => {
          const state = readState(startParams.taskId);
          state.result = {
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            taskId: startParams.taskId,
            ok: false,
            error: {
              code: error instanceof SystemTaskExecutionError
                ? error.code
                : 'system_task_failed',
              message: error instanceof Error ? error.message : 'System task failed',
            },
          };
        },
      );

      return {
        taskId: startParams.taskId,
      };
    },

    async poll(pollParams) {
      const state = readState(pollParams.taskId);
      const cursor = Math.max(0, Math.floor(pollParams.cursor));
      return {
        events: state.events.slice(cursor),
        nextCursor: state.events.length,
        result: state.result,
        pendingPrompt: state.pendingPrompt,
      };
    },

    async respond(respondParams) {
      const state = readState(respondParams.taskId);
      if (!state.resolvePrompt) {
        throw new Error(`System task ${respondParams.taskId} is not waiting for a prompt response`);
      }
      state.resolvePrompt(respondParams.answer);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

export function buildPromptEventData(prompt: InteractiveSystemTaskPromptRequest): SystemTaskJsonValue {
  const redactedData = redactSensitiveSystemTaskJsonValue(prompt.data);
  if (prompt.data && typeof prompt.data === 'object' && !Array.isArray(prompt.data)) {
    return {
      kind: prompt.kind,
      ...(redactedData as SystemTaskJsonObject),
    };
  }

  return {
    kind: prompt.kind,
    value: redactedData,
  };
}

export function redactSensitiveSystemTaskJsonValue(value: unknown): SystemTaskJsonValue {
  if (value === null) {
    return value;
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'object':
      if (Array.isArray(value)) {
        return value.map((entry) => redactSensitiveSystemTaskJsonValue(entry));
      }

      return Object.fromEntries(
        Object.entries(value as SystemTaskJsonObject)
          .filter(([key]) => !isSensitivePromptDataKey(key))
          .map(([key, entry]) => [key, redactSensitiveSystemTaskJsonValue(entry)]),
      ) as SystemTaskJsonObject;
    default:
      return null;
  }
}

const SENSITIVE_PROMPT_DATA_KEY_PATTERNS = [
  /secret/i,
  /token/i,
  /password/i,
  /statefile/i,
  /privatekeypath/i,
  /identityfile/i,
  /^env$/i,
  /cookie/i,
];

function isSensitivePromptDataKey(key: string): boolean {
  const normalizedKey = String(key ?? '').trim();
  if (!normalizedKey) {
    return false;
  }
  return SENSITIVE_PROMPT_DATA_KEY_PATTERNS.some((pattern) => pattern.test(normalizedKey));
}
