import { spawn } from 'node:child_process';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { isClaudeCliJavaScriptFile } from '@/backends/claude/utils/resolveClaudeCliPath';
import { requireJavaScriptRuntimeExecutable } from '@/runtime/js/requireJavaScriptRuntimeExecutable';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { isBun } from '@/utils/runtime';

const ULTRACODE_PROBE_SENTINEL = 'happier-ultracode-probe-invalid';
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;

export type ClaudeInstalledRuntimeCapabilities = Readonly<{
  supportsEffort: boolean;
  supportsUltracode: boolean;
}>;

/** Installed-runtime half of Claude model-option admission; model capability is checked separately. */
export function isClaudeModelOptionSupportedByInstalledRuntime(
  optionId: string,
  capabilities: ClaudeInstalledRuntimeCapabilities,
): boolean {
  if (optionId === 'reasoning_effort') return capabilities.supportsEffort;
  if (optionId === 'ultracode') return capabilities.supportsUltracode;
  return true;
}

export function resolveClaudeInstalledRuntimeSessionOptions(
  requested: Readonly<{ reasoningEffort?: string; ultracode?: boolean }>,
  capabilities: ClaudeInstalledRuntimeCapabilities,
): Readonly<{ reasoningEffort?: string; ultracode?: boolean }> {
  return {
    ...(capabilities.supportsEffort
      ? { reasoningEffort: requested.reasoningEffort }
      : {}),
    ...(capabilities.supportsEffort && capabilities.supportsUltracode
      ? { ultracode: requested.ultracode }
      : {}),
  };
}

/** Apply installed-runtime admission at the final launch-mode assembly boundary. */
export function resolveClaudeInstalledRuntimeSessionMode<
  T extends Readonly<{ reasoningEffort?: string; ultracode?: boolean }>,
>(
  requested: T,
  capabilities: ClaudeInstalledRuntimeCapabilities,
): Omit<T, 'reasoningEffort' | 'ultracode'> & Readonly<{ reasoningEffort?: string; ultracode?: boolean }> {
  const { reasoningEffort, ultracode, ...mode } = requested;
  return {
    ...mode,
    ...resolveClaudeInstalledRuntimeSessionOptions({ reasoningEffort, ultracode }, capabilities),
  };
}

type ProbeClaudeCli = (params: Readonly<{
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}>) => Promise<string | null>;

function reportsUnknownEffortValue(output: string, value: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes('unknown --effort value') && normalized.includes(value.toLowerCase());
}

async function probeClaudeCli(params: Readonly<{
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}>): Promise<string | null> {
  const timeoutMs = Math.max(250, params.timeoutMs);

  let command: string;
  let args: string[];
  let windowsVerbatimArguments: boolean | undefined;

  try {
    const launch = requireProviderCliLaunchSpec('claude');
    const launchArgs = [...launch.args, ...params.args];
    if (isClaudeCliJavaScriptFile(launch.resolvedPath)) {
      const runtimeExecutable = await requireJavaScriptRuntimeExecutable({
        isBunRuntime: isBun(),
        targetLabel: 'Claude Code capability probe',
      });
      const invocation = resolveWindowsCommandInvocation({
        command: runtimeExecutable,
        args: [launch.resolvedPath, ...params.args],
        env: process.env,
      });
      command = invocation.command;
      args = [...invocation.args];
      windowsVerbatimArguments = invocation.windowsVerbatimArguments ? true : undefined;
    } else {
      const invocation = resolveWindowsCommandInvocation({
        command: launch.command,
        args: launchArgs,
        env: process.env,
      });
      command = invocation.command;
      args = [...invocation.args];
      windowsVerbatimArguments = invocation.windowsVerbatimArguments ? true : undefined;
    }
  } catch {
    return null;
  }

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(command, args, {
      cwd: params.cwd,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });

    const stopForFailure = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Best-effort process cleanup after a bounded capability probe.
      }
      finish(null);
    };

    const timer = setTimeout(stopForFailure, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
        clearTimeout(timer);
        stopForFailure();
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));

    child.on('close', (code) => {
      clearTimeout(timer);
      if (typeof code !== 'number' || code !== 0) return finish(null);
      const output = `${stderr}\n${stdout}`.trim();
      finish(output || null);
    });
  });
}

/**
 * Resolve the controls recognized by the installed Claude Code parser.
 *
 * `--help` proves generic effort support. Ultracode is deliberately checked as a candidate against
 * an invalid sentinel: current Claude exits successfully for both, but warns only for values the
 * parser does not recognize. This is installed-runtime evidence; model xhigh support remains a
 * separate catalog prerequisite at the option/launch resolver.
 */
export async function probeClaudeInstalledRuntimeCapabilities(
  params: Readonly<{ cwd: string; timeoutMs: number }>,
  probe: ProbeClaudeCli = probeClaudeCli,
): Promise<ClaudeInstalledRuntimeCapabilities> {
  const runProbeFailClosed = (args: readonly string[]) => probe({ args, ...params }).catch(() => null);
  const helpText = await runProbeFailClosed(['--help']);
  const supportsEffort = typeof helpText === 'string' && /\B--effort\b/i.test(helpText);
  if (!supportsEffort) return { supportsEffort: false, supportsUltracode: false };

  const [ultracodeOutput, sentinelOutput] = await Promise.all([
    runProbeFailClosed(['--effort', 'ultracode', '--help']),
    runProbeFailClosed(['--effort', ULTRACODE_PROBE_SENTINEL, '--help']),
  ]);
  const sentinelIsRejected = typeof sentinelOutput === 'string'
    && reportsUnknownEffortValue(sentinelOutput, ULTRACODE_PROBE_SENTINEL)
    && /valid values\s*:/i.test(sentinelOutput);
  const ultracodeIsRejected = typeof ultracodeOutput !== 'string'
    || reportsUnknownEffortValue(ultracodeOutput, 'ultracode');

  return {
    supportsEffort: true,
    supportsUltracode: sentinelIsRejected && !ultracodeIsRejected,
  };
}
