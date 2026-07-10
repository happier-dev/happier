import { isAbsolute as isNativeAbsolute } from 'node:path';
import { isAbsolute as isWin32Absolute } from 'node:path/win32';

import type {
  CreateExecutionRunBackendParamsV1,
  ExecLaunchInputV1,
  ExecProcessHandleV1,
  ExecRunResultV1,
  ExecutionRunHostBackendV1,
  ExecutionRunHostMessageV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import { composeSessionIsolationEnvironment } from '@happier-dev/plugin-sdk/experimental/runtime/session';
import {
  createSingleShotExecutionRunHostBackend,
  REVIEW_SCM_SCOPE_INPUT_KEY,
} from '@happier-dev/plugin-sdk';
import { redactReviewCommentSensitiveText } from '@happier-dev/plugin-sdk/reviews';

import { readCodeRabbitReviewConfigFromEnv } from './config.js';
import { mapCodeRabbitReviewComments } from './comments.js';
import { buildCodeRabbitEnv } from './env.js';
import { buildCodeRabbitReviewJsonOutput, normalizeCodeRabbitPlainReviewOutput } from './plainOutput.js';
import {
  preflightCodeRabbitReviewScope,
  readCodeRabbitReviewScopeFacts,
  resolveCodeRabbitBaseRef,
} from './scopePreflight.js';
import { runWithCodeRabbitRateLimitRetries } from './rateLimitRetries.js';
import { normalizeCodeRabbitReviewStartInput } from './startInput.js';

type CodeRabbitStartContext = Readonly<{
  intentInput?: unknown;
}>;

type AttemptResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
}>;

function readStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readCwd(params: CreateExecutionRunBackendParamsV1): string {
  return String(params.cwd ?? params.directory ?? '.').trim() || '.';
}

function readEnv(params: CreateExecutionRunBackendParamsV1): Readonly<Record<string, string>> {
  return composeSessionIsolationEnvironment({
    isolationEnvironment: readStringRecord(params.isolation?.env),
    environment: readStringRecord(params.env),
    unsetEnvKeys: params.isolation?.unsetEnvKeys,
  });
}

function compactEnv(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function sanitizeCodeRabbitDiagnostic(
  value: string,
  env: Readonly<Record<string, string>>,
): string {
  const redactedValues = Object.entries(env)
    .filter(([key, raw]) => raw.trim() && /(^|_)(api_?key|secret|token|password|credential|auth)($|_)/i.test(key))
    .map(([, raw]) => raw);
  return redactReviewCommentSensitiveText(value, { redactedValues });
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolvePreferredCommandOverride(command: string): Readonly<{
  preferredPath: string | null;
  preferredCommand: string | null;
}> {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) {
    return { preferredPath: null, preferredCommand: null };
  }
  return isNativeAbsolute(trimmed) || isWin32Absolute(trimmed)
    ? { preferredPath: trimmed, preferredCommand: null }
    : { preferredPath: null, preferredCommand: trimmed };
}

function readStartContext(params: CreateExecutionRunBackendParamsV1): CodeRabbitStartContext | null {
  const start = readRecord((params as unknown as { start?: unknown }).start);
  if (!start) return null;
  return { intentInput: start.intentInput };
}

function createSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const finish = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function createModelOutputMessage(fullText: string): ExecutionRunHostMessageV1 {
  return { type: 'model-output', fullText } as unknown as ExecutionRunHostMessageV1;
}

function logCommentPersistenceFailure(
  ctx: PluginContextV1,
  error: unknown,
  env: Readonly<Record<string, string>>,
): void {
  const message = error instanceof Error ? error.message : String(error);
  (ctx as Partial<Pick<PluginContextV1, 'logger'>>).logger?.warn('CodeRabbit review comment persistence failed', {
    error: sanitizeCodeRabbitDiagnostic(message, env),
  });
}

export function createCodeRabbitExecutionRunBackend(params: Readonly<{
  ctx: PluginContextV1;
  executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunHostBackendV1 {
  const cwd = readCwd(params.executionRunParams);
  const baseEnv = readEnv(params.executionRunParams);
  const config = readCodeRabbitReviewConfigFromEnv(baseEnv);
  const start = readStartContext(params.executionRunParams);

  async function buildLaunchRequest(prompt: string): Promise<Readonly<{
    args: readonly string[];
    normalizePlainOutput: boolean;
    projectId: string | null;
    workspaceId: string | null;
    sessionId: string | null;
  }>> {
    const reviewInput = normalizeCodeRabbitReviewStartInput({
      intentInput: start?.intentInput ?? {},
      fallbackInstructions: prompt,
    });
    const engineConfig = readRecord(reviewInput.engines?.coderabbit);
    const configFiles = Array.isArray(engineConfig?.configFiles) ? engineConfig.configFiles : [];
    const plain = engineConfig?.plain !== false;
    const promptOnly = engineConfig?.promptOnly === true;
    const scopeFacts = readCodeRabbitReviewScopeFacts(readRecord(start?.intentInput)?.[REVIEW_SCM_SCOPE_INPUT_KEY]);

    const preflight = await preflightCodeRabbitReviewScope({
      cwd,
      intentInput: start?.intentInput ?? {},
      scope: scopeFacts,
      maxEligibleFiles: config.maxEligibleFiles,
    });
    if (!preflight.ok) {
      throw new Error(preflight.error);
    }

    const args = ['review', '--no-color', '--cwd', cwd, '--type', reviewInput.changeType];
    if (plain) args.push('--plain');
    if (promptOnly) args.push('--prompt-only');

    const resolvedBaseRef = resolveCodeRabbitBaseRef({ reviewInput, scope: scopeFacts });
    if (reviewInput.base.kind === 'commit' && resolvedBaseRef) {
      args.push('--base-commit', resolvedBaseRef);
    } else if (resolvedBaseRef) {
      args.push('--base', resolvedBaseRef);
    }

    for (const configFile of configFiles) {
      const trimmed = String(configFile ?? '').trim();
      if (trimmed) args.push('--config', trimmed);
    }

    return {
      args,
      normalizePlainOutput: plain,
      projectId: readOptionalString(reviewInput.projectId),
      workspaceId: readOptionalString(reviewInput.workspaceId),
      sessionId: readOptionalString(reviewInput.sessionId),
    };
  }

  async function runOnce(params2: Readonly<{
    launch: ExecLaunchInputV1;
    processRef: { current: ExecProcessHandleV1 | null };
    signal: AbortSignal;
    isCancelled: () => boolean;
  }>): Promise<AttemptResult> {
    const processHandle = await params.ctx.agentRuntime.exec.spawn(params2.launch, {
      timeoutMs: config.timeoutMs ?? undefined,
      maxStdoutBytes: 1024 * 1024 * 8,
      maxStderrBytes: 1024 * 256,
      signal: params2.signal,
    });
    params2.processRef.current = processHandle;
    if (params2.isCancelled()) {
      processHandle.kill('SIGTERM');
    }
    try {
      const result: ExecRunResultV1 = await processHandle.exit;
      return {
        ok: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        signal: result.signal,
      };
    } finally {
      if (params2.processRef.current === processHandle) params2.processRef.current = null;
      await processHandle.dispose().catch(() => undefined);
    }
  }

  return createSingleShotExecutionRunHostBackend({
    backendId: 'coderabbit',
    sessionIdPrefix: 'coderabbit',
    signal: params.executionRunParams.signal,
    busyMessage: 'CodeRabbit backend is busy',
    resumeUnsupportedMessage: 'CodeRabbit execution runs do not support session resume',
    replayUnsupportedMessage: 'CodeRabbit execution runs do not support replay capture',
    run: async ({ prompt, sessionId, signal }) => {
      const preferredCommandOverride = resolvePreferredCommandOverride(config.command);

      const processRef: { current: ExecProcessHandleV1 | null } = { current: null };
      let cancelled = false;
      const abort = () => {
        cancelled = true;
        processRef.current?.kill('SIGTERM');
      };
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener('abort', abort, { once: true });
      }

      try {
        const launchRequest = await buildLaunchRequest(prompt);
        const toolGrant = await params.ctx.agentRuntime.exec.systemTools.resolve({
          toolId: 'coderabbit',
          purpose: 'run CodeRabbit review',
          cwd,
          preferredPath: preferredCommandOverride.preferredPath,
          preferredCommand: preferredCommandOverride.preferredCommand,
          signal,
        });
        const env = buildCodeRabbitEnv({ baseEnv, homeDir: config.homeDir });
        const launchEnv = compactEnv({ ...(toolGrant.launch.env ?? {}), ...env });
        const launch: ExecLaunchInputV1 = {
          ...toolGrant.launch,
          cwd,
          args: [...(toolGrant.launch.args ?? []), ...launchRequest.args],
          env: launchEnv,
        };
        const result = await runWithCodeRabbitRateLimitRetries({
          maxAttempts: config.rateLimitMaxAttempts,
          maxTotalRetrySleepMs: config.timeoutMs,
          runOnce: async () => cancelled
            ? { ok: false, stdout: '', stderr: 'cancelled', exitCode: null, signal: 'SIGTERM' }
            : await runOnce({ launch, processRef, signal, isCancelled: () => cancelled }),
          sleepMs: async (ms) => {
            if (!cancelled) await createSleep(ms, signal);
          },
        });
        if (!result.ok) {
          const stderr = sanitizeCodeRabbitDiagnostic(result.stderr.trim(), launchEnv);
          throw new Error(cancelled
            ? 'CodeRabbit review cancelled'
            : `CodeRabbit exited with code ${result.exitCode ?? 'null'}${stderr ? `: ${stderr}` : ''}`);
        }
        if (launchRequest.normalizePlainOutput && launchRequest.projectId) {
          const comments = (params.ctx as Partial<Pick<PluginContextV1, 'reviews'>>).reviews?.comments;
          if (typeof comments?.create === 'function' && typeof comments.resolveSnapshot === 'function') {
            try {
              await mapCodeRabbitReviewComments({
                projectId: launchRequest.projectId,
                ...(launchRequest.workspaceId ? { workspaceId: launchRequest.workspaceId } : {}),
                ...(launchRequest.sessionId ? { sessionId: launchRequest.sessionId } : {}),
                runId: params.executionRunParams.runId ?? sessionId,
                findings: normalizeCodeRabbitPlainReviewOutput(result.stdout),
                comments,
                cwd,
              });
            } catch (error) {
              logCommentPersistenceFailure(params.ctx, error, launchEnv);
            }
          }
        }
        return {
          messages: [createModelOutputMessage(
            launchRequest.normalizePlainOutput
              ? buildCodeRabbitReviewJsonOutput(result.stdout)
              : result.stdout,
          )],
        };
      } finally {
        signal.removeEventListener('abort', abort);
        processRef.current = null;
      }
    },
  });
}
