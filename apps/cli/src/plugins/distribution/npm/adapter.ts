import { performance } from 'node:perf_hooks';

import { downloadResolvedNpmArtifact, type NpmArtifactBodyClient } from './download';
import { normalizeNpmArtifactRequest } from './normalize';
import { resolveNpmArtifactMetadata, type NpmRegistryJsonClient } from './resolver';
import type { DownloadedNpmArtifactCandidate, NpmProvenanceSignal, NpmRegistrySigningKey, NormalizeNpmArtifactRequestInput, ResolvedNpmArtifact } from './types';

export type NpmRegistryArtifactClient = NpmRegistryJsonClient & NpmArtifactBodyClient;

function parseRegistryKeys(value: unknown): readonly NpmRegistrySigningKey[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid npm registry signing keys response');
  const keys = (value as Record<string, unknown>).keys;
  if (!Array.isArray(keys)) throw new Error('Invalid npm registry signing keys response');
  return keys.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid npm registry signing key');
    const key = value as Record<string, unknown>;
    if (
      typeof key.keyid !== 'string' || !key.keyid || key.keyid.length > 512
      || typeof key.key !== 'string' || !key.key || key.key.length > 8192
      || typeof key.keytype !== 'string' || !key.keytype || key.keytype.length > 128
      || typeof key.scheme !== 'string' || !key.scheme || key.scheme.length > 128
      || !(key.expires === null || typeof key.expires === 'string')
    ) throw new Error('Invalid npm registry signing key');
    if (typeof key.expires === 'string') {
      const parsedExpiry = Date.parse(key.expires);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(key.expires) || !Number.isFinite(parsedExpiry) || new Date(parsedExpiry).toISOString() !== key.expires) {
        throw new Error('Invalid npm registry signing key expiry');
      }
    }
    return {
      keyid: key.keyid, key: key.key, keytype: key.keytype, scheme: key.scheme, expires: key.expires,
    };
  });
}

function parseRetrievedProvenance(value: unknown, declaredPredicateType: string): NpmProvenanceSignal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid npm provenance response');
  const attestations = (value as Record<string, unknown>).attestations;
  if (!Array.isArray(attestations) || attestations.length === 0 || attestations.length > 64) throw new Error('Invalid npm provenance response');
  const predicateTypes = attestations.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid npm provenance attestation');
    const record = entry as Record<string, unknown>;
    if (typeof record.predicateType !== 'string' || !record.predicateType || record.predicateType.length > 512 || !record.bundle || typeof record.bundle !== 'object' || Array.isArray(record.bundle)) {
      throw new Error('Invalid npm provenance attestation');
    }
    return record.predicateType;
  });
  if (!predicateTypes.includes(declaredPredicateType)) throw new Error('Npm provenance predicate mismatch');
  return { status: 'retrieved', predicateTypes: [...new Set(predicateTypes)].sort(), verified: false };
}

async function retrieveProvenanceSignal(params: Readonly<{
  resolved: ResolvedNpmArtifact;
  client: NpmRegistryArtifactClient;
  maxBytes: number;
  deadlineAtMonotonicMs: number;
}>): Promise<NpmProvenanceSignal> {
  if (params.resolved.provenance?.status === 'unavailable') return { ...params.resolved.provenance, verified: false };
  if (params.resolved.provenance?.status !== 'declared') return { status: 'absent' };
  if (performance.now() >= params.deadlineAtMonotonicMs) return { status: 'unavailable', code: 'attestation_unavailable', verified: false };
  try {
    const value = await params.client.getJson({
      url: params.resolved.provenance.url,
      maxBytes: params.maxBytes,
      headers: { accept: 'application/json' },
      deadlineAtMonotonicMs: params.deadlineAtMonotonicMs,
    });
    return parseRetrievedProvenance(value, params.resolved.provenance.predicateType);
  } catch {
    return { status: 'unavailable', code: 'attestation_unavailable', verified: false };
  }
}

export async function resolveAndDownloadNpmArtifact(params: Readonly<{
  input: NormalizeNpmArtifactRequestInput;
  destinationPath: string;
  artifactMaxBytes: number;
  metadataMaxBytes?: number;
  signingKeysMaxBytes?: number;
  attestationsMaxBytes?: number;
  timeoutMs?: number;
  client: NpmRegistryArtifactClient;
}>): Promise<DownloadedNpmArtifactCandidate> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5 * 60_000) throw new Error('Invalid npm artifact operation timeout');
  const deadlineAtMonotonicMs = performance.now() + timeoutMs;
  const request = normalizeNpmArtifactRequest(params.input);
  const resolved = await resolveNpmArtifactMetadata({ request, client: params.client, metadataMaxBytes: params.metadataMaxBytes, deadlineAtMonotonicMs });
  const registryKeys = resolved.signatures.length === 0 ? [] : parseRegistryKeys(await params.client.getJson({
    url: `${request.registryOrigin}/-/npm/v1/keys`,
    maxBytes: params.signingKeysMaxBytes ?? 1024 * 1024,
    headers: { accept: 'application/json' },
    deadlineAtMonotonicMs,
  }));
  const candidate = await downloadResolvedNpmArtifact({
    resolved, destinationPath: params.destinationPath, maxBytes: params.artifactMaxBytes,
    client: params.client, registryKeys, deadlineAtMonotonicMs,
  });
  const provenance = await retrieveProvenanceSignal({
    resolved,
    client: params.client,
    maxBytes: params.attestationsMaxBytes ?? 2 * 1024 * 1024,
    deadlineAtMonotonicMs,
  });
  return { ...candidate, provenance };
}
