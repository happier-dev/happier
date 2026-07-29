/**
 * Node-fs host adapter for the shared model-pack installer core.
 *
 * Implements {@link ModelPackInstallerHost} on top of `node:fs` streaming I/O and
 * `fetch`, so the daemon installer runs the one shared
 * `installModelPackWithHost` algorithm (resume-aware download → verify → atomic
 * swap → restore-on-failure) instead of a parallel implementation.
 *
 * Layout (all siblings of the live pack so promotion is a same-filesystem
 * rename):
 *   live    `<packsRootDir>/<packId>`
 *   scratch `<packsRootDir>/.<packId>.scratch`  — STABLE per-pack partial store.
 *           Survives a failed/aborted attempt so the NEXT attempt resumes via
 *           HTTP `Range` from the partial offset (FIND-010). Cleared only after a
 *           successful promote.
 *   backup  `<packsRootDir>/.<packId>.backup`   — STABLE name; the prior live tree
 *           during the swap window.
 *   intent  `<packsRootDir>/.<packId>.promote-intent` — durable promotion
 *           transaction marker. Present through the filesystem swap and durable
 *           metadata commit so either side can be rolled back after a crash.
 *
 * Crash recovery: {@link reconcileModelPackPromotions} sweeps the packs root at
 * daemon start and rolls any interrupted swap forward/back using the intent
 * marker + backup, so a power loss between `rename(live→backup)` and
 * `rename(scratch→live)` can never leave the pack permanently missing.
 */

import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { filePathParts } from '@happier-dev/protocol';
import type {
  ModelPackDownloadRequest,
  ModelPackDownloadStream,
  ModelPackHasher,
  ModelPackInstallerHost,
  ModelPackPromotionIntentV1,
  ModelPackPromotionPriorInstallV1,
  ModelPackStagingPlan,
  ModelPackStagingHandle,
  ModelPackUrlPolicy,
} from '@happier-dev/voice-modelpacks';
import {
  assertModelPackResolvedAddressesAllowed,
  assertModelPackUrlAllowed,
  isLegacyModelPackPromotionIntent,
  MODEL_PACK_PROMOTION_INTENT_MAX_BYTES,
  parseModelPackPromotionIntentV1,
} from '@happier-dev/voice-modelpacks';

import {
  openPinnedHttpStream,
  type PinnedHttpStreamTransport,
} from '../../network/pinnedHttp';
import { resolveUrlConnectionIdentity } from '../../network/urlConnectionIdentity';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

const SCRATCH_SUFFIX = '.scratch';
const BACKUP_SUFFIX = '.backup';
const INTENT_SUFFIX = '.promote-intent';
const RESUME_PLAN_FILE = '.resume-plan.json';
const activeStagingKeys = new Set<string>();

function stagingKeyFor(packsRootDir: string, packId: string): string {
  return JSON.stringify([resolve(packsRootDir), packId]);
}

async function writePromotionIntent(path: string, intent: ModelPackPromotionIntentV1): Promise<void> {
  await writeJsonAtomic(path, intent);
}

function scratchDirFor(packsRootDir: string, packId: string): string {
  return join(packsRootDir, `.${packId}${SCRATCH_SUFFIX}`);
}
function backupDirFor(packsRootDir: string, packId: string): string {
  return join(packsRootDir, `.${packId}${BACKUP_SUFFIX}`);
}
function intentFileFor(packsRootDir: string, packId: string): string {
  return join(packsRootDir, `.${packId}${INTENT_SUFFIX}`);
}
function liveDirFor(packsRootDir: string, packId: string): string {
  return join(packsRootDir, packId);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function pruneScratchTreeToPlan(
  scratchDir: string,
  filePaths: readonly string[],
): Promise<void> {
  const allowedFiles = new Set(filePaths);
  allowedFiles.add(RESUME_PLAN_FILE);
  const allowedDirectories = new Set<string>();
  for (const filePath of filePaths) {
    const parts = filePathParts(filePath);
    for (let length = 1; length < parts.length; length += 1) {
      allowedDirectories.add(parts.slice(0, length).join('/'));
    }
  }

  const visit = async (directory: string, parentParts: readonly string[]): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const parts = [...parentParts, entry.name];
      const relativePath = parts.join('/');
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory() && allowedDirectories.has(relativePath)) {
        await visit(absolutePath, parts);
      } else if (!(entry.isFile() && allowedFiles.has(relativePath))) {
        await rm(absolutePath, { recursive: true, force: true });
      }
    }
  };

  await visit(scratchDir, []);
}

async function measureReusablePlanBytes(
  scratchDir: string,
  files: ModelPackStagingPlan['files'],
): Promise<number> {
  let reusableBytes = 0;
  for (const file of files) {
    try {
      const info = await stat(join(scratchDir, ...filePathParts(file.path)));
      if (info.isFile() && info.size >= 0 && info.size <= file.sizeBytes) {
        reusableBytes += info.size;
      }
    } catch {
      // Missing or unreadable partials contribute no reusable bytes.
    }
  }
  return reusableBytes;
}

function createNodeHasher(): ModelPackHasher {
  const hash = createHash('sha256');
  return {
    update: (chunk) => {
      hash.update(chunk);
    },
    digestHex: async () => hash.digest('hex').toLowerCase(),
  };
}

const MODEL_PACK_MAX_REDIRECTS = 5;
const MODEL_PACK_DOWNLOAD_WALL_TIME_MS = 30 * 60 * 1_000;
const MODEL_PACK_DOWNLOAD_IDLE_TIME_MS = 30_000;
const MODEL_PACK_MIN_FREE_DISK_HEADROOM_BYTES = 512 * 1024 * 1024;

async function defaultResolveAddresses(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address);
}

function headerValue(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const expected = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1];
}

export type NodeModelPackDownloadNetwork = Readonly<{
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  pinnedTransport?: PinnedHttpStreamTransport;
}>;

export function createNodeModelPackDownloadOpener(opts: Readonly<{
  urlPolicy?: ModelPackUrlPolicy;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  pinnedTransport?: PinnedHttpStreamTransport;
  wallTimeMs?: number;
  idleTimeMs?: number;
}>): (request: ModelPackDownloadRequest) => Promise<ModelPackDownloadStream> {
  const resolveAddresses = opts.resolveAddresses ?? defaultResolveAddresses;
  const transport = opts.pinnedTransport ?? openPinnedHttpStream;
  const wallTimeMs = opts.wallTimeMs ?? MODEL_PACK_DOWNLOAD_WALL_TIME_MS;
  const idleTimeMs = opts.idleTimeMs ?? MODEL_PACK_DOWNLOAD_IDLE_TIME_MS;
  return async (request) => {
    const operation = new AbortController();
    const forwardCallerAbort = () => operation.abort(request.signal.reason);
    if (request.signal.aborted) {
      forwardCallerAbort();
    } else {
      request.signal.addEventListener('abort', forwardCallerAbort, { once: true });
    }
    const wallTimer = setTimeout(
      () => operation.abort(new Error('pinned_http_wall_timeout')),
      Math.max(0, wallTimeMs),
    );
    wallTimer.unref?.();
    let activeResponse: Awaited<ReturnType<PinnedHttpStreamTransport>> | null = null;
    let completed = false;
    const cancelActiveResponse = () => {
      const response = activeResponse;
      activeResponse = null;
      response?.cancel();
    };
    const cleanup = () => {
      if (completed) return;
      completed = true;
      clearTimeout(wallTimer);
      request.signal.removeEventListener('abort', forwardCallerAbort);
      operation.signal.removeEventListener('abort', settleAbortedOperation);
    };
    const settleAbortedOperation = () => {
      cancelActiveResponse();
      cleanup();
    };
    operation.signal.addEventListener('abort', settleAbortedOperation, { once: true });
    const awaitOperation = <T>(
      pending: Promise<T>,
      onAbortedResolve?: (value: T) => void,
    ): Promise<T> => {
      if (operation.signal.aborted) return Promise.reject(operation.signal.reason);
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(operation.signal.reason);
        operation.signal.addEventListener('abort', onAbort, { once: true });
        pending.then((value) => {
          if (operation.signal.aborted) {
            onAbortedResolve?.(value);
            reject(operation.signal.reason);
            return;
          }
          resolve(value);
        }, reject).finally(() => {
          operation.signal.removeEventListener('abort', onAbort);
        });
      });
    };

    let currentUrl = request.url;
    let redirects = 0;
    try {
      for (;;) {
        assertModelPackUrlAllowed(currentUrl, opts.urlPolicy);
        const hostname = resolveUrlConnectionIdentity(new URL(currentUrl).hostname).hostname;
        const resolvedAddresses = Object.freeze([
          ...new Set(await awaitOperation(resolveAddresses(hostname))),
        ].sort());
        assertModelPackResolvedAddressesAllowed(resolvedAddresses, {
          ...opts.urlPolicy,
          requireResolvedAddresses: true,
          requestUrl: currentUrl,
        });
        const headers: Record<string, string> = {};
        if (request.rangeStart && request.rangeStart > 0) headers.Range = `bytes=${request.rangeStart}-`;
        const response = await awaitOperation(
          transport({
            url: currentUrl,
            validatedAddresses: resolvedAddresses,
            headers,
            signal: operation.signal,
            wallTimeMs,
            idleTimeMs,
          }),
          (lateResponse) => lateResponse.cancel(),
        );
        activeResponse = response;
        if (operation.signal.aborted) throw operation.signal.reason;
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          cancelActiveResponse();
          const location = headerValue(response.headers, 'location');
          if (!location || redirects >= MODEL_PACK_MAX_REDIRECTS) {
            throw new Error('model_pack_redirect_invalid');
          }
          try {
            currentUrl = new URL(location, currentUrl).toString();
          } catch {
            throw new Error('model_pack_redirect_invalid');
          }
          redirects += 1;
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          cancelActiveResponse();
          throw new Error(`model_pack_download_failed:${response.status}`);
        }
        let streamSettled = false;
        const settleStream = () => {
          if (streamSettled) return;
          streamSettled = true;
          activeResponse = null;
          cleanup();
        };
        return {
          contentLength: response.contentLength,
          isPartial: response.status === 206,
          finalUrl: currentUrl,
          resolvedAddresses,
          read: async () => {
            if (streamSettled) return null;
            try {
              const chunk = await awaitOperation(response.read());
              if (chunk === null) settleStream();
              return chunk;
            } catch (error) {
              cancelActiveResponse();
              settleStream();
              throw error;
            }
          },
          cancel: () => {
            cancelActiveResponse();
            settleStream();
          },
        };
      }
    } catch (error) {
      cancelActiveResponse();
      cleanup();
      throw error;
    }
  };
}

export function createNodeModelPackInstallerHost(opts: {
  packsRootDir: string;
  renamePath?: typeof rename;
  urlPolicy?: ModelPackUrlPolicy;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  pinnedTransport?: PinnedHttpStreamTransport;
  resolveAvailableDiskBytes?: (packsRootDir: string) => Promise<number>;
  minFreeDiskHeadroomBytes?: number;
}): ModelPackInstallerHost {
  const { packsRootDir } = opts;
  const renamePath = opts.renamePath ?? rename;
  const openDownload = createNodeModelPackDownloadOpener({
    urlPolicy: opts.urlPolicy,
    resolveAddresses: opts.resolveAddresses,
    pinnedTransport: opts.pinnedTransport,
  });
  const resolveAvailableDiskBytes = opts.resolveAvailableDiskBytes ?? (async (rootDir: string) => {
    const info = await statfs(rootDir);
    return info.bavail * info.bsize;
  });
  const minFreeDiskHeadroomBytes = opts.minFreeDiskHeadroomBytes ?? MODEL_PACK_MIN_FREE_DISK_HEADROOM_BYTES;

  return {
    openDownload,
    createHasher: createNodeHasher,
    beginStaging: async (packId, plan: ModelPackStagingPlan): Promise<ModelPackStagingHandle> => {
      const stagingKey = stagingKeyFor(packsRootDir, packId);
      if (activeStagingKeys.has(stagingKey)) throw new Error('model_pack_install_already_in_progress');
      activeStagingKeys.add(stagingKey);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeStagingKeys.delete(stagingKey);
      };
      const scratchDir = scratchDirFor(packsRootDir, packId);
      const backupDir = backupDirFor(packsRootDir, packId);
      const intentFile = intentFileFor(packsRootDir, packId);
      const liveDir = liveDirFor(packsRootDir, packId);

      // Each file path is already validated path-safe by the core before staging;
      // re-split here to map onto the scratch tree.
      const scratchPath = (filePath: string) => join(scratchDir, ...filePathParts(filePath));

      let promoted = false;
      let promotionSettled = false;

      // Resume bytes have meaning only for the exact immutable install plan. A
      // missing/mismatched marker invalidates the entire scratch tree so an old
      // manifest can never donate unlisted or differently-sourced files.
      const resumePlanFile = join(scratchDir, RESUME_PLAN_FILE);
      try {
        let storedPlanKey: string | null = null;
        try {
          const stored = JSON.parse(await readFile(resumePlanFile, 'utf8')) as { key?: unknown };
          storedPlanKey = typeof stored.key === 'string' ? stored.key : null;
        } catch {
          storedPlanKey = null;
        }
        if (storedPlanKey !== plan.key) {
          await rm(scratchDir, { recursive: true, force: true });
        } else if (await pathExists(scratchDir)) {
          await pruneScratchTreeToPlan(scratchDir, plan.filePaths);
        }
        const reusableBytes = await measureReusablePlanBytes(scratchDir, plan.files);
        const requiredAdditionalBytes = Math.max(0, plan.totalBytes - reusableBytes);
        const availableDiskBytes = await resolveAvailableDiskBytes(packsRootDir);
        if (
          !Number.isSafeInteger(availableDiskBytes)
          || availableDiskBytes < 0
          || !Number.isSafeInteger(minFreeDiskHeadroomBytes)
          || minFreeDiskHeadroomBytes < 0
          || !Number.isSafeInteger(plan.totalBytes)
          || plan.totalBytes < 0
          || !Number.isSafeInteger(requiredAdditionalBytes)
          || availableDiskBytes < requiredAdditionalBytes + minFreeDiskHeadroomBytes
        ) {
          throw new Error('model_pack_insufficient_disk_space');
        }
        await mkdir(scratchDir, { recursive: true });
        await writeFile(
          resumePlanFile,
          JSON.stringify({ schemaVersion: 1, key: plan.key, filePaths: plan.filePaths }),
          'utf8',
        );
      } catch (error) {
        release();
        throw error;
      }

      return {
        partialByteLength: async (filePath) => {
          try {
            const info = await stat(scratchPath(filePath));
            return info.isFile() ? info.size : 0;
          } catch {
            return 0;
          }
        },
        streamPartial: async (filePath, onChunk) => {
          const target = scratchPath(filePath);
          let total = 0;
          try {
            for await (const chunk of createReadStream(target)) {
              const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
              if (bytes.byteLength === 0) continue;
              total += bytes.byteLength;
              await onChunk(bytes);
            }
            return total;
          } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
              return 0;
            }
            throw error;
          }
        },
        resetPartial: async (filePath) => {
          await rm(scratchPath(filePath), { force: true }).catch(() => undefined);
        },
        appendDownloadedChunk: async (filePath, chunk) => {
          const target = scratchPath(filePath);
          await mkdir(dirname(target), { recursive: true });
          await appendFile(target, chunk);
        },
        writeManifest: async (manifest) => {
          await writeFile(join(scratchDir, 'pack.json'), JSON.stringify(manifest, null, 2), 'utf8');
        },
        promote: async (declaredPriorInstall) => {
          let backupCreated = false;
          let swapWindowClosed = false;
          let intent: ModelPackPromotionIntentV1 = {
            schemaVersion: 1,
            packId,
            phase: 'swap_prepared',
            startedAtMs: Date.now(),
            token: randomUUID(),
            priorInstall: declaredPriorInstall === undefined
              ? (await pathExists(liveDir)
                  ? Object.freeze({ scopeKey: `filesystem:${resolve(packsRootDir)}`, identityKey: packId })
                  : null)
              : declaredPriorInstall,
            recovery: null,
          };
          if ((await pathExists(liveDir)) && (await pathExists(backupDir)) && !(await pathExists(intentFile))) {
            await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
          }
          // Host-owned scratch metadata is never part of the installed pack.
          await rm(resumePlanFile, { force: true });
          // Durable promote-intent marker, written BEFORE the swap window opens so a
          // crash between the two renames is recoverable on boot (X-M1). Stored as
          // JSON for forward-compatible reconciliation.
          await writePromotionIntent(intentFile, intent);
          try {
            try {
              await renamePath(liveDir, backupDir);
              backupCreated = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
                throw error;
              }
              swapWindowClosed = true;
            }
            await renamePath(scratchDir, liveDir);
            promoted = true;
            swapWindowClosed = true;
          } catch (error) {
            let rollbackRestored = !backupCreated;
            if (!promoted && backupCreated) {
              try {
                await renamePath(backupDir, liveDir);
                rollbackRestored = true;
              } catch {
                rollbackRestored = false;
              }
            }
            if (!rollbackRestored) {
              // Keep the intent marker: boot reconciliation can retry restoring
              // the backup instead of losing the only durable swap-window state.
              throw error;
            }
            swapWindowClosed = true;
            throw error;
          } finally {
            // Intent is cleared last: only once the swap window is fully closed
            // (either promoted, or rolled back above) is the install state durable.
            if (swapWindowClosed && !promoted) {
              await rm(intentFile, { force: true }).catch(() => undefined);
            }
          }
          return {
            rootLocation: liveDir,
            prepareDurableCommit: async (recovery) => {
              if (promotionSettled) throw new Error('model_pack_promotion_settled');
              intent = { ...intent, phase: 'metadata_pending', recovery };
              await writePromotionIntent(intentFile, intent);
            },
            markDurableCommitted: async () => {
              if (promotionSettled) throw new Error('model_pack_promotion_settled');
              intent = { ...intent, phase: 'metadata_committed' };
              await writePromotionIntent(intentFile, intent);
            },
            commit: async () => {
              if (promotionSettled) return;
              promotionSettled = true;
              // Clearing intent is the commit linearization point. If cleanup
              // crashes afterwards, startup sees an orphan backup and drops it.
              await rm(intentFile, { force: true }).catch(() => undefined);
              await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
            },
            rollback: async () => {
              if (promotionSettled) return;
              intent = { ...intent, phase: 'rollback_pending' };
              await writePromotionIntent(intentFile, intent);
              await rm(liveDir, { recursive: true, force: true });
              if (backupCreated && await pathExists(backupDir)) {
                if (intent.priorInstall) await renamePath(backupDir, liveDir);
                else await rm(backupDir, { recursive: true, force: true });
              }
              promoted = false;
            },
            completeRollback: async () => {
              if (promotionSettled) return;
              promotionSettled = true;
              await rm(intentFile, { force: true });
            },
          };
        },
        cleanup: async () => {
          // On failure keep the scratch dir so the next attempt can resume; only a
          // successful promote consumes it (scratch was renamed into live). Nothing
          // to clean here — the stable scratch is intentionally retained.
          if (promoted) {
            await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
          }
          release();
        },
      };
    },
  };
}

/**
 * Read bounded, phase-bearing promotion markers. Durable metadata-bearing
 * records are settled by the scoped public state owner; the generic sweep below
 * handles only legacy/non-durable swaps and deliberately leaves scoped records.
 */
export async function readModelPackPromotionIntents(
  packsRootDir: string,
): Promise<readonly ModelPackPromotionIntentV1[]> {
  let entries: string[];
  try {
    entries = await readdir(packsRootDir);
  } catch {
    return [];
  }
  const intents: ModelPackPromotionIntentV1[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('.') || !entry.endsWith(INTENT_SUFFIX)) continue;
    const packId = entry.slice(1, entry.length - INTENT_SUFFIX.length);
    if (!packId) continue;
    if (activeStagingKeys.has(stagingKeyFor(packsRootDir, packId))) continue;
    try {
      const path = join(packsRootDir, entry);
      const info = await stat(path);
      if (!info.isFile() || info.size > MODEL_PACK_PROMOTION_INTENT_MAX_BYTES) {
        throw new Error('model_pack_promotion_intent_invalid');
      }
      const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
      try {
        intents.push(parseModelPackPromotionIntentV1(raw, packId));
      } catch {
        if (!isLegacyModelPackPromotionIntent(raw, packId)) throw new Error('model_pack_promotion_intent_invalid');
        const liveExists = await pathExists(liveDirFor(packsRootDir, packId));
        const backupExists = await pathExists(backupDirFor(packsRootDir, packId));
        if (liveExists && !backupExists) throw new Error('model_pack_promotion_legacy_ambiguous');
        // Pre-transaction markers carried no phase/recovery payload.
        intents.push({
          schemaVersion: 1,
          packId,
          phase: 'swap_prepared',
          startedAtMs: 0,
          token: 'legacy',
          priorInstall: backupExists
            ? Object.freeze({ scopeKey: `legacy-filesystem:${resolve(packsRootDir)}`, identityKey: packId })
            : null,
          recovery: null,
        });
      }
    } catch {
      throw new Error(`model_pack_promotion_intent_invalid:${packId}`);
    }
  }
  return Object.freeze(intents);
}

export async function settleModelPackPromotion(params: Readonly<{
  packsRootDir: string;
  packId: string;
  outcome: 'commit' | 'rollback';
  clearIntent?: boolean;
  priorInstall?: ModelPackPromotionPriorInstallV1;
}>): Promise<void> {
  const liveDir = liveDirFor(params.packsRootDir, params.packId);
  const backupDir = backupDirFor(params.packsRootDir, params.packId);
  const intentFile = intentFileFor(params.packsRootDir, params.packId);
  if (params.outcome === 'commit') {
    if (!(await pathExists(liveDir))) throw new Error('model_pack_promotion_live_missing');
    if (params.clearIntent !== false) await rm(intentFile, { force: true });
    await rm(backupDir, { recursive: true, force: true });
    return;
  }
  const liveExists = await pathExists(liveDir);
  const backupExists = await pathExists(backupDir);
  if (backupExists) {
    if (liveExists) await rm(liveDir, { recursive: true, force: true });
    if (params.priorInstall) await rename(backupDir, liveDir);
    else await rm(backupDir, { recursive: true, force: true });
  } else if (params.priorInstall) {
    if (!liveExists) throw new Error('model_pack_promotion_prior_missing');
  } else if (liveExists) {
    await rm(liveDir, { recursive: true, force: true });
  }
  if (params.clearIntent !== false) await rm(intentFile, { force: true });
}

export async function inspectModelPackPromotionTopology(
  packsRootDir: string,
  packId: string,
): Promise<Readonly<{ liveExists: boolean; backupExists: boolean }>> {
  return {
    liveExists: await pathExists(liveDirFor(packsRootDir, packId)),
    backupExists: await pathExists(backupDirFor(packsRootDir, packId)),
  };
}

export async function clearModelPackPromotionIntent(packsRootDir: string, packId: string): Promise<void> {
  await rm(intentFileFor(packsRootDir, packId), { force: true });
}

export async function reconcileModelPackPromotions(packsRootDir: string): Promise<readonly string[]> {
  const entries = await readdir(packsRootDir).catch(() => [] as string[]);
  const intents = await readModelPackPromotionIntents(packsRootDir);
  const intentPackIds = new Set(intents.map((intent) => intent.packId));
  const restored: string[] = [];

  for (const intent of intents) {
    // Durable metadata-bearing intents require the scoped state owner to decide.
    if (intent.recovery) continue;
    const hadBackup = await pathExists(backupDirFor(packsRootDir, intent.packId));
    await settleModelPackPromotion({
      packsRootDir,
      packId: intent.packId,
      outcome: 'rollback',
      priorInstall: intent.priorInstall,
    });
    if (hadBackup) restored.push(intent.packId);
  }

  for (const entry of entries) {
    if (!entry.startsWith('.') || !entry.endsWith(BACKUP_SUFFIX)) {
      continue;
    }
    const packId = entry.slice(1, entry.length - BACKUP_SUFFIX.length);
    if (!packId || intentPackIds.has(packId)) {
      continue;
    }
    const liveDir = liveDirFor(packsRootDir, packId);
    const backupDir = backupDirFor(packsRootDir, packId);
    const intentFile = intentFileFor(packsRootDir, packId);
    if ((await pathExists(liveDir)) && (await pathExists(backupDir)) && !(await pathExists(intentFile))) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return restored;
}
