import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  installVersionedPayload,
  recordDesktopInstallation,
  recordDesktopResourceUse,
  FirstPartyAcquisitionError,
  readAcquisitionFailureCause,
  redactAcquisitionDiagnostic,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  readHappierCliChoiceSync,
  readInstalledVersionMarkersSync,
  resolveFirstPartyInstallLayout,
  resolveForeignHappierCli,
  resolveInstalledFirstPartyComponentPaths,
  resolveTerminalHappierCli,
  type TerminalHappierCli,
  type FirstPartyComponentId,
  type PreparedFirstPartyComponentPayload,
  type FirstPartyAcquisitionOptions,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

/**
 * Where a local first-party command came from — an INSTALL-OWNERSHIP record, not verified
 * publisher provenance.
 *
 * `managed` means this machine's managed install layout claims it: `installVersionedPayload`
 * promoted a payload under `~/.happier` and recorded `current.version` next to it at
 * `versions/<versionId>/`, and both that record and the binary it names are present. The marker is
 * a plain text file in the user's own home, so `managed` states "this app's install path put it
 * there", never "this binary was cryptographically proven to be official Happier" — any process
 * running as the user can write both the marker and the binary. What the acquisition path does
 * verify (minisign-checked release checksums in
 * `prepareFirstPartyComponentPayloadFromGitHubRelease`) is verified at download time, not re-proved
 * here on every resolve.
 *
 * Everything else is `override` — an explicit env override, a repo-local checkout, or a binary
 * that merely exists at `<installRoot>/current` with no install behind it.
 *
 * The distinction is still the right one to act on, because it decides HOW a pairing is approved
 * rather than whether the binary is authentic: the app approves a `managed` CLI silently, and puts
 * an `override` CLI to the person at the keyboard once, naming the resolved path
 * (`apps/ui/sources/setup/presentUnmanagedCliConsent.ts`). The narrow invariant is that the app
 * must not release account content-key material UNATTENDED to a command line its own install path
 * did not place — the very same key it already releases, attended, to any CLI paired by QR code.
 * Later same-user tampering with a recorded managed install is explicitly outside this boundary
 * (plan D4); a directory nothing ever installed into is not, because no install happened there at
 * all.
 */
export type LocalFirstPartyCommandProvenance = 'managed' | 'override';

export type ResolvedLocalFirstPartyCommand = Readonly<{
  command: string;
  provenance: LocalFirstPartyCommandProvenance;
}>;

export type LocalFirstPartyCommandParams = FirstPartyAcquisitionOptions & Readonly<{
  componentId: FirstPartyComponentId;
  releaseRing: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
  envVarNames?: readonly string[];
  /** Reject an acquired release before writing its payload. */
  assertAcceptableVersion?: (versionId: string) => void;
}>;

export function resolveExplicitOrInstalledLocalFirstPartyCommand(
  params: LocalFirstPartyCommandParams,
): ResolvedLocalFirstPartyCommand | null {
  const processEnv = params.processEnv ?? process.env;

  for (const envVarName of params.envVarNames ?? []) {
    const explicit = String(processEnv[envVarName] ?? '').trim();
    if (explicit) {
      return { command: explicit, provenance: 'override' };
    }
  }

  // R12 — one CLI per computer. "Keep my own" names the CLI every task runs, even beside a managed
  // copy still on disk. A kept CLI that disappeared is still this computer's answer (R13 b): using a
  // leftover managed copy, or acquiring one, would switch CLIs behind the person's back, so it is
  // the question setup asks first (`inspectLocalHappierCliChoice`) that decides what happens next.
  const choice = params.componentId === 'happier-cli' ? readHappierCliChoiceSync({ processEnv }) : null;
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
    const installed = resolveInstalledLocalFirstPartyCommand({
      componentId: params.componentId,
      processEnv,
      releaseRing: params.releaseRing,
    });
    if (installed) {
      return installed;
    }
  } catch {
    // ignore and continue to managed install acquisition
  }

  const repoLocalPath = resolveRepoLocalFirstPartyCommandPath({
    componentId: params.componentId,
    processEnv,
  });
  if (repoLocalPath) {
    return { command: repoLocalPath, provenance: 'override' };
  }

  // Until this computer answers R12's question, a `happier` the user installed is the CLI here:
  // acquiring a managed one beside it — which any read would otherwise do — is exactly the second
  // CLI the question exists to prevent. "Let Happier manage it" is what lets acquisition run.
  if (params.componentId === 'happier-cli' && choice?.mode !== 'managed') {
    const terminal = resolveTerminalLocalHappierCli(processEnv);
    if (terminal && !terminal.managed) {
      return { command: terminal.command, provenance: 'override' };
    }
  }

  return null;
}

/**
 * A `happier` on the search path that this Happier home's managed layout did not place, found past
 * the managed shim (R12/R13 b) — every other copy, for Settings to name and offer to remove.
 */
export function resolveForeignLocalHappierCli(processEnv: NodeJS.ProcessEnv): string | null {
  return resolveForeignHappierCli({
    binDir: resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv }).shimDir,
    processEnv,
  });
}

/** The `happier` a new terminal runs first — what the R12 question is about (RV3-1). */
export function resolveTerminalLocalHappierCli(processEnv: NodeJS.ProcessEnv): TerminalHappierCli | null {
  return resolveTerminalHappierCli({
    binDir: resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv }).shimDir,
    processEnv,
  });
}

/**
 * The installed command under `~/.happier`, classified by whether an install actually recorded it.
 *
 * `promoteVersionedPayload` writes the payload to `versions/<versionId>` and only then writes the
 * `current.version` marker, so a marker naming a version whose binary is present is the install
 * path's own record of what it put there. A binary sitting at `<installRoot>/current` without that
 * record was never acquired here, so it resolves as `override`: still runnable, but its pairing
 * approval is put to the user instead of granted unattended.
 */
export function resolveInstalledLocalFirstPartyCommand(params: Readonly<{
  componentId: FirstPartyComponentId;
  processEnv: NodeJS.ProcessEnv;
  releaseRing: PublicReleaseRingId;
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

function resolveRepoLocalFirstPartyCommandPath(params: Readonly<{
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

function resolveRepoRootForFirstPartyComponent(processEnv: NodeJS.ProcessEnv): string | null {
  const explicitRepoRoot = String(processEnv.HAPPIER_STACK_REPO_DIR ?? processEnv.HAPPIER_STACK_CLI_ROOT_DIR ?? '').trim();
  const startDir = explicitRepoRoot || process.cwd();
  if (!startDir) {
    return null;
  }

  let cursor = resolve(startDir);
  while (true) {
    const stackBin = join(cursor, 'apps', 'stack', 'bin', 'hstack.mjs');
    const cliBin = join(cursor, 'apps', 'cli', 'bin', 'happier.mjs');
    if (existsSync(stackBin) || existsSync(cliBin)) {
      return cursor;
    }

    const parent = dirname(cursor);
    if (!parent || parent === cursor) {
      break;
    }
    cursor = parent;
  }

  return null;
}

type PreparedPayload = Pick<PreparedFirstPartyComponentPayload, 'versionId' | 'payloadRoot' | 'cleanup'>;

function acquisitionFailureCode(
  componentId: FirstPartyComponentId,
  phase: Parameters<NonNullable<FirstPartyAcquisitionOptions['onProgress']>>[0]['phase'],
): string {
  return componentId === 'happier-cli'
    ? `cli_acquisition_${phase}_failed`
    : 'first_party_component_install_failed';
}

/**
 * The named task failure for an acquisition that failed in `phase` (reported as a progress
 * failure too). A named task failure — a version refusal, or one raised inside a dep — keeps its
 * own code: relabelling it as an install failure would hide why the acquisition was refused.
 */
export function toAcquisitionFailure(params: Readonly<{
  componentId: FirstPartyComponentId;
  error: unknown;
  phase: Parameters<NonNullable<FirstPartyAcquisitionOptions['onProgress']>>[0]['phase'];
  onProgress: NonNullable<FirstPartyAcquisitionOptions['onProgress']>;
}>): SystemTaskExecutionError {
  const { error } = params;
  if (error instanceof SystemTaskExecutionError) {
    return error;
  }
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : `Failed to acquire ${params.componentId}.`;
  const failurePhase = error instanceof FirstPartyAcquisitionError ? error.phase : params.phase;
  const failureCause = error instanceof FirstPartyAcquisitionError ? error.failureCause : readAcquisitionFailureCause(error);
  params.onProgress({ phase: failurePhase, failure: { cause: failureCause } });
  return new SystemTaskExecutionError(
    acquisitionFailureCode(params.componentId, failurePhase),
    redactAcquisitionDiagnostic(message),
  );
}

export type LocalFirstPartyCommandAcquisitionDeps = Readonly<{
  preparePayload: (params: FirstPartyAcquisitionOptions & Readonly<{
    componentId: FirstPartyComponentId;
    channel: PublicReleaseRingId;
  }>) => Promise<PreparedPayload>;
  installPayload: typeof installVersionedPayload;
}>;

/**
 * Acquire the component through the managed release path for the caller's ring (the payload's
 * checksums are minisign-verified at download),
 * regardless of what is already resolvable, and return the managed command it installed.
 */
export async function acquireManagedLocalFirstPartyComponentCommand(
  params: LocalFirstPartyCommandParams,
  overrides: Partial<LocalFirstPartyCommandAcquisitionDeps> = {},
): Promise<ResolvedLocalFirstPartyCommand> {
  const processEnv = params.processEnv ?? process.env;
  const deps: LocalFirstPartyCommandAcquisitionDeps = {
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
    params.signal?.throwIfAborted();
    const desktop = params.componentId === 'happier-cli' ? await recordDesktopInstallation(processEnv) : null;
    prepared = await deps.preparePayload({
      componentId: params.componentId,
      channel: params.releaseRing,
      signal: params.signal,
      onProgress,
    });
    params.assertAcceptableVersion?.(prepared.versionId);

    await deps.installPayload({
      componentId: params.componentId,
      processEnv,
      releaseRing: params.releaseRing,
      versionId: prepared.versionId,
      payloadRoot: prepared.payloadRoot,
      ...(desktop ? { desktopBundleId: desktop.bundleId } : {}),
      signal: params.signal,
      onProgress,
    });
  } catch (error) {
    params.signal?.throwIfAborted();
    throw toAcquisitionFailure({ componentId: params.componentId, error, phase, onProgress });
  } finally {
    if (prepared) {
      await prepared.cleanup().catch(() => undefined);
    }
  }

  params.signal?.throwIfAborted();

  const installedCommand = resolveExplicitOrInstalledLocalFirstPartyCommand({
    componentId: params.componentId,
    releaseRing: params.releaseRing,
    processEnv,
  });
  if (installedCommand?.provenance === 'managed') {
    if (params.componentId === 'happier-cli') await recordDesktopInstallation(processEnv, installedCommand.command);
    return installedCommand;
  }

  onProgress({ phase: 'finalizing', failure: { cause: 'managed_command_unavailable' } });
  throw new SystemTaskExecutionError(
    acquisitionFailureCode(params.componentId, 'finalizing'),
    `Installed ${params.componentId}, but its managed command path is still unavailable.`,
  );
}

export async function ensureLocalFirstPartyComponentCommand(
  params: LocalFirstPartyCommandParams,
  overrides: Partial<LocalFirstPartyCommandAcquisitionDeps> = {},
): Promise<ResolvedLocalFirstPartyCommand> {
  const resolved = resolveExplicitOrInstalledLocalFirstPartyCommand(params);
  if (resolved) {
    if (params.componentId === 'happier-cli') {
      const processEnv = params.processEnv ?? process.env;
      const desktop = await recordDesktopInstallation(processEnv, resolved.command);
      if (desktop && resolved.provenance === 'managed') {
        await recordDesktopResourceUse({
          resourcePath: resolveFirstPartyInstallLayout({ componentId: params.componentId, releaseRing: params.releaseRing, processEnv }).installRoot,
          bundleId: desktop.bundleId,
          created: false,
        });
      }
    }
    return resolved;
  }
  return await acquireManagedLocalFirstPartyComponentCommand(params, overrides);
}
