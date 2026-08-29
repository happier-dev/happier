import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  ComposerContentHandleV1Schema,
  type ComposerContentHandleV1,
  type ComposerContentMediaKindV1,
  type ComposerContentMimeTypeV1,
  ComposerInstanceIdSchema,
  ComposerRefV1Schema,
  PendingLocalIdSchema,
  type ComposerRefV1,
  type PluginContributionIdentityV1,
  type SessionExecutionTargetV1,
} from '@happier-dev/protocol';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { composerRefsV1Equal } from '@happier-dev/protocol/plugins/ui/composerRef';
import { configuration } from '@/configuration';
import {
  isSessionMediaImageMimeType,
  sessionMediaKindForMimeType,
  sniffSessionMediaMimeType,
  type SupportedSessionMediaMimeType,
} from '@/session/media/mime';
import { sanitizeSessionMediaFileName } from '@/session/media/names';

const MANIFEST_VERSION = 1 as const;
const MANIFEST_MAX_BYTES = 16 * 1024;
const MIME_SNIFF_BYTES = 4 * 1024;
const CONTENT_FILE_NAME = 'content';
const MANIFEST_FILE_NAME = 'manifest.json';
const CLAIM_FILE_NAME = 'claim.json';
const COMPLETED_DIRECTORY_NAME = 'completed';
const PENDING_DIRECTORY_NAME = '.pending';
const STAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const COMPOSER_MEDIA_STAGE_ORPHAN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type ComposerMediaStageManifest = Readonly<{
  v: typeof MANIFEST_VERSION;
  createdAtMs: number;
  handle: ComposerContentHandleV1;
}>;

export type ComposerMediaStageClaimant = Readonly<{
  composer: ComposerRefV1;
  attachmentInstanceId: string;
}>;

type ComposerMediaStageFailureCode =
  | 'invalid_metadata'
  | 'target_mismatch'
  | 'source_corrupt'
  | 'stage_corrupt'
  | 'stage_unavailable';

type ComposerMediaStageFailure = Readonly<{
  success: false;
  error: string;
  code: ComposerMediaStageFailureCode;
}>;

export type ComposerMediaStageFinalizeResult =
  | Readonly<{ success: true; handle: ComposerContentHandleV1 }>
  | ComposerMediaStageFailure;

export type ComposerMediaStageInspection =
  | Readonly<{
      status: 'ready';
      handle: ComposerContentHandleV1;
      filePath: string;
      mediaKind: ComposerContentMediaKindV1;
      mimeType: ComposerContentMimeTypeV1;
      name: string;
      sizeBytes: number;
      sha256: string;
    }>
  | Readonly<{
      status: 'unavailable';
      reason: 'notFound' | 'expired' | 'targetMismatch' | 'ownerMismatch' | 'claimedElsewhere' | 'corrupt';
    }>;

export type ComposerMediaStageReleaseResult =
  | Readonly<{ status: 'released' }>
  | Readonly<{
      status: 'unavailable';
      reason: 'notFound' | 'expired' | 'targetMismatch' | 'ownerMismatch' | 'claimedElsewhere' | 'corrupt';
    }>;

export type ComposerMediaStageClaimResult =
  | Readonly<{ status: 'claimed'; newlyAcquired: boolean }>
  | Extract<ComposerMediaStageInspection, { status: 'unavailable' }>;

export type ComposerMediaStageStore = Readonly<{
  finalizeUpload: (input: Readonly<{
    tempPath: string;
    sizeBytes: number;
    sha256: string;
    executionTarget: SessionExecutionTargetV1;
    owner: PluginContributionIdentityV1;
    mediaKind: ComposerContentMediaKindV1;
    mimeType: ComposerContentMimeTypeV1;
    name: string;
  }>) => Promise<ComposerMediaStageFinalizeResult>;
  inspectForFinalization: (input: Readonly<{
    handle: ComposerContentHandleV1;
    executionTarget: SessionExecutionTargetV1;
    owner: PluginContributionIdentityV1;
    claimant?: ComposerMediaStageClaimant;
  }>) => Promise<ComposerMediaStageInspection>;
  claim: (input: Readonly<{
    handle: ComposerContentHandleV1;
    executionTarget: SessionExecutionTargetV1;
    owner: PluginContributionIdentityV1;
    claimant: ComposerMediaStageClaimant;
  }>) => Promise<ComposerMediaStageClaimResult>;
  release: (input: Readonly<{
    handle: ComposerContentHandleV1;
    executionTarget: SessionExecutionTargetV1;
    owner: PluginContributionIdentityV1;
    claimant?: ComposerMediaStageClaimant;
  }>) => Promise<ComposerMediaStageReleaseResult>;
  forkClaimForSubmission: (input: Readonly<{
    handle: ComposerContentHandleV1;
    executionTarget: SessionExecutionTargetV1;
    owner: PluginContributionIdentityV1;
    sourceClaimant: ComposerMediaStageClaimant;
    destinationClaimant: ComposerMediaStageClaimant;
    messageLocalId: string;
  }>) => Promise<ComposerMediaStageClaimResult & Readonly<{ handle?: ComposerContentHandleV1 }>>;
}>;

function unavailable(reason: Extract<ComposerMediaStageInspection, { status: 'unavailable' }>['reason']): Extract<ComposerMediaStageInspection, { status: 'unavailable' }> {
  return { status: 'unavailable', reason };
}

function failure(code: ComposerMediaStageFailureCode, error: string): ComposerMediaStageFailure {
  return { success: false, code, error };
}

function sameExecutionTarget(
  left: SessionExecutionTargetV1,
  right: SessionExecutionTargetV1,
): boolean {
  return left.serverId === right.serverId && left.machineId === right.machineId;
}

function sameOwner(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function readManifest(value: unknown): ComposerMediaStageManifest | null {
  if (!isRecord(value) || !hasExactKeys(value, ['v', 'createdAtMs', 'handle'])) return null;
  if (value.v !== MANIFEST_VERSION) return null;
  const createdAtMs = value.createdAtMs;
  if (typeof createdAtMs !== 'number' || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0) return null;
  const handle = ComposerContentHandleV1Schema.safeParse(value.handle);
  if (!handle.success) return null;
  return {
    v: MANIFEST_VERSION,
    createdAtMs,
    handle: handle.data,
  };
}

function readClaimant(value: unknown): ComposerMediaStageClaimant | null {
  if (!isRecord(value) || !hasExactKeys(value, ['composer', 'attachmentInstanceId'])) return null;
  const composer = ComposerRefV1Schema.safeParse(value.composer);
  const attachmentInstanceId = ComposerInstanceIdSchema.safeParse(value.attachmentInstanceId);
  return composer.success && attachmentInstanceId.success
    ? { composer: composer.data, attachmentInstanceId: attachmentInstanceId.data }
    : null;
}

function sameClaimant(left: ComposerMediaStageClaimant, right: ComposerMediaStageClaimant): boolean {
  return left.attachmentInstanceId === right.attachmentInstanceId
    && composerRefsV1Equal(left.composer, right.composer);
}

function deterministicStageId(input: string): string {
  const bytes = Buffer.from(createHash('sha256').update(input).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readStageClaim(
  directory: string,
): Promise<ComposerMediaStageClaimant | null | 'unattachedRelease' | 'corrupt'> {
  const path = join(directory, CLAIM_FILE_NAME);
  const stat = await lstat(path).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MANIFEST_MAX_BYTES) {
    return 'corrupt';
  }
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return 'corrupt';
  try {
    const value = JSON.parse(raw) as unknown;
    if (isRecord(value) && hasExactKeys(value, ['unattachedRelease']) && value.unattachedRelease === true) {
      return 'unattachedRelease';
    }
    return readClaimant(value) ?? 'corrupt';
  } catch {
    return 'corrupt';
  }
}

function normalizeSha256(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function readPositiveSafeInteger(value: number): number | null {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeSupportedMimeType(value: ComposerContentMimeTypeV1): SupportedSessionMediaMimeType {
  return value as SupportedSessionMediaMimeType;
}

function isWebmHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) {
    return false;
  }
  return Buffer.from(bytes).includes(Buffer.from('webm', 'ascii'));
}

async function readPrefix(path: string, maxBytes: number): Promise<Buffer | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const bytes = Buffer.alloc(Math.max(1, maxBytes));
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    return bytes.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function hashFile(path: string): Promise<string | null> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/** Verifies staged bytes against their declared handle: size, digest and sniffed container. */
async function verifyContentFile(input: Readonly<{
  path: string;
  handle: ComposerContentHandleV1;
}>): Promise<boolean> {
  const fileStat = await lstat(input.path).catch(() => null);
  if (!fileStat || !fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== input.handle.sizeBytes) {
    return false;
  }
  const actualSha256 = await hashFile(input.path);
  if (!actualSha256 || actualSha256 !== input.handle.sha256.toLowerCase()) return false;

  const prefix = await readPrefix(input.path, MIME_SNIFF_BYTES);
  if (!prefix) return false;
  const mimeType = normalizeSupportedMimeType(input.handle.mimeType);
  if (isSessionMediaImageMimeType(mimeType)) {
    return sniffSessionMediaMimeType(prefix) === mimeType;
  }
  return input.handle.mediaKind === 'video' && mimeType === 'video/webm' && isWebmHeader(prefix);
}

async function readBoundedManifest(path: string): Promise<ComposerMediaStageManifest | null> {
  const manifestStat = await lstat(path).catch(() => null);
  if (
    !manifestStat?.isFile()
    || manifestStat.isSymbolicLink()
    || manifestStat.size <= 0
    || manifestStat.size > MANIFEST_MAX_BYTES
  ) {
    return null;
  }
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    return readManifest(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function stageDirectory(rootDirectory: string, id: string): string {
  return join(rootDirectory, COMPLETED_DIRECTORY_NAME, id);
}

function isStageId(value: string): boolean {
  return STAGE_ID_PATTERN.test(value);
}

function isContainedPath(rootDirectory: string, candidatePath: string): boolean {
  const containedPath = relative(rootDirectory, candidatePath);
  return containedPath !== ''
    && containedPath !== '..'
    && !containedPath.startsWith(`..${sep}`)
    && !isAbsolute(containedPath);
}

async function resolveStageNamespace(rootDirectory: string, name: string): Promise<string | null> {
  const canonicalRoot = await realpath(rootDirectory).catch(() => null);
  if (!canonicalRoot) return null;

  const namespacePath = join(canonicalRoot, name);
  const namespaceStat = await lstat(namespacePath).catch(() => null);
  if (!namespaceStat?.isDirectory() || namespaceStat.isSymbolicLink()) return null;

  const canonicalNamespace = await realpath(namespacePath).catch(() => null);
  if (!canonicalNamespace || !isContainedPath(canonicalRoot, canonicalNamespace)) return null;
  return canonicalNamespace;
}

async function removeStageEntryFromNamespace(namespaceDirectory: string, id: string): Promise<void> {
  if (!isStageId(id)) return;
  const entryPath = join(namespaceDirectory, id);
  if (!isContainedPath(namespaceDirectory, entryPath)) return;

  const entryStat = await lstat(entryPath).catch(() => null);
  if (!entryStat?.isDirectory() || entryStat.isSymbolicLink()) return;

  const canonicalEntry = await realpath(entryPath).catch(() => null);
  if (!canonicalEntry || !isContainedPath(namespaceDirectory, canonicalEntry)) return;
  await rm(canonicalEntry, { recursive: true, force: true }).catch(() => undefined);
}

async function sweepCompletedStages(input: Readonly<{
  rootDirectory: string;
  now: number;
  orphanTtlMs: number;
}>): Promise<void> {
  const completedDirectory = await resolveStageNamespace(input.rootDirectory, COMPLETED_DIRECTORY_NAME);
  if (!completedDirectory) return;

  const entries = await readdir(completedDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isStageId(entry.name)) continue;

    const entryPath = join(completedDirectory, entry.name);
    const entryStat = await lstat(entryPath).catch(() => null);
    if (!entryStat?.isDirectory() || entryStat.isSymbolicLink() || !Number.isFinite(entryStat.mtimeMs)) {
      continue;
    }

    const manifest = await readBoundedManifest(join(entryPath, MANIFEST_FILE_NAME));
    const createdAtMs = manifest?.handle.id === entry.name
      ? manifest.createdAtMs
      : entryStat.mtimeMs;
    if (!isExpired(createdAtMs, input.now, input.orphanTtlMs)) {
      continue;
    }
    const claim = await readStageClaim(entryPath);
    if (claim === 'corrupt') continue;
    if (claim !== null && claim !== 'unattachedRelease') continue;
    await removeStageEntryFromNamespace(completedDirectory, entry.name);
  }
}

async function sweepPendingStages(input: Readonly<{
  rootDirectory: string;
  now: number;
  orphanTtlMs: number;
}>): Promise<void> {
  const pendingDirectory = await resolveStageNamespace(input.rootDirectory, PENDING_DIRECTORY_NAME);
  if (!pendingDirectory) return;

  const entries = await readdir(pendingDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isStageId(entry.name)) continue;

    const entryPath = join(pendingDirectory, entry.name);
    const entryStat = await lstat(entryPath).catch(() => null);
    if (
      !entryStat?.isDirectory()
      || entryStat.isSymbolicLink()
      || !Number.isFinite(entryStat.mtimeMs)
      || !isExpired(entryStat.mtimeMs, input.now, input.orphanTtlMs)
    ) {
      continue;
    }
    await removeStageEntryFromNamespace(pendingDirectory, entry.name);
  }
}

async function sweepExpiredOrphanedStages(input: Readonly<{
  rootDirectory: string;
  now: () => number;
  orphanTtlMs: number;
}>): Promise<void> {
  const currentTime = input.now();
  if (!Number.isFinite(currentTime)) return;
  await Promise.all([
    sweepCompletedStages({
      rootDirectory: input.rootDirectory,
      now: currentTime,
      orphanTtlMs: input.orphanTtlMs,
    }),
    sweepPendingStages({
      rootDirectory: input.rootDirectory,
      now: currentTime,
      orphanTtlMs: input.orphanTtlMs,
    }),
  ]);
}

export async function runComposerMediaStageStartupMaintenance(input: Readonly<{
  rootDirectory: string;
  now?: () => number;
  orphanTtlMs?: number;
}>): Promise<void> {
  await sweepExpiredOrphanedStages({
    rootDirectory: input.rootDirectory,
    now: input.now ?? Date.now,
    orphanTtlMs: Math.max(
      1,
      Math.floor(input.orphanTtlMs ?? COMPOSER_MEDIA_STAGE_ORPHAN_TTL_MS),
    ),
  });
}

function isExpired(createdAtMs: number, now: number, orphanTtlMs: number): boolean {
  return now >= createdAtMs + orphanTtlMs;
}

function createCanonicalHandle(input: Readonly<{
  id: string;
  executionTarget: SessionExecutionTargetV1;
  owner: PluginContributionIdentityV1;
  mediaKind: ComposerContentMediaKindV1;
  mimeType: ComposerContentMimeTypeV1;
  name: string;
  sizeBytes: number;
  sha256: string;
}>): ComposerContentHandleV1 | null {
  const sanitizedName = sanitizeSessionMediaFileName(input.name, 'media');
  const parsed = ComposerContentHandleV1Schema.safeParse({
    v: MANIFEST_VERSION,
    id: input.id,
    executionTarget: input.executionTarget,
    owner: input.owner,
    mediaKind: input.mediaKind,
    mimeType: input.mimeType,
    name: sanitizedName,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
  });
  return parsed.success ? parsed.data : null;
}

export function createComposerMediaStageStore(input: Readonly<{
  rootDirectory: string;
  executionTarget: SessionExecutionTargetV1;
  now?: () => number;
  orphanTtlMs?: number;
}>): ComposerMediaStageStore {
  const now = input.now ?? Date.now;
  const orphanTtlMs = Math.max(1, Math.floor(input.orphanTtlMs ?? COMPOSER_MEDIA_STAGE_ORPHAN_TTL_MS));
  const completedDirectory = join(input.rootDirectory, COMPLETED_DIRECTORY_NAME);
  const pendingDirectory = join(input.rootDirectory, PENDING_DIRECTORY_NAME);

  const removeStage = async (id: string): Promise<void> => {
    const canonicalCompletedDirectory = await resolveStageNamespace(
      input.rootDirectory,
      COMPLETED_DIRECTORY_NAME,
    );
    if (!canonicalCompletedDirectory) return;
    await removeStageEntryFromNamespace(canonicalCompletedDirectory, id);
  };

  const inspectStage = async (request: Readonly<{
    handle: ComposerContentHandleV1;
    executionTarget: SessionExecutionTargetV1;
    owner: PluginContributionIdentityV1;
    claimant?: ComposerMediaStageClaimant;
  }>): Promise<ComposerMediaStageInspection> => {
    const handle = ComposerContentHandleV1Schema.safeParse(request.handle);
    if (!handle.success) return unavailable('corrupt');
    if (!sameExecutionTarget(request.executionTarget, input.executionTarget)
      || !sameExecutionTarget(handle.data.executionTarget, input.executionTarget)) {
      return unavailable('targetMismatch');
    }
    if (!sameOwner(request.owner, handle.data.owner)) return unavailable('ownerMismatch');

    const directory = stageDirectory(input.rootDirectory, handle.data.id);
    const manifest = await readBoundedManifest(join(directory, MANIFEST_FILE_NAME));
    if (!manifest) {
      const exists = await lstat(directory).then(() => true).catch(() => false);
      if (exists) await removeStage(handle.data.id);
      return unavailable(exists ? 'corrupt' : 'notFound');
    }
    if (isExpired(manifest.createdAtMs, now(), orphanTtlMs)) {
      const claim = await readStageClaim(directory);
      if (claim === 'corrupt') return unavailable('corrupt');
      if (claim !== null && claim !== 'unattachedRelease') {
        const claimant = request.claimant ? readClaimant(request.claimant) : null;
        if (claimant && sameClaimant(claim, claimant)) {
          // Valid claimed stages remain inspectable and exactly releasable; TTL
          // cleanup only owns unattached or explicitly unattached-release stages.
        } else {
          return unavailable('expired');
        }
      } else {
        await removeStage(handle.data.id);
        return unavailable('expired');
      }
    }
    if (!sameExecutionTarget(manifest.handle.executionTarget, input.executionTarget)) {
      await removeStage(handle.data.id);
      return unavailable('corrupt');
    }
    // The caller's opaque claim is untrusted. A foreign or altered claim must
    // never make its real completed stage destructible.
    if (!sameOwner(manifest.handle.owner, request.owner)) return unavailable('ownerMismatch');
    if (JSON.stringify(manifest.handle) !== JSON.stringify(handle.data)) return unavailable('corrupt');

    const filePath = join(directory, CONTENT_FILE_NAME);
    if (!await verifyContentFile({ path: filePath, handle: manifest.handle })) {
      await removeStage(handle.data.id);
      return unavailable('corrupt');
    }
    return {
      status: 'ready',
      handle: manifest.handle,
      filePath,
      mediaKind: manifest.handle.mediaKind,
      mimeType: manifest.handle.mimeType,
      name: manifest.handle.name,
      sizeBytes: manifest.handle.sizeBytes,
      sha256: manifest.handle.sha256,
    };
  };

  const claim: ComposerMediaStageStore['claim'] = async (request) => {
    const claimant = readClaimant(request.claimant);
    if (!claimant) return unavailable('corrupt');
    const inspected = await inspectStage(request);
    if (inspected.status !== 'ready') return inspected;

    const directory = stageDirectory(input.rootDirectory, inspected.handle.id);
    const existing = await readStageClaim(directory);
    if (existing === 'corrupt') return unavailable('corrupt');
    if (existing === 'unattachedRelease') return unavailable('claimedElsewhere');
    if (existing) {
      return sameClaimant(existing, claimant)
        ? { status: 'claimed', newlyAcquired: false }
        : unavailable('claimedElsewhere');
    }

    // Each contender writes complete private bytes first. The hard-link is the
    // one atomic first-claim decision; a loser reads the winner and succeeds
    // only when it names the exact same Composer attachment.
    const candidatePath = join(directory, `.claim-${randomUUID()}.json`);
    let newlyAcquired = false;
    try {
      await writeFile(candidatePath, JSON.stringify(claimant), { encoding: 'utf8', flag: 'wx' });
      await link(candidatePath, join(directory, CLAIM_FILE_NAME));
      newlyAcquired = true;
    } catch {
      // A concurrent first claimant is expected. All other failures are
      // adjudicated by reading the canonical claim below.
    } finally {
      await rm(candidatePath, { force: true }).catch(() => undefined);
    }
    const admitted = await readStageClaim(directory);
    if (admitted === 'corrupt' || admitted === null) return unavailable('corrupt');
    if (admitted === 'unattachedRelease') return unavailable('claimedElsewhere');
    return sameClaimant(admitted, claimant)
      ? { status: 'claimed', newlyAcquired }
      : unavailable('claimedElsewhere');
  };

  const inspectForFinalization: ComposerMediaStageStore['inspectForFinalization'] = async (request) => {
    if (request.claimant) {
      const claimed = await claim({ ...request, claimant: request.claimant });
      if (claimed.status !== 'claimed') return claimed;
    }
    return await inspectStage(request);
  };

  const forkClaimForSubmission: ComposerMediaStageStore['forkClaimForSubmission'] = async (request) => {
    const sourceClaimant = readClaimant(request.sourceClaimant);
    const destinationClaimant = readClaimant(request.destinationClaimant);
    const messageLocalId = PendingLocalIdSchema.safeParse(request.messageLocalId);
    if (!sourceClaimant || !destinationClaimant || !messageLocalId.success) return unavailable('corrupt');
    if (sameClaimant(sourceClaimant, destinationClaimant)) {
      // A same-document capture must still submit against its own fork. Keeping
      // the original handle here would let a concurrent draft removal delete the
      // exact bytes this submission captured between inspection and Session
      // persistence. Rejoin (or acquire) the source claim idempotently, then
      // fork below like every other submission snapshot.
      const claimed = await claim({
        handle: request.handle,
        executionTarget: request.executionTarget,
        owner: request.owner,
        claimant: sourceClaimant,
      });
      if (claimed.status !== 'claimed') return claimed;
    }

    const sourceInspection = await inspectStage({ ...request, claimant: sourceClaimant });
    if (sourceInspection.status !== 'ready') return sourceInspection;
    const sourceClaim = await readStageClaim(stageDirectory(input.rootDirectory, sourceInspection.handle.id));
    if (sourceClaim === 'corrupt') return unavailable('corrupt');
    if (!sourceClaim || sourceClaim === 'unattachedRelease' || !sameClaimant(sourceClaim, sourceClaimant)) {
      return unavailable('claimedElsewhere');
    }

    const forkId = deterministicStageId(createCanonicalJsonSigningInput({
      domain: 'composer-media-stage-submission-fork-v1',
      sourceHandle: sourceInspection.handle,
      sourceClaimant,
      destinationClaimant,
      messageLocalId: messageLocalId.data,
    }));
    const forkHandle = createCanonicalHandle({
      id: forkId,
      executionTarget: sourceInspection.handle.executionTarget,
      owner: sourceInspection.handle.owner,
      mediaKind: sourceInspection.handle.mediaKind,
      mimeType: sourceInspection.handle.mimeType,
      name: sourceInspection.handle.name,
      sizeBytes: sourceInspection.handle.sizeBytes,
      sha256: sourceInspection.handle.sha256,
    });
    if (!forkHandle) return unavailable('corrupt');

    const forkDirectory = stageDirectory(input.rootDirectory, forkId);
    const existingFork = await inspectStage({
      handle: forkHandle,
      executionTarget: request.executionTarget,
      owner: request.owner,
      claimant: destinationClaimant,
    });
    if (existingFork.status === 'ready') {
      const existingClaim = await readStageClaim(forkDirectory);
      if (existingClaim === 'corrupt') return unavailable('corrupt');
      if (!existingClaim || existingClaim === 'unattachedRelease' || !sameClaimant(existingClaim, destinationClaimant)) {
        return unavailable('claimedElsewhere');
      }
      return { status: 'claimed', newlyAcquired: false, handle: existingFork.handle };
    }
    if (existingFork.reason !== 'notFound') return existingFork;

    const pendingStageDirectory = join(pendingDirectory, randomUUID());
    try {
      await mkdir(pendingDirectory, { recursive: true });
      await mkdir(completedDirectory, { recursive: true });
      await mkdir(pendingStageDirectory);
      const contentPath = join(pendingStageDirectory, CONTENT_FILE_NAME);
      await copyFile(sourceInspection.filePath, contentPath);
      if (!await verifyContentFile({ path: contentPath, handle: forkHandle })) {
        await rm(pendingStageDirectory, { recursive: true, force: true });
        return unavailable('corrupt');
      }
      const manifest: ComposerMediaStageManifest = {
        v: MANIFEST_VERSION,
        createdAtMs: now(),
        handle: forkHandle,
      };
      await writeFile(join(pendingStageDirectory, MANIFEST_FILE_NAME), JSON.stringify(manifest), {
        encoding: 'utf8',
        flag: 'wx',
      });
      await writeFile(join(pendingStageDirectory, CLAIM_FILE_NAME), JSON.stringify(destinationClaimant), {
        encoding: 'utf8',
        flag: 'wx',
      });
      await rename(pendingStageDirectory, forkDirectory);
    } catch {
      await rm(pendingStageDirectory, { recursive: true, force: true }).catch(() => undefined);
      const retry = await inspectStage({
        handle: forkHandle,
        executionTarget: request.executionTarget,
        owner: request.owner,
        claimant: destinationClaimant,
      });
      if (retry.status !== 'ready') return retry;
      const retryClaim = await readStageClaim(forkDirectory);
      if (retryClaim === 'corrupt') return unavailable('corrupt');
      if (!retryClaim || retryClaim === 'unattachedRelease' || !sameClaimant(retryClaim, destinationClaimant)) {
        return unavailable('claimedElsewhere');
      }
      return { status: 'claimed', newlyAcquired: false, handle: retry.handle };
    }
    return { status: 'claimed', newlyAcquired: true, handle: forkHandle };
  };

  return {
    finalizeUpload: async (request) => {
      const sizeBytes = readPositiveSafeInteger(request.sizeBytes);
      const sha256 = normalizeSha256(request.sha256);
      if (!sizeBytes || !sha256) return failure('invalid_metadata', 'Invalid Composer media metadata');
      if (!sameExecutionTarget(request.executionTarget, input.executionTarget)) {
        return failure('target_mismatch', 'Composer media stage target does not match target daemon');
      }
      const handle = createCanonicalHandle({
        id: randomUUID(),
        executionTarget: request.executionTarget,
        owner: request.owner,
        mediaKind: request.mediaKind,
        mimeType: request.mimeType,
        name: request.name,
        sizeBytes,
        sha256,
      });
      if (!handle || sessionMediaKindForMimeType(normalizeSupportedMimeType(handle.mimeType)) !== handle.mediaKind) {
        return failure('invalid_metadata', 'Invalid Composer media metadata');
      }
      if (!await verifyContentFile({ path: request.tempPath, handle })) {
        return failure('source_corrupt', 'Composer media bytes do not match declared metadata');
      }

      const pendingStageDirectory = join(pendingDirectory, randomUUID());
      const destinationDirectory = stageDirectory(input.rootDirectory, handle.id);
      try {
        await mkdir(pendingDirectory, { recursive: true });
        await mkdir(completedDirectory, { recursive: true });
        await mkdir(pendingStageDirectory);
        const contentPath = join(pendingStageDirectory, CONTENT_FILE_NAME);
        await copyFile(request.tempPath, contentPath);
        if (!await verifyContentFile({ path: contentPath, handle })) {
          await rm(pendingStageDirectory, { recursive: true, force: true });
          return failure('source_corrupt', 'Composer media bytes changed while being finalized');
        }
        const manifest: ComposerMediaStageManifest = {
          v: MANIFEST_VERSION,
          createdAtMs: now(),
          handle,
        };
        await writeFile(
          join(pendingStageDirectory, MANIFEST_FILE_NAME),
          JSON.stringify(manifest),
          { encoding: 'utf8', flag: 'wx' },
        );
        await rename(pendingStageDirectory, destinationDirectory);
        return { success: true, handle };
      } catch {
        await rm(pendingStageDirectory, { recursive: true, force: true }).catch(() => undefined);
        return failure('stage_unavailable', 'Unable to finalize Composer media stage');
      }
    },
    claim,
    inspectForFinalization,
    forkClaimForSubmission,
    release: async (request) => {
      const inspected = await inspectStage(request);
      if (inspected.status !== 'ready') return inspected;
      const existingClaim = await readStageClaim(stageDirectory(input.rootDirectory, inspected.handle.id));
      if (existingClaim === 'corrupt') return unavailable('corrupt');
      if (request.claimant) {
        const claimant = readClaimant(request.claimant);
        if (!claimant) return unavailable('corrupt');
        if (existingClaim === null) {
          const claimed = await claim({ ...request, claimant });
          if (claimed.status !== 'claimed') return claimed;
        } else if (existingClaim === 'unattachedRelease') {
          return unavailable('claimedElsewhere');
        } else if (!sameClaimant(existingClaim, claimant)) {
          // A different host-created attachment identity never deletes the
          // stage. The same identity may legitimately carry a different
          // Composer location after draft admission.
          return unavailable('claimedElsewhere');
        }
      } else {
        if (existingClaim !== null) return unavailable('claimedElsewhere');
        const directory = stageDirectory(input.rootDirectory, inspected.handle.id);
        const candidatePath = join(directory, `.release-${randomUUID()}.json`);
        try {
          await writeFile(candidatePath, JSON.stringify({ unattachedRelease: true }), {
            encoding: 'utf8',
            flag: 'wx',
          });
          await link(candidatePath, join(directory, CLAIM_FILE_NAME));
        } catch {
          // A concurrent attachment claim is adjudicated below.
        } finally {
          await rm(candidatePath, { force: true }).catch(() => undefined);
        }
        const admitted = await readStageClaim(directory);
        if (admitted !== 'unattachedRelease') {
          return admitted === 'corrupt' || admitted === null
            ? unavailable('corrupt')
            : unavailable('claimedElsewhere');
        }
      }
      await removeStage(inspected.handle.id);
      return { status: 'released' };
    },
  };
}

/**
 * Production callers use this factory instead of deriving an active-server
 * path themselves. The completed-stage root is one daemon-owned namespace.
 */
export function createActiveDaemonComposerMediaStageStore(input: Readonly<{
  machineId: string;
}>): ComposerMediaStageStore {
  return createComposerMediaStageStore({
    rootDirectory: join(configuration.activeServerDir, 'composer-media-stages'),
    executionTarget: {
      serverId: configuration.activeServerId,
      machineId: input.machineId,
    },
  });
}

export async function runActiveDaemonComposerMediaStageStartupMaintenance(): Promise<void> {
  await runComposerMediaStageStartupMaintenance({
    rootDirectory: join(configuration.activeServerDir, 'composer-media-stages'),
  });
}
