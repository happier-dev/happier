import { readHomeAuthorityMismatchFailure } from '@happier-dev/protocol/ssh/commandFailure';
import { readKnownSystemTaskFailure } from './runSystemTask.js';
import { SYSTEM_TASK_PROTOCOL_VERSION } from '@happier-dev/protocol/system/tasks/spec';
import type { SystemTaskEvent, SystemTaskJsonObject, SystemTaskJsonValue, SystemTaskResult } from '@happier-dev/protocol';

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
  /** Host-only, current-question delivery. Neither the closure nor its result enters task observations. */
  deliver?: (request: unknown) => Promise<SystemTaskJsonValue>;
  /** Host-only authority check, including ordinary answers to this exact question. */
  validateResponse?: (authorization: unknown) => Promise<void>;
  /** Retain prompt custody after task cancellation only when the owning operation has crossed
   * an irreversible boundary and must finish converging to a stable result. */
  nonCancellable?: true;
}>;

export type InteractiveSystemTaskContext = Readonly<{
  /** Host admission identity; never taken from task input. */
  taskId?: string;
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
  deliverPrompt: InteractiveSystemTaskPromptRequest['deliver'] | null;
  validateResponse: InteractiveSystemTaskPromptRequest['validateResponse'] | null;
  resolvePrompt: ((answer: unknown) => void) | null;
  rejectPrompt: ((error: SystemTaskExecutionError) => void) | null;
  abortController: AbortController;
  settlement: Promise<void> | null;
};

export function createSystemTasksRunner(params: Readonly<{
  now?: () => number;
  kinds: InteractiveSystemTaskKindMap;
}>): Readonly<{
  start: (params: Readonly<{ taskId: string; kind: string; params: SystemTaskJsonValue }>) => Promise<Readonly<{ taskId: string }>>;
  /** Host-only prepared transport; public start still uses the fixed kind catalog. */
  startAdmitted: (params: Readonly<{ taskId: string; kind: string; params: SystemTaskJsonValue }>, kind: InteractiveSystemTaskKind) => Promise<Readonly<{ taskId: string }>>;
  wait: (params: Readonly<{ taskId: string }>) => Promise<SystemTaskResult>;
  poll: (params: Readonly<{ taskId: string; cursor: number }>) => Promise<Readonly<{
    events: SystemTaskEvent[];
    nextCursor: number;
    result: SystemTaskResult | null;
    pendingPrompt: PromptEnvelope | null;
  }>>;
  respond: (params: Readonly<{ taskId: string; answer: unknown; delivery?: unknown; responseAuthorization?: unknown; expectedPromptKind?: unknown; expectedPromptId?: unknown }>) => Promise<SystemTaskJsonValue | undefined>;
  cancel: (params: Readonly<{ taskId: string }>) => Promise<void>;
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

  async function startTask(startParams: Readonly<{ taskId: string; kind: string; params: SystemTaskJsonValue }>, kind: InteractiveSystemTaskKind) {
      states.set(startParams.taskId, {
        events: [],
        result: null,
        pendingPrompt: null,
        deliverPrompt: null,
        validateResponse: null,
        resolvePrompt: null,
        rejectPrompt: null,
        abortController: new AbortController(),
        settlement: null,
      });

      const state = readState(startParams.taskId);
      state.settlement = kind.run({
        taskId: startParams.taskId,
        params: startParams.params,
        signal: state.abortController.signal,
        emit: (event) => {
          appendEvent(startParams.taskId, event);
        },
        prompt: async (prompt) => {
          const state = readState(startParams.taskId);
          if (state.abortController.signal.aborted && prompt.nonCancellable !== true) {
            throw new SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
          }
          state.pendingPrompt = {
            kind: prompt.kind,
            data: redactSensitiveSystemTaskJsonValue(prompt.data),
          };
          state.deliverPrompt = prompt.deliver ?? null;
          state.validateResponse = prompt.validateResponse ?? null;
          appendEvent(startParams.taskId, {
            type: 'prompt',
            ...(prompt.stepId ? { stepId: prompt.stepId } : {}),
            message: prompt.message,
            data: buildPromptEventData(prompt),
          });
          return await new Promise((resolve, reject) => {
            state.resolvePrompt = (answer) => {
              state.pendingPrompt = null;
              state.deliverPrompt = null;
              state.validateResponse = null;
              state.resolvePrompt = null;
              state.rejectPrompt = null;
              resolve(answer);
            };
            state.rejectPrompt = prompt.nonCancellable === true
              ? null
              : (error) => {
                  state.pendingPrompt = null;
                  state.deliverPrompt = null;
                  state.validateResponse = null;
                  state.resolvePrompt = null;
                  state.rejectPrompt = null;
                  reject(error);
                };
            if (state.abortController.signal.aborted) {
              state.rejectPrompt?.(new SystemTaskExecutionError('cancelled', 'System task execution was cancelled.'));
            }
          });
        },
      }).then(
        (data) => {
          const state = readState(startParams.taskId);
          state.pendingPrompt = null;
          state.deliverPrompt = null;
          state.validateResponse = null;
          state.resolvePrompt = null;
          state.rejectPrompt = null;
          state.result = {
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            taskId: startParams.taskId,
            ok: true,
            ...(typeof data !== 'undefined' ? { data: data as never } : {}),
          };
        },
        (error) => {
          const state = readState(startParams.taskId);
          const authorityFailure = error && typeof error === 'object'
            ? readHomeAuthorityMismatchFailure(Reflect.get(error, 'code'), Reflect.get(error, 'message')) : null;
          const knownFailure = readKnownSystemTaskFailure(error);
          state.pendingPrompt = null;
          state.deliverPrompt = null;
          state.validateResponse = null;
          state.resolvePrompt = null;
          state.rejectPrompt = null;
          state.result = {
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            taskId: startParams.taskId,
            ok: false,
            error: {
              code: authorityFailure?.code ?? (knownFailure
                ? knownFailure.code
                : state.abortController.signal.aborted
                  ? 'cancelled'
                  : 'system_task_failed'),
              message: authorityFailure?.message ?? knownFailure?.message ?? (error instanceof Error ? error.message : 'System task failed'),
            },
          };
        },
      );

      return {
        taskId: startParams.taskId,
      };
  }

  return {
    async start(startParams) {
      const kind = params.kinds[startParams.kind];
      if (!kind) throw new Error(`Unsupported system task kind: ${startParams.kind}`);
      return await startTask(startParams, kind);
    },
    async startAdmitted(startParams, kind) {
      return await startTask(startParams, kind);
    },
    async wait({ taskId }) {
      const state = readState(taskId);
      await state.settlement;
      if (!state.result) throw new Error(`System task ${taskId} did not settle`);
      return state.result;
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
      // The transport is untyped; validate and compare at the task owner, atomically with acceptance.
      if (respondParams.expectedPromptKind !== undefined && typeof respondParams.expectedPromptKind !== 'string') {
        throw new SystemTaskExecutionError('invalid_params', 'Expected prompt kind must be a string.');
      }
      if (respondParams.expectedPromptId !== undefined && (typeof respondParams.expectedPromptId !== 'string' || !respondParams.expectedPromptId.trim())) {
        throw new SystemTaskExecutionError('invalid_params', 'Expected prompt id must be a nonempty string.');
      }
      if (respondParams.expectedPromptKind !== undefined && state.pendingPrompt?.kind !== respondParams.expectedPromptKind) {
        throw new SystemTaskExecutionError('no_prompt', 'The system task question has changed.');
      }
      if (respondParams.expectedPromptId !== undefined || state.pendingPrompt?.kind === 'administrator.establish') {
        const promptData = state.pendingPrompt?.data;
        const promptId = promptData && typeof promptData === 'object' && !Array.isArray(promptData) && 'promptId' in promptData ? promptData.promptId : undefined;
        if (typeof promptId !== 'string' || promptId !== respondParams.expectedPromptId) {
          throw new SystemTaskExecutionError('no_prompt', 'The system task question has changed.');
        }
      }
      if (Object.hasOwn(respondParams, 'delivery')) {
        const deliver = state.deliverPrompt;
        if (!deliver || !state.resolvePrompt || state.abortController.signal.aborted) {
          throw new SystemTaskExecutionError('no_prompt', 'The system task question has changed.');
        }
        const delivered = await deliver(respondParams.delivery);
        if (state.deliverPrompt !== deliver || state.abortController.signal.aborted) {
          throw new SystemTaskExecutionError('no_prompt', 'The system task question has changed.');
        }
        return delivered;
      }
      if (!state.resolvePrompt) {
        throw new Error(`System task ${respondParams.taskId} is not waiting for a prompt response`);
      }
      const resolvePrompt = state.resolvePrompt;
      if (state.validateResponse) {
        await state.validateResponse(respondParams.responseAuthorization);
        if (state.resolvePrompt !== resolvePrompt || state.abortController.signal.aborted) {
          throw new SystemTaskExecutionError('no_prompt', 'The system task question has changed.');
        }
      }
      state.resolvePrompt(respondParams.answer);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return undefined;
    },

    async cancel(cancelParams) {
      const state = readState(cancelParams.taskId);
      state.abortController.abort();
      state.rejectPrompt?.(new SystemTaskExecutionError('cancelled', 'System task execution was cancelled.'));
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

/**
 * A URL string with any `user:pass@` userinfo removed.
 *
 * Redaction below matches sensitive *key names*, but a URL carrying embedded credentials is the
 * same class of secret under an ordinary key (`relayUrl`, `webappUrl`, `targetServerUrl`), and
 * every producer of such a key would otherwise have to remember to strip it. Doing it here keeps
 * one owner for "what is safe to publish as task data". Identity is unaffected: comparable-key
 * derivation ignores userinfo, so a producer and its reader still resolve the same host.
 */
function stripUrlCredentials(value: string): string {
  if (!value.includes('@') || !value.includes('://')) {
    return value;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) {
      return value;
    }
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Unparseable here means unverifiable, so drop the whole userinfo segment rather than emit it.
    return value.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#]*@/, '$1');
  }
}

export function redactSensitiveSystemTaskJsonValue(value: unknown): SystemTaskJsonValue {
  if (value === null) {
    return value;
  }

  switch (typeof value) {
    case 'string':
      return stripUrlCredentials(value);
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
  /privatekey/i,
  /identityprivatekey/i,
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
