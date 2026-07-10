import { inflateRawSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { PypiWheelAssetError } from './types.js';

type ZipCentralEntry = Readonly<{
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
  externalFileAttributes: number;
}>;

function validateRelativeMemberPath(path: string): void {
  if (path.startsWith('/') || path.startsWith('\\')) {
    throw new PypiWheelAssetError('wheel_asset_absolute_path', '[pypi-wheel-asset] wheel asset path must be relative');
  }
  if (path.endsWith('/') || path.endsWith('\\')) {
    throw new PypiWheelAssetError('wheel_asset_directory', '[pypi-wheel-asset] wheel asset path must be a file');
  }
  if (path.split(/[\\/]+/).some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new PypiWheelAssetError('wheel_asset_traversal', '[pypi-wheel-asset] wheel asset path contains traversal');
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = 22;
  const start = Math.max(0, buffer.length - 0xffff - minimum);
  for (let offset = buffer.length - minimum; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new PypiWheelAssetError('wheel_asset_corrupt', '[pypi-wheel-asset] corrupt wheel archive');
}

function readCentralDirectory(buffer: Buffer): readonly ZipCentralEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipCentralEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new PypiWheelAssetError('wheel_asset_corrupt', '[pypi-wheel-asset] corrupt wheel central directory');
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalFileAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > buffer.length) {
      throw new PypiWheelAssetError('wheel_asset_corrupt', '[pypi-wheel-asset] corrupt wheel member name');
    }
    entries.push({
      name: buffer.subarray(nameStart, nameEnd).toString('utf8'),
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
      externalFileAttributes,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function readEntryData(buffer: Buffer, entry: ZipCentralEntry, maxOutputLength: number): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new PypiWheelAssetError('wheel_asset_corrupt', '[pypi-wheel-asset] corrupt wheel local header');
  }
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new PypiWheelAssetError('wheel_asset_corrupt', '[pypi-wheel-asset] corrupt wheel member data');
  }
  const compressed = buffer.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod === 8) {
    try {
      return inflateRawSync(compressed, { maxOutputLength });
    } catch (error) {
      if (typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new PypiWheelAssetError('wheel_asset_oversize', '[pypi-wheel-asset] wheel asset exceeds configured size cap');
      }
      throw error;
    }
  }
  throw new PypiWheelAssetError('wheel_asset_unsupported_compression', '[pypi-wheel-asset] unsupported wheel compression method');
}

function isSymlink(entry: ZipCentralEntry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
}

export async function extractExactWheelAsset(params: Readonly<{
  wheelPath: string;
  assetPath: string;
  outputPath: string;
  maxAssetSizeBytes: number;
}>): Promise<void> {
  validateRelativeMemberPath(params.assetPath);
  const wheel = await readFile(params.wheelPath);
  const matches = readCentralDirectory(wheel).filter((entry) => entry.name === params.assetPath);
  if (matches.length === 0) {
    throw new PypiWheelAssetError('wheel_asset_not_found', `[pypi-wheel-asset] wheel asset not found: ${params.assetPath}`);
  }
  if (matches.length > 1) {
    throw new PypiWheelAssetError('wheel_asset_duplicate_member', `[pypi-wheel-asset] duplicate wheel asset member: ${params.assetPath}`);
  }

  const entry = matches[0];
  if (!entry) {
    throw new PypiWheelAssetError('wheel_asset_not_found', `[pypi-wheel-asset] wheel asset not found: ${params.assetPath}`);
  }
  if (entry.name.endsWith('/')) {
    throw new PypiWheelAssetError('wheel_asset_directory', '[pypi-wheel-asset] wheel asset member is a directory');
  }
  validateRelativeMemberPath(entry.name);
  if (isSymlink(entry)) {
    throw new PypiWheelAssetError('wheel_asset_symlink', '[pypi-wheel-asset] wheel asset member is a symlink');
  }
  if (entry.uncompressedSize > params.maxAssetSizeBytes) {
    throw new PypiWheelAssetError('wheel_asset_oversize', '[pypi-wheel-asset] wheel asset exceeds configured size cap');
  }

  const data = readEntryData(wheel, entry, params.maxAssetSizeBytes);
  if (data.length > params.maxAssetSizeBytes) {
    throw new PypiWheelAssetError('wheel_asset_oversize', '[pypi-wheel-asset] wheel asset exceeds configured size cap');
  }

  await mkdir(dirname(params.outputPath), { recursive: true });
  await writeFile(params.outputPath, data);
}
