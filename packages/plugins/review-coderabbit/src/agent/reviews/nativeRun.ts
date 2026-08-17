import type {
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentExecutionRunRuntimeFactory,
  AgentRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import {
  REVIEW_SCM_SCOPE_INPUT_KEY,
  redactReviewCommentSensitiveText,
} from '@happier-dev/plugin-sdk/reviews';

import { readCodeRabbitReviewConfigFromEnv } from './config.js';
import { buildCodeRabbitReviewJsonOutput } from './plainOutput.js';
import {
  preflightCodeRabbitReviewScope,
  readCodeRabbitReviewScopeFacts,
  resolveCodeRabbitBaseRef,
} from './scopePreflight.js';
import { runWithCodeRabbitRateLimitRetries } from './rateLimitRetries.js';
import { normalizeCodeRabbitReviewStartInput } from './startInput.js';
import { CODERABBIT_SYSTEM_TOOL_ID } from './systemTool.js';

type AttemptResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}>;

type EventInput = AgentExecutionRunEvent extends infer Event
  ? Event extends AgentExecutionRunEvent
    ? Omit<Event, 'sequence' | 'runId' | 'emittedAtMs'>
    : never
  : never;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readCodeRabbitConfig(
  request: AgentExecutionRunOpenRequest,
): ReturnType<typeof readCodeRabbitReviewConfigFromEnv> {
  const launchEnvironment = request.launchEnvironment;
  if (!launchEnvironment) return readCodeRabbitReviewConfigFromEnv({});
  const unsetNames = new Set(launchEnvironment.unset.map((name) => name.toUpperCase()));
  const values = Object.fromEntries(
    Object.entries(launchEnvironment.values).filter(([name]) => !unsetNames.has(name.toUpperCase())),
  );
  return readCodeRabbitReviewConfigFromEnv(values);
}

function createSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
  });
}

function toAttemptResult(result: PluginProcessResult): AttemptResult {
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  const observed = result.termination.observed;
  if (observed.kind === 'exit') {
    return { ok: observed.exitCode === 0, stdout, stderr, exitCode: observed.exitCode, signal: null };
  }
  if (observed.kind === 'signal') {
    return { ok: false, stdout, stderr, exitCode: null, signal: observed.signal };
  }
  return {
    ok: false,
    stdout,
    stderr: stderr || observed.diagnostic.message || observed.diagnostic.code,
    exitCode: null,
    signal: null,
  };
}

function createRuntime(
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>,
  context: AgentRuntimeContext,
): AgentExecutionRunRuntime {
  const abortController = new AbortController();
  const signal = AbortSignal.any([context.signal, abortController.signal]);
  const listeners = new Set<(event: AgentExecutionRunEvent) => void>();
  const history: AgentExecutionRunEvent[] = [];
  let sequence = 0;
  let terminal = false;
  let disposed = false;

  function emit(event: EventInput): void {
    if (terminal) return;
    const published = Object.freeze({
      ...event,
      sequence: ++sequence,
      runId: request.runId,
      emittedAtMs: Date.now(),
    }) as AgentExecutionRunEvent;
    history.push(published);
    for (const listener of listeners) listener(published);
    terminal = event.kind === 'run-complete' || event.kind === 'run-failed' || event.kind === 'run-cancelled';
  }

  async function execute(): Promise<void> {
    emit({ kind: 'run-start' });
    try {
      if (context.services.availability('exec').status !== 'available') {
        throw new Error('CodeRabbit execution requires the host process service');
      }
      const config = readCodeRabbitConfig(request);
      const reviewInput = normalizeCodeRabbitReviewStartInput({
        intentInput: request.input.structuredInput ?? {},
        fallbackInstructions: request.input.text,
      });
      const engineConfig = readRecord(reviewInput.engines?.coderabbit);
      const configFiles = Array.isArray(engineConfig?.configFiles) ? engineConfig.configFiles : [];
      const plain = engineConfig?.plain !== false;
      const promptOnly = engineConfig?.promptOnly === true;
      const scopeFacts = readCodeRabbitReviewScopeFacts(
        readRecord(request.input.structuredInput)?.[REVIEW_SCM_SCOPE_INPUT_KEY],
      );
      const preflight = await preflightCodeRabbitReviewScope({
        cwd: request.cwd,
        intentInput: request.input.structuredInput ?? {},
        scope: scopeFacts,
        maxEligibleFiles: config.maxEligibleFiles,
      });
      if (!preflight.ok) throw new Error(preflight.error);

      const args = ['review', '--no-color', '--cwd', request.cwd, '--type', reviewInput.changeType];
      if (plain) args.push('--plain');
      if (promptOnly) args.push('--prompt-only');
      const resolvedBaseRef = resolveCodeRabbitBaseRef({ reviewInput, scope: scopeFacts });
      if (reviewInput.base.kind === 'commit' && resolvedBaseRef) args.push('--base-commit', resolvedBaseRef);
      else if (resolvedBaseRef) args.push('--base', resolvedBaseRef);
      for (const configFile of configFiles) {
        const trimmed = String(configFile ?? '').trim();
        if (trimmed) args.push('--config', trimmed);
      }

      const result = await runWithCodeRabbitRateLimitRetries({
        maxAttempts: config.rateLimitMaxAttempts,
        maxTotalRetrySleepMs: config.timeoutMs,
        runOnce: async () => {
          if (signal.aborted) {
            return { ok: false, stdout: '', stderr: 'cancelled', exitCode: null, signal: 'SIGTERM' };
          }
          return toAttemptResult(await context.services.exec.run({
            executable: { kind: 'systemTool', id: CODERABBIT_SYSTEM_TOOL_ID },
            args,
            cwd: { root: 'workspace', relativePath: '' },
            ...(config.timeoutMs === null ? {} : { timeoutMs: config.timeoutMs }),
            maxStdoutBytes: 1024 * 1024 * 8,
            maxStderrBytes: 1024 * 256,
          }, { signal }));
        },
        sleepMs: async (ms) => await createSleep(ms, signal),
      });
      if (signal.aborted) {
        emit({ kind: 'run-cancelled' });
        return;
      }
      if (!result.ok) {
        const stderr = redactReviewCommentSensitiveText(result.stderr.trim());
        throw new Error(`CodeRabbit exited with code ${result.exitCode ?? 'null'}${stderr ? `: ${stderr}` : ''}`);
      }
      const output = plain
        ? buildCodeRabbitReviewJsonOutput(result.stdout)
        : result.stdout;
      emit({ kind: 'output-delta', channel: 'assistant', text: output });
      emit({ kind: 'run-complete' });
    } catch (error) {
      if (signal.aborted) {
        emit({ kind: 'run-cancelled' });
        return;
      }
      emit({
        kind: 'run-failed',
        diagnostic: {
          code: 'coderabbit_execution_failed',
          severity: 'error',
          message: error instanceof Error ? error.message : 'CodeRabbit execution failed',
        },
      });
    }
  }

  const execution = execute();
  void execution.catch(() => undefined);
  return Object.freeze({
    async send() {
      return {
        status: 'unsupported' as const,
        diagnostic: {
          code: 'coderabbit_follow_up_unsupported',
          severity: 'error' as const,
          message: 'CodeRabbit execution runs are single-shot',
        },
      };
    },
    async stop() {
      if (terminal) return { status: 'notRunning' as const };
      abortController.abort(new Error('CodeRabbit execution run stopped'));
      return { status: 'requested' as const };
    },
    watch(listener: (event: AgentExecutionRunEvent) => void) {
      for (const event of history) listener(event);
      if (!terminal) listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      abortController.abort(new Error('CodeRabbit execution run disposed'));
      listeners.clear();
      await execution;
    },
  });
}

export function createCodeRabbitExecutionRunFactory(): AgentExecutionRunRuntimeFactory {
  const factory: AgentExecutionRunRuntimeFactory = {
    open(request: AgentExecutionRunOpenRequest, context: AgentRuntimeContext) {
      if (request.kind !== 'create') {
        throw new Error('CodeRabbit execution runs support create only');
      }
      return createRuntime(request, context);
    },
  };
  return Object.freeze(factory);
}
