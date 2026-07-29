import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { extractExactWheelAsset } from './extract.js';
import {
  resolvePypiWheelAsset,
  type PypiWheelAssetFetchJson,
  type PypiWheelAssetSimpleIndex,
} from './resolve.js';
import {
  PypiWheelAssetError,
  type PypiWheelAssetHostPlatform,
  type PypiWheelAssetLinuxLibc,
  type PypiWheelAssetPlatformMap,
} from './types.js';

const DEFAULT_MAX_WHEEL_SIZE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ASSET_SIZE_BYTES = 256 * 1024 * 1024;

type FetchBinaryResponse = Readonly<{
  ok: boolean;
  status: number;
  headers?: Readonly<{ get: (name: string) => string | null }>;
  body?: Readonly<{
    getReader: () => {
      read: () => Promise<Readonly<{ done: boolean; value?: Uint8Array | undefined }>>;
      cancel?: () => Promise<void>;
    };
  }>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

export type PypiWheelAssetFetchWheel = (url: string, init: Readonly<{
  headers: Readonly<Record<string, string>>;
}>) => Promise<Buffer | Uint8Array | ArrayBuffer>;

export type PypiWheelAssetCompatibilityProbe = (params: Readonly<{
  executablePath: string;
  probeId: string;
  distribution: string;
  version: string;
}>) => Promise<Readonly<{ ok: true } | { ok: false; errorMessage?: string }>>;

export type InstalledPypiWheelAssetMetadata = Readonly<{
  sourceKind: 'managed_pypi_wheel_asset';
  distribution: string;
  version: string;
  wheelFilename: string;
  wheelDigest: string;
  assetPath: string;
  platform: PypiWheelAssetHostPlatform;
  executablePath: string;
  compatibilityProbe: Readonly<{ id: string | null; ok: boolean; errorMessage?: string }>;
}>;

export type InstalledPypiWheelAsset = Readonly<{
  executablePath: string;
  metadataPath: string;
  version: string;
  metadata: InstalledPypiWheelAssetMetadata;
}>;

function toBuffer(value: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function commandBasenameFromAsset(assetPath: string): string {
  return basename(assetPath.replace(/\\/g, '/'));
}

function currentMetadataPath(installRoot: string): string {
  return join(installRoot, 'current.json');
}

function safePathSegment(value: string): string {
  const safe = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
  return safe || 'version';
}

function isInstalledMetadata(value: unknown): value is InstalledPypiWheelAssetMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.sourceKind === 'managed_pypi_wheel_asset'
    && typeof record.distribution === 'string'
    && typeof record.version === 'string'
    && typeof record.wheelFilename === 'string'
    && typeof record.wheelDigest === 'string'
    && typeof record.assetPath === 'string'
    && typeof record.platform === 'string'
    && typeof record.executablePath === 'string';
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

async function resolveContainedInstalledExecutable(
  installRoot: string,
  executablePath: string,
): Promise<string | null> {
  const resolvedRoot = resolve(installRoot);
  const resolvedExecutable = resolve(executablePath);
  if (!isPathInsideRoot(resolvedRoot, resolvedExecutable)) return null;

  try {
    const [canonicalRoot, canonicalExecutable, executableStats] = await Promise.all([
      realpath(resolvedRoot),
      realpath(resolvedExecutable),
      stat(resolvedExecutable),
    ]);
    if (!executableStats.isFile() || !isPathInsideRoot(canonicalRoot, canonicalExecutable)) return null;
    return canonicalExecutable;
  } catch {
    return null;
  }
}

export async function readInstalledPypiWheelAsset(installRoot: string): Promise<InstalledPypiWheelAsset | null> {
  const metadataPath = currentMetadataPath(installRoot);
  let metadata: InstalledPypiWheelAssetMetadata;
  try {
    const parsed = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown;
    if (!isInstalledMetadata(parsed)) return null;
    metadata = parsed;
  } catch {
    return null;
  }

  const executablePath = await resolveContainedInstalledExecutable(installRoot, metadata.executablePath);
  if (!executablePath) return null;

  return {
    executablePath,
    metadataPath,
    version: metadata.version,
    metadata,
  };
}

async function defaultFetchWheel(
  url: string,
  init: Readonly<{
    headers: Readonly<Record<string, string>>;
  }>,
  maxWheelSizeBytes: number,
): Promise<Buffer> {
  if (typeof globalThis.fetch !== 'function') {
    throw new PypiWheelAssetError('wheel_download_failed', '[pypi-wheel-asset] fetch is unavailable');
  }
  const response = await globalThis.fetch(url, init) as FetchBinaryResponse;
  if (!response.ok) {
    throw new PypiWheelAssetError('wheel_download_failed', `[pypi-wheel-asset] failed to download wheel (${response.status})`);
  }
  const contentLengthHeader = response.headers?.get('content-length');
  const contentLength = Number.parseInt(contentLengthHeader ?? '', 10);
  if (Number.isFinite(contentLength) && !Number.isNaN(contentLength) && contentLength > maxWheelSizeBytes) {
    throw new PypiWheelAssetError('wheel_size_exceeded', '[pypi-wheel-asset] wheel exceeds configured size cap');
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxWheelSizeBytes) {
      throw new PypiWheelAssetError('wheel_size_exceeded', '[pypi-wheel-asset] wheel exceeds configured size cap');
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value) {
        bytesRead += result.value.byteLength;
        if (bytesRead > maxWheelSizeBytes) {
          await reader.cancel?.().catch(() => undefined);
          throw new PypiWheelAssetError('wheel_size_exceeded', '[pypi-wheel-asset] wheel exceeds configured size cap');
        }
        chunks.push(Buffer.from(result.value));
      }
    }
  } catch (error) {
    if (error instanceof PypiWheelAssetError) {
      throw error;
    }
    throw new PypiWheelAssetError('wheel_download_failed', `[pypi-wheel-asset] failed to read wheel: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  return Buffer.concat(chunks, bytesRead);
}

async function downloadVerifiedWheel(params: Readonly<{
  url: string;
  expectedSha256: string;
  destinationPath: string;
  maxWheelSizeBytes: number;
  fetchWheel: PypiWheelAssetFetchWheel;
}>): Promise<void> {
  const bytes = toBuffer(await params.fetchWheel(params.url, {
    headers: {
      accept: 'application/octet-stream',
      'user-agent': 'happier-cli',
    },
  }));
  if (bytes.length > params.maxWheelSizeBytes) {
    throw new PypiWheelAssetError('wheel_size_exceeded', '[pypi-wheel-asset] wheel exceeds configured size cap');
  }
  if (sha256(bytes) !== params.expectedSha256) {
    throw new PypiWheelAssetError('wheel_digest_mismatch', '[pypi-wheel-asset] wheel checksum verification failed');
  }
  await mkdir(dirname(params.destinationPath), { recursive: true });
  await writeFile(params.destinationPath, bytes);
}

async function promoteCandidate(params: Readonly<{
  installRoot: string;
  stagingDir: string;
  versionDir: string;
  metadata: InstalledPypiWheelAssetMetadata;
}>): Promise<void> {
  try {
    await rename(params.stagingDir, params.versionDir);
  } catch (error) {
    throw new PypiWheelAssetError(
      'promotion_failed',
      error instanceof Error ? `[pypi-wheel-asset] failed to promote candidate: ${error.message}` : '[pypi-wheel-asset] failed to promote candidate',
    );
  }

  const pointerPath = currentMetadataPath(params.installRoot);
  const pointerTempPath = join(params.installRoot, `.current-${process.pid}-${randomUUID()}.json.tmp`);
  try {
    await writeFile(pointerTempPath, `${JSON.stringify(params.metadata, null, 2)}\n`, 'utf8');
    await rename(pointerTempPath, pointerPath);
  } catch (error) {
    await rm(pointerTempPath, { force: true }).catch(() => undefined);
    await rm(params.versionDir, { recursive: true, force: true }).catch(() => undefined);
    throw new PypiWheelAssetError(
      'promotion_failed',
      error instanceof Error ? `[pypi-wheel-asset] failed to promote candidate: ${error.message}` : '[pypi-wheel-asset] failed to promote candidate',
    );
  }
}

export async function installPypiWheelAsset(params: Readonly<{
  installRoot: string;
  distribution: string;
  versionSpecifier: string;
  assetPathByPlatform: PypiWheelAssetPlatformMap;
  executable: true;
  platform: PypiWheelAssetHostPlatform;
  linuxLibc?: PypiWheelAssetLinuxLibc;
  compatibilityProbe?: string;
  trustedPublisher?: string;
  maxWheelSizeBytes?: number;
  maxAssetSizeBytes?: number;
  index?: PypiWheelAssetSimpleIndex;
  fetchJson?: PypiWheelAssetFetchJson;
  fetchWheel?: PypiWheelAssetFetchWheel;
  probeExecutable?: PypiWheelAssetCompatibilityProbe;
}>): Promise<InstalledPypiWheelAsset> {
  const resolved = await resolvePypiWheelAsset({
    distribution: params.distribution,
    versionSpecifier: params.versionSpecifier,
    assetPathByPlatform: params.assetPathByPlatform,
    platform: params.platform,
    ...(params.linuxLibc ? { linuxLibc: params.linuxLibc } : {}),
    ...(params.index ? { index: params.index } : {}),
    ...(params.fetchJson ? { fetchJson: params.fetchJson } : {}),
  });
  if (!resolved.ok) {
    throw new PypiWheelAssetError(resolved.code, resolved.message);
  }
  if (resolved.size != null && resolved.size > (params.maxWheelSizeBytes ?? DEFAULT_MAX_WHEEL_SIZE_BYTES)) {
    throw new PypiWheelAssetError('wheel_size_exceeded', '[pypi-wheel-asset] wheel exceeds configured size cap');
  }

  await mkdir(params.installRoot, { recursive: true });
  const scratchDir = await mkdtemp(join(params.installRoot, '.scratch-'));
  const stagingDir = await mkdtemp(join(params.installRoot, '.staging-'));
  const versionsDir = join(params.installRoot, 'versions');
  const versionDir = join(versionsDir, `${safePathSegment(resolved.version)}-${resolved.sha256.slice(0, 12)}-${randomUUID()}`);
  try {
    const wheelPath = join(scratchDir, resolved.filename);
    await downloadVerifiedWheel({
      url: resolved.url,
      expectedSha256: resolved.sha256,
      destinationPath: wheelPath,
      maxWheelSizeBytes: params.maxWheelSizeBytes ?? DEFAULT_MAX_WHEEL_SIZE_BYTES,
      fetchWheel: params.fetchWheel ?? ((url, init) => defaultFetchWheel(url, init, params.maxWheelSizeBytes ?? DEFAULT_MAX_WHEEL_SIZE_BYTES)),
    });

    const executablePath = join(stagingDir, 'bin', commandBasenameFromAsset(resolved.assetPath));
    await extractExactWheelAsset({
      wheelPath,
      assetPath: resolved.assetPath,
      outputPath: executablePath,
      maxAssetSizeBytes: params.maxAssetSizeBytes ?? DEFAULT_MAX_ASSET_SIZE_BYTES,
    });
    if (params.executable && params.platform !== 'win32-x64' && params.platform !== 'win32-arm64') {
      await chmod(executablePath, 0o755);
    }

    let probeResult: InstalledPypiWheelAssetMetadata['compatibilityProbe'] = { id: null, ok: true };
    if (params.compatibilityProbe) {
      const probe = params.probeExecutable
        ? await params.probeExecutable({
          executablePath,
          probeId: params.compatibilityProbe,
          distribution: resolved.distribution,
          version: resolved.version,
        })
        : { ok: false as const, errorMessage: 'No compatibility probe runner is available' };
      probeResult = {
        id: params.compatibilityProbe,
        ok: probe.ok,
        ...(!probe.ok && probe.errorMessage ? { errorMessage: probe.errorMessage } : {}),
      };
      if (!probe.ok) {
        throw new PypiWheelAssetError('compatibility_probe_failed', `[pypi-wheel-asset] compatibility probe failed: ${probe.errorMessage ?? params.compatibilityProbe}`);
      }
    }

    const promotedExecutablePath = join(versionDir, 'bin', commandBasenameFromAsset(resolved.assetPath));
    const metadata: InstalledPypiWheelAssetMetadata = {
      sourceKind: 'managed_pypi_wheel_asset',
      distribution: resolved.distribution,
      version: resolved.version,
      wheelFilename: resolved.filename,
      wheelDigest: `sha256:${resolved.sha256}`,
      assetPath: resolved.assetPath,
      platform: resolved.platform,
      executablePath: promotedExecutablePath,
      compatibilityProbe: probeResult,
    };
    await writeFile(join(stagingDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await mkdir(versionsDir, { recursive: true });
    await promoteCandidate({ installRoot: params.installRoot, stagingDir, versionDir, metadata });

    return {
      executablePath: metadata.executablePath,
      metadataPath: currentMetadataPath(params.installRoot),
      version: resolved.version,
      metadata,
    };
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
