import semver from 'semver';

import type { NormalizedNpmArtifactRequest, NpmProvenanceDeclaration, NpmRegistrySignature, ResolvedNpmArtifact } from './types';

export type NpmRegistryJsonClient = Readonly<{
  getJson(input: Readonly<{ url: string; maxBytes: number; headers: Readonly<Record<string, string>>; deadlineAtMonotonicMs?: number }>): Promise<unknown>;
}>;

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid npm ${label}`);
  return value as RecordValue;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid npm ${label}`);
  return value.trim();
}

function resolveVersion(request: NormalizedNpmArtifactRequest, packument: RecordValue): string {
  const versions = asRecord(packument.versions, 'versions metadata');
  if (request.selector.kind === 'exact') return request.selector.value;
  if (request.selector.kind === 'tag') {
    const tags = asRecord(packument['dist-tags'], 'dist-tags metadata');
    const tagged = requiredString(tags[request.selector.value], `dist-tag '${request.selector.value}'`);
    if (semver.valid(tagged) !== tagged) throw new Error(`Npm dist-tag '${request.selector.value}' did not resolve to an exact canonical semver`);
    return tagged;
  }
  const matching = semver.maxSatisfying(Object.keys(versions).filter((version) => semver.valid(version) === version), request.selector.value);
  if (!matching) throw new Error(`No npm version satisfies '${request.selector.value}'`);
  return matching;
}

function parseProvenance(value: unknown, registryOrigin: string): NpmProvenanceDeclaration {
  if (value === undefined) return { status: 'absent' };
  try {
    const attestations = asRecord(value, 'provenance declaration');
    const urlValue = requiredString(attestations.url, 'provenance URL');
    const provenance = asRecord(attestations.provenance, 'provenance metadata');
    const predicateType = requiredString(provenance.predicateType, 'provenance predicate type');
    if (urlValue.length > 2048 || predicateType.length > 512) throw new Error('Invalid npm provenance declaration limits');
    const url = new URL(urlValue);
    if (url.protocol !== 'https:' || url.origin !== registryOrigin || url.username || url.password) throw new Error('Npm provenance URL origin mismatch');
    return { status: 'declared', url: url.toString(), predicateType };
  } catch {
    return { status: 'unavailable', code: 'declaration_invalid' };
  }
}

function parseSignatures(value: unknown): readonly NpmRegistrySignature[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid npm registry signatures metadata');
  return value.map((entry) => {
    const record = asRecord(entry, 'registry signature');
    return { keyid: requiredString(record.keyid, 'registry signature keyid'), sig: requiredString(record.sig, 'registry signature') };
  });
}

export async function resolveNpmArtifactMetadata(params: Readonly<{
  request: NormalizedNpmArtifactRequest;
  client: NpmRegistryJsonClient;
  metadataMaxBytes?: number;
  deadlineAtMonotonicMs?: number;
}>): Promise<ResolvedNpmArtifact> {
  const packagePath = encodeURIComponent(params.request.packageName);
  const packument = asRecord(await params.client.getJson({
    url: `${params.request.registryOrigin}/${packagePath}`,
    maxBytes: params.metadataMaxBytes ?? 8 * 1024 * 1024,
    headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
    deadlineAtMonotonicMs: params.deadlineAtMonotonicMs,
  }), 'package metadata');
  if (packument.name !== params.request.packageName) throw new Error('Npm package identity mismatch in registry metadata');

  const version = resolveVersion(params.request, packument);
  const versions = asRecord(packument.versions, 'versions metadata');
  const manifest = asRecord(versions[version], `version '${version}' metadata`);
  if (manifest.name !== params.request.packageName || manifest.version !== version) throw new Error('Npm package identity mismatch in version metadata');
  const dist = asRecord(manifest.dist, 'dist metadata');
  const integrity = requiredString(dist.integrity, 'dist.integrity');
  const tarballUrl = requiredString(dist.tarball, 'dist.tarball');
  let parsedTarball: URL;
  try { parsedTarball = new URL(tarballUrl); } catch { throw new Error('Invalid npm dist.tarball URL'); }
  if (parsedTarball.protocol !== 'https:' || parsedTarball.origin !== params.request.registryOrigin || parsedTarball.username || parsedTarball.password) {
    throw new Error('Npm tarball origin does not match the selected registry origin');
  }

  return {
    registryOrigin: params.request.registryOrigin,
    packageName: params.request.packageName,
    version,
    integrity,
    tarballUrl: parsedTarball.toString(),
    signatures: parseSignatures(dist.signatures),
    provenance: parseProvenance(dist.attestations, params.request.registryOrigin),
  };
}
