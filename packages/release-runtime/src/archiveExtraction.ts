import { createReadStream } from 'node:fs';
import type { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import extractZip from 'extract-zip';
import * as tar from 'tar';
import type { TarOptionsWithAliasesAsyncNoFile } from 'tar';

const WINDOWS_INVALID_PATH_CHARACTER = /[\u0000-\u001f<>:"|?*]/u;
const WINDOWS_RESERVED_PATH_SEGMENT = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const MAX_TAR_METADATA_ENTRY_BYTES = 1024 * 1024;

export type ArchiveExtractionLimits = Readonly<{
  maxArchiveBytes: number;
  maxEntries: number;
  maxFiles: number;
  maxFileBytes: number;
  maxExpandedBytes: number;
  maxCompressionRatio: number;
  timeoutMs: number;
}>;

export const DEFAULT_ARCHIVE_EXTRACTION_LIMITS: ArchiveExtractionLimits = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 20_000,
  maxFiles: 10_000,
  maxFileBytes: 256 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 100,
  timeoutMs: 120_000,
});

type ArchiveEntryKind = 'directory' | 'file';
type ArchiveBudgetEntryKind = ArchiveEntryKind | 'metadata';

function mergeArchiveExtractionLimits(
  overrides: Partial<ArchiveExtractionLimits> | undefined,
): ArchiveExtractionLimits {
  const limits = { ...DEFAULT_ARCHIVE_EXTRACTION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`[release-runtime] archive limit ${name} must be a non-negative finite number`);
    }
  }
  return limits;
}

type ArchiveBudget = Readonly<{
  account: (kind: ArchiveBudgetEntryKind, byteLength: number) => void;
}>;

function createArchiveBudget(params: Readonly<{
  archiveBytes: number;
  limits: ArchiveExtractionLimits;
}>): ArchiveBudget {
  let entryCount = 0;
  let fileCount = 0;
  let expandedBytes = 0;

  return {
    account: (kind, byteLength) => {
      entryCount += 1;
      if (entryCount > params.limits.maxEntries) {
        throw new Error('[release-runtime] archive contains too many entries');
      }
      if (kind === 'directory') return;
      if (kind === 'file') {
        fileCount += 1;
        if (fileCount > params.limits.maxFiles) {
          throw new Error('[release-runtime] archive contains too many files');
        }
      }
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw new Error('[release-runtime] archive file has an invalid byte length');
      }
      if (byteLength > params.limits.maxFileBytes) {
        throw new Error('[release-runtime] archive file exceeds its byte limit');
      }
      expandedBytes += byteLength;
      if (expandedBytes > params.limits.maxExpandedBytes) {
        throw new Error('[release-runtime] archive exceeds expanded-byte limit');
      }
      if (expandedBytes / Math.max(1, params.archiveBytes) > params.limits.maxCompressionRatio) {
        throw new Error('[release-runtime] archive exceeds compression ratio limit');
      }
    },
  };
}

type TarMetadataEmitter = Pick<EventEmitter, 'on'>;

function attachTarMetadataBudget(params: Readonly<{
  parser: TarMetadataEmitter;
  budget: ArchiveBudget;
  abort: (error: Error) => void;
}>): void {
  const accountMetadata = (byteLength: number) => {
    try {
      params.budget.account('metadata', byteLength);
    } catch (error) {
      params.abort(error instanceof Error ? error : new Error(String(error)));
    }
  };
  params.parser.on('meta', (metadata: string) => {
    accountMetadata(Buffer.byteLength(metadata, 'utf8'));
  });
  params.parser.on('ignoredEntry', (entry: TarArchiveEntry) => {
    if (entry.meta) accountMetadata(entry.size ?? Number.NaN);
  });
}

type BoundedTarOptions = TarOptionsWithAliasesAsyncNoFile & Readonly<{
  maxDecompressionRatio: number;
}>;

type ArchiveAbortContext = Readonly<{
  abort: (error: Error) => void;
  dispose: () => void;
  signal: AbortSignal;
  throwIfAborted: () => void;
}>;

function createArchiveAbortContext(params: Readonly<{
  externalSignal?: AbortSignal;
  timeoutMs: number;
}>): ArchiveAbortContext {
  if (params.externalSignal?.aborted) {
    throw new Error('[release-runtime] archive extraction was aborted');
  }
  if (params.timeoutMs === 0) {
    throw new Error('[release-runtime] archive extraction timed out');
  }

  const controller = new AbortController();
  const abort = (error: Error) => {
    if (!controller.signal.aborted) controller.abort(error);
  };
  const onExternalAbort = () => abort(new Error('[release-runtime] archive extraction was aborted'));
  params.externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timeout = setTimeout(
    () => abort(new Error('[release-runtime] archive extraction timed out')),
    params.timeoutMs,
  );
  timeout.unref?.();

  return {
    abort,
    dispose: () => {
      clearTimeout(timeout);
      params.externalSignal?.removeEventListener('abort', onExternalAbort);
    },
    signal: controller.signal,
    throwIfAborted: () => {
      if (!controller.signal.aborted) return;
      const reason = controller.signal.reason;
      throw reason instanceof Error
        ? reason
        : new Error('[release-runtime] archive extraction was aborted');
    },
  };
}

export type InspectedTarArchiveEntry = Readonly<{
  path: string;
  kind: ArchiveEntryKind;
  mode: number | null;
  uid: number | null;
  gid: number | null;
}>;

function normalizeArchiveEntryPath(rawPath: string, kind: ArchiveEntryKind): string | null {
  if (String(rawPath).includes('\\')) {
    throw new Error(`[release-runtime] archive entry has a non-portable separator: ${rawPath}`);
  }
  const pathWithPortableSeparators = String(rawPath).replaceAll('\\', '/');
  if (
    !pathWithPortableSeparators
    || pathWithPortableSeparators.startsWith('/')
    || pathWithPortableSeparators.startsWith('//')
    || /^[a-z]:/iu.test(pathWithPortableSeparators)
  ) {
    throw new Error(`[release-runtime] archive entry has an absolute or empty path: ${rawPath}`);
  }

  const rawSegments = pathWithPortableSeparators.split('/');
  if (kind === 'directory' && rawSegments.at(-1) === '') rawSegments.pop();
  const portableSegments: string[] = [];
  for (const rawSegment of rawSegments) {
    if (rawSegment === '.') continue;
    if (!rawSegment || rawSegment === '..') {
      throw new Error(`[release-runtime] archive entry has a non-portable path: ${rawPath}`);
    }

    const segment = rawSegment.normalize('NFC');
    if (
      WINDOWS_INVALID_PATH_CHARACTER.test(segment)
      || /[. ]$/u.test(segment)
      || WINDOWS_RESERVED_PATH_SEGMENT.test(segment)
    ) {
      throw new Error(`[release-runtime] archive entry has a Windows-invalid path: ${rawPath}`);
    }
    portableSegments.push(segment);
  }

  if (portableSegments.length === 0 && kind === 'directory') return null;
  if (portableSegments.length === 0) {
    throw new Error(`[release-runtime] archive entry has an empty path: ${rawPath}`);
  }
  return portableSegments.join('/');
}

function createArchiveEntryValidator(
  allowedEntryRoots?: readonly string[],
): (rawPath: string, kind: ArchiveEntryKind) => string | null {
  const canonicalPrefixesByPortablePath = new Map<string, string>();
  const explicitEntryPaths = new Set<string>();
  const explicitEntryKindsByPortablePath = new Map<string, ArchiveEntryKind>();
  const implicitDirectoryPaths = new Set<string>();
  const normalizedAllowedEntryRoots = allowedEntryRoots?.map((root) => {
    const normalizedRoot = normalizeArchiveEntryPath(root, 'directory');
    if (normalizedRoot === null) {
      throw new Error('[release-runtime] allowed archive entry root must not be the archive root');
    }
    return normalizedRoot;
  });

  return (rawPath, kind) => {
    const portablePath = normalizeArchiveEntryPath(rawPath, kind);
    if (portablePath === null) return null;
    const portableSegments = portablePath.split('/');
    if (
      normalizedAllowedEntryRoots
      && !normalizedAllowedEntryRoots.some((root) => (
        portablePath === root
        || portablePath.startsWith(`${root}/`)
        || root.startsWith(`${portablePath}/`)
      ))
    ) {
      throw new Error(
        `[release-runtime] archive entry is outside an allowed entry root: ${rawPath}`,
      );
    }
    const collisionKey = portablePath.toLowerCase();
    if (explicitEntryPaths.has(collisionKey)) {
      throw new Error(
        `[release-runtime] duplicate archive entry path: ${rawPath}`,
      );
    }

    for (let index = 0; index < portableSegments.length; index += 1) {
      const canonicalPrefix = portableSegments.slice(0, index + 1).join('/');
      const portablePrefix = canonicalPrefix.toLowerCase();
      const previousPrefix = canonicalPrefixesByPortablePath.get(portablePrefix);
      if (previousPrefix !== undefined && previousPrefix !== canonicalPrefix) {
        throw new Error(
          `[release-runtime] archive entry path collision: ${rawPath} conflicts with ${previousPrefix}`,
        );
      }
      canonicalPrefixesByPortablePath.set(portablePrefix, canonicalPrefix);
      if (index < portableSegments.length - 1) {
        if (explicitEntryKindsByPortablePath.get(portablePrefix) === 'file') {
          throw new Error(
            `[release-runtime] archive entry has a file/directory prefix conflict: ${rawPath} descends from ${canonicalPrefix}`,
          );
        }
        implicitDirectoryPaths.add(portablePrefix);
      }
    }
    if (kind === 'file' && implicitDirectoryPaths.has(collisionKey)) {
      throw new Error(
        `[release-runtime] archive entry has a file/directory prefix conflict: ${rawPath} was already used as a directory`,
      );
    }
    explicitEntryPaths.add(collisionKey);
    explicitEntryKindsByPortablePath.set(collisionKey, kind);
    return portablePath;
  };
}

type TarArchiveEntry = Readonly<{
  gid?: number | null;
  meta: boolean;
  mode?: number | null;
  path: string;
  size?: number;
  type: string;
  uid?: number | null;
}>;

type TarEntryValidator = Readonly<{
  accept: (entry: TarArchiveEntry) => boolean;
  assertValid: () => void;
}>;

type TarLinkPolicy = 'reject' | 'skip';

function createTarEntryValidator(
  linkPolicy: TarLinkPolicy,
  budget: ArchiveBudget,
  allowedEntryRoots?: readonly string[],
  onFailure?: (error: Error) => void,
  onEntry?: (entry: InspectedTarArchiveEntry) => void,
): TarEntryValidator {
  const validatePath = createArchiveEntryValidator(allowedEntryRoots);
  let firstError: Error | null = null;
  return {
    accept: (entry) => {
      try {
        if (entry.meta) return true;
        if (entry.type === 'Directory' || entry.type === 'GNUDumpDir') {
          budget.account('directory', 0);
          const path = validatePath(entry.path, 'directory');
          if (path !== null) {
            onEntry?.({
              path,
              kind: 'directory',
              mode: entry.mode ?? null,
              uid: entry.uid ?? null,
              gid: entry.gid ?? null,
            });
          }
          return true;
        }
        if (entry.type === 'File' || entry.type === 'OldFile' || entry.type === 'ContiguousFile') {
          budget.account('file', entry.size ?? Number.NaN);
          const path = validatePath(entry.path, 'file');
          if (path !== null) {
            onEntry?.({
              path,
              kind: 'file',
              mode: entry.mode ?? null,
              uid: entry.uid ?? null,
              gid: entry.gid ?? null,
            });
          }
          return true;
        }
        if (linkPolicy === 'skip' && (entry.type === 'SymbolicLink' || entry.type === 'Link')) {
          budget.account('file', 0);
          validatePath(entry.path, 'file');
          return false;
        }
        throw new Error(`[release-runtime] archive entry type is not supported: ${entry.type} (${entry.path})`);
      } catch (error) {
        firstError ??= error instanceof Error ? error : new Error(String(error));
        onFailure?.(firstError);
        return false;
      }
    },
    assertValid: () => {
      if (firstError) throw firstError;
    },
  };
}

export async function inspectTarArchiveEntries(params: Readonly<{
  archivePath: string;
  limits?: Partial<ArchiveExtractionLimits>;
  signal?: AbortSignal;
}>): Promise<readonly InspectedTarArchiveEntry[]> {
  const limits = mergeArchiveExtractionLimits(params.limits);
  const archiveStats = await readArchiveStats({
    archivePath: params.archivePath,
    limits,
  });
  const abortContext = createArchiveAbortContext({
    externalSignal: params.signal,
    timeoutMs: limits.timeoutMs,
  });
  const entries: InspectedTarArchiveEntry[] = [];
  const budget = createArchiveBudget({ archiveBytes: archiveStats.size, limits });
  const validateEntry = createTarEntryValidator(
    'reject',
    budget,
    undefined,
    abortContext.abort,
    (entry) => entries.push(entry),
  );
  try {
    const parserOptions: BoundedTarOptions = {
      filter: (_path, entry) => 'meta' in entry ? validateEntry.accept(entry) : true,
      maxDecompressionRatio: limits.maxCompressionRatio,
      maxMetaEntrySize: MAX_TAR_METADATA_ENTRY_BYTES,
      strict: true,
    };
    const parser = tar.t(parserOptions);
    attachTarMetadataBudget({ parser, budget, abort: abortContext.abort });
    await pipeline(createReadStream(params.archivePath), parser, { signal: abortContext.signal });
    abortContext.throwIfAborted();
    validateEntry.assertValid();
    return entries;
  } catch (error) {
    abortContext.throwIfAborted();
    validateEntry.assertValid();
    throw error;
  } finally {
    abortContext.dispose();
  }
}

type ZipArchiveEntry = Readonly<{
  compressedSize: number;
  externalFileAttributes: number;
  fileName: string;
  uncompressedSize: number;
  versionMadeBy: number;
}>;

function createZipEntryValidator(params: Readonly<{
  allowedEntryRoots?: readonly string[];
  abortContext: ArchiveAbortContext;
  budget: ArchiveBudget;
}>): (entry: ZipArchiveEntry) => void {
  const validatePath = createArchiveEntryValidator(params.allowedEntryRoots);
  return (entry) => {
    params.abortContext.throwIfAborted();
    const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
    const unixFileType = unixMode & 0o170000;
    const madeBy = entry.versionMadeBy >>> 8;
    const isDirectory = entry.fileName.endsWith('/')
      || unixFileType === 0o040000
      || (madeBy === 0 && entry.externalFileAttributes === 16);
    if (unixFileType !== 0 && unixFileType !== 0o040000 && unixFileType !== 0o100000) {
      throw new Error(`[release-runtime] archive entry type is not supported: link or special file (${entry.fileName})`);
    }
    params.budget.account(isDirectory ? 'directory' : 'file', isDirectory ? 0 : entry.uncompressedSize);
    validatePath(entry.fileName, isDirectory ? 'directory' : 'file');
  };
}

type XzReadableStreamConstructor = new (
  compressedStream: NodeReadableStream<Uint8Array>,
) => NodeReadableStream<Uint8Array>;

let xzReadableStreamConstructorPromise: Promise<XzReadableStreamConstructor> | null = null;

async function resolveXzReadableStreamConstructor(): Promise<XzReadableStreamConstructor> {
  if (!xzReadableStreamConstructorPromise) {
    xzReadableStreamConstructorPromise = import('xz-decompress').then((module) => {
      const xzModule = module as Readonly<{
        XzReadableStream?: XzReadableStreamConstructor;
        default?: Readonly<{
          XzReadableStream?: XzReadableStreamConstructor;
        }>;
      }>;
      const XzReadableStream = xzModule.XzReadableStream ?? xzModule.default?.XzReadableStream;
      if (!XzReadableStream) {
        throw new Error('[release-runtime] xz-decompress does not expose XzReadableStream');
      }
      return XzReadableStream;
    });
  }
  return await xzReadableStreamConstructorPromise;
}

async function readArchiveStats(params: Readonly<{
  archivePath: string;
  limits: ArchiveExtractionLimits;
}>) {
  const archiveStats = await lstat(params.archivePath).catch((error: unknown) => {
    throw new Error('[release-runtime] archive source is unavailable', {
      cause: error instanceof Error ? error : undefined,
    });
  });
  if (!archiveStats.isFile() || archiveStats.isSymbolicLink()) {
    throw new Error('[release-runtime] archive source must be a regular file');
  }
  if (archiveStats.size > params.limits.maxArchiveBytes) {
    throw new Error('[release-runtime] archive exceeds compressed-byte limit');
  }
  return archiveStats;
}

async function assertEmptyExtractionDestination(extractDir: string): Promise<boolean> {
  const destinationStats = await lstat(extractDir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  });
  if (!destinationStats) return false;
  if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) {
    throw new Error('[release-runtime] archive extraction destination must be an empty directory');
  }
  if ((await readdir(extractDir)).length !== 0) {
    throw new Error('[release-runtime] archive extraction destination must be empty');
  }
  return true;
}

async function publishStagedExtraction(params: Readonly<{
  destinationExisted: boolean;
  extractDir: string;
  stagingDir: string;
}>): Promise<void> {
  if (params.destinationExisted) {
    await rmdir(params.extractDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
    });
  }
  await rename(params.stagingDir, params.extractDir);
}

function createXzDecompressionRatioGuard(params: Readonly<{
  abortContext: ArchiveAbortContext;
  archiveBytes: number;
  limits: ArchiveExtractionLimits;
}>): Transform {
  let decompressedBytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      decompressedBytes += chunk.byteLength;
      if (
        decompressedBytes / Math.max(1, params.archiveBytes)
        > params.limits.maxCompressionRatio
      ) {
        const error = new Error('[release-runtime] archive exceeds compression ratio limit');
        params.abortContext.abort(error);
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
}

async function extractTarArchiveToDirectory(params: Readonly<{
  abortContext: ArchiveAbortContext;
  allowedEntryRoots?: readonly string[];
  archiveBytes: number;
  archivePath: string;
  extractDir: string;
  isXz: boolean;
  limits: ArchiveExtractionLimits;
  linkPolicy: TarLinkPolicy;
}>): Promise<void> {
  const budget = createArchiveBudget({
    archiveBytes: params.archiveBytes,
    limits: params.limits,
  });
  const validateEntry = createTarEntryValidator(
    params.linkPolicy,
    budget,
    params.allowedEntryRoots,
    params.abortContext.abort,
  );
  const unpackOptions: BoundedTarOptions = {
    cwd: params.extractDir,
    filter: (_path, entry) => 'meta' in entry ? validateEntry.accept(entry) : true,
    maxDecompressionRatio: params.limits.maxCompressionRatio,
    maxMetaEntrySize: MAX_TAR_METADATA_ENTRY_BYTES,
    preserveOwner: false,
    strict: true,
  };
  const unpack = tar.x(unpackOptions);
  attachTarMetadataBudget({ parser: unpack, budget, abort: params.abortContext.abort });

  try {
    if (params.isXz) {
      const source = createReadStream(params.archivePath);
      const XzReadableStream = await resolveXzReadableStreamConstructor();
      const decompressedStream = new XzReadableStream(Readable.toWeb(source));
      await pipeline(
        Readable.fromWeb(decompressedStream),
        createXzDecompressionRatioGuard(params),
        unpack,
        { signal: params.abortContext.signal },
      );
    } else {
      await pipeline(
        createReadStream(params.archivePath),
        unpack,
        { signal: params.abortContext.signal },
      );
    }
    params.abortContext.throwIfAborted();
    validateEntry.assertValid();
  } catch (error) {
    params.abortContext.throwIfAborted();
    validateEntry.assertValid();
    throw error;
  }
}

type ZipFileCloser = Readonly<{ close: () => void }>;

async function extractZipArchiveToDirectory(params: Readonly<{
  abortContext: ArchiveAbortContext;
  allowedEntryRoots?: readonly string[];
  archiveBytes: number;
  archivePath: string;
  extractDir: string;
  limits: ArchiveExtractionLimits;
}>): Promise<void> {
  const budget = createArchiveBudget({
    archiveBytes: params.archiveBytes,
    limits: params.limits,
  });
  const validateEntry = createZipEntryValidator({
    allowedEntryRoots: params.allowedEntryRoots,
    abortContext: params.abortContext,
    budget,
  });
  let activeZipFile: ZipFileCloser | null = null;
  const onAbort = () => activeZipFile?.close();
  params.abortContext.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await extractZip(params.archivePath, {
      dir: params.extractDir,
      onEntry: (entry, zipFile) => {
        activeZipFile = zipFile;
        validateEntry(entry);
      },
    });
    params.abortContext.throwIfAborted();
  } finally {
    params.abortContext.signal.removeEventListener('abort', onAbort);
  }
}

export async function extractArchivePayloadToDirectory(params: Readonly<{
  allowedEntryRoots?: readonly string[];
  archivePath: string;
  archiveName: string;
  extractDir: string;
  limits?: Partial<ArchiveExtractionLimits>;
  signal?: AbortSignal;
  tarLinkPolicy?: TarLinkPolicy;
}>): Promise<void> {
  const archiveName = params.archiveName.toLowerCase();
  const archiveType = archiveName.endsWith('.zip')
    ? 'zip'
    : archiveName.endsWith('.tar.xz')
      ? 'tar.xz'
      : archiveName.endsWith('.tar.gz') || archiveName.endsWith('.tgz')
        ? 'tar.gz'
        : null;
  if (!archiveType) {
    throw new Error(`[release-runtime] unsupported archive type: ${params.archiveName}`);
  }

  const limits = mergeArchiveExtractionLimits(params.limits);
  const archiveStats = await readArchiveStats({
    archivePath: params.archivePath,
    limits,
  });
  const abortContext = createArchiveAbortContext({
    externalSignal: params.signal,
    timeoutMs: limits.timeoutMs,
  });
  const extractDir = resolve(params.extractDir);
  let stagingDir: string | null = null;

  try {
    abortContext.throwIfAborted();
    const destinationExisted = await assertEmptyExtractionDestination(extractDir);
    const stagingParent = dirname(extractDir);
    await mkdir(stagingParent, { recursive: true });
    stagingDir = await mkdtemp(join(stagingParent, `.${basename(extractDir)}.extract-`));
    abortContext.throwIfAborted();

    if (archiveType === 'zip') {
      await extractZipArchiveToDirectory({
        abortContext,
        allowedEntryRoots: params.allowedEntryRoots,
        archiveBytes: archiveStats.size,
        archivePath: params.archivePath,
        extractDir: stagingDir,
        limits,
      });
    } else {
      await extractTarArchiveToDirectory({
        abortContext,
        allowedEntryRoots: params.allowedEntryRoots,
        archiveBytes: archiveStats.size,
        archivePath: params.archivePath,
        extractDir: stagingDir,
        isXz: archiveType === 'tar.xz',
        limits,
        linkPolicy: params.tarLinkPolicy ?? 'reject',
      });
    }

    abortContext.throwIfAborted();
    await publishStagedExtraction({
      destinationExisted,
      extractDir,
      stagingDir,
    });
    stagingDir = null;
  } catch (error) {
    let failure: unknown = error;
    try {
      abortContext.throwIfAborted();
    } catch (abortError) {
      failure = abortError;
    }
    if (stagingDir) {
      try {
        await rm(stagingDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 10,
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [failure, cleanupError],
          '[release-runtime] archive extraction failed and partial output cleanup also failed',
        );
      }
    }
    throw failure;
  } finally {
    abortContext.dispose();
  }
}
