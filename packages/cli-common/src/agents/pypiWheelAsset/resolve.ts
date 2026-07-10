import {
  PypiWheelAssetError,
  type PypiWheelAssetDiagnosticCode,
  type PypiWheelAssetHostPlatform,
  type PypiWheelAssetLinuxLibc,
  type PypiWheelAssetPlatformMap,
  type PypiWheelAssetSupportedPlatform,
} from './types.js';

type FetchJsonResponse = Readonly<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type PypiWheelAssetSimpleIndexFile = Readonly<{
  filename: string;
  url: string;
  hashes?: Readonly<{ sha256?: string }>;
  yanked?: boolean | string;
  size?: number;
  requiresPython?: string;
  coreMetadata?: boolean;
  dataDistInfoMetadata?: boolean;
  version?: string;
}>;

export type PypiWheelAssetSimpleIndex = Readonly<{
  meta?: Readonly<{ apiVersion?: string }>;
  name: string;
  files: readonly PypiWheelAssetSimpleIndexFile[];
}>;

export type ResolvedPypiWheelAsset = Readonly<{
  ok: true;
  distribution: string;
  version: string;
  filename: string;
  url: string;
  sha256: string;
  size: number | null;
  assetPath: string;
  platform: PypiWheelAssetSupportedPlatform;
}>;

export type PypiWheelAssetResolution =
  | ResolvedPypiWheelAsset
  | Readonly<{ ok: false; code: PypiWheelAssetDiagnosticCode; message: string }>;

export type PypiWheelAssetFetchJson = (url: string, init: Readonly<{
  headers: Readonly<Record<string, string>>;
}>) => Promise<FetchJsonResponse>;

function fail(code: PypiWheelAssetDiagnosticCode, message: string): PypiWheelAssetResolution {
  return { ok: false, code, message };
}

export function normalizePypiProjectName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

function parseSimpleVersion(version: string): readonly number[] | null {
  const raw = version.trim();
  if (!/^[0-9]+(?:\.[0-9]+)*$/.test(raw)) return null;
  return raw.split('.').map((part) => Number(part));
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}

type ParsedSpecifier =
  | Readonly<{ ok: true; predicates: readonly ((version: readonly number[]) => boolean)[] }>
  | Readonly<{ ok: false }>;

function parseVersionSpecifier(specifier: string): ParsedSpecifier {
  const raw = specifier.trim();
  if (!raw) return { ok: false };

  if (/^[0-9]+(?:\.[0-9]+)*$/.test(raw)) {
    const exact = parseSimpleVersion(raw);
    return exact ? { ok: true, predicates: [(version) => compareVersions(version, exact) === 0] } : { ok: false };
  }

  const predicates: Array<(version: readonly number[]) => boolean> = [];
  for (const part of raw.split(',')) {
    const item = part.trim();
    const match = /^(==|>=|<=|>|<)\s*([0-9]+(?:\.[0-9]+)*)$/.exec(item);
    if (!match) return { ok: false };
    const operator = match[1] as '==' | '>=' | '<=' | '>' | '<';
    const version = parseSimpleVersion(match[2] ?? '');
    if (!version) return { ok: false };
    predicates.push((candidate) => {
      const compared = compareVersions(candidate, version);
      if (operator === '==') return compared === 0;
      if (operator === '>=') return compared >= 0;
      if (operator === '<=') return compared <= 0;
      if (operator === '>') return compared > 0;
      return compared < 0;
    });
  }
  return { ok: true, predicates };
}

function parseWheelFilename(filename: string, distribution: string): Readonly<{
  version: string;
  platforms: readonly WheelPlatformCompatibility[];
}> | null {
  if (!filename.endsWith('.whl')) return null;
  const stem = filename.slice(0, -'.whl'.length);
  const parts = stem.split('-');
  if (parts.length < 5) return null;

  const filenameDistribution = normalizePypiProjectName(parts[0] ?? '');
  if (filenameDistribution !== distribution) return null;

  const version = parts[1] ?? '';
  const platformTag = parts.at(-1) ?? '';
  const platforms = resolveWheelPlatformTags(platformTag);
  return platforms.length > 0 ? { version, platforms } : null;
}

type WheelPlatformCompatibility = Readonly<{
  platform: PypiWheelAssetSupportedPlatform;
  linuxLibc?: 'glibc' | 'musl';
}>;

function platformKey(value: WheelPlatformCompatibility): string {
  return `${value.platform}:${value.linuxLibc ?? ''}`;
}

function resolveWheelPlatformTags(platformTag: string): readonly WheelPlatformCompatibility[] {
  const platforms = new Map<string, WheelPlatformCompatibility>();
  const add = (platform: PypiWheelAssetSupportedPlatform, linuxLibc?: 'glibc' | 'musl') => {
    const value = Object.freeze({
      platform,
      ...(linuxLibc ? { linuxLibc } : {}),
    });
    platforms.set(platformKey(value), value);
  };
  for (const tag of platformTag.split('.')) {
    if (/^macosx_[0-9]+_[0-9]+_(?:arm64|universal2)$/.test(tag)) {
      add('darwin-arm64');
      continue;
    }
    if (/^manylinux(?:_[0-9]+_[0-9]+|[0-9]+)_x86_64$/.test(tag)) {
      add('linux-x64', 'glibc');
      continue;
    }
    if (/^manylinux(?:_[0-9]+_[0-9]+|[0-9]+)_aarch64$/.test(tag)) {
      add('linux-arm64', 'glibc');
      continue;
    }
    if (/^musllinux_[0-9]+_[0-9]+_x86_64$/.test(tag)) {
      add('linux-x64', 'musl');
      continue;
    }
    if (/^musllinux_[0-9]+_[0-9]+_aarch64$/.test(tag)) {
      add('linux-arm64', 'musl');
      continue;
    }
    if (tag === 'win_amd64') {
      add('win32-x64');
      continue;
    }
    if (tag === 'win_arm64') {
      add('win32-arm64');
    }
  }
  return [...platforms.values()];
}

function isSupportedPlatform(platform: PypiWheelAssetHostPlatform): platform is PypiWheelAssetSupportedPlatform {
  return platform === 'darwin-arm64'
    || platform === 'linux-x64'
    || platform === 'linux-arm64'
    || platform === 'win32-x64'
    || platform === 'win32-arm64';
}

function isLinuxPlatform(platform: PypiWheelAssetHostPlatform): platform is 'linux-x64' | 'linux-arm64' {
  return platform === 'linux-x64' || platform === 'linux-arm64';
}

function isCompatibleWheelPlatform(
  candidate: WheelPlatformCompatibility,
  platform: PypiWheelAssetSupportedPlatform,
  linuxLibc: PypiWheelAssetLinuxLibc | undefined,
): boolean {
  if (candidate.platform !== platform) return false;
  if (!isLinuxPlatform(platform)) return true;
  return candidate.linuxLibc === linuxLibc;
}

function normalizeSha256(value: string | undefined): string | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}

async function fetchSimpleIndex(params: Readonly<{
  distribution: string;
  fetchJson: PypiWheelAssetFetchJson;
  indexBaseUrl: string;
}>): Promise<PypiWheelAssetSimpleIndex> {
  const base = params.indexBaseUrl.replace(/\/+$/, '');
  const url = `${base}/${params.distribution}/`;
  const response = await params.fetchJson(url, {
    headers: {
      accept: 'application/vnd.pypi.simple.v1+json',
      'user-agent': 'happier-cli',
    },
  });
  if (!response.ok) {
    throw new PypiWheelAssetError('wheel_download_failed', `[pypi-wheel-asset] failed to fetch index (${response.status})`);
  }
  return response.json() as Promise<PypiWheelAssetSimpleIndex>;
}

export async function resolvePypiWheelAsset(params: Readonly<{
  distribution: string;
  versionSpecifier: string;
  assetPathByPlatform: PypiWheelAssetPlatformMap;
  platform: PypiWheelAssetHostPlatform;
  linuxLibc?: PypiWheelAssetLinuxLibc;
  index?: PypiWheelAssetSimpleIndex;
  fetchJson?: PypiWheelAssetFetchJson;
  indexBaseUrl?: string;
}>): Promise<PypiWheelAssetResolution> {
  const distribution = normalizePypiProjectName(params.distribution);
  if (!isSupportedPlatform(params.platform)) {
    return fail('unsupported_platform', `[pypi-wheel-asset] unsupported platform ${params.platform}`);
  }
  const platform: PypiWheelAssetSupportedPlatform = params.platform;
  if (isLinuxPlatform(platform) && params.linuxLibc !== 'glibc' && params.linuxLibc !== 'musl') {
    return fail(
      'unsupported_platform',
      `[pypi-wheel-asset] unsupported Linux libc for ${platform}: ${params.linuxLibc ?? 'unknown'}`,
    );
  }

  const assetPath = params.assetPathByPlatform[platform];
  if (!assetPath) {
    return fail('unsupported_platform', `[pypi-wheel-asset] no asset path is configured for ${platform}`);
  }

  const specifier = parseVersionSpecifier(params.versionSpecifier);
  if (!specifier.ok) {
    return fail('unsupported_version_specifier', `[pypi-wheel-asset] unsupported version specifier: ${params.versionSpecifier}`);
  }

  const index = params.index ?? await fetchSimpleIndex({
    distribution,
    fetchJson: params.fetchJson ?? defaultFetchJson,
    indexBaseUrl: params.indexBaseUrl ?? 'https://pypi.org/simple',
  });

  const candidates: Array<ResolvedPypiWheelAsset & Readonly<{ parsedVersion: readonly number[] }>> = [];
  for (const file of index.files ?? []) {
    if (file.yanked) continue;
    const wheel = parseWheelFilename(file.filename, distribution);
    if (!wheel || !wheel.platforms.some((candidate) => isCompatibleWheelPlatform(candidate, platform, params.linuxLibc))) continue;
    const parsedVersion = parseSimpleVersion(wheel.version);
    if (!parsedVersion || !specifier.predicates.every((predicate) => predicate(parsedVersion))) continue;
    const sha256 = normalizeSha256(file.hashes?.sha256);
    if (!sha256) continue;
    candidates.push({
      ok: true,
      distribution,
      version: wheel.version,
      filename: file.filename,
      url: file.url,
      sha256,
      size: typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : null,
      assetPath,
      platform,
      parsedVersion,
    });
  }

  candidates.sort((left, right) => compareVersions(right.parsedVersion, left.parsedVersion));
  const selected = candidates[0];
  if (!selected) {
    return fail('no_compatible_wheel', `[pypi-wheel-asset] no compatible wheel found for ${distribution} on ${params.platform}`);
  }
  const { parsedVersion: _parsedVersion, ...result } = selected;
  return result;
}

const defaultFetchJson: PypiWheelAssetFetchJson = async (url, init) => {
  if (typeof globalThis.fetch !== 'function') {
    throw new PypiWheelAssetError('wheel_download_failed', '[pypi-wheel-asset] fetch is unavailable');
  }
  return await globalThis.fetch(url, init);
};
