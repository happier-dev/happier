import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { t as listTar, type ReadEntry } from 'tar';

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
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw error('archive_source_invalid', `Archive limit ${name} must be a non-negative finite number`);
    }
  }
  return limits;
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

  const pathRegistry = createPortablePathRegistry();
  const inventory: PortableArchiveFile[] = [];
  let entryOperation = Promise.resolve();
  const activeEntries = new Set<ReadEntry>();
  let entryCount = 0;
  let fileCount = 0;
  let expandedBytes = 0;
  const fileMetadata = new WeakMap<ReadEntry, Readonly<{ path: string; size: number; kind: 'file' | 'directory' }>>();

  const abortWith = (failure: PortableArchiveError): void => {
    if (!abortController.signal.aborted) abortController.abort(failure);
  };
  const stopEntries = (): void => {
    const reason = abortController.signal.reason;
    for (const entry of activeEntries) entry.destroy(reason instanceof Error ? reason : error('archive_aborted', 'Archive extraction was aborted'));
  };
  abortController.signal.addEventListener('abort', stopEntries);

  const accountMetadataEntry = (byteLength: number): void => {
    entryCount += 1;
    if (limits.maxEntries !== null && entryCount > limits.maxEntries) {
      abortWith(error('archive_limit_entries', 'Archive contains too many entries'));
      return;
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || (limits.maxFileBytes !== null && byteLength > limits.maxFileBytes)) {
      abortWith(error('archive_limit_file_bytes', 'Archive metadata entry exceeds its byte limit'));
      return;
    }
    expandedBytes += byteLength;
    if (limits.maxExpandedBytes !== null && expandedBytes > limits.maxExpandedBytes) {
      abortWith(error('archive_limit_expanded_bytes', 'Archive exceeds expanded-byte limit'));
      return;
    }
    if (limits.maxCompressionRatio !== null && expandedBytes / params.expectedArchiveBytes > limits.maxCompressionRatio) {
      abortWith(error('archive_limit_compression_ratio', 'Archive exceeds compression-ratio limit'));
    }
  };

  const filter = (rawPath: string, candidateEntry: ReadEntry | Stats): boolean => {
    if (abortController.signal.aborted) return false;
    try {
      if (!('type' in candidateEntry)) throw error('archive_format_invalid', 'Extraction received a non-archive entry');
      const entry = candidateEntry as ReadEntry;
      entryCount += 1;
      if (limits.maxEntries !== null && entryCount > limits.maxEntries) throw error('archive_limit_entries', 'Archive contains too many entries');
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
      if (portable.kind === 'directory') {
        fileMetadata.set(entry, { path: portable.relativePath, size: 0, kind: 'directory' });
        return true;
      }

      fileCount += 1;
      if (limits.maxFiles !== null && fileCount > limits.maxFiles) throw error('archive_limit_files', 'Archive contains too many files');
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || (limits.maxFileBytes !== null && entry.size > limits.maxFileBytes)) {
        throw error('archive_limit_file_bytes', `Archive file exceeds its byte limit: ${portable.relativePath}`);
      }
      expandedBytes += entry.size;
      if (limits.maxExpandedBytes !== null && expandedBytes > limits.maxExpandedBytes) throw error('archive_limit_expanded_bytes', 'Archive exceeds expanded-byte limit');
      if (limits.maxCompressionRatio !== null && expandedBytes / params.expectedArchiveBytes > limits.maxCompressionRatio) {
        throw error('archive_limit_compression_ratio', 'Archive exceeds compression-ratio limit');
      }

      fileMetadata.set(entry, { path: portable.relativePath, size: entry.size, kind: 'file' });
      return true;
    } catch (cause) {
      const failure = cause instanceof PortableArchiveError
        ? cause
        : error('archive_format_invalid', 'Archive entry could not be validated safely', cause);
      abortWith(failure);
      return false;
    }
  };

  const extractEntry = async (entry: ReadEntry): Promise<void> => {
    const metadata = fileMetadata.get(entry);
    if (!metadata) { entry.resume(); return; }
    const destinationPath = join(extractedRoot, metadata.path);
    if (metadata.kind === 'directory') {
      await mkdir(destinationPath, { recursive: true, mode: typeof entry.mode === 'number' ? (entry.mode | 0o700) & 0o7777 : 0o777 });
    } else {
      await mkdir(dirname(destinationPath), { recursive: true });
    }
    abortController.signal.throwIfAborted();
    if (metadata.kind === 'directory') { entry.resume(); return; }
    const digest = createHash('sha256');
    let seenBytes = 0;
    const stream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        seenBytes += chunk.byteLength;
        digest.update(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        if (seenBytes !== metadata.size) {
          const failure = error('archive_format_invalid', `Archive file size did not match header: ${metadata.path}`);
          callback(failure);
          return;
        }
        inventory.push({
          path: metadata.path,
          byteLength: seenBytes,
          digest: `sha256:${digest.digest('hex')}`,
        });
        callback();
      },
    });
    const file = await open(destinationPath, 'wx', typeof entry.mode === 'number' ? entry.mode & 0o7777 : 0o666);
    try {
      await pipeline(entry, stream, file.createWriteStream(), { signal: abortController.signal });
    } finally {
      await file.close();
    }
  };

  const integrityTransform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      verifier.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    // tar's parser does no filesystem work. Own and join every write here:
    // Unpack's parser abort does not join its private pending filesystem work.
    const unpack = listTar({
      gzip: true,
      strict: true,
      maxMetaEntrySize: MAX_METADATA_ENTRY_BYTES,
      // Payloads stream to disk; only an explicit caller quota may reject them.
      // tar otherwise adds its own implicit 1000:1 decompression cutoff.
      maxDecompressionRatio: Number.POSITIVE_INFINITY,
      noResume: true,
      filter,
      onentry(entry) {
        activeEntries.add(entry);
        entry.on('error', (cause: unknown) => abortWith(classifyUnexpectedFailure(cause)));
        // An empty entry can finish parsing before its file has closed. Join
        // that file lifetime before opening the next entry, rather than impose
        // an archive-count ceiling based on available process descriptors.
        entryOperation = entryOperation.then(() => {
          abortController.signal.throwIfAborted();
          return extractEntry(entry);
        })
          .catch((cause: unknown) => { abortWith(classifyUnexpectedFailure(cause)); })
          .finally(() => { activeEntries.delete(entry); });
      },
    });
    unpack.on('meta', (metadata: string) => accountMetadataEntry(Buffer.byteLength(metadata, 'utf8')));
    unpack.on('ignoredEntry', (entry: ReadEntry) => {
      if (entry.meta) accountMetadataEntry(entry.size);
    });
    const abortParser = () => unpack.abort(abortController.signal.reason instanceof Error
      ? abortController.signal.reason : error('archive_aborted', 'Archive extraction was aborted'));
    // Parser.abort closes its decompressor; the entry pipelines above own and
    // join the filesystem work independently of the parser's error/close event.
    unpack.on('error', (cause: unknown) => abortWith(classifyUnexpectedFailure(cause)));
    abortController.signal.addEventListener('abort', abortParser, { once: true });
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      sourceHandle = await open(params.archivePath, constants.O_RDONLY | noFollow);
      abortController.signal.throwIfAborted();
      await pipeline(
        sourceHandle.createReadStream({ autoClose: false }),
        integrityTransform,
        unpack,
        { signal: abortController.signal },
      );
    } catch (cause) {
      abortWith(classifyUnexpectedFailure(cause));
      throw cause;
    } finally {
      abortController.signal.removeEventListener('abort', abortParser);
      await sourceHandle?.close();
      await entryOperation;
    }
    abortController.signal.throwIfAborted();
    if (!verifier.verify()) throw error('archive_integrity_mismatch', 'Archive integrity did not match downloaded candidate');
    inventory.sort((left, right) => left.path.localeCompare(right.path));
    const result: ExtractedPortableArchive = Object.freeze({
      rootPath: extractedRoot,
      inventory: Object.freeze(inventory),
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
    abortController.signal.removeEventListener('abort', stopEntries);
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
