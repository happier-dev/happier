import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { AsyncTtlCache } from '@happier-dev/protocol';

import { isClaudeCliJavaScriptFile } from '@/backends/claude/utils/resolveClaudeCliPath';
import { requireJavaScriptRuntimeExecutable } from '@/runtime/js/requireJavaScriptRuntimeExecutable';
import {
  requireProviderCliLaunchSpec,
  resolveProviderCliLaunchSpec,
} from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { isBun } from '@/utils/runtime';

const ULTRACODE_PROBE_SENTINEL = 'happier-ultracode-probe-invalid';
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;
/**
 * Backstop only: the binary fingerprint in the cache key is what actually invalidates this answer,
 * and a timed-out probe is never cached at all (it is not `conclusive`). The TTL exists for what the
 * fingerprint cannot see — a replacement that lands on the same size and mtime, or a launcher whose
 * accepted flags depend on state outside the file — and keeps a long-lived daemon from holding one
 * answer forever.
 */
const INSTALLED_RUNTIME_CAPABILITIES_TTL_MS = 12 * 60 * 60 * 1_000;

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

type InstalledRuntimeCapabilitiesProbeOutcome = Readonly<{
  capabilities: ClaudeInstalledRuntimeCapabilities;
  /**
   * Every probe that contributed to the answer produced installed-parser output, so the result is
   * evidence about the binary rather than a fail-closed answer from a spawn that could not run.
   * Only a conclusive outcome may be cached: caching a failure would let one bad `cwd`, a mid-install
   * window, or one timeout pin `supportsEffort: false` onto a runtime that does support it.
   */
  conclusive: boolean;
}>;

/**
 * Resolve the controls recognized by the installed Claude Code parser.
 *
 * `--help` proves generic effort support. Ultracode is deliberately checked as a candidate against
 * an invalid sentinel: current Claude exits successfully for both, but warns only for values the
 * parser does not recognize. This is installed-runtime evidence; model xhigh support remains a
 * separate catalog prerequisite at the option/launch resolver.
 */
async function runInstalledRuntimeCapabilitiesProbe(
  params: Readonly<{ cwd: string; timeoutMs: number }>,
  probe: ProbeClaudeCli,
): Promise<InstalledRuntimeCapabilitiesProbeOutcome> {
  const runProbeFailClosed = (args: readonly string[]) => probe({ args, ...params }).catch(() => null);
  const helpText = await runProbeFailClosed(['--help']);
  const supportsEffort = typeof helpText === 'string' && /\B--effort\b/i.test(helpText);
  if (!supportsEffort) {
    return {
      capabilities: { supportsEffort: false, supportsUltracode: false },
      conclusive: typeof helpText === 'string',
    };
  }

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
    capabilities: {
      supportsEffort: true,
      supportsUltracode: sentinelIsRejected && !ultracodeIsRejected,
    },
    conclusive: typeof ultracodeOutput === 'string' && typeof sentinelOutput === 'string',
  };
}

/**
 * Per-process cache of the installed-runtime answer, keyed by binary fingerprint.
 *
 * `errorTtlMs: 0` is not a tuning choice: this cache only ever stores conclusive outcomes, so
 * `setError` is deliberately never called. Caching a fail-closed answer would let one mid-install
 * window or one timed-out spawn pin `supportsEffort: false` onto a runtime that does support it.
 */
const installedRuntimeCapabilitiesCache = new AsyncTtlCache<ClaudeInstalledRuntimeCapabilities>({
  successTtlMs: INSTALLED_RUNTIME_CAPABILITIES_TTL_MS,
  errorTtlMs: 0,
});

export function resetClaudeInstalledRuntimeCapabilitiesCacheForTests(): void {
  installedRuntimeCapabilitiesCache.clear();
}

/**
 * Identity of the Claude binary this process would probe, or `null` when it cannot be fingerprinted.
 *
 * The probed fact — which flags and `--effort` values the installed parser recognizes — belongs to
 * the binary, not to the session `cwd`, so `cwd` is deliberately absent from the key: preflighting
 * a different worktree or connected account against the same daemon must not re-pay three process
 * spawns for an answer that cannot have changed. Size and mtime cover an in-place upgrade of the
 * same path (`claude update`, an npm reinstall, a managed-tool swap), which a path-only key would
 * miss for the whole TTL.
 */
export function resolveInstalledClaudeCliIdentity(): string | null {
  const launch = resolveProviderCliLaunchSpec('claude');
  if (!launch) return null;
  try {
    const stats = statSync(launch.resolvedPath);
    // JSON keeps the fields unambiguous: a path may contain any separator character.
    return JSON.stringify([
      launch.source,
      launch.command,
      ...launch.args,
      launch.resolvedPath,
      stats.size,
      stats.mtimeMs,
    ]);
  } catch {
    // No readable binary is an absence of identity, not an identity of its own. Probe uncached
    // rather than caching under a key that cannot notice the binary changing underneath it.
    return null;
  }
}

/**
 * Installed-runtime capabilities for the Claude binary this process would launch.
 *
 * Cached and de-duplicated per binary fingerprint **within one process**: three `claude --help`
 * spawns are far more expensive than the answer is volatile. The concurrent callers this actually
 * coalesces are the daemon's new-session preflight probes — `claudePreflightModelsProbeAdapter`
 * declares `modelProbeCachePolicy: 'provider-owned'`, so `agentModelsProbe` deliberately skips its
 * own cache and de-dupe and leaves both to this owner. A spawned session process is a separate
 * process with its own empty module state, so nothing here can be shared with it: `runClaude`
 * resolves this once per session process and hands the value to the `sessionModelsV1` publisher, so
 * neither the cache nor the de-dupe has a second reader there.
 */
export async function probeClaudeInstalledRuntimeCapabilities(
  params: Readonly<{ cwd: string; timeoutMs: number }>,
  probe: ProbeClaudeCli = probeClaudeCli,
  options: Readonly<{
    resolveInstalledCliIdentity?: () => string | null;
    nowMs?: () => number;
  }> = {},
): Promise<ClaudeInstalledRuntimeCapabilities> {
  const identity = (options.resolveInstalledCliIdentity ?? resolveInstalledClaudeCliIdentity)();
  if (identity === null) return (await runInstalledRuntimeCapabilitiesProbe(params, probe)).capabilities;

  const nowMs = options.nowMs ?? Date.now;
  const cached = installedRuntimeCapabilitiesCache.get(identity);
  if (cached?.kind === 'success' && installedRuntimeCapabilitiesCache.isFresh(cached, nowMs())) return cached.value;

  return await installedRuntimeCapabilitiesCache.runDedupe(identity, async () => {
    const settled = installedRuntimeCapabilitiesCache.get(identity);
    if (settled?.kind === 'success' && installedRuntimeCapabilitiesCache.isFresh(settled, nowMs())) return settled.value;

    const outcome = await runInstalledRuntimeCapabilitiesProbe(params, probe);
    if (outcome.conclusive) {
      installedRuntimeCapabilitiesCache.setSuccess(identity, outcome.capabilities, { nowMs: nowMs() });
    }
    return outcome.capabilities;
  });
}
