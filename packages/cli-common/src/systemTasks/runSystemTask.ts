import {
  SYSTEM_TASK_PROTOCOL_VERSION,
  SystemTaskEventSchema,
  SystemTaskJsonValueSchema,
  SystemTaskResultSchema,
  SystemTaskSpecSchema,
  type SystemTaskEvent,
  type SystemTaskResult,
} from '@happier-dev/protocol';

import { redactSensitiveSystemTaskJsonValue } from './interactiveTaskKinds.js';

export class SystemTaskExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SystemTaskExecutionError';
    this.code = code;
  }
}

export type SystemTaskExecutionRunner = (params: unknown, context: Readonly<{
  taskId: string;
  signal: AbortSignal;
  now: () => number;
}>) => AsyncGenerator<unknown, unknown, void>;

export type SystemTaskRegistryEntry = Readonly<{
  kind: string;
  handler: SystemTaskExecutionRunner;
}>;

export type SystemTaskRegistry = ReadonlyMap<string, SystemTaskExecutionRunner>;

export function createSystemTaskRegistry(entries: ReadonlyArray<SystemTaskRegistryEntry>): SystemTaskRegistry {
  const registry = new Map<string, SystemTaskExecutionRunner>();
  for (const entry of entries) {
    const kind = String(entry.kind ?? '').trim();
    if (!kind) {
      throw new Error('System task registry entries require a non-empty kind.');
    }
    if (registry.has(kind)) {
      throw new Error(`Duplicate system task kind: ${kind}`);
    }
    registry.set(kind, entry.handler);
  }
  return registry;
}

export async function executeSystemTask({
  spec,
  taskId,
  registry,
  signal = undefined,
  now = Date.now,
  emitEvent,
}: Readonly<{
  spec: unknown;
  taskId: string;
  registry: SystemTaskRegistry;
  signal?: AbortSignal;
  now?: () => number;
  emitEvent?: (event: SystemTaskEvent) => void;
}>): Promise<SystemTaskResult> {
  const effectiveSignal = signal ?? new AbortController().signal;
  const parsedSpec = SystemTaskSpecSchema.safeParse(spec);
  if (!parsedSpec.success) {
    return buildFailureResult(taskId, 'invalid_spec', 'Invalid system task spec.');
  }

  const handler = registry.get(parsedSpec.data.kind);
  if (!handler) {
    return buildFailureResult(taskId, 'unknown_kind', 'Unknown system task kind.');
  }

  const iterator = handler(parsedSpec.data.params, {
    taskId,
    signal: effectiveSignal,
    now,
  });

  try {
    while (true) {
      if (effectiveSignal.aborted) {
        await closeIterator(iterator);
        return buildFailureResult(taskId, 'cancelled', 'System task execution was cancelled.');
      }

      const next = await iterator.next();
      if (next.done) {
        if (effectiveSignal.aborted) {
          return buildFailureResult(taskId, 'cancelled', 'System task execution was cancelled.');
        }
        return buildSuccessResult(taskId, next.value);
      }

      const event = buildEvent({
        taskId,
        tsMs: now(),
        rawEvent: next.value,
      });
      if (!event.ok) {
        await closeIterator(iterator);
        return buildFailureResult(taskId, 'invalid_event', event.message);
      }

      emitEvent?.(event.value);
    }
  } catch (error) {
    await closeIterator(iterator);
    if (effectiveSignal.aborted || isAbortLikeError(error)) {
      return buildFailureResult(taskId, 'cancelled', 'System task execution was cancelled.');
    }
    if (error instanceof SystemTaskExecutionError) {
      return buildFailureResult(taskId, error.code, error.message);
    }
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'System task execution failed.';
    return buildFailureResult(taskId, 'execution_failed', message);
  }
}

async function closeIterator(iterator: AsyncGenerator<unknown, unknown, void>): Promise<void> {
  if (typeof iterator.return !== 'function') return;
  try {
    await iterator.return(undefined);
  } catch {
    // Best-effort cleanup only.
  }
}

function buildEvent({
  taskId,
  tsMs,
  rawEvent,
}: Readonly<{
  taskId: string;
  tsMs: number;
  rawEvent: unknown;
}>): Readonly<
  | { ok: true; value: SystemTaskEvent }
  | { ok: false; message: string }
> {
  if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
    return { ok: false, message: 'System task handlers must yield event objects.' };
  }

  const candidate: Record<string, unknown> = {
    ...rawEvent,
    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
    taskId,
    tsMs,
  };
  if (Object.prototype.hasOwnProperty.call(candidate, 'data') && typeof candidate.data !== 'undefined') {
    const parsedData = SystemTaskJsonValueSchema.safeParse(candidate.data);
    if (parsedData.success) {
      candidate.data = redactSensitiveSystemTaskJsonValue(parsedData.data);
    }
  }

  const parsed = SystemTaskEventSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, message: 'System task handler emitted an invalid event payload.' };
  }
  return { ok: true, value: parsed.data };
}

function buildSuccessResult(taskId: string, data: unknown): SystemTaskResult {
  const parsed = SystemTaskResultSchema.safeParse({
    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
    taskId,
    ok: true,
    ...(data === undefined ? {} : { data }),
  });
  if (!parsed.success) {
    return buildFailureResult(taskId, 'invalid_result', 'System task handler returned an invalid result payload.');
  }
  return parsed.data;
}

function buildFailureResult(taskId: string, code: string, message: string): SystemTaskResult {
  const parsed = SystemTaskResultSchema.parse({
    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
    taskId,
    ok: false,
    error: {
      code,
      message,
    },
  });
  return parsed;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String(error.name ?? '') : '';
  return name === 'AbortError';
}
