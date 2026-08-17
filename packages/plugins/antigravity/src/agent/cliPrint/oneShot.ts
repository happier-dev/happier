import { redactBugReportSensitiveText } from '@happier-dev/plugin-sdk';

import type { AntigravityStep } from '../normalize/index.js';
import { hasAntigravityStepOutputEvidence } from '../normalize/index.js';

const CLI_PRINT_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const CLI_PRINT_MAX_STDERR_BYTES = 1024 * 1024;
const CLI_PRINT_ERROR_PREVIEW_MAX_CHARS = 2_000;

export type AntigravityCliPrintExit = Readonly<{
  exitCode: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}>;

export type AntigravityCliPrintExecRunInput = Readonly<{
  kind: 'agent-cli';
  agentId: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
}>;

export type AntigravityCliPrintExecRunOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}>;

export type AntigravityCliPrintExecRun = (
  input: AntigravityCliPrintExecRunInput,
  options: AntigravityCliPrintExecRunOptions,
) => Promise<AntigravityCliPrintExit>;

export type AntigravityCliPrintOneShotResult = Readonly<{
  status: 'completed';
  stdout: string;
  stderr: string;
  transcriptSteps?: readonly AntigravityStep[];
}>;

export class AntigravityCliPrintOneShotError extends Error {
  readonly code: string;
  readonly exitCode?: number | null;
  readonly stderr?: string;

  constructor(input: Readonly<{ code: string; message: string; exitCode?: number | null; stderr?: string }>) {
    super(input.message);
    this.name = 'AntigravityCliPrintOneShotError';
    this.code = input.code;
    this.exitCode = input.exitCode;
    this.stderr = input.stderr;
  }
}

type AntigravityCliPrintOneShotBaseParams = Readonly<{
  args: readonly string[];
  cwd: string;
  prompt: string;
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  hasTranscriptEvidence?: () => Promise<boolean>;
  readTranscriptSteps?: () => Promise<readonly AntigravityStep[]>;
}>;

type AntigravityCliPrintExecRunOneShotParams = AntigravityCliPrintOneShotBaseParams & Readonly<{
  agentId: string;
  run: AntigravityCliPrintExecRun;
}>;

function readCliPrintStdoutError(stdout: string): string | null {
  const firstLine = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  const errorMatch = /^Error:\s*(.+)$/iu.exec(firstLine);
  if (!errorMatch) return null;
  return redactBugReportSensitiveText(errorMatch[1] ?? firstLine)
    .slice(0, CLI_PRINT_ERROR_PREVIEW_MAX_CHARS);
}

async function completeFromExit(
  params: AntigravityCliPrintOneShotBaseParams,
  exit: AntigravityCliPrintExit,
): Promise<AntigravityCliPrintOneShotResult> {
  const stdout = exit.stdout ?? '';
  const stderr = exit.stderr ?? '';
  if (exit.exitCode !== 0) {
    const stderrPreview = redactBugReportSensitiveText(String(stderr).trim())
      .slice(0, CLI_PRINT_ERROR_PREVIEW_MAX_CHARS);
    const exitMessage = `Antigravity CLI print exited with code ${exit.exitCode ?? 'unknown'}`;
    throw new AntigravityCliPrintOneShotError({
      code: 'antigravity_cliprint_exit_nonzero',
      message: stderrPreview
        ? `${exitMessage}: ${stderrPreview}`
        : `${exitMessage}.`,
      exitCode: exit.exitCode,
      stderr,
    });
  }
  const transcriptSteps = await params.readTranscriptSteps?.().catch(() => []) ?? [];
  const transcriptEvidence = hasAntigravityStepOutputEvidence(transcriptSteps)
    || ((await params.hasTranscriptEvidence?.().catch(() => false)) ?? false);
  const stdoutError = !transcriptEvidence ? readCliPrintStdoutError(stdout) : null;
  if (stdoutError) {
    throw new AntigravityCliPrintOneShotError({
      code: 'antigravity_cliprint_stdout_error',
      message: stdoutError,
    });
  }
  if (!stdout.trim() && !transcriptEvidence) {
    throw new AntigravityCliPrintOneShotError({
      code: 'antigravity_cliprint_no_output',
      message: 'Antigravity CLI print exited successfully without stdout or transcript evidence.',
    });
  }
  return {
    status: 'completed',
    stdout,
    stderr,
    ...(transcriptSteps.length > 0 ? { transcriptSteps } : {}),
  };
}

async function runWithHostExec(
  params: AntigravityCliPrintExecRunOneShotParams,
): Promise<AntigravityCliPrintOneShotResult> {
  const exit = await params.run({
    kind: 'agent-cli',
    agentId: params.agentId,
    args: params.args,
    cwd: params.cwd,
    ...(params.env ? { env: params.env } : {}),
  }, {
    ...(params.signal ? { signal: params.signal } : {}),
    timeoutMs: params.timeoutMs,
    maxStdoutBytes: CLI_PRINT_MAX_STDOUT_BYTES,
    maxStderrBytes: CLI_PRINT_MAX_STDERR_BYTES,
  });
  return completeFromExit(params, exit);
}

export async function runAntigravityCliPrintOneShot(
  params: AntigravityCliPrintExecRunOneShotParams,
): Promise<AntigravityCliPrintOneShotResult> {
  return runWithHostExec(params);
}
