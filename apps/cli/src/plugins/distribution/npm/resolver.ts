import semver from 'semver';

import { evaluatePluginCompatibilityProjection } from '@/plugins/availability/compatibility';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

import type {
  NormalizedNpmArtifactRequest,
  NpmArtifactCompatibilitySelection,
  NpmProvenanceDeclaration,
  NpmRegistrySignature,
  ResolvedNpmArtifact,
} from './types';

export type NpmRegistryJsonClient = Readonly<{
  getJson(input: Readonly<{ url: string; maxBytes: number; headers: Readonly<Record<string, string>>; deadlineAtMonotonicMs?: number }>): Promise<unknown>;
}>;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`Invalid npm ${label}`);
  return value;
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

function candidateVersionsForRequest(
  request: NormalizedNpmArtifactRequest,
  packument: RecordValue,
  versions: RecordValue,
): readonly string[] {
  if (request.selector.kind === 'exact') return [request.selector.value];
  const canonicalVersions = Object.keys(versions).filter((version) => semver.valid(version) === version);
  if (request.selector.kind === 'range') {
    return Object.freeze(canonicalVersions
      .filter((version) => semver.satisfies(version, request.selector.value))
      .sort(semver.rcompare));
  }
  const tags = asRecord(packument['dist-tags'], 'dist-tags metadata');
  const tagged = requiredString(tags[request.selector.value], `dist-tag '${request.selector.value}'`);
  if (semver.valid(tagged) !== tagged) throw new Error(`Npm dist-tag '${request.selector.value}' did not resolve to an exact canonical semver`);
  const previewChannel = semver.prerelease(tagged) !== null;
  return Object.freeze(canonicalVersions
    .filter((version) => (
      semver.lte(version, tagged)
      && (semver.prerelease(version) !== null) === previewChannel
    ))
    .sort(semver.rcompare));
}

type CandidateCompatibility = Readonly<{
  automaticEligible: boolean;
  projection?: NpmArtifactCompatibilitySelection['projection'];
  diagnostics: readonly PluginCompatibilityDiagnostic[];
}>;

const MAX_BLOCKED_NEWER_VERSIONS = 32;

function compatibilityDiagnostic(
  code: PluginCompatibilityDiagnostic['code'],
  message: string,
): PluginCompatibilityDiagnostic {
  return Object.freeze({ code, message });
}

function evaluateCandidateCompatibility(
  metadata: unknown,
  candidateVersion: string,
): CandidateCompatibility {
  if (!isRecord(metadata)) {
    return Object.freeze({
      automaticEligible: false,
      diagnostics: Object.freeze([
        compatibilityDiagnostic(
          'plugin_compatibility_projection_invalid',
          'Npm version metadata must be an object before compatibility selection.',
        ),
      ]),
    });
  }
  const happier = metadata.happier;
  const projection = isRecord(happier) ? happier.compatibilityProjection : undefined;
  if (projection === undefined) {
    return Object.freeze({
      automaticEligible: false,
      diagnostics: Object.freeze([
        compatibilityDiagnostic(
          'plugin_compatibility_projection_missing',
          'Npm version metadata has no generated compatibility projection.',
        ),
      ]),
    });
  }
  const evaluation = evaluatePluginCompatibilityProjection(projection);
  if (
    evaluation.kind !== 'invalid'
    && evaluation.projection.manifest.version !== candidateVersion
  ) {
    return Object.freeze({
      automaticEligible: false,
      projection: evaluation.projection,
      diagnostics: Object.freeze([
        compatibilityDiagnostic(
          'plugin_compatibility_projection_invalid',
          `Npm compatibility projection version '${evaluation.projection.manifest.version}' does not match candidate '${candidateVersion}'.`,
        ),
      ]),
    });
  }
  if (evaluation.kind === 'compatible') {
    return Object.freeze({
      automaticEligible: true,
      projection: evaluation.projection,
      diagnostics: Object.freeze([]),
    });
  }
  return Object.freeze({
    automaticEligible: false,
    ...(evaluation.kind === 'incompatible' ? { projection: evaluation.projection } : {}),
    diagnostics: evaluation.diagnostics,
  });
}

function selectCompatibleVersion(params: Readonly<{
  request: NormalizedNpmArtifactRequest;
  packument: RecordValue;
  versions: RecordValue;
}>): Readonly<{
  version: string;
  compatibility: NpmArtifactCompatibilitySelection;
}> {
  const fallbackVersion = resolveVersion(params.request, params.packument);
  const candidates = candidateVersionsForRequest(params.request, params.packument, params.versions);
  const evaluations = new Map<string, CandidateCompatibility>();
  const evaluate = (version: string): CandidateCompatibility => {
    const existing = evaluations.get(version);
    if (existing) return existing;
    const next = evaluateCandidateCompatibility(params.versions[version], version);
    evaluations.set(version, next);
    return next;
  };

  for (const version of candidates) {
    const compatibility = evaluate(version);
    if (!compatibility.automaticEligible) continue;
    const candidateIndex = candidates.indexOf(version);
    return Object.freeze({
      version,
      compatibility: Object.freeze({
        automaticEligible: true,
        ...(compatibility.projection ? { projection: compatibility.projection } : {}),
        diagnostics: Object.freeze([]),
        blockedNewerVersions: Object.freeze(candidates.slice(0, Math.min(candidateIndex, MAX_BLOCKED_NEWER_VERSIONS)).map((blockedVersion) => Object.freeze({
          version: blockedVersion,
          diagnostics: evaluate(blockedVersion).diagnostics,
        }))),
      }),
    });
  }

  const fallbackCompatibility = evaluate(fallbackVersion);
  const fallbackIndex = candidates.indexOf(fallbackVersion);
  return Object.freeze({
    version: fallbackVersion,
    compatibility: Object.freeze({
      automaticEligible: false,
      ...(fallbackCompatibility.projection ? { projection: fallbackCompatibility.projection } : {}),
      diagnostics: fallbackCompatibility.diagnostics,
      blockedNewerVersions: Object.freeze(
        (fallbackIndex < 0 ? [] : candidates.slice(0, Math.min(fallbackIndex, MAX_BLOCKED_NEWER_VERSIONS))).map((blockedVersion) => Object.freeze({
          version: blockedVersion,
          diagnostics: evaluate(blockedVersion).diagnostics,
        })),
      ),
    }),
  });
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
    headers: { accept: 'application/json' },
    deadlineAtMonotonicMs: params.deadlineAtMonotonicMs,
  }), 'package metadata');
  if (packument.name !== params.request.packageName) throw new Error('Npm package identity mismatch in registry metadata');

  const versions = asRecord(packument.versions, 'versions metadata');
  const selection = selectCompatibleVersion({
    request: params.request,
    packument,
    versions,
  });
  const version = selection.version;
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
    versionMetadata: manifest,
    integrity,
    tarballUrl: parsedTarball.toString(),
    signatures: parseSignatures(dist.signatures),
    provenance: parseProvenance(dist.attestations, params.request.registryOrigin),
    compatibility: selection.compatibility,
  };
}
