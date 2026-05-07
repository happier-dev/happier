// @ts-check

import { brotliCompress, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { chmod, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants as zlibConstants } from 'node:zlib';

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const COMPRESSIBLE_EXTENSIONS = new Set(['.css', '.js', '.json', '.map', '.svg', '.wasm']);
const SIDECAR_EXTENSIONS = new Set(['.br', '.gz']);
const MIN_COMPRESSIBLE_BYTES = 1024;
const SUPPORTED_ENCODINGS = new Set(['br', 'gzip']);

function extensionOf(path) {
  const lower = path.toLowerCase();
  const index = lower.lastIndexOf('.');
  return index >= 0 ? lower.slice(index) : '';
}

function shouldPrecompress(relativePath, size) {
  const lower = relativePath.toLowerCase();
  for (const sidecarExtension of SIDECAR_EXTENSIONS) {
    if (lower.endsWith(sidecarExtension)) return false;
  }
  return size >= MIN_COMPRESSIBLE_BYTES && COMPRESSIBLE_EXTENSIONS.has(extensionOf(relativePath));
}

async function collectCompressibleFiles(rootDir, dir = rootDir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...await collectCompressibleFiles(rootDir, absolutePath, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(absolutePath).catch(() => null);
    if (!info?.isFile()) continue;
    if (shouldPrecompress(relativePath, info.size)) {
      files.push({ absolutePath, relativePath, size: info.size });
    }
  }
  return files;
}

async function writeBeneficialSidecar({ sourcePath, sidecarPath, bytes, compressedBytes }) {
  if (compressedBytes.length >= bytes.length) {
    await rm(sidecarPath, { force: true }).catch(() => {});
    return false;
  }
  await writeFile(sidecarPath, compressedBytes);
  await chmod(sidecarPath, 0o644).catch(() => {});
  return true;
}

function normalizeEncodings(encodings) {
  if (encodings == null) return ['br', 'gzip'];
  const values = [...encodings].map((encoding) => String(encoding).trim()).filter(Boolean);
  if (values.length === 0) throw new Error('[release] UI web precompression requires at least one encoding');
  for (const encoding of values) {
    if (!SUPPORTED_ENCODINGS.has(encoding)) {
      throw new Error(`[release] unsupported UI web precompression encoding: ${encoding}`);
    }
  }
  return [...new Set(values)];
}

export async function precompressUiWebAssets({ dir, encodings } = {}) {
  const root = String(dir ?? '').trim();
  if (!root) throw new Error('[release] UI web precompression requires --dir');
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) {
    throw new Error(`[release] UI web precompression directory is missing: ${root}`);
  }
  const enabledEncodings = new Set(normalizeEncodings(encodings));

  const files = await collectCompressibleFiles(root);
  let brotliFiles = 0;
  let gzipFiles = 0;
  for (const file of files) {
    const bytes = await readFile(file.absolutePath);
    if (enabledEncodings.has('br')) {
      const brotliBytes = await brotliCompressAsync(bytes, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        },
      });
      if (await writeBeneficialSidecar({
        sourcePath: file.absolutePath,
        sidecarPath: `${file.absolutePath}.br`,
        bytes,
        compressedBytes: brotliBytes,
      })) {
        brotliFiles += 1;
      }
    } else {
      await rm(`${file.absolutePath}.br`, { force: true }).catch(() => {});
    }
    if (enabledEncodings.has('gzip')) {
      const gzipBytes = await gzipAsync(bytes, { level: 9 });
      if (await writeBeneficialSidecar({
        sourcePath: file.absolutePath,
        sidecarPath: `${file.absolutePath}.gz`,
        bytes,
        compressedBytes: gzipBytes,
      })) {
        gzipFiles += 1;
      }
    } else {
      await rm(`${file.absolutePath}.gz`, { force: true }).catch(() => {});
    }
  }

  return {
    scannedFiles: files.length,
    brotliFiles,
    gzipFiles,
  };
}
