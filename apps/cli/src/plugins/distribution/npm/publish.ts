import { createHash } from 'node:crypto';
import semver from 'semver';

import { NpmRegistryHttpError, type NpmRegistryPublicationClient } from './httpsClient';
import { normalizeNpmArtifactRequest, normalizeNpmArtifactSelector } from './normalize';

export type NpmPublicationCoordinate = Readonly<{
  registryOrigin: string;
  packageName: string;
  version: string;
  integrity: string;
  packageUrl: string;
}>;

export type NpmPublicationFailure =
  | Readonly<{ status: 'authentication_required' | 'authentication_failed' | 'version_conflict' | 'outcome_unknown' | 'cancelled' }>
  | Readonly<{ status: 'challenge'; code: 'otp_required' }>
  | Readonly<{ status: 'failed'; code: 'invalid_input' | 'request_failed' | 'invalid_response' }>;

export type NpmPublicationResult = NpmPublicationCoordinate & (
  | Readonly<{ status: 'published' }>
  | Readonly<{ status: 'awaiting_maintainer'; stageId: string; reviewUrl: string }>
  | NpmPublicationFailure
);

export type NpmPublicationCheckResult = NpmPublicationCoordinate & (
  | Readonly<{ status: 'published' | 'missing' }>
  | NpmPublicationFailure
);

export type NpmPackageVersionHistoryResult = Readonly<{ registryOrigin: string; packageName: string }> & (
  | Readonly<{ status: 'available'; versions: readonly string[]; latestVersion?: string }>
  | Readonly<{ status: 'missing' }>
  | NpmPublicationFailure
);

export async function publishNpmPackage(params: Readonly<{
  registryOrigin: string;
  manifest: Readonly<Record<string, unknown>> & Readonly<{ name: string; version: string }>;
  tarball: Uint8Array;
  mode?: 'direct' | 'staged';
  client: NpmRegistryPublicationClient;
  signal?: AbortSignal;
}>): Promise<NpmPublicationResult> {
  const bytes = Buffer.from(params.tarball);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const coordinate = publicationCoordinate(params.registryOrigin, params.manifest.name, params.manifest.version, integrity);
  if (params.signal?.aborted) return { ...coordinate, status: 'cancelled' };
  if (params.manifest.private || params.manifest.packageExtensions !== undefined) {
    return { ...coordinate, status: 'failed', code: 'invalid_input' };
  }
  const tarballName = `${coordinate.packageName}-${coordinate.version}.tgz`;
  // libnpmpublish 12.0.1 metadata/attachment contract; no npm process or dependency tree.
  const { patchedDependencies: _patchedDependencies, ...manifest } = params.manifest;
  const versionManifest = {
    ...manifest, name: coordinate.packageName, version: coordinate.version,
    _id: `${coordinate.packageName}@${coordinate.version}`,
    dist: {
      integrity, shasum: createHash('sha1').update(bytes).digest('hex'),
      tarball: `${coordinate.registryOrigin}/${coordinate.packageName}/-/${tarballName}`,
    },
  };
  const body = {
    _id: coordinate.packageName, name: coordinate.packageName, description: manifest.description,
    access: 'public', 'dist-tags': { latest: coordinate.version },
    versions: { [coordinate.version]: versionManifest },
    _attachments: { [tarballName]: { content_type: 'application/octet-stream', data: bytes.toString('base64'), length: bytes.byteLength } },
  };
  let sent = false;
  try {
    const staged = params.mode === 'staged';
    const response = await params.client.requestJson({
      url: `${coordinate.registryOrigin}/${staged ? '-/stage/package/' : ''}${escapedName(coordinate.packageName)}`,
      method: staged ? 'POST' : 'PUT', body, headers: { accept: 'application/json' },
      signal: params.signal, ignoreBody: !staged, onRequestSent: () => { sent = true; },
    });
    if (!staged) return { ...coordinate, status: 'published' };
    if (!isRecord(response) || typeof response.stageId !== 'string' || !response.stageId.trim()) {
      return { ...coordinate, status: 'outcome_unknown' };
    }
    // npm documents review on the package's Staged Packages tab; it publishes no deep-link API.
    const reviewUrl = coordinate.registryOrigin === 'https://registry.npmjs.org'
      ? `https://www.npmjs.com/package/${coordinate.packageName}`
      : coordinate.registryOrigin;
    return { ...coordinate, status: 'awaiting_maintainer', stageId: response.stageId, reviewUrl };
  } catch (error) {
    if (error instanceof NpmRegistryHttpError) return { ...coordinate, ...classifyFailure(error, params.signal) };
    return { ...coordinate, ...(sent ? { status: 'outcome_unknown' as const } : classifyFailure(error, params.signal)) };
  }
}

export async function checkNpmPublication(params: Readonly<{
  registryOrigin: string;
  packageName: string;
  version: string;
  integrity: string;
  client: Pick<NpmRegistryPublicationClient, 'getJson'>;
  signal?: AbortSignal;
}>): Promise<NpmPublicationCheckResult> {
  const coordinate = publicationCoordinate(params.registryOrigin, params.packageName, params.version, params.integrity);
  try {
    const metadata = await params.client.getJson({
      url: `${coordinate.registryOrigin}/${escapedName(coordinate.packageName)}/${coordinate.version}`,
      headers: { accept: 'application/json' }, signal: params.signal,
    });
    if (!isRecord(metadata) || metadata.name !== coordinate.packageName || metadata.version !== coordinate.version
      || !isRecord(metadata.dist) || typeof metadata.dist.integrity !== 'string') {
      return { ...coordinate, status: 'failed', code: 'invalid_response' };
    }
    return { ...coordinate, status: metadata.dist.integrity === coordinate.integrity ? 'published' : 'version_conflict' };
  } catch (error) {
    return { ...coordinate, ...(error instanceof NpmRegistryHttpError && error.statusCode === 404
      ? { status: 'missing' as const } : classifyFailure(error, params.signal)) };
  }
}

export async function readNpmPackageVersionHistory(params: Readonly<{
  registryOrigin: string;
  packageName: string;
  client: Pick<NpmRegistryPublicationClient, 'getJson'>;
  signal?: AbortSignal;
}>): Promise<NpmPackageVersionHistoryResult> {
  const request = normalizeNpmArtifactRequest({ registryOrigin: params.registryOrigin, packageName: params.packageName });
  const coordinate = { registryOrigin: request.registryOrigin, packageName: request.packageName };
  try {
    const metadata = await params.client.getJson({
      url: `${request.registryOrigin}/${escapedName(request.packageName)}`,
      headers: { accept: 'application/json' }, signal: params.signal,
    });
    if (!isRecord(metadata) || metadata.name !== request.packageName || !isRecord(metadata.versions)) {
      return { ...coordinate, status: 'failed', code: 'invalid_response' };
    }
    const versions = Object.keys(metadata.versions).filter(isCanonicalVersion).sort(semver.rcompare);
    const tags = isRecord(metadata['dist-tags']) ? metadata['dist-tags'] : undefined;
    const latest = tags?.latest;
    return { ...coordinate, status: 'available', versions,
      ...(typeof latest === 'string' && versions.includes(latest) ? { latestVersion: latest } : {}) };
  } catch (error) {
    return { ...coordinate, ...(error instanceof NpmRegistryHttpError && error.statusCode === 404
      ? { status: 'missing' as const } : classifyFailure(error, params.signal)) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapedName(packageName: string): string {
  return packageName.replace('/', '%2f');
}

function isCanonicalVersion(value: string): boolean {
  try {
    const selector = normalizeNpmArtifactSelector(value);
    return selector.kind === 'exact' && selector.value === value;
  } catch { return false; }
}

export function npmPackageUrl(registryOrigin: string, packageName: string, version?: string): string {
  const request = normalizeNpmArtifactRequest({ registryOrigin, packageName, selector: version ?? 'latest' });
  if (version !== undefined && request.selector.kind !== 'exact') throw new Error('Npm package URL requires an exact version');
  return request.registryOrigin === 'https://registry.npmjs.org'
    ? `https://www.npmjs.com/package/${request.packageName}${version === undefined ? '' : `/v/${request.selector.value}`}`
    : `${request.registryOrigin}/${escapedName(request.packageName)}${version === undefined ? '' : `/${request.selector.value}`}`;
}

function publicationCoordinate(registryOrigin: string, packageName: string, version: string, integrity: string): NpmPublicationCoordinate {
  let request: ReturnType<typeof normalizeNpmArtifactRequest>;
  try { request = normalizeNpmArtifactRequest({ registryOrigin, packageName, selector: version }); }
  catch { throw new Error('Invalid npm publication coordinate'); }
  if (request.selector.kind !== 'exact') throw new Error('Npm publication requires an exact version');
  const packageUrl = npmPackageUrl(request.registryOrigin, request.packageName, request.selector.value);
  return { registryOrigin: request.registryOrigin, packageName: request.packageName, version: request.selector.value, integrity, packageUrl };
}

function classifyFailure(error: unknown, signal?: AbortSignal): NpmPublicationFailure {
  if (error instanceof NpmRegistryHttpError) {
    if (error.publicationReason === 'otp_required') return { status: 'challenge', code: 'otp_required' };
    if (error.publicationReason === 'version_conflict' || error.statusCode === 409) return { status: 'version_conflict' };
    if (error.statusCode === 401 || error.statusCode === 403) return { status: 'authentication_failed' };
  }
  if (signal?.aborted) return { status: 'cancelled' };
  return { status: 'failed', code: 'request_failed' };
}
