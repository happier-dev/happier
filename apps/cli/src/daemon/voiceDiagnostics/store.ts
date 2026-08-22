import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  statfs as nodeStatfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  VoiceSpeechDiagnosticFormatV1,
  VoiceSpeechDiagnosticsBackupPolicyV1,
  VoiceSpeechDiagnosticsSettingsV1,
} from '@happier-dev/protocol';
import { resolveVoiceSpeechDiagnosticsStoragePolicy } from '@happier-dev/protocol';

export type VoiceDiagnosticPolicy = Readonly<Partial<VoiceSpeechDiagnosticsSettingsV1> & {
  enabled: boolean;
  consentVersion: 1 | null;
  minFreeBytes?: number;
}>;

export type VoiceDiagnosticCapture = Readonly<{
  direction: 'stt_input' | 'tts_output';
  format: VoiceSpeechDiagnosticFormatV1;
  bytes: Uint8Array;
  durationMs: number | null;
  sessionId: string;
  providerId: string;
  attemptId: string;
  authorizationId?: string;
  signal?: AbortSignal;
}>;

/** A daemon-owned staged audio file copied atomically into diagnostic retention. */
export type VoiceDiagnosticFileCapture = Omit<VoiceDiagnosticCapture, 'bytes'> & Readonly<{
  filePath: string;
}>;

export type VoiceDiagnosticArtifact = Readonly<{
  id: string;
  createdAtMs: number;
  direction: VoiceDiagnosticCapture['direction'];
  format: VoiceDiagnosticCapture['format'];
  durationMs: number | null;
  byteLength: number;
  audioPath: string;
  metadataPath: string;
}>;

export type VoiceDiagnosticStoreInspection = Readonly<{
  artifacts: readonly VoiceDiagnosticArtifact[];
  ownedEntryCount: number;
  cleanupRequired: boolean;
}>;

export class VoiceDiagnosticCleanupError extends Error {
  readonly code = 'voice_diagnostics_cleanup_failed';

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'voice_diagnostics_cleanup_failed', { cause });
    this.name = 'VoiceDiagnosticCleanupError';
  }
}

type VoiceDiagnosticMetadataV1 = Readonly<{
  v: 1;
  id: string;
  createdAtMs: number;
  direction: VoiceDiagnosticCapture['direction'];
  format: VoiceDiagnosticCapture['format'];
  durationMs: number | null;
  byteLength: number;
  sessionRef: string;
  providerRef: string;
  attemptRef: string;
}>;

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1_000;
const DEFAULT_MIN_FREE_BYTES = 100 * 1024 * 1024;

function abortError(): Error {
  return Object.assign(new Error('voice_diagnostics_cancelled'), { name: 'AbortError' });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
    ? Math.floor(value)
    : fallback;
}

function opaqueRef(value: string): string {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

const SUPPORTED_FORMATS = new Set<VoiceSpeechDiagnosticFormatV1>([
  'pcm16', 'wav', 'webm', 'ogg', 'mpeg', 'mp4', 'flac',
]);
const DIAGNOSTIC_ARTIFACT_ID_PATTERN = /^[a-f0-9-]{8,96}$/;
const DIAGNOSTIC_TEMP_NONCE_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CACHE_DIRECTORY_TAG_NAME = 'CACHEDIR.TAG';
const CACHE_DIRECTORY_TAG_CONTENT = 'Signature: 8a477f597d28d172789f06886806bc55\n';
const BACKUP_POLICY = Object.freeze(resolveVoiceSpeechDiagnosticsStoragePolicy('daemon_desktop'));

function isDiagnosticOwnedFilename(name: string): boolean {
  const separator = name.lastIndexOf('.');
  if (separator <= 0) return false;
  const id = name.slice(0, separator);
  const extension = name.slice(separator + 1);
  return DIAGNOSTIC_ARTIFACT_ID_PATTERN.test(id)
    && (extension === 'json' || SUPPORTED_FORMATS.has(extension as VoiceSpeechDiagnosticFormatV1));
}

function isDiagnosticOwnedTempFilename(name: string): boolean {
  const separator = name.lastIndexOf('.tmp-');
  if (separator <= 0) return false;
  return isDiagnosticOwnedFilename(name.slice(0, separator))
    && DIAGNOSTIC_TEMP_NONCE_PATTERN.test(name.slice(separator + '.tmp-'.length));
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16)
    | (bytes[offset + 3]! << 24)) >>> 0;
}

/** Reads PCM WAV duration without trusting fixed chunk offsets. */
export function resolveVoiceDiagnosticWavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 12 || readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') return null;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = readUint32Le(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (chunkSize > bytes.byteLength - dataOffset) return null;
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      const audioFormat = readUint16Le(bytes, dataOffset);
      const candidateByteRate = readUint32Le(bytes, dataOffset + 8);
      if (audioFormat !== 1 || candidateByteRate <= 0) return null;
      byteRate = candidateByteRate;
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }
    const paddedSize = chunkSize + (chunkSize % 2);
    if (paddedSize > bytes.byteLength - dataOffset) return null;
    offset = dataOffset + paddedSize;
  }
  if (byteRate === null || dataBytes === null) return null;
  return Math.round((dataBytes / byteRate) * 1_000);
}

/**
 * Reads only the canonical PCM WAV header written by daemon streaming capture. Other WAV
 * layouts remain valid captures with an honest unknown duration rather than loading audio
 * solely to calculate metadata.
 */
async function resolveCanonicalWavDurationMsFromFile(filePath: string, fileByteLength: number): Promise<number | null> {
  if (fileByteLength < 44) return null;
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(44);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    if (bytesRead !== header.byteLength) return null;
    if (
      readAscii(header, 0, 4) !== 'RIFF'
      || readAscii(header, 8, 4) !== 'WAVE'
      || readAscii(header, 12, 4) !== 'fmt '
      || readUint32Le(header, 16) !== 16
      || readUint16Le(header, 20) !== 1
      || readAscii(header, 36, 4) !== 'data'
    ) {
      return null;
    }
    const byteRate = readUint32Le(header, 28);
    const dataBytes = readUint32Le(header, 40);
    if (byteRate <= 0 || dataBytes > fileByteLength - header.byteLength) return null;
    return Math.round((dataBytes / byteRate) * 1_000);
  } finally {
    await handle.close();
  }
}

export function resolveVoiceDiagnosticRoot(happyHomeDir: string): string {
  if (!happyHomeDir || happyHomeDir.trim() !== happyHomeDir || !isAbsolute(happyHomeDir)) {
    throw new TypeError('voice_diagnostics_home_invalid');
  }
  return join(happyHomeDir, 'voice', 'diagnostics', 'v1');
}

async function ensurePrivateDirectoryTree(happyHomeDir: string, root: string): Promise<void> {
  const directories = [
    resolve(happyHomeDir),
    join(happyHomeDir, 'voice'),
    join(happyHomeDir, 'voice', 'diagnostics'),
    root,
  ];
  for (const directory of directories) {
    await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('voice_diagnostics_root_unsafe');
    }
    if (process.platform !== 'win32') await chmod(directory, 0o700);
  }
  const tagPath = join(root, CACHE_DIRECTORY_TAG_NAME);
  try {
    const existing = await lstat(tagPath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('voice_diagnostics_backup_tag_unsafe');
    if (await readFile(tagPath, 'utf8') !== CACHE_DIRECTORY_TAG_CONTENT) {
      await writeFile(tagPath, CACHE_DIRECTORY_TAG_CONTENT, { mode: 0o600 });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeFile(tagPath, CACHE_DIRECTORY_TAG_CONTENT, { flag: 'wx', mode: 0o600 });
  }
  if (process.platform !== 'win32') await chmod(tagPath, 0o600);
}

function parseMetadata(raw: unknown): VoiceDiagnosticMetadataV1 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<VoiceDiagnosticMetadataV1>;
  if (value.v !== 1 || typeof value.id !== 'string' || !DIAGNOSTIC_ARTIFACT_ID_PATTERN.test(value.id)) return null;
  if (typeof value.createdAtMs !== 'number' || !Number.isFinite(value.createdAtMs)) return null;
  if (value.direction !== 'stt_input' && value.direction !== 'tts_output') return null;
  if (!SUPPORTED_FORMATS.has(value.format as VoiceSpeechDiagnosticFormatV1)) return null;
  if (value.durationMs !== null && (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0)) return null;
  if (typeof value.byteLength !== 'number' || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) return null;
  if (typeof value.sessionRef !== 'string' || typeof value.providerRef !== 'string' || typeof value.attemptRef !== 'string') return null;
  return value as VoiceDiagnosticMetadataV1;
}

function toArtifact(root: string, metadata: VoiceDiagnosticMetadataV1): VoiceDiagnosticArtifact {
  return {
    id: metadata.id,
    createdAtMs: metadata.createdAtMs,
    direction: metadata.direction,
    format: metadata.format,
    durationMs: metadata.durationMs,
    byteLength: metadata.byteLength,
    audioPath: join(root, `${metadata.id}.${metadata.format}`),
    metadataPath: join(root, `${metadata.id}.json`),
  };
}

export function createVoiceDiagnosticStore(input: Readonly<{
  happyHomeDir: string;
  policy: VoiceDiagnosticPolicy;
  now?: () => number;
  statfs?: (path: string) => Promise<Readonly<{ bavail: number | bigint; bsize: number | bigint }>>;
  removeFile?: (path: string) => Promise<void>;
  readArtifactFile?: typeof readFile;
}>): Readonly<{
  root: string;
  backupPolicy: VoiceSpeechDiagnosticsBackupPolicyV1;
  capture(capture: VoiceDiagnosticCapture): Promise<VoiceDiagnosticArtifact | null>;
  captureFile(capture: VoiceDiagnosticFileCapture): Promise<VoiceDiagnosticArtifact | null>;
  list(): Promise<readonly VoiceDiagnosticArtifact[]>;
  inspect(): Promise<VoiceDiagnosticStoreInspection>;
  prune(): Promise<void>;
  deleteAll(): Promise<void>;
  resolveArtifactForExport(artifactId: string): Promise<VoiceDiagnosticArtifact | null>;
}> {
  const root = resolveVoiceDiagnosticRoot(input.happyHomeDir);
  const now = input.now ?? Date.now;
  const maxAgeMs = boundedInteger(input.policy.maxAgeMs, DEFAULT_MAX_AGE_MS, 0);
  const maxFiles = boundedInteger(input.policy.maxFiles, DEFAULT_MAX_FILES, 1);
  const maxBytes = boundedInteger(input.policy.maxBytes, DEFAULT_MAX_BYTES, 1);
  const maxDurationMs = boundedInteger(input.policy.maxDurationMs, DEFAULT_MAX_DURATION_MS, 1);
  const minFreeBytes = boundedInteger(input.policy.minFreeBytes, DEFAULT_MIN_FREE_BYTES, 0);
  const readStatfs = input.statfs ?? (async (path: string) => await nodeStatfs(path));
  const removeFile = input.removeFile ?? unlink;
  const readArtifactFile = input.readArtifactFile ?? readFile;
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function inspectUnlocked(): Promise<VoiceDiagnosticStoreInspection> {
    await ensurePrivateDirectoryTree(input.happyHomeDir, root);
    const entries = await readdir(root, { withFileTypes: true });
    const ownedFilenames = new Set(entries
      .filter((entry) => !entry.isDirectory()
        && (isDiagnosticOwnedFilename(entry.name) || isDiagnosticOwnedTempFilename(entry.name)))
      .map((entry) => entry.name));
    const committedFilenames = new Set<string>();
    const artifacts: VoiceDiagnosticArtifact[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.includes('.tmp-')) continue;
      try {
        const metadata = parseMetadata(JSON.parse(await readArtifactFile(join(root, entry.name), 'utf8')));
        if (!metadata || entry.name !== `${metadata.id}.json`) continue;
        const artifact = toArtifact(root, metadata);
        const audioMetadata = await lstat(artifact.audioPath);
        if (!audioMetadata.isFile() || audioMetadata.isSymbolicLink() || audioMetadata.size !== metadata.byteLength) continue;
        artifacts.push(artifact);
        committedFilenames.add(entry.name);
        committedFilenames.add(artifact.audioPath.slice(root.length + 1));
      } catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    return {
      artifacts: artifacts.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)),
      ownedEntryCount: ownedFilenames.size,
      cleanupRequired: [...ownedFilenames].some((name) => !committedFilenames.has(name)),
    };
  }

  async function listUnlocked(): Promise<VoiceDiagnosticArtifact[]> {
    return [...(await inspectUnlocked()).artifacts];
  }

  async function settleCleanupOperations(operations: readonly Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(operations);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  }

  async function removeArtifact(artifact: VoiceDiagnosticArtifact): Promise<void> {
    await settleCleanupOperations([
      removeOwnedFile(artifact.audioPath),
      removeOwnedFile(artifact.metadataPath),
    ]);
  }

  async function removeOwnedFile(path: string): Promise<void> {
    try {
      await removeFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new VoiceDiagnosticCleanupError(error);
      }
    }
  }

  async function pruneUnlocked(): Promise<void> {
    const artifacts = await listUnlocked();
    let retained = artifacts;
    const cutoff = now() - maxAgeMs;
    const expired = retained.filter((artifact) => artifact.createdAtMs < cutoff);
    await settleCleanupOperations(expired.map(removeArtifact));
    retained = retained.filter((artifact) => artifact.createdAtMs >= cutoff);

    let totalBytes = retained.reduce((sum, artifact) => sum + artifact.byteLength, 0);
    while (retained.length > maxFiles || totalBytes > maxBytes) {
      const oldest = retained.shift();
      if (!oldest) break;
      totalBytes -= oldest.byteLength;
      await removeArtifact(oldest);
    }

    const retainedFilenames = new Set(retained.flatMap((artifact) => [
      artifact.audioPath.slice(root.length + 1),
      artifact.metadataPath.slice(root.length + 1),
    ]));
    const entries = await readdir(root, { withFileTypes: true });
    await settleCleanupOperations(entries
      .filter((entry) => isDiagnosticOwnedTempFilename(entry.name)
        || (isDiagnosticOwnedFilename(entry.name) && !retainedFilenames.has(entry.name)))
      .map((entry) => removeOwnedFile(join(root, entry.name))));
  }

  async function captureWithWriter(
    capture: Omit<VoiceDiagnosticCapture, 'bytes'>,
    source: Readonly<{
      byteLength: number;
      durationMs: number | null;
      writeAudio: (audioTempPath: string) => Promise<void>;
    }>,
  ): Promise<VoiceDiagnosticArtifact | null> {
    if (!input.policy.enabled || input.policy.consentVersion !== 1) return null;
    if (capture.direction === 'stt_input' && input.policy.captureSttInput !== true) return null;
    if (capture.direction === 'tts_output' && input.policy.captureTtsOutput !== true) return null;
    throwIfAborted(capture.signal);
    if (source.durationMs !== null && (!Number.isFinite(source.durationMs) || source.durationMs < 0 || source.durationMs > maxDurationMs)) {
      throw new Error('voice_diagnostics_duration_exceeded');
    }
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0 || source.byteLength > maxBytes) {
      throw new Error('voice_diagnostics_artifact_too_large');
    }
    await ensurePrivateDirectoryTree(input.happyHomeDir, root);
    await pruneUnlocked();
    const disk = await readStatfs(root);
    const availableBytes = Number(disk.bavail) * Number(disk.bsize);
    if (!Number.isFinite(availableBytes) || availableBytes < source.byteLength + minFreeBytes) {
      throw new Error('voice_diagnostics_disk_headroom');
    }

    const createdAtMs = now();
    const id = `${Math.max(0, Math.floor(createdAtMs)).toString(16)}-${randomUUID()}`;
    const metadata: VoiceDiagnosticMetadataV1 = {
      v: 1,
      id,
      createdAtMs,
      direction: capture.direction,
      format: capture.format,
      durationMs: source.durationMs,
      byteLength: source.byteLength,
      sessionRef: opaqueRef(capture.sessionId),
      providerRef: opaqueRef(capture.providerId),
      attemptRef: opaqueRef(capture.attemptId),
    };
    const artifact = toArtifact(root, metadata);
    const nonce = randomUUID();
    const audioTempPath = `${artifact.audioPath}.tmp-${nonce}`;
    const metadataTempPath = `${artifact.metadataPath}.tmp-${nonce}`;
    try {
      await source.writeAudio(audioTempPath);
      const audioMetadata = await lstat(audioTempPath);
      if (
        !audioMetadata.isFile()
        || audioMetadata.isSymbolicLink()
        || audioMetadata.size !== source.byteLength
      ) {
        throw new Error('voice_diagnostics_staged_audio_invalid');
      }
      throwIfAborted(capture.signal);
      await writeFile(metadataTempPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      throwIfAborted(capture.signal);
      await rename(audioTempPath, artifact.audioPath);
      await rename(metadataTempPath, artifact.metadataPath);
      if (process.platform !== 'win32') {
        await Promise.all([chmod(artifact.audioPath, 0o600), chmod(artifact.metadataPath, 0o600)]);
      }
      await pruneUnlocked();
      return (await listUnlocked()).find((candidate) => candidate.id === artifact.id) ?? null;
    } catch (error) {
      await Promise.all([
        unlink(audioTempPath).catch(() => {}),
        unlink(metadataTempPath).catch(() => {}),
        unlink(artifact.audioPath).catch(() => {}),
        unlink(artifact.metadataPath).catch(() => {}),
      ]);
      throw error;
    }
  }

  return {
    root,
    backupPolicy: BACKUP_POLICY,
    capture: (capture) => enqueue(async () => await captureWithWriter(
      capture,
      {
        byteLength: capture.bytes.byteLength,
        durationMs: capture.durationMs ?? (capture.format === 'wav' ? resolveVoiceDiagnosticWavDurationMs(capture.bytes) : null),
        writeAudio: async (audioTempPath) => {
          await writeFile(audioTempPath, capture.bytes, { flag: 'wx', mode: 0o600 });
        },
      },
    )),
    captureFile: (capture) => enqueue(async () => {
      const sourceMetadata = await lstat(capture.filePath);
      if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink() || !Number.isSafeInteger(sourceMetadata.size)) {
        throw new Error('voice_diagnostics_source_file_invalid');
      }
      const durationMs = capture.durationMs ?? (
        capture.format === 'wav'
          ? await resolveCanonicalWavDurationMsFromFile(capture.filePath, sourceMetadata.size)
          : null
      );
      return await captureWithWriter(
        capture,
        {
          byteLength: sourceMetadata.size,
          durationMs,
          writeAudio: async (audioTempPath) => {
            await copyFile(capture.filePath, audioTempPath, fsConstants.COPYFILE_EXCL);
          },
        },
      );
    }),
    list: () => enqueue(listUnlocked),
    inspect: () => enqueue(inspectUnlocked),
    prune: () => enqueue(pruneUnlocked),
    deleteAll: () => enqueue(async () => {
      await ensurePrivateDirectoryTree(input.happyHomeDir, root);
      const entries = await readdir(root, { withFileTypes: true });
      await settleCleanupOperations(entries
        .filter((entry) => !entry.isDirectory()
          && (isDiagnosticOwnedFilename(entry.name) || isDiagnosticOwnedTempFilename(entry.name)))
        .map((entry) => removeOwnedFile(join(root, entry.name))));
    }),
    resolveArtifactForExport: (artifactId) => enqueue(async () => {
      if (!DIAGNOSTIC_ARTIFACT_ID_PATTERN.test(artifactId)) return null;
      return (await listUnlocked()).find((artifact) => artifact.id === artifactId) ?? null;
    }),
  };
}
