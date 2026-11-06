import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { AsyncTtlCache } from '@happier-dev/protocol';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { remainingCatalogProbeMs, withCatalogProbeLifecycle, type CatalogProbeLifecycle, type NativeCatalogCleanup, type RegisterNativeCatalogCleanup } from '@/capabilities/probes/catalogProbeLifecycle';
import { isClaudeCliJavaScriptFile } from '@/backends/claude/utils/resolveClaudeCliPath';
import { requireJavaScriptRuntimeExecutable } from '@/runtime/js/requireJavaScriptRuntimeExecutable';
import {
  requireProviderCliLaunchSpec,
  resolveProviderCliLaunchSpec,
} from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { isBun } from '@/utils/runtime';
import { logger } from '@/ui/logger';

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

type RuntimeProbeParams = CatalogProbeLifecycle & Readonly<{
  cwd: string;
  processEnv?: NodeJS.ProcessEnv;
  onNativeCleanup?: RegisterNativeCatalogCleanup;
}>;

type ProbeClaudeCli = (params: RuntimeProbeParams & Readonly<{
  args: readonly string[];
}>) => Promise<string | null>;

function reportsUnknownEffortValue(output: string, value: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes('unknown --effort value') && normalized.includes(value.toLowerCase());
}

/**
 * Run one installed-parser command within its caller's lifecycle and output bound.
 * Completion closes both output readers and awaits native cleanup before returning parser text.
 */
async function probeClaudeCli(params: RuntimeProbeParams & Readonly<{
  args: readonly string[];
}>): Promise<string | null> {
  const processEnv = params.processEnv ?? process.env;
  let child: ReturnType<typeof spawn> | undefined;
  let childClosed: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    try {
      if (child) await killProcessTree(child);
    } finally {
      // An exited root may leave descendants holding either inherited pipe. Its PID is no
      // longer ours to signal; close our readers so cleanup still observes child close.
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      await childClosed;
    }
  })();

  return await withCatalogProbeLifecycle(params, async (lifecycle) => {
    let command: string;
    let args: string[];
    let windowsVerbatimArguments: boolean | undefined;
    try {
      const launch = requireProviderCliLaunchSpec('claude', { processEnv });
      const launchArgs = [...launch.args, ...params.args];
      if (isClaudeCliJavaScriptFile(launch.resolvedPath)) {
        const runtimeExecutable = await requireJavaScriptRuntimeExecutable({
          isBunRuntime: isBun(),
          processEnv,
          targetLabel: 'Claude Code capability probe',
        });
        const invocation = resolveWindowsCommandInvocation({
          command: runtimeExecutable,
          args: [launch.resolvedPath, ...params.args],
          env: processEnv,
        });
        command = invocation.command;
        args = [...invocation.args];
        windowsVerbatimArguments = invocation.windowsVerbatimArguments ? true : undefined;
      } else {
        const invocation = resolveWindowsCommandInvocation({ command: launch.command, args: launchArgs, env: processEnv });
        command = invocation.command;
        args = [...invocation.args];
        windowsVerbatimArguments = invocation.windowsVerbatimArguments ? true : undefined;
      }
    } catch {
      return null;
    }
    remainingCatalogProbeMs(lifecycle);

    return await new Promise<string | null>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let settled = false;
      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const started = spawn(command, args, {
        cwd: params.cwd,
        env: { ...processEnv, CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      child = started;
      childClosed = new Promise<void>((closed) => started.once('close', () => closed()));
      params.onNativeCleanup?.(cleanup);
      started.once('error', () => finish(null));
      const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
          settled = true;
          void cleanup().then(() => resolve(null), reject);
          return;
        }
        if (target === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };
      started.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
      started.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
      started.once('close', (code) => {
        if (code !== 0) return finish(null);
        finish(`${stderr}\n${stdout}`.trim() || null);
      });
    });
  }, cleanup);
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
  params: RuntimeProbeParams,
  probe: ProbeClaudeCli,
): Promise<InstalledRuntimeCapabilitiesProbeOutcome> {
  const runProbeFailClosed = (args: readonly string[]) => {
    params.signal?.throwIfAborted();
    return probe({ args, ...params }).catch(() => null);
  };
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
export function resolveInstalledClaudeCliIdentity(processEnv: NodeJS.ProcessEnv = process.env): string | null {
  const launch = resolveProviderCliLaunchSpec('claude', { processEnv });
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
 * Completed binary facts are cached **within one process**. Unsignalled callers also coalesce
 * their process work; caller-owned deadlines and cancellation keep independent operations.
 * `claudePreflightModelsProbeAdapter` declares `modelProbeCachePolicy: 'provider-owned'`, so
 * `agentModelsProbe` leaves cache and lifecycle decisions to this owner. A spawned session process is a separate
 * process with its own empty module state, so nothing here can be shared with it: `runClaude`
 * resolves this once per session process and hands the value to the `sessionModelsV1` publisher, so
 * neither the cache nor the de-dupe has a second reader there.
 */
export async function probeClaudeInstalledRuntimeCapabilities(
  params: RuntimeProbeParams,
  probe: ProbeClaudeCli = probeClaudeCli,
  options: Readonly<{
    resolveInstalledCliIdentity?: (processEnv?: NodeJS.ProcessEnv) => string | null;
    nowMs?: () => number;
  }> = {},
): Promise<ClaudeInstalledRuntimeCapabilities> {
  const callerOwnsLifecycle = params.deadlineAt !== undefined || params.signal !== undefined || params.onNativeCleanup !== undefined;
  if (callerOwnsLifecycle) remainingCatalogProbeMs(params);
  const identity = (options.resolveInstalledCliIdentity ?? resolveInstalledClaudeCliIdentity)(params.processEnv);
  const nowMs = options.nowMs ?? Date.now;

  const run = async (): Promise<ClaudeInstalledRuntimeCapabilities> => {
    if (identity !== null) {
      const cached = installedRuntimeCapabilitiesCache.get(identity);
      if (cached?.kind === 'success' && installedRuntimeCapabilitiesCache.isFresh(cached, nowMs())) return cached.value;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(params.signal?.reason);
    params.signal?.addEventListener('abort', onAbort, { once: true });
    if (params.signal?.aborted) onAbort();
    const cleanups = new Set<NativeCatalogCleanup>();
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => cleanupPromise ??= (async () => {
      controller.abort();
      // RPC retains one callback. Both parallel parser probes belong to this operation.
      const results = await Promise.allSettled([...cleanups].map((stop) => stop()));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') {
        if (callerOwnsLifecycle) throw failed.reason;
        // Session startup may proceed with controls withheld. Keep that fallback observable
        // without exposing native process errors, commands, environment, or output.
        logger.warnFile('[claude-runtime] Installed capability probe cleanup failed; using fail-closed controls');
      }
    })();
    params.onNativeCleanup?.(cleanup);
    const runAndCache = async (lifecycle: CatalogProbeLifecycle) => {
      const outcome = await runInstalledRuntimeCapabilitiesProbe({
        ...params,
        ...lifecycle,
        onNativeCleanup: (stop) => { cleanups.add(stop); },
      }, probe);
      if (callerOwnsLifecycle) remainingCatalogProbeMs(lifecycle);
      if (identity !== null && outcome.conclusive) {
        installedRuntimeCapabilitiesCache.setSuccess(identity, outcome.capabilities, { nowMs: nowMs() });
      }
      return outcome.capabilities;
    };
    try {
      if (callerOwnsLifecycle) {
        return await withCatalogProbeLifecycle({ ...params, signal: controller.signal }, runAndCache, cleanup);
      }
      // Standalone session probes retain their per-command timeout and fail-closed result.
      return await runAndCache({ timeoutMs: params.timeoutMs, signal: controller.signal });
    } finally {
      params.signal?.removeEventListener('abort', onAbort);
      await cleanup();
    }
  };

  // A caller-owned deadline or abort cannot govern another caller's process operation. Completed
  // binary facts remain shareable; only legacy unsignalled work shares an in-flight operation.
  return identity === null || callerOwnsLifecycle
    ? await run()
    : await installedRuntimeCapabilitiesCache.runDedupe(identity, run);
}
