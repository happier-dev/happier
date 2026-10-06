import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, watch } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';

import { CliUpdateLastResultSchema } from '@happier-dev/protocol/machines/cliUpdateFacts';
import type { CliUpdateLastResult } from '@happier-dev/protocol';
import { resolvePublicReleaseRingLabelForId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { joinPathForPathShape } from '../path/pathShape.js';
import { doesVersionMatchReleaseRing } from '../update/index.js';
import type { FirstPartyAcquisitionOptions } from './acquisitionProgress.js';
import { getFirstPartyComponentCatalogEntry } from './componentCatalog.js';
import { resolveFirstPartyActivationLockTarget, resolveFirstPartyInstallLayout, type FirstPartyInstallLayout } from './installLayout.js';
import { activateVersionedPayload, pruneInstalledVersionsAfterActivation } from './installVersionedPayload.js';
import {
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  type PreparedFirstPartyComponentPayload,
} from './prepareFirstPartyComponentPayloadFromGitHubRelease.js';
import {
  captureActivationStateForUpdate,
  discardActivationStateSnapshot,
  restoreActivationStateAfterUpdate,
} from './restoreInstalledPayloadState.js';
import { readInstalledVersionMarkers } from './versionMarkers.js';
import {
  isFirstPartyLockHeldError,
  withFirstPartyActivationLock,
  withFirstPartyPayloadMutationLock,
} from './withFirstPartyPayloadMutationLock.js';

const COMPONENT_ID = 'happier-cli' as const;
const LAST_UPDATE_FILE_NAME = 'last-update.json';

/**
 * Restart the background service's daemon onto whatever `current` names now, and prove it runs
 * `expectedVersion` — through the CLI service owner (`service restart`, whose ownership wait
 * is the budget). Throws when that is not proven. `phase` says which binary that is: the activated
 * one, or the previous one after a restore.
 */
export type ManagedCliUpdateRestart = (params: Readonly<{
  expectedVersion: string;
  phase: 'activated' | 'restored';
}>) => Promise<void>;

export type ManagedCliUpdateParams = FirstPartyAcquisitionOptions & Readonly<{
  channel: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
  /** An exact version to install; otherwise the ring's newest release. Resolved once. */
  targetVersion?: string;
  /** Reads the version an executable reports (`<command> --version`), within the caller's process budget. */
  readVersion: (command: string) => Promise<string | null>;
  /**
   * `null` when the background service's own daemon was not running before the update: nothing is
   * restarted then, and nothing is started.
   */
  restartServiceDaemon: ManagedCliUpdateRestart | null;
  /**
   * A `last-update.json` write failed. Recording never blocks recovery; the default reports the
   * failure on stderr (the updater's log when the daemon started it).
   */
  onRecordFailure?: (error: unknown) => void;
  /** Something after commit did not complete (pruning old versions); the default reports it on stderr. */
  onWarning?: (message: string) => void;
  /** Called once the attempt holds its locks, before it downloads anything. */
  onAdmitted?: () => void;
  /** Runs under the install lock right before activation (Windows `self update` stops the payload's processes). */
  beforeActivate?: () => Promise<void>;
  /** The release acquisition (download + minisign verification + unpack). */
  preparePayload?: (params: FirstPartyAcquisitionOptions & Readonly<{
    componentId: typeof COMPONENT_ID;
    channel: PublicReleaseRingId;
    versionId?: string;
  }>) => Promise<Pick<PreparedFirstPartyComponentPayload, 'versionId' | 'payloadRoot' | 'cleanup'>>;
}>;

export type ManagedCliUpdateResult = Readonly<
  | {
    outcome: 'succeeded';
    previousVersion: string | null;
    targetVersion: string;
    /** Whether the service daemon was restarted onto (and proved to run) the target. */
    restarted: boolean;
    /** `false` when the target was already the installed version. */
    changed: boolean;
    /** The replaced install had a `current` payload without version markers (a pre-marker install). */
    hadLegacyCurrentInstallWithoutVersionMarkers: boolean;
  }
  | { outcome: 'rolledBack'; previousVersion: string; targetVersion: string; message: string }
  | { outcome: 'failed'; previousVersion: string | null; targetVersion: string; message: string }
>;

/**
 * A refusal before anything was activated: the staged executable did not run (`cli_update_smoke_failed`),
 * or another install/update of this CLI — or any activation of the shared Happier commands — still
 * held its lock after the lock owner's wait (`cli_update_in_progress`).
 */
export class ManagedCliUpdateError extends Error {
  constructor(
    readonly code: 'cli_update_smoke_failed' | 'cli_update_in_progress',
    message: string,
    readonly targetVersion: string | null,
  ) {
    super(message);
    this.name = 'ManagedCliUpdateError';
  }
}

function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map(describeError).join('; ') || error.message;
  }
  return error instanceof Error && error.message.trim() ? error.message.trim() : String(error);
}

function resolveLastUpdatePath(layout: FirstPartyInstallLayout): string {
  return joinPathForPathShape(layout.installRoot, LAST_UPDATE_FILE_NAME);
}

/** The last update attempt's outcome for a ring's managed CLI (`<installRoot>/last-update.json`). */
export function readLastCliUpdateResult(params: Readonly<{
  channel: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): CliUpdateLastResult | null {
  const layout = resolveFirstPartyInstallLayout({ componentId: COMPONENT_ID, channel: params.channel, processEnv: params.processEnv });
  try {
    const parsed = CliUpdateLastResultSchema.safeParse(JSON.parse(readFileSync(resolveLastUpdatePath(layout), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type LastUpdateRecord =
  | Readonly<{ targetVersion: string; outcome: 'succeeded' | 'rolledBack' | 'pendingReconnect'; message: string | null }>
  | Readonly<{ targetVersion: string | null; outcome: 'failed'; message: string | null }>;

/**
 * The one writer of `last-update.json` (atomic tmp+rename). Never throws: a record that cannot be
 * written must not stop a restore or a restart, so the failure goes to `onRecordFailure`.
 */
async function recordLastUpdate(
  layout: FirstPartyInstallLayout,
  result: LastUpdateRecord,
  onRecordFailure: ((error: unknown) => void) | undefined,
): Promise<void> {
  const path = resolveLastUpdatePath(layout);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const record: CliUpdateLastResult = { ...result, at: Date.now() };
  try {
    await mkdir(layout.installRoot, { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(record)}\n`, 'utf8');
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    (onRecordFailure ?? reportRecordFailure)(error);
  }
}

function reportWarning(message: string): void {
  process.stderr.write(`[happier] ${message}\n`);
}

function reportRecordFailure(error: unknown): void {
  process.stderr.write(`[happier] Could not record the CLI update outcome: ${describeError(error)}\n`);
}

/**
 * Call `onChange` whenever a ring's `last-update.json` is (re)written — how a running daemon learns
 * an update attempt ended without polling (it republishes its update facts). Watches the install
 * root; returns the stop function, or `null` when there is no managed install to watch.
 */
export function watchLastCliUpdateResult(params: Readonly<{
  channel: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
  onChange: () => void;
  onError?: (error: unknown) => void;
}>): (() => void) | null {
  const layout = resolveFirstPartyInstallLayout({ componentId: COMPONENT_ID, channel: params.channel, processEnv: params.processEnv });
  if (!existsSync(layout.installRoot)) return null;
  const watcher = watch(layout.installRoot, { persistent: false }, (_event, fileName) => {
    if (String(fileName ?? '') === LAST_UPDATE_FILE_NAME) params.onChange();
  });
  watcher.on('error', (error) => params.onError?.(error));
  return () => watcher.close();
}

function resolveStagedBinaryPath(payloadRoot: string): string {
  const { binaryRelativePath } = getFirstPartyComponentCatalogEntry(COMPONENT_ID);
  return joinPathForPathShape(payloadRoot, process.platform === 'win32' ? `${binaryRelativePath}.exe` : binaryRelativePath);
}

/**
 * The one first-party CLI update transaction (plan R13 f), used by `happier self update`, the
 * desktop's `cli.update.v1` and the daemon-hosted remote `cli.update.v1` (which runs
 * `self update` detached from the daemon). It always runs from the version being replaced.
 *
 * 1. Resolve the target version once and acquire it (download + minisign verification). Every later
 *    step is bound to that version.
 * 2. Smoke the staged executable: its `--version` must be the target, or nothing is activated.
 * 3. Under the install root's lock and the home-wide activation lock (launchers and the
 *    default-channel record are shared by every channel), capture all activation state, then
 *    activate without pruning.
 * 4. When the service's own daemon was running, restart it onto the new version and prove it.
 * 5. Commit and prune — or, when activation or that proof failed, restore everything, restart the
 *    previous binary and prove it. Relay reachability is never part of the proof: a machine that is
 *    offline after a good local restart has updated.
 * 6. Record every end in `last-update.json` — failures before activation included, and recovery
 *    before reporting (`pendingReconnect` while the service restarts). A running daemon watches the
 *    record and republishes its update facts when it changes.
 *
 * Recovery covers failures this process catches. It does not survive the updater itself being
 * killed or the machine losing power mid-transaction, and it does not prove that state a new
 * daemon wrote before it failed is readable by the previous version beyond the supported
 * predecessor transition (`docs/cli-architecture.md`).
 *
 * Locks: the install root's lock and the home-wide activation lock are the existing
 * `proper-lockfile` owners (`withFirstPartyPayloadMutationLock`): a concurrent mutation waits for
 * the owner's retry budget and then fails `cli_update_in_progress` without recording anything.
 */
export async function runManagedCliUpdate(params: ManagedCliUpdateParams): Promise<ManagedCliUpdateResult> {
  const layout = resolveFirstPartyInstallLayout({ componentId: COMPONENT_ID, channel: params.channel, processEnv: params.processEnv });
  const warn = params.onWarning ?? reportWarning;
  const onReleaseFailure = (error: unknown) => warn(describeError(error));
  params.signal?.throwIfAborted();
  // Admission first: the attempt holds both locks before it downloads anything, so a concurrent
  // one is refused (cli_update_in_progress, nothing recorded — the record belongs to the attempt in
  // progress) and a caller learns it was admitted before it waits for the download.
  return await withFirstPartyPayloadMutationLock({
    layout,
    onReleaseFailure,
    operation: async () => await withFirstPartyActivationLock({
      activationLockTarget: resolveFirstPartyActivationLockTarget(layout),
      happyHomeDir: layout.happyHomeDir,
      onReleaseFailure,
      operation: async () => {
        params.onAdmitted?.();
        return await acquireActivateAndProve(params, layout);
      },
    }),
  }).catch((error: unknown) => {
    if (!isFirstPartyLockHeldError(error)) throw error;
    throw new ManagedCliUpdateError(
      'cli_update_in_progress',
      'Another Happier process is still installing or updating the Happier CLI on this machine; nothing was changed. Try again when it finishes.',
      params.targetVersion ?? null,
    );
  });
}

async function acquireActivateAndProve(params: ManagedCliUpdateParams, layout: FirstPartyInstallLayout): Promise<ManagedCliUpdateResult> {
  const preparePayload = params.preparePayload ?? prepareFirstPartyComponentPayloadFromGitHubRelease;
  const record = async (result: LastUpdateRecord) => await recordLastUpdate(layout, result, params.onRecordFailure);
  const recordFailureBeforeActivation = async (error: unknown, targetVersion: string | null) => {
    await record({
      targetVersion,
      outcome: 'failed',
      message: /nothing was changed/iu.test(describeError(error)) ? describeError(error) : `${describeError(error)} Nothing was changed.`,
    });
  };

  let prepared: Pick<PreparedFirstPartyComponentPayload, 'versionId' | 'payloadRoot' | 'cleanup'> | null = null;
  try {
    params.signal?.throwIfAborted();
    prepared = await preparePayload({
      componentId: COMPONENT_ID,
      channel: params.channel,
      ...(params.targetVersion ? { versionId: params.targetVersion } : {}),
      signal: params.signal,
      onProgress: params.onProgress,
    });
    const targetVersion = prepared.versionId;
    if (!doesVersionMatchReleaseRing(targetVersion, params.channel)) {
      throw new Error(`The resolved Happier CLI ${targetVersion} does not match the ${resolvePublicReleaseRingLabelForId(params.channel)} release channel; nothing was changed.`);
    }

    params.onProgress?.({ phase: 'checkingCli' });
    const reported = (await params.readVersion(resolveStagedBinaryPath(prepared.payloadRoot)))?.trim() ?? null;
    if (reported !== targetVersion) {
      throw new ManagedCliUpdateError(
        'cli_update_smoke_failed',
        `The downloaded Happier CLI ${targetVersion} did not start on this machine`
          + ` (it reported ${reported ? `version ${reported}` : 'no version'}); nothing was changed.`,
        targetVersion,
      );
    }
    params.signal?.throwIfAborted();
  } catch (error) {
    // Every admitted attempt that ends before activation is recorded too.
    await recordFailureBeforeActivation(error, prepared?.versionId ?? params.targetVersion ?? null);
    await prepared?.cleanup().catch(() => undefined);
    throw error;
  }

  try {
    return await activateAndProve({ params, layout, prepared, targetVersion: prepared.versionId, record });
  } catch (error) {
    // Only a capture failure reaches here, and a failed capture puts every launcher back.
    await recordFailureBeforeActivation(error, prepared.versionId);
    throw error;
  } finally {
    await prepared.cleanup().catch(() => undefined);
  }
}

async function activateAndProve(input: Readonly<{
  params: ManagedCliUpdateParams;
  layout: FirstPartyInstallLayout;
  prepared: Pick<PreparedFirstPartyComponentPayload, 'payloadRoot'>;
  targetVersion: string;
  record: (result: LastUpdateRecord) => Promise<void>;
}>): Promise<ManagedCliUpdateResult> {
  const { params, layout, targetVersion, record } = input;
  const restart = params.restartServiceDaemon;
  const { currentVersionId } = await readInstalledVersionMarkers(layout);

  if (currentVersionId === targetVersion) {
    // Nothing to activate. A service daemon still on an older build is moved onto it.
    if (restart) {
      try {
        await restart({ expectedVersion: targetVersion, phase: 'activated' });
      } catch (error) {
        const message = `Happier CLI ${targetVersion} is installed, but the background service did not restart onto it: ${describeError(error)}`;
        await record({ targetVersion, outcome: 'failed', message });
        return { outcome: 'failed', previousVersion: currentVersionId, targetVersion, message };
      }
    }
    await record({ targetVersion, outcome: 'succeeded', message: null });
    return { outcome: 'succeeded', previousVersion: currentVersionId, targetVersion, restarted: restart !== null, changed: false, hadLegacyCurrentInstallWithoutVersionMarkers: false };
  }

  const snapshot = await captureActivationStateForUpdate({
    componentId: COMPONENT_ID,
    channel: params.channel,
    processEnv: params.processEnv,
  });
  const previousVersion = snapshot.payload.currentVersionId;

  /**
   * Recovery first, report second: restore every captured piece, restart the previous binary and
   * prove it, and only then record the outcome — `rolledBack` only when that previous daemon is
   * proven (or none was running), `failed` naming whatever could not be recovered.
   */
  const rollBack = async (failure: unknown): Promise<ManagedCliUpdateResult> => {
    const reason = `Happier CLI ${targetVersion} did not start on this machine (${describeError(failure)})`;
    if (!previousVersion) {
      const message = `${reason}, and no previous version was installed to restore.`;
      await record({ targetVersion, outcome: 'failed', message });
      return { outcome: 'failed', previousVersion, targetVersion, message };
    }
    const restoreError = await restoreActivationStateAfterUpdate(snapshot).then(() => null, (error: unknown) => error);
    const restartError = restart
      ? await restart({ expectedVersion: previousVersion, phase: 'restored' }).then(() => null, (error: unknown) => error)
      : null;
    if (restoreError === null && restartError === null) {
      await discardActivationStateSnapshot(snapshot);
      const message = `${reason}; ${previousVersion} was restored.`;
      await record({ targetVersion, outcome: 'rolledBack', message });
      return { outcome: 'rolledBack', previousVersion, targetVersion, message };
    }
    const message = restoreError !== null
      ? `${reason}, and restoring ${previousVersion} failed: ${describeError(restoreError)}`
        + (restartError !== null ? `; the background service did not come back either: ${describeError(restartError)}` : '')
      : `${reason}; ${previousVersion} was restored, but the background service did not come back on it: ${describeError(restartError)}`;
    await record({ targetVersion, outcome: 'failed', message });
    return { outcome: 'failed', previousVersion, targetVersion, message };
  };

  let hadLegacyCurrentInstallWithoutVersionMarkers = false;
  try {
    await params.beforeActivate?.();
    ({ hadLegacyCurrentInstallWithoutVersionMarkers } = await activateVersionedPayload({
      componentId: COMPONENT_ID,
      versionId: targetVersion,
      payloadRoot: input.prepared.payloadRoot,
      payloadRootAlreadyFiltered: true,
      channel: params.channel,
      processEnv: params.processEnv,
      onProgress: params.onProgress,
    }));
  } catch (error) {
    return await rollBack(error);
  }

  if (restart) {
    await record({ targetVersion, outcome: 'pendingReconnect', message: null });
    try {
      await restart({ expectedVersion: targetVersion, phase: 'activated' });
    } catch (error) {
      return await rollBack(error);
    }
  }

  await discardActivationStateSnapshot(snapshot);
  // Committed and proven: pruning old versions is best-effort and never turns this into a failure.
  await pruneInstalledVersionsAfterActivation({
    componentId: COMPONENT_ID,
    channel: params.channel,
    processEnv: params.processEnv,
    currentVersionId: targetVersion,
    previousVersionId: previousVersion,
  }).catch((error: unknown) => {
    (params.onWarning ?? reportWarning)(`Happier CLI ${targetVersion} is installed; an older version could not be removed: ${describeError(error)}`);
  });
  await record({ targetVersion, outcome: 'succeeded', message: null });
  return { outcome: 'succeeded', previousVersion, targetVersion, restarted: restart !== null, changed: true, hadLegacyCurrentInstallWithoutVersionMarkers };
}
