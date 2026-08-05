import { createReadStream, createWriteStream } from 'node:fs';
import type { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createInflateRaw } from 'node:zlib';

import * as tar from 'tar';
import type { TarOptionsWithAliasesAsyncNoFile } from 'tar';
import * as yauzl from 'yauzl';

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
  compressionMethod: number;
  crc32: number;
  decodedRawFileName: string;
  externalFileAttributes: number;
  fileName: string;
  generalPurposeBitFlag: number;
  rawFileName: Buffer;
  relativeOffsetOfLocalHeader: number;
  uncompressedSize: number;
  usesZip64DataDescriptor: boolean;
  versionMadeBy: number;
}>;

type ValidatedZipArchiveEntry = ZipArchiveEntry & Readonly<{
  kind: ArchiveEntryKind;
  mode: number;
  path: string | null;
}>;

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0
      ? 0xedb88320 ^ (value >>> 1)
      : value >>> 1;
  }
  return value >>> 0;
});

function updateCrc32(previousChecksum: number, chunk: Buffer): number {
  let checksum = (previousChecksum ^ 0xffffffff) >>> 0;
  for (const byte of chunk) {
    checksum = (CRC32_TABLE[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8)) >>> 0;
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

const CP437_CHARACTERS = Array.from(
  '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ',
);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

type RawYauzlEntry = Omit<yauzl.Entry, 'fileName'> & Readonly<{
  fileName: Buffer;
}>;

type ZipExtraField = Readonly<{
  data: Buffer;
  id: number;
}>;

function decodeZipUnicodePath(params: Readonly<{
  extraFields: readonly ZipExtraField[];
  headerName: 'central' | 'local';
  rawFileName: Buffer;
}>): string | null {
  let unicodeFileName: string | null = null;
  for (const field of params.extraFields) {
    if (
      field.id !== 0x7075
      || field.data.byteLength < 6
      || field.data.readUInt8(0) !== 1
      || field.data.readUInt32LE(1) !== updateCrc32(0, params.rawFileName)
    ) {
      continue;
    }
    let decodedName: string;
    try {
      decodedName = UTF8_DECODER.decode(field.data.subarray(5));
    } catch {
      throw new Error(
        `[release-runtime] ZIP ${params.headerName} Unicode path extra field is not valid UTF-8`,
      );
    }
    if (unicodeFileName !== null && unicodeFileName !== decodedName) {
      throw new Error(
        `[release-runtime] ZIP ${params.headerName} header has conflicting Unicode path extra fields`,
      );
    }
    unicodeFileName = decodedName;
  }
  return unicodeFileName;
}

function decodeZipEntryFileName(entry: RawYauzlEntry): ZipArchiveEntry {
  const rawFileName = Buffer.from(entry.fileName);
  let fileName: string;
  if ((entry.generalPurposeBitFlag & 0x800) !== 0) {
    try {
      fileName = UTF8_DECODER.decode(rawFileName);
    } catch {
      throw new Error('[release-runtime] ZIP entry filename is not valid UTF-8');
    }
  } else {
    fileName = Array.from(rawFileName, (byte) => CP437_CHARACTERS[byte]!).join('');
  }
  const decodedRawFileName = fileName;

  const unicodeFileName = decodeZipUnicodePath({
    extraFields: entry.extraFields,
    headerName: 'central',
    rawFileName,
  });
  if (
    unicodeFileName !== null
    && (entry.generalPurposeBitFlag & 0x800) !== 0
    && unicodeFileName !== decodedRawFileName
  ) {
    throw new Error(
      '[release-runtime] ZIP central Unicode path extra field conflicts with its UTF-8 filename',
    );
  }
  if (unicodeFileName !== null) fileName = unicodeFileName;

  return {
    compressedSize: entry.compressedSize,
    compressionMethod: entry.compressionMethod,
    crc32: entry.crc32,
    decodedRawFileName,
    externalFileAttributes: entry.externalFileAttributes,
    fileName,
    generalPurposeBitFlag: entry.generalPurposeBitFlag,
    rawFileName,
    relativeOffsetOfLocalHeader: entry.relativeOffsetOfLocalHeader,
    uncompressedSize: entry.uncompressedSize,
    usesZip64DataDescriptor: (
      (entry.generalPurposeBitFlag & 0x8) !== 0
      && entry.extraFields.some((field) => field.id === 0x0001)
    ),
    versionMadeBy: entry.versionMadeBy,
  };
}

function createZipEntryValidator(params: Readonly<{
  allowedEntryRoots?: readonly string[];
  abortContext: ArchiveAbortContext;
  budget: ArchiveBudget;
}>): (entry: ZipArchiveEntry) => ValidatedZipArchiveEntry {
  const validatePath = createArchiveEntryValidator(params.allowedEntryRoots);
  return (entry) => {
    params.abortContext.throwIfAborted();
    if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
      throw new Error(`[release-runtime] encrypted archive entries are not supported (${entry.fileName})`);
    }
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      throw new Error(
        `[release-runtime] ZIP compression method is not supported: ${entry.compressionMethod} (${entry.fileName})`,
      );
    }
    if (
      !Number.isSafeInteger(entry.compressedSize)
      || entry.compressedSize < 0
      || !Number.isSafeInteger(entry.relativeOffsetOfLocalHeader)
      || entry.relativeOffsetOfLocalHeader < 0
    ) {
      throw new Error(`[release-runtime] archive entry has invalid ZIP offsets (${entry.fileName})`);
    }
    if (entry.compressionMethod === 0 && entry.compressedSize !== entry.uncompressedSize) {
      throw new Error(`[release-runtime] stored ZIP entry has inconsistent sizes (${entry.fileName})`);
    }
    const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
    const unixFileType = unixMode & 0o170000;
    const madeBy = entry.versionMadeBy >>> 8;
    const isDirectory = entry.fileName.endsWith('/')
      || unixFileType === 0o040000
      || (madeBy === 0 && entry.externalFileAttributes === 16);
    if (unixFileType !== 0 && unixFileType !== 0o040000 && unixFileType !== 0o100000) {
      throw new Error(`[release-runtime] archive entry type is not supported: link or special file (${entry.fileName})`);
    }
    const kind = isDirectory ? 'directory' : 'file';
    params.budget.account(kind, isDirectory ? 0 : entry.uncompressedSize);
    return {
      ...entry,
      kind,
      mode: unixMode & 0o777,
      path: validatePath(entry.fileName, kind),
    };
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

async function readValidatedZipEntries(params: Readonly<{
  abortContext: ArchiveAbortContext;
  archivePath: string;
  validateEntry: (entry: ZipArchiveEntry) => ValidatedZipArchiveEntry;
}>): Promise<readonly ValidatedZipArchiveEntry[]> {
  const entries: ValidatedZipArchiveEntry[] = [];
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let zipFile: yauzl.ZipFile | null = null;
    let openCompleted = false;
    let settlementRequested = false;
    let settlementError: unknown;
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      if (settlementError === undefined) {
        resolvePromise();
      } else {
        rejectPromise(settlementError);
      }
    };
    const closeThenComplete = () => {
      if (zipFile?.isOpen) {
        zipFile.once('close', complete);
        zipFile.close();
        return;
      }
      complete();
    };
    const settle = (error?: unknown) => {
      if (settlementRequested) return;
      settlementRequested = true;
      settlementError = error;
      params.abortContext.signal.removeEventListener('abort', onAbort);
      if (openCompleted) closeThenComplete();
    };
    const onAbort = () => settle(params.abortContext.signal.reason);
    params.abortContext.signal.addEventListener('abort', onAbort, { once: true });

    yauzl.open(
      params.archivePath,
      {
        autoClose: false,
        decodeStrings: false,
        lazyEntries: true,
        strictFileNames: false,
        validateEntrySizes: true,
      },
      (openError, openedZipFile) => {
        openCompleted = true;
        if (openError) {
          settle(openError);
          closeThenComplete();
          return;
        }
        zipFile = openedZipFile;
        if (settlementRequested) {
          closeThenComplete();
          return;
        }
        zipFile.once('error', settle);
        zipFile.on('entry', (entry: yauzl.Entry) => {
          try {
            entries.push(params.validateEntry(
              decodeZipEntryFileName(entry as unknown as RawYauzlEntry),
            ));
            zipFile?.readEntry();
          } catch (error) {
            settle(error);
          }
        });
        zipFile.once('end', () => settle());
        zipFile.readEntry();
      },
    );
  });
  params.abortContext.throwIfAborted();
  return entries;
}

type ZipCentralDirectory = Readonly<{
  offset: number;
  size: number;
}>;

type ValidatedZipEntryRange = Readonly<{
  dataOffset: number;
  rangeEnd: number;
  rangeStart: number;
}>;

async function readZipArchiveBytes(params: Readonly<{
  abortContext: ArchiveAbortContext;
  archiveBytes: number;
  archiveFile: Awaited<ReturnType<typeof open>>;
  byteLength: number;
  position: number;
}>): Promise<Buffer> {
  const end = params.position + params.byteLength;
  if (
    !Number.isSafeInteger(params.position)
    || params.position < 0
    || !Number.isSafeInteger(end)
    || end > params.archiveBytes
  ) {
    throw new Error('[release-runtime] ZIP structure is outside the archive payload');
  }

  const buffer = Buffer.alloc(params.byteLength);
  let bytesRead = 0;
  while (bytesRead < buffer.byteLength) {
    params.abortContext.throwIfAborted();
    const readResult = await params.archiveFile.read(
      buffer,
      bytesRead,
      buffer.byteLength - bytesRead,
      params.position + bytesRead,
    );
    params.abortContext.throwIfAborted();
    if (readResult.bytesRead === 0) break;
    bytesRead += readResult.bytesRead;
  }
  if (bytesRead !== buffer.byteLength) {
    throw new Error('[release-runtime] ZIP structure is truncated');
  }
  return buffer;
}

function readSafeZipUInt64(buffer: Buffer, offset: number, description: string): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`[release-runtime] ZIP ${description} exceeds the supported numeric range`);
  }
  return Number(value);
}

async function readZipCentralDirectory(params: Readonly<{
  abortContext: ArchiveAbortContext;
  archiveBytes: number;
  archiveFile: Awaited<ReturnType<typeof open>>;
}>): Promise<ZipCentralDirectory> {
  const minimumEndRecordBytes = 22;
  if (params.archiveBytes < minimumEndRecordBytes) {
    throw new Error('[release-runtime] ZIP end record is missing');
  }
  const tailByteLength = Math.min(params.archiveBytes, minimumEndRecordBytes + 0xffff);
  const tailPosition = params.archiveBytes - tailByteLength;
  const tail = await readZipArchiveBytes({
    ...params,
    byteLength: tailByteLength,
    position: tailPosition,
  });
  let endRecordOffset = -1;
  for (let offset = tail.byteLength - minimumEndRecordBytes; offset >= 0; offset -= 1) {
    if (
      tail.readUInt32LE(offset) === 0x06054b50
      && offset + minimumEndRecordBytes + tail.readUInt16LE(offset + 20) === tail.byteLength
    ) {
      endRecordOffset = offset;
      break;
    }
  }
  if (endRecordOffset < 0) {
    throw new Error('[release-runtime] ZIP end record is missing or malformed');
  }
  if (
    tail.readUInt16LE(endRecordOffset + 4) !== 0
    || tail.readUInt16LE(endRecordOffset + 6) !== 0
  ) {
    throw new Error('[release-runtime] multi-disk ZIP archives are not supported');
  }

  const absoluteEndRecordOffset = tailPosition + endRecordOffset;
  let size = tail.readUInt32LE(endRecordOffset + 12);
  let offset = tail.readUInt32LE(endRecordOffset + 16);
  let metadataStart = absoluteEndRecordOffset;
  if (size === 0xffffffff || offset === 0xffffffff) {
    const locatorPosition = absoluteEndRecordOffset - 20;
    const locator = await readZipArchiveBytes({
      ...params,
      byteLength: 20,
      position: locatorPosition,
    });
    if (
      locator.readUInt32LE(0) !== 0x07064b50
      || locator.readUInt32LE(4) !== 0
      || locator.readUInt32LE(16) !== 1
    ) {
      throw new Error('[release-runtime] ZIP64 end locator is missing or unsupported');
    }
    const zip64EndRecordOffset = readSafeZipUInt64(locator, 8, 'ZIP64 end-record offset');
    const zip64EndRecord = await readZipArchiveBytes({
      ...params,
      byteLength: 56,
      position: zip64EndRecordOffset,
    });
    if (
      zip64EndRecord.readUInt32LE(0) !== 0x06064b50
      || zip64EndRecord.readUInt32LE(16) !== 0
      || zip64EndRecord.readUInt32LE(20) !== 0
    ) {
      throw new Error('[release-runtime] ZIP64 end record is missing or unsupported');
    }
    size = readSafeZipUInt64(zip64EndRecord, 40, 'central-directory size');
    offset = readSafeZipUInt64(zip64EndRecord, 48, 'central-directory offset');
    metadataStart = zip64EndRecordOffset;
  }

  const centralDirectoryEnd = offset + size;
  if (
    !Number.isSafeInteger(centralDirectoryEnd)
    || offset < 0
    || centralDirectoryEnd > metadataStart
  ) {
    throw new Error('[release-runtime] ZIP central directory is outside its declared range');
  }
  return { offset, size };
}

function parseZipExtraFields(buffer: Buffer, headerName: 'central' | 'local'): readonly ZipExtraField[] {
  const fields: ZipExtraField[] = [];
  let offset = 0;
  while (offset < buffer.byteLength) {
    if (offset + 4 > buffer.byteLength) {
      throw new Error(`[release-runtime] ZIP ${headerName} extra field is malformed`);
    }
    const fieldSize = buffer.readUInt16LE(offset + 2);
    const fieldEnd = offset + 4 + fieldSize;
    if (fieldEnd > buffer.byteLength) {
      throw new Error(`[release-runtime] ZIP ${headerName} extra field is malformed`);
    }
    fields.push({
      data: buffer.subarray(offset + 4, fieldEnd),
      id: buffer.readUInt16LE(offset),
    });
    offset = fieldEnd;
  }
  return fields;
}

function readLocalZipSizes(params: Readonly<{
  compressedSize: number;
  extraFields: readonly ZipExtraField[];
  uncompressedSize: number;
}>): Readonly<{ compressedSize: number; uncompressedSize: number }> {
  let compressedSize = params.compressedSize;
  let uncompressedSize = params.uncompressedSize;
  if (compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff) {
    return { compressedSize, uncompressedSize };
  }

  const zip64Data = params.extraFields.find((field) => field.id === 0x0001)?.data ?? null;
  if (!zip64Data) {
    throw new Error('[release-runtime] ZIP local header is missing ZIP64 sizes');
  }

  let zip64Offset = 0;
  if (uncompressedSize === 0xffffffff) {
    if (zip64Offset + 8 > zip64Data.byteLength) {
      throw new Error('[release-runtime] ZIP local header is missing its ZIP64 uncompressed size');
    }
    uncompressedSize = readSafeZipUInt64(zip64Data, zip64Offset, 'local uncompressed size');
    zip64Offset += 8;
  }
  if (compressedSize === 0xffffffff) {
    if (zip64Offset + 8 > zip64Data.byteLength) {
      throw new Error('[release-runtime] ZIP local header is missing its ZIP64 compressed size');
    }
    compressedSize = readSafeZipUInt64(zip64Data, zip64Offset, 'local compressed size');
  }
  return { compressedSize, uncompressedSize };
}

function readZipDataDescriptorSize(params: Readonly<{
  descriptor: Buffer;
  entry: ValidatedZipArchiveEntry;
}>): number {
  const candidates: number[] = [];
  const hasSignature = (
    params.descriptor.byteLength >= 4
    && params.descriptor.readUInt32LE(0) === 0x08074b50
  );
  const signatureVariants = hasSignature ? [true, false] : [false];
  const sizeVariants: readonly (4 | 8)[] = params.entry.usesZip64DataDescriptor ? [8] : [4];

  for (const signed of signatureVariants) {
    for (const sizeBytes of sizeVariants) {
      const valueOffset = signed ? 4 : 0;
      const byteLength = valueOffset + 4 + (2 * sizeBytes);
      if (byteLength > params.descriptor.byteLength) continue;
      const checksum = params.descriptor.readUInt32LE(valueOffset);
      const compressedSize = sizeBytes === 4
        ? params.descriptor.readUInt32LE(valueOffset + 4)
        : readSafeZipUInt64(params.descriptor, valueOffset + 4, 'descriptor compressed size');
      const uncompressedSize = sizeBytes === 4
        ? params.descriptor.readUInt32LE(valueOffset + 8)
        : readSafeZipUInt64(
            params.descriptor,
            valueOffset + 4 + sizeBytes,
            'descriptor uncompressed size',
          );
      if (
        checksum === params.entry.crc32
        && compressedSize === params.entry.compressedSize
        && uncompressedSize === params.entry.uncompressedSize
      ) {
        candidates.push(byteLength);
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `[release-runtime] ZIP data descriptor is missing or conflicts with the central header (${params.entry.fileName})`,
    );
  }
  return candidates[0]!;
}

async function readZipEntryDataOffset(params: Readonly<{
  abortContext: ArchiveAbortContext;
  archiveBytes: number;
  archiveFile: Awaited<ReturnType<typeof open>>;
  centralDirectoryOffset: number;
  entry: ValidatedZipArchiveEntry;
}>): Promise<ValidatedZipEntryRange> {
  const localHeader = await readZipArchiveBytes({
    ...params,
    byteLength: 30,
    position: params.entry.relativeOffsetOfLocalHeader,
  });
  if (
    localHeader.readUInt32LE(0) !== 0x04034b50
  ) {
    throw new Error(`[release-runtime] archive entry has an invalid ZIP local header (${params.entry.fileName})`);
  }

  const localFlags = localHeader.readUInt16LE(6);
  const localCompressionMethod = localHeader.readUInt16LE(8);
  if (
    localFlags !== params.entry.generalPurposeBitFlag
    || localCompressionMethod !== params.entry.compressionMethod
  ) {
    throw new Error(`[release-runtime] ZIP central and local headers disagree (${params.entry.fileName})`);
  }

  const fileNameBytes = localHeader.readUInt16LE(26);
  const extraFieldBytes = localHeader.readUInt16LE(28);
  const localVariableFields = await readZipArchiveBytes({
    ...params,
    byteLength: fileNameBytes + extraFieldBytes,
    position: params.entry.relativeOffsetOfLocalHeader + localHeader.byteLength,
  });
  const localFileName = localVariableFields.subarray(0, fileNameBytes);
  const localExtraField = localVariableFields.subarray(fileNameBytes);
  if (!localFileName.equals(params.entry.rawFileName)) {
    throw new Error(`[release-runtime] ZIP central and local headers disagree (${params.entry.fileName})`);
  }
  const localExtraFields = parseZipExtraFields(localExtraField, 'local');
  const localUnicodeFileName = decodeZipUnicodePath({
    extraFields: localExtraFields,
    headerName: 'local',
    rawFileName: localFileName,
  });
  if (
    localUnicodeFileName !== null
    && (localFlags & 0x800) !== 0
    && localUnicodeFileName !== params.entry.decodedRawFileName
  ) {
    throw new Error(
      `[release-runtime] ZIP local Unicode path extra field conflicts with its UTF-8 filename (${params.entry.fileName})`,
    );
  }
  const localSemanticFileName = localUnicodeFileName ?? params.entry.decodedRawFileName;
  if (params.entry.fileName !== localSemanticFileName) {
    throw new Error(
      `[release-runtime] ZIP central and local Unicode path fields disagree (${params.entry.fileName})`,
    );
  }
  if ((localFlags & 0x8) === 0) {
    const localSizes = readLocalZipSizes({
      compressedSize: localHeader.readUInt32LE(18),
      extraFields: localExtraFields,
      uncompressedSize: localHeader.readUInt32LE(22),
    });
    if (
      localHeader.readUInt32LE(14) !== params.entry.crc32
      || localSizes.compressedSize !== params.entry.compressedSize
      || localSizes.uncompressedSize !== params.entry.uncompressedSize
    ) {
      throw new Error(`[release-runtime] ZIP central and local headers disagree (${params.entry.fileName})`);
    }
  }

  const dataOffset = params.entry.relativeOffsetOfLocalHeader
    + localHeader.byteLength
    + fileNameBytes
    + extraFieldBytes;
  const dataEnd = dataOffset + params.entry.compressedSize;
  if (
    !Number.isSafeInteger(dataOffset)
    || dataOffset < 0
    || !Number.isSafeInteger(dataEnd)
    || dataEnd > params.centralDirectoryOffset
  ) {
    throw new Error(`[release-runtime] archive entry data enters the ZIP central directory (${params.entry.fileName})`);
  }
  let rangeEnd = dataEnd;
  if ((localFlags & 0x8) !== 0) {
    const descriptor = await readZipArchiveBytes({
      ...params,
      byteLength: Math.min(24, params.centralDirectoryOffset - dataEnd),
      position: dataEnd,
    });
    rangeEnd += readZipDataDescriptorSize({
      descriptor,
      entry: params.entry,
    });
    if (rangeEnd > params.centralDirectoryOffset) {
      throw new Error(
        `[release-runtime] ZIP data descriptor enters the central directory (${params.entry.fileName})`,
      );
    }
  }
  return {
    dataOffset,
    rangeEnd,
    rangeStart: params.entry.relativeOffsetOfLocalHeader,
  };
}

function createZipPayloadVerifier(params: Readonly<{
  abortContext: ArchiveAbortContext;
  entry: ValidatedZipArchiveEntry;
}>): Transform {
  let byteLength = 0;
  let checksum = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteLength += chunk.byteLength;
      if (byteLength > params.entry.uncompressedSize) {
        const error = new Error(
          `[release-runtime] ZIP entry expanded beyond its declared size (${params.entry.fileName})`,
        );
        params.abortContext.abort(error);
        callback(error);
        return;
      }
      checksum = updateCrc32(checksum, chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (byteLength !== params.entry.uncompressedSize) {
        callback(new Error(
          `[release-runtime] ZIP entry size does not match its declaration (${params.entry.fileName})`,
        ));
        return;
      }
      if ((checksum >>> 0) !== (params.entry.crc32 >>> 0)) {
        callback(new Error(
          `[release-runtime] ZIP entry checksum does not match its declaration (${params.entry.fileName})`,
        ));
        return;
      }
      callback();
    },
  });
}

async function extractValidatedZipEntry(params: Readonly<{
  abortContext: ArchiveAbortContext;
  archivePath: string;
  entry: ValidatedZipArchiveEntry & Readonly<{ dataOffset: number }>;
  extractDir: string;
}>): Promise<void> {
  params.abortContext.throwIfAborted();
  if (params.entry.path === null) return;
  const outputPath = join(params.extractDir, ...params.entry.path.split('/'));
  if (params.entry.kind === 'directory') {
    await mkdir(outputPath, {
      recursive: true,
      mode: params.entry.mode || 0o755,
    });
    return;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const payloadSource = params.entry.compressedSize === 0
    ? Readable.from([])
    : createReadStream(params.archivePath, {
        start: params.entry.dataOffset,
        end: params.entry.dataOffset + params.entry.compressedSize - 1,
      });
  const verifier = createZipPayloadVerifier(params);
  const output = createWriteStream(outputPath, {
    flags: 'wx',
    mode: params.entry.mode || 0o644,
  });
  if (params.entry.compressionMethod === 8) {
    const inflater = createInflateRaw();
    await pipeline(
      payloadSource,
      inflater,
      verifier,
      output,
      { signal: params.abortContext.signal },
    );
    if (inflater.bytesWritten !== params.entry.compressedSize) {
      throw new Error(
        `[release-runtime] ZIP deflate stream did not consume its declared compressed span (${params.entry.fileName})`,
      );
    }
  } else {
    await pipeline(
      payloadSource,
      verifier,
      output,
      { signal: params.abortContext.signal },
    );
  }
  params.abortContext.throwIfAborted();
}

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
  const entries = await readValidatedZipEntries({
    abortContext: params.abortContext,
    archivePath: params.archivePath,
    validateEntry,
  });
  const archiveFile = await open(params.archivePath, 'r');
  try {
    const centralDirectory = await readZipCentralDirectory({
      abortContext: params.abortContext,
      archiveBytes: params.archiveBytes,
      archiveFile,
    });
    const entriesWithOffsets: Array<ValidatedZipArchiveEntry & Readonly<{ dataOffset: number }>> = [];
    const ranges: Array<ValidatedZipEntryRange & Readonly<{ fileName: string }>> = [];
    for (const entry of entries) {
      params.abortContext.throwIfAborted();
      const range = await readZipEntryDataOffset({
        abortContext: params.abortContext,
        archiveBytes: params.archiveBytes,
        archiveFile,
        centralDirectoryOffset: centralDirectory.offset,
        entry,
      });
      entriesWithOffsets.push({
        ...entry,
        dataOffset: range.dataOffset,
      });
      ranges.push({ ...range, fileName: entry.fileName });
    }
    ranges.sort((left, right) => left.rangeStart - right.rangeStart);
    for (let index = 1; index < ranges.length; index += 1) {
      const previous = ranges[index - 1]!;
      const current = ranges[index]!;
      if (current.rangeStart < previous.rangeEnd) {
        throw new Error(
          `[release-runtime] ZIP local header and payload ranges overlap (${previous.fileName}, ${current.fileName})`,
        );
      }
    }
    await archiveFile.close();

    for (const entry of entriesWithOffsets) {
      await extractValidatedZipEntry({
        abortContext: params.abortContext,
        archivePath: params.archivePath,
        entry,
        extractDir: params.extractDir,
      });
    }
  } finally {
    await archiveFile.close().catch(() => undefined);
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
