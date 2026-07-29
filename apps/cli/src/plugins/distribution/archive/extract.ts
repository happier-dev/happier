import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { x as extractTar, type ReadEntry } from 'tar';

import { createStreamingIntegrityVerifier } from '../integrity';
import { createPortablePathRegistry, readPortableArchiveEntryPath } from './path';
import {
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
  PortableArchiveError,
  type ExtractedPortableArchive,
  type PortableArchiveErrorCode,
  type PortableArchiveFile,
  type PortableArchiveLimits,
} from './types';

type OwnedExtractionState = { cleanupPromise: Promise<void> | null };
const ownedExtractions = new WeakMap<ExtractedPortableArchive, OwnedExtractionState>();
const MAX_METADATA_ENTRY_BYTES = 1024 * 1024;

export type ExtractPortableTarGzipArchiveParams = Readonly<{
  archivePath: string;
  expectedArchiveBytes: number;
  expectedIntegrity: string;
  stagingParentPath: string;
  stripRootDirectory: string;
  limits?: Partial<PortableArchiveLimits>;
  signal?: AbortSignal;
}>;

function error(code: PortableArchiveErrorCode, message: string, cause?: unknown): PortableArchiveError {
  return new PortableArchiveError(code, message, cause instanceof Error ? { cause } : undefined);
}

function mergeLimits(overrides: Partial<PortableArchiveLimits> | undefined): PortableArchiveLimits {
  const limits = { ...DEFAULT_PORTABLE_ARCHIVE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0) {
      throw error('archive_source_invalid', `Archive limit ${name} must be a non-negative finite number`);
    }
  }
  return limits;
}

function createRootDigest(inventory: readonly PortableArchiveFile[]): `sha256:${string}` {
  const hash = createHash('sha256').update('happier.portableArchive.fileSet.v1\n');
  for (const file of inventory) {
    hash.update(`path:${Buffer.byteLength(file.path, 'utf8')}\n`);
    hash.update(file.path);
    hash.update(`\nbytes:${file.byteLength}\ndigest:${file.digest}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}

function classifyUnexpectedFailure(cause: unknown): PortableArchiveError {
  if (cause instanceof PortableArchiveError) return cause;
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  if (code === 'ABORT_ERR') return error('archive_aborted', 'Archive extraction was aborted', cause);
  return error('archive_format_invalid', 'Archive could not be extracted safely', cause);
}

export async function extractPortableTarGzipArchive(
  params: ExtractPortableTarGzipArchiveParams,
): Promise<ExtractedPortableArchive> {
  const limits = mergeLimits(params.limits);
  if (limits.timeoutMs === 0) throw error('archive_timeout', 'Archive extraction timed out');
  if (params.signal?.aborted) throw error('archive_aborted', 'Archive extraction was aborted');
  if (!Number.isSafeInteger(params.expectedArchiveBytes) || params.expectedArchiveBytes <= 0) {
    throw error('archive_source_invalid', 'Expected archive byte length must be a positive safe integer');
  }

  let verifier: ReturnType<typeof createStreamingIntegrityVerifier>;
  try {
    verifier = createStreamingIntegrityVerifier(params.expectedIntegrity);
  } catch (cause) {
    throw error('archive_integrity_invalid', 'Archive integrity declaration is invalid', cause);
  }

  const sourceStat = await lstat(params.archivePath).catch((cause: unknown) => {
    throw error('archive_source_invalid', 'Archive source is unavailable', cause);
  });
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== params.expectedArchiveBytes) {
    throw error('archive_source_invalid', 'Archive source is not the exact downloaded regular file');
  }

  let operationRoot: string | undefined;
  try {
    await mkdir(params.stagingParentPath, { recursive: true });
    operationRoot = await mkdtemp(join(params.stagingParentPath, '.candidate-'));
  } catch (cause) {
    if (operationRoot) await rm(operationRoot, { recursive: true, force: true });
    throw error('archive_source_invalid', 'Archive staging root could not be created', cause);
  }
  const extractedRoot = join(operationRoot, 'root');
  try {
    await mkdir(extractedRoot, { recursive: false });
  } catch (cause) {
    await rm(operationRoot, { recursive: true, force: true });
    throw error('archive_source_invalid', 'Archive extraction root could not be created', cause);
  }

  const abortController = new AbortController();
  const onExternalAbort = () => abortController.abort(params.signal?.reason);
  params.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (params.signal?.aborted) onExternalAbort();
  const timeout = setTimeout(() => abortController.abort(error('archive_timeout', 'Archive extraction timed out')), limits.timeoutMs);
  timeout.unref?.();

  const pathRegistry = createPortablePathRegistry();
  const inventoryPromises: Promise<PortableArchiveFile>[] = [];
  let entryCount = 0;
  let fileCount = 0;
  let expandedBytes = 0;
  const fileMetadata = new WeakMap<ReadEntry, Readonly<{ path: string; size: number }>>();

  const abortWith = (failure: PortableArchiveError): void => {
    if (!abortController.signal.aborted) abortController.abort(failure);
  };

  const accountMetadataEntry = (byteLength: number): void => {
    entryCount += 1;
    if (entryCount > limits.maxEntries) {
      abortWith(error('archive_limit_entries', 'Archive contains too many entries'));
      return;
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > limits.maxFileBytes) {
      abortWith(error('archive_limit_file_bytes', 'Archive metadata entry exceeds its byte limit'));
      return;
    }
    expandedBytes += byteLength;
    if (expandedBytes > limits.maxExpandedBytes) {
      abortWith(error('archive_limit_expanded_bytes', 'Archive exceeds expanded-byte limit'));
      return;
    }
    if (expandedBytes / params.expectedArchiveBytes > limits.maxCompressionRatio) {
      abortWith(error('archive_limit_compression_ratio', 'Archive exceeds compression-ratio limit'));
    }
  };

  const filter = (rawPath: string, candidateEntry: ReadEntry | Stats): boolean => {
    if (abortController.signal.aborted) return false;
    try {
      if (!('type' in candidateEntry)) throw error('archive_format_invalid', 'Extraction received a non-archive entry');
      const entry = candidateEntry as ReadEntry;
      entryCount += 1;
      if (entryCount > limits.maxEntries) throw error('archive_limit_entries', 'Archive contains too many entries');
      if (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'Directory') {
        throw error('archive_entry_type_unsupported', `Archive entry type is unsupported: ${entry.type}`);
      }
      const portable = readPortableArchiveEntryPath({
        rawPath,
        expectedRootDirectory: params.stripRootDirectory,
        entry,
        maxPathBytes: limits.maxPathBytes,
        maxPathDepth: limits.maxPathDepth,
      });
      if (portable.isRootDirectory) return false;
      pathRegistry.add(portable.relativePath, portable.kind);
      if (portable.kind === 'directory') return true;

      fileCount += 1;
      if (fileCount > limits.maxFiles) throw error('archive_limit_files', 'Archive contains too many files');
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxFileBytes) {
        throw error('archive_limit_file_bytes', `Archive file exceeds its byte limit: ${portable.relativePath}`);
      }
      expandedBytes += entry.size;
      if (expandedBytes > limits.maxExpandedBytes) throw error('archive_limit_expanded_bytes', 'Archive exceeds expanded-byte limit');
      if (expandedBytes / params.expectedArchiveBytes > limits.maxCompressionRatio) {
        throw error('archive_limit_compression_ratio', 'Archive exceeds compression-ratio limit');
      }

      fileMetadata.set(entry, { path: portable.relativePath, size: entry.size });
      return true;
    } catch (cause) {
      const failure = cause instanceof PortableArchiveError
        ? cause
        : error('archive_format_invalid', 'Archive entry could not be validated safely', cause);
      abortWith(failure);
      return false;
    }
  };

  const transformEntry = (entry: ReadEntry): Transform | undefined => {
    const metadata = fileMetadata.get(entry);
    if (!metadata) return undefined;
    const digest = createHash('sha256');
    let seenBytes = 0;
    let resolveInventory!: (value: PortableArchiveFile) => void;
    let rejectInventory!: (cause: unknown) => void;
    inventoryPromises.push(new Promise<PortableArchiveFile>((resolve, reject) => {
      resolveInventory = resolve;
      rejectInventory = reject;
    }));
    const stream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        seenBytes += chunk.byteLength;
        digest.update(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        if (seenBytes !== metadata.size) {
          const failure = error('archive_format_invalid', `Archive file size did not match header: ${metadata.path}`);
          rejectInventory(failure);
          callback(failure);
          return;
        }
        resolveInventory({
          path: metadata.path,
          byteLength: seenBytes,
          digest: `sha256:${digest.digest('hex')}`,
        });
        callback();
      },
    });
    stream.once('error', rejectInventory);
    return stream;
  };
  // tar 7.5.19's runtime and documented contract accept a transform stream,
  // but its declaration currently narrows this callback to ReadEntry.
  const tarTransformEntry = transformEntry as unknown as (
    entry: ReadEntry,
  ) => ReadEntry | undefined;

  const integrityTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      verifier.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    const unpack = extractTar({
      cwd: extractedRoot,
      gzip: true,
      strict: true,
      maxMetaEntrySize: MAX_METADATA_ENTRY_BYTES,
      preservePaths: false,
      strip: 1,
      noMtime: true,
      filter,
      transform: tarTransformEntry,
    });
    unpack.on('meta', (metadata: string) => accountMetadataEntry(Buffer.byteLength(metadata, 'utf8')));
    unpack.on('ignoredEntry', (entry: ReadEntry) => {
      if (entry.meta) accountMetadataEntry(entry.size);
    });
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const sourceHandle = await open(params.archivePath, constants.O_RDONLY | noFollow);
    try {
      await pipeline(
        sourceHandle.createReadStream({ autoClose: false }),
        integrityTransform,
        unpack,
        { signal: abortController.signal },
      );
    } finally {
      await sourceHandle.close();
    }
    if (!verifier.verify()) throw error('archive_integrity_mismatch', 'Archive integrity did not match downloaded candidate');
    const inventory = (await Promise.all(inventoryPromises)).sort((left, right) => left.path.localeCompare(right.path));
    const result: ExtractedPortableArchive = Object.freeze({
      rootPath: extractedRoot,
      inventory: Object.freeze(inventory),
      rootDigest: createRootDigest(inventory),
    });
    ownedExtractions.set(result, { cleanupPromise: null });
    return result;
  } catch (cause) {
    const abortReason = abortController.signal.aborted ? abortController.signal.reason : undefined;
    const failure = abortReason instanceof PortableArchiveError
      ? abortReason
      : params.signal?.aborted
        ? error('archive_aborted', 'Archive extraction was aborted', cause)
        : classifyUnexpectedFailure(cause);
    await rm(operationRoot, { recursive: true, force: true });
    throw failure;
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener('abort', onExternalAbort);
  }
}

export function cleanupExtractedPortableArchive(archive: ExtractedPortableArchive): Promise<void> {
  const state = ownedExtractions.get(archive);
  if (!state) return Promise.reject(new Error('Refusing to clean a path without an operation-owned extraction handle'));
  if (state.cleanupPromise) return state.cleanupPromise;
  const cleanupPromise = rm(dirname(archive.rootPath), { recursive: true, force: true })
    .then(() => { ownedExtractions.delete(archive); })
    .catch((cause: unknown) => {
      state.cleanupPromise = null;
      throw cause;
    });
  state.cleanupPromise = cleanupPromise;
  return cleanupPromise;
}
