import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
  FirstPartyAcquisitionError,
  installVersionedPayload,
  readAcquisitionFailureCause,
  redactAcquisitionDiagnostic,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  readHappierCliChoiceSync,
  readInstalledVersionMarkersSync,
  resolveFirstPartyInstallLayout,
  resolveInstalledFirstPartyComponentPaths,
  resolveTerminalHappierCli,
  ManagedCliUpdateError,
  runManagedCliUpdate,
  type FirstPartyComponentId,
  type FirstPartyAcquisitionOptions,
  type ManagedCliUpdateRestart,
  type ManagedCliUpdateResult,
  type PreparedFirstPartyComponentPayload,
} from '../../firstPartyRuntime/index.js';
import { resolveWindowsCommandInvocation } from '../../process/index.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import { applyPublicReleaseRingScopeToEnv } from './releaseRingScopedEnv.js';

export const DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES = [
  'HAPPIER_BOOTSTRAP_CLI_PATH',
  'HAPPIER_BOOTSTRAP_HAPPIER_PATH',
] as const;

export type HappierTextResult = Readonly<{
  status: number;
  stdout: string;
  stderr: string;
}>;

export type RunHappierOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  /** `null` delegates the deadline to the invoked operation's lifecycle owner. */
  timeoutMs?: number | null;
  onStdoutChunk?: (text: string) => void;
  includeStdoutInError?: boolean;
  /** Ephemeral process input. Callers must keep credentials and durable secrets out. */
  input?: string;
}>;

export interface HappierJsonExecutor {
  runHappierText(args: readonly string[], opts?: RunHappierOptions): Promise<HappierTextResult>;
  runHappierJson(
    args: readonly string[],
    opts?: RunHappierOptions & Readonly<{ allowJsonFailure?: boolean }>,
  ): Promise<unknown>;
}

/** Transports supply process IO; CLI JSON success/failure stays transport-neutral. */
export function createHappierJsonExecutorFromTextRunner(runHappierText: HappierJsonExecutor['runHappierText']): HappierJsonExecutor {
  return {
    runHappierText,
    async runHappierJson(args, opts) {
      const result = await runHappierText(args, opts);
      const parsed = parseFirstJsonObject(result.stdout);
      if (result.status !== 0) {
        if (opts?.allowJsonFailure && parsed && typeof parsed === 'object') return parsed;
        throw new SystemTaskExecutionError('cli_command_failed', result.stderr.trim() || result.stdout.trim() || 'Command failed.');
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new SystemTaskExecutionError('invalid_cli_response', `Command did not return a JSON object: ${args.join(' ')}`);
      }
      if (!opts?.allowJsonFailure && isJsonFailureEnvelope(parsed)) {
        const envelope = parsed as { error?: unknown; message?: unknown };
        const error = envelope.error;
        const message = typeof envelope.message === 'string' && envelope.message.trim()
          ? envelope.message.trim()
          : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
            ? error.message.trim()
            : `Command failed: ${args.join(' ')}`;
        throw new SystemTaskExecutionError('cli_command_failed', message);
      }
      return parsed;
    },
  };
}

type CommandExecutionResult = Readonly<{
  status: number;
  stdout: string;
  stderr: string;
}>;

const MAX_HAPPIER_PROCESS_INPUT_BYTES = 64 * 1024;

function readLocalServiceAction(args: readonly string[]): string | null {
  const commandOffset = args[0] === '--server' ? 2 : args[0]?.startsWith('--server=') ? 1 : 0;
  const serviceOffset = commandOffset + (args[commandOffset] === 'daemon' ? 1 : 0);
  return args[serviceOffset] === 'service' ? args[serviceOffset + 1] ?? null : null;
}

/** Local service mutations own their OS-command, startup and recovery budgets in the CLI. */
export function resolveLocalHappierCommandTimeoutMs(args: readonly string[]): number | null | undefined {
  return ['install', 'start', 'stop', 'restart'].includes(readLocalServiceAction(args) ?? '')
    && !args.includes('--dry-run')
    ? null
    : undefined;
}

async function runCommandCapture(params: Readonly<{
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number | null;
  input?: string;
  onStdoutChunk?: (text: string) => void;
}>): Promise<CommandExecutionResult> {
  if (params.input !== undefined && Buffer.byteLength(params.input, 'utf8') > MAX_HAPPIER_PROCESS_INPUT_BYTES) {
    throw new SystemTaskExecutionError('input_limit_exceeded', 'Happier CLI input exceeds the supported size.');
  }
  const invocation = resolveWindowsCommandInvocation({
    command: params.command,
    args: [...params.args],
    env: params.env,
  });

  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const child = spawn(invocation.command, invocation.args, {
      env: params.env,
      cwd: params.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const cleanupAbortListener = () => {
      if (!params.signal) return;
      params.signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      cleanupAbortListener();
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      rejectPromise(new Error('Command aborted.'));
    };

    if (params.signal) {
      if (params.signal.aborted) {
        onAbort();
        return;
      }
      params.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (params.timeoutMs !== null) {
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupAbortListener();
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        rejectPromise(new Error(`Command timed out: ${params.command}`));
      }, Number.isFinite(params.timeoutMs) ? Math.max(1, Math.floor(params.timeoutMs as number)) : 60_000);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      params.onStdoutChunk?.(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.stdin?.on('error', () => {
      // The child exit/error event is the command authority. An early exit can
      // close stdin while bounded input is still being written; do not turn
      // that expected EPIPE into an unhandled process error.
    });

    if (params.input !== undefined) {
      child.stdin?.end(params.input);
    } else {
      child.stdin?.end();
    }

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      cleanupAbortListener();
      rejectPromise(error);
    });

    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      cleanupAbortListener();
      resolvePromise({
        status: typeof code === 'number' ? code : 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function parseFirstJsonObject(text: string): unknown {
  const lines = String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

function isJsonFailureEnvelope(value: unknown): value is Readonly<{ ok: false }> {
  return Boolean(
    value
      && typeof value === 'object'
      && 'ok' in value
      && (value as { ok?: unknown }).ok === false,
  );
}

function resolveRepoRootForFirstPartyComponent(processEnv: NodeJS.ProcessEnv): string | null {
  const explicitRepoRoot = String(
    processEnv.HAPPIER_STACK_REPO_DIR ??
      processEnv.HAPPIER_STACK_CLI_ROOT_DIR ??
      '',
  ).trim();
  const startDir = explicitRepoRoot || process.cwd();
  if (!startDir) return null;

  let cursor = resolve(startDir);
  while (true) {
    const stackBin = join(cursor, 'apps', 'stack', 'bin', 'hstack.mjs');
    const cliBin = join(cursor, 'apps', 'cli', 'bin', 'happier.mjs');
    if (existsSync(stackBin) || existsSync(cliBin)) {
      return cursor;
    }

    const parent = dirname(cursor);
    if (!parent || parent === cursor) break;
    cursor = parent;
  }

  return null;
}

/** A repo checkout's own command (a developer override), or `null` outside a checkout. */
export function resolveRepoLocalFirstPartyCommandPath(params: Readonly<{
  componentId: FirstPartyComponentId;
  processEnv: NodeJS.ProcessEnv;
}>): string | null {
  const repoRoot = resolveRepoRootForFirstPartyComponent(params.processEnv);
  if (!repoRoot) {
    return null;
  }

  const candidates =
    params.componentId === 'hstack'
      ? [
          join(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs'),
          join(repoRoot, 'packages', 'stack', 'bin', 'hstack.mjs'),
        ]
      : params.componentId === 'happier-cli'
        ? [
            join(repoRoot, 'apps', 'cli', 'bin', 'happier.mjs'),
            join(repoRoot, 'packages', 'cli', 'bin', 'happier.mjs'),
          ]
        : [];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Where a local first-party command came from.
 *
 * `managed` means this machine's install path actually produced it: the verified release payload
 * (`prepareFirstPartyComponentPayloadFromGitHubRelease` -> `installVersionedPayload`) was promoted
 * under the install root, which records `current.version` next to the payload it installed at
 * `versions/<versionId>/`. Both the record and the binary it names must be present, because that
 * install is the only thing release verification ever happened for. Everything else is `override`
 * - an explicit env override, a repo-local checkout, or a binary that merely exists at
 * `<installRoot>/current` with no install behind it: usable, never trusted for automatic pairing
 * approval. Later same-user tampering with a recorded managed install is outside this boundary; a
 * directory nothing ever installed into is not - no verification was performed there at all.
 */
export type LocalFirstPartyCommandProvenance = 'managed' | 'override';

export type ResolvedLocalFirstPartyCommand = Readonly<{
  command: string;
  provenance: LocalFirstPartyCommandProvenance;
}>;

export function resolveExplicitOrInstalledLocalFirstPartyCommand(params: Readonly<{
  componentId: FirstPartyComponentId;
  processEnv: NodeJS.ProcessEnv;
  envVarNames?: readonly string[];
  releaseRing?: PublicReleaseRingId;
}>): ResolvedLocalFirstPartyCommand | null {
  for (const envVarName of params.envVarNames ?? []) {
    const explicit = String(params.processEnv[envVarName] ?? '').trim();
    if (explicit) {
      return { command: explicit, provenance: 'override' };
    }
  }

  const repoLocalPath = resolveRepoLocalFirstPartyCommandPath({
    componentId: params.componentId,
    processEnv: params.processEnv,
  });
  if (repoLocalPath) {
    return { command: repoLocalPath, provenance: 'override' };
  }

  // R12 — one CLI per computer. "Keep my own" names the CLI every task runs, even beside a managed
  // copy still on disk. A kept CLI that disappeared is still this computer's answer (R13 b): using a
  // leftover managed copy, or acquiring one, would switch CLIs behind the person's back, so the
  // question setup asks first decides what happens next.
  const choice = params.componentId === 'happier-cli' ? readHappierCliChoiceSync({ processEnv: params.processEnv }) : null;
  if (choice?.mode === 'own') {
    if (existsSync(choice.command)) {
      return { command: choice.command, provenance: 'override' };
    }
    throw new SystemTaskExecutionError(
      'cli_choice_required',
      `The Happier CLI this computer keeps, at ${choice.command}, is no longer there. Choose which command line Happier uses to continue.`,
    );
  }

  try {
    const installed = resolveInstalledLocalFirstPartyCommand(params);
    if (installed) return installed;
  } catch {
    // ignore and continue to managed install acquisition
  }

  // Until this computer answers R12's question, a `happier` the user installed that a new terminal
  // runs first is the CLI here: acquiring a managed one beside it — which any read would otherwise
  // do — is exactly the second CLI the question exists to prevent. "Let Happier manage it" is what
  // lets acquisition run.
  if (params.componentId === 'happier-cli' && choice?.mode !== 'managed') {
    const terminal = resolveTerminalHappierCli({
      binDir: resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: params.processEnv }).shimDir,
      processEnv: params.processEnv,
    });
    if (terminal && !terminal.managed) {
      return { command: terminal.command, provenance: 'override' };
    }
  }

  return null;
}

/**
 * The installed command under the install root, classified by whether an install actually recorded
 * it. `promoteVersionedPayload` writes the payload to `versions/<versionId>` and only then writes
 * the `current.version` marker, so a marker naming a version whose binary is present is the install
 * path's own record of what it put there. A binary sitting at `<installRoot>/current` without that
 * record was never acquired or verified here, so it resolves as `override`: still runnable, never
 * automatically approved for pairing.
 */
function resolveInstalledLocalFirstPartyCommand(params: Readonly<{
  componentId: FirstPartyComponentId;
  processEnv: NodeJS.ProcessEnv;
  releaseRing?: PublicReleaseRingId;
}>): ResolvedLocalFirstPartyCommand | null {
  const paths = resolveInstalledFirstPartyComponentPaths({
    componentId: params.componentId,
    processEnv: params.processEnv,
    releaseRing: params.releaseRing,
  });
  const layout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    processEnv: params.processEnv,
    releaseRing: params.releaseRing,
  });
  const { currentVersionId } = readInstalledVersionMarkersSync(layout);
  if (currentVersionId && paths.resolvedBinaryPath && existsSync(paths.resolvedBinaryPath)) {
    return { command: paths.binaryPath, provenance: 'managed' };
  }
  if (existsSync(paths.binaryPath)) {
    return { command: paths.binaryPath, provenance: 'override' };
  }
  return null;
}

type PreparedPayload = Pick<PreparedFirstPartyComponentPayload, 'versionId' | 'payloadRoot' | 'cleanup'>;

type EnsureLocalFirstPartyCommandDeps = Readonly<{
  preparePayload: (params: FirstPartyAcquisitionOptions & Readonly<{ componentId: FirstPartyComponentId; channel: PublicReleaseRingId }>) => Promise<PreparedPayload>;
  installPayload: typeof installVersionedPayload;
}>;

export async function ensureLocalFirstPartyComponentCommand(params: FirstPartyAcquisitionOptions & Readonly<{
  componentId: FirstPartyComponentId;
  processEnv: NodeJS.ProcessEnv;
  envVarNames?: readonly string[];
  releaseRing?: PublicReleaseRingId;
}>, overrides: Partial<EnsureLocalFirstPartyCommandDeps> = {}): Promise<string> {
  params.signal?.throwIfAborted();
  const resolved = resolveExplicitOrInstalledLocalFirstPartyCommand(params);
  if (resolved) {
    return resolved.command;
  }
  await acquireFirstPartyComponentRelease(params, overrides);
  return resolveAcquiredCommand(params);
}

/**
 * Reads the version a staged or installed executable reports (`<command> --version`) within the
 * owner's process budget (`runCommandCapture` default). `null` when it did not run.
 */
async function readCommandVersion(command: string, processEnv: NodeJS.ProcessEnv): Promise<string | null> {
  const result = await runCommandCapture({ command, args: ['--version'], env: processEnv }).catch(() => null);
  if (!result || result.status !== 0) return null;
  return result.stdout.trim().split(/\r?\n/u)[0]?.trim() || null;
}

/**
 * Updates the managed install of this channel through the one CLI update transaction
 * (`runManagedCliUpdate`, plan R13 f): target resolved once, staged smoke, capture/activate under
 * the install and activation locks without pruning, restart + proof through the caller's service
 * owner (`restartServiceDaemon`), commit or restore, and `last-update.json` for every end.
 * Refuses by name for a CLI the managed install path did not place: an env or repo override, or a
 * binary with no install record, is never replaced here.
 *
 * Failure codes: `cli_update_rolled_back` (the previous version runs again), `cli_update_failed`
 * (restore or its restart proof failed — the stranded case), `cli_update_smoke_failed`,
 * `cli_update_in_progress`, `cli_acquisition_<phase>_failed`, `cli_not_managed`.
 */
export async function updateManagedLocalFirstPartyComponent(params: FirstPartyAcquisitionOptions & Readonly<{
  componentId: 'happier-cli';
  processEnv: NodeJS.ProcessEnv;
  envVarNames?: readonly string[];
  releaseRing?: PublicReleaseRingId;
  /**
   * Observed once the CLI is known to be managed and before anything changes: the restart (through
   * the service owner, proving the version) of the background service's daemon, or `null` when that
   * daemon is not running. Absent: nothing is restarted.
   */
  planServiceDaemonRestart?: () => Promise<ManagedCliUpdateRestart | null>;
}>, overrides: Partial<Pick<EnsureLocalFirstPartyCommandDeps, 'preparePayload'>> & Readonly<{
  readVersion?: (command: string) => Promise<string | null>;
}> = {}): Promise<Readonly<{
  previousVersion: string;
  version: string;
  command: string;
  restarted: boolean;
}>> {
  params.signal?.throwIfAborted();
  const releaseRing = params.releaseRing ?? 'stable';
  const resolved = resolveExplicitOrInstalledLocalFirstPartyCommand(params);
  const layout = resolveFirstPartyInstallLayout({ componentId: params.componentId, processEnv: params.processEnv, releaseRing });
  const previousVersion = readInstalledVersionMarkersSync(layout).currentVersionId;
  if (!resolved || resolved.provenance !== 'managed' || !previousVersion) {
    throw new SystemTaskExecutionError(
      'cli_not_managed',
      resolved
        ? `The Happier CLI at ${resolved.command} was not installed by Happier, so it is not updated here.`
        : 'No Happier-installed CLI exists for this channel.',
    );
  }

  const restartServiceDaemon = params.planServiceDaemonRestart ? await params.planServiceDaemonRestart() : null;
  let phase: Parameters<NonNullable<FirstPartyAcquisitionOptions['onProgress']>>[0]['phase'] = 'resolvingRelease';
  const onProgress: NonNullable<FirstPartyAcquisitionOptions['onProgress']> = (progress) => {
    phase = progress.phase;
    if (!params.signal?.aborted) params.onProgress?.(progress);
  };
  let result: ManagedCliUpdateResult;
  try {
    result = await runManagedCliUpdate({
      channel: releaseRing,
      processEnv: params.processEnv,
      signal: params.signal,
      onProgress,
      readVersion: overrides.readVersion ?? (async (command) => await readCommandVersion(command, params.processEnv)),
      restartServiceDaemon,
      ...(overrides.preparePayload ? { preparePayload: overrides.preparePayload } : {}),
    });
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof ManagedCliUpdateError) throw new SystemTaskExecutionError(error.code, error.message);
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : `Failed to update ${params.componentId}.`;
    const failurePhase = error instanceof FirstPartyAcquisitionError ? error.phase : phase;
    const failureCause = error instanceof FirstPartyAcquisitionError ? error.failureCause : readAcquisitionFailureCause(error);
    onProgress({ phase: failurePhase, failure: { cause: failureCause } });
    throw new SystemTaskExecutionError(`cli_acquisition_${failurePhase}_failed`, redactAcquisitionDiagnostic(message));
  }
  if (result.outcome === 'rolledBack') throw new SystemTaskExecutionError('cli_update_rolled_back', result.message);
  if (result.outcome === 'failed') throw new SystemTaskExecutionError('cli_update_failed', result.message);
  return {
    previousVersion,
    version: result.targetVersion,
    command: resolveAcquiredCommand(params),
    restarted: result.restarted,
  };
}

/**
 * The one download-and-install path for a first-party component: prepares the channel's release
 * payload and promotes it through `installVersionedPayload`, reporting the acquisition phases.
 * Returns the release version. Updates go through `runManagedCliUpdate` instead.
 */
async function acquireFirstPartyComponentRelease(
  params: FirstPartyAcquisitionOptions & Readonly<{
    componentId: FirstPartyComponentId;
    processEnv: NodeJS.ProcessEnv;
    releaseRing?: PublicReleaseRingId;
  }>,
  overrides: Partial<EnsureLocalFirstPartyCommandDeps>,
): Promise<string> {
  const releaseRing = params.releaseRing ?? 'stable';
  const deps: EnsureLocalFirstPartyCommandDeps = {
    preparePayload: async (innerParams) => await prepareFirstPartyComponentPayloadFromGitHubRelease(innerParams),
    installPayload: installVersionedPayload,
    ...overrides,
  };

  let prepared: PreparedPayload | null = null;
  let phase: Parameters<NonNullable<FirstPartyAcquisitionOptions['onProgress']>>[0]['phase'] = 'resolvingRelease';
  const onProgress: NonNullable<FirstPartyAcquisitionOptions['onProgress']> = (progress) => {
    phase = progress.phase;
    if (!params.signal?.aborted) params.onProgress?.(progress);
  };
  try {
    prepared = await deps.preparePayload({
      componentId: params.componentId,
      channel: releaseRing,
      signal: params.signal,
      onProgress,
    });

    await deps.installPayload({
      componentId: params.componentId,
      processEnv: params.processEnv,
      releaseRing,
      versionId: prepared.versionId,
      payloadRoot: prepared.payloadRoot,
      signal: params.signal,
      onProgress,
    });
    return prepared.versionId;
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof SystemTaskExecutionError) throw error;
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : `Failed to acquire ${params.componentId}.`;
    const failurePhase = error instanceof FirstPartyAcquisitionError ? error.phase : phase;
    const failureCause = error instanceof FirstPartyAcquisitionError ? error.failureCause : readAcquisitionFailureCause(error);
    onProgress({ phase: failurePhase, failure: { cause: failureCause } });
    throw new SystemTaskExecutionError(`cli_acquisition_${failurePhase}_failed`, redactAcquisitionDiagnostic(message));
  } finally {
    if (prepared) {
      await prepared.cleanup().catch(() => undefined);
    }
  }
}

function resolveAcquiredCommand(params: FirstPartyAcquisitionOptions & Readonly<{
  componentId: FirstPartyComponentId;
  processEnv: NodeJS.ProcessEnv;
  envVarNames?: readonly string[];
  releaseRing?: PublicReleaseRingId;
}>): string {
  params.signal?.throwIfAborted();
  const installed = resolveExplicitOrInstalledLocalFirstPartyCommand({
    componentId: params.componentId,
    processEnv: params.processEnv,
    envVarNames: params.envVarNames,
    releaseRing: params.releaseRing ?? 'stable',
  });
  if (installed) {
    return installed.command;
  }

  params.onProgress?.({ phase: 'finalizing', failure: { cause: 'managed_command_unavailable' } });
  throw new SystemTaskExecutionError(
    'cli_acquisition_finalizing_failed',
    `Installed ${params.componentId} but could not resolve it.`,
  );
}

export function createLocalHappierJsonExecutor(params: FirstPartyAcquisitionOptions & Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  envVarNames?: readonly string[];
  releaseRing?: PublicReleaseRingId;
  /** Reports that acquisition completed and the command is about to run. */
  onCommandReady?: () => void;
}> = {}): HappierJsonExecutor {
  const defaultProcessEnv = params.processEnv ?? process.env;
  const envVarNames = params.envVarNames ?? DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES;
  const releaseRing = params.releaseRing;

  let installPromise: Promise<void> | null = null;
  const ensureCommand = async (processEnv: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();
    const resolved = resolveExplicitOrInstalledLocalFirstPartyCommand({
      componentId: 'happier-cli',
      processEnv,
      envVarNames,
      releaseRing,
    });
    if (resolved) {
      return resolved.command;
    }

    if (!installPromise) {
      installPromise = ensureLocalFirstPartyComponentCommand({
        componentId: 'happier-cli',
        processEnv,
        envVarNames,
        releaseRing,
        signal,
        onProgress: params.onProgress,
      }).then(() => undefined).finally(() => { installPromise = null; });
    }
    await installPromise;
    signal?.throwIfAborted();

    const installed = resolveExplicitOrInstalledLocalFirstPartyCommand({
      componentId: 'happier-cli',
      processEnv,
      envVarNames,
      releaseRing,
    });
    if (installed) {
      return installed.command;
    }

    throw new SystemTaskExecutionError(
      'cli_acquisition_finalizing_failed',
      'Installed happier-cli but could not resolve it.',
    );
  };

  return createHappierJsonExecutorFromTextRunner(async (args, opts) => {
      const processEnv = opts?.env ?? defaultProcessEnv;
      const signal = opts?.signal && params.signal && opts.signal !== params.signal
        ? AbortSignal.any([opts.signal, params.signal])
        : opts?.signal ?? params.signal;
      const command = await ensureCommand(processEnv, signal);
      signal?.throwIfAborted();
      params.onCommandReady?.();
      const scopedEnv = { ...applyPublicReleaseRingScopeToEnv(processEnv, releaseRing ?? null) };
      // Attribution is an install request, never an inherited daemon/session identity. The CLI's
      // service owner validates the bundle identifier and preserves installed attribution.
      delete scopedEnv.HAPPIER_DAEMON_SERVICE_BUNDLE_ID;
      if (readLocalServiceAction(args) === 'install' && processEnv.HAPPIER_DESKTOP_BUNDLE_ID) {
        scopedEnv.HAPPIER_DAEMON_SERVICE_BUNDLE_ID = processEnv.HAPPIER_DESKTOP_BUNDLE_ID;
      }
      const result = await runCommandCapture({
        command,
        args,
        env: scopedEnv,
        cwd: opts?.cwd,
        signal,
        timeoutMs: opts?.timeoutMs === undefined ? resolveLocalHappierCommandTimeoutMs(args) : opts.timeoutMs,
        input: opts?.input,
        onStdoutChunk: opts?.onStdoutChunk,
      }).catch((error: unknown) => {
        signal?.throwIfAborted();
        const message = error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'Failed to spawn Happier CLI.';
        throw new SystemTaskExecutionError('cli_spawn_failed', message);
      });

      return result;
  });
}
