import { awaitPluginAcquisition, createPluginAcquisitionLifetime } from '../acquisitionLifetime';

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
  maxBytes?: number | null;
  signal?: AbortSignal;
}>): Promise<NpmProvenanceSignal> {
  if (params.resolved.provenance?.status === 'unavailable') return { ...params.resolved.provenance, verified: false };
  if (params.resolved.provenance?.status !== 'declared') return { status: 'absent' };
  params.signal?.throwIfAborted();
  try {
    const value = await awaitPluginAcquisition(params.client.getJson({
      url: params.resolved.provenance.url,
      maxBytes: params.maxBytes,
      headers: { accept: 'application/json' },
      signal: params.signal,
    }), params.signal);
    return parseRetrievedProvenance(value, params.resolved.provenance.predicateType);
  } catch {
    params.signal?.throwIfAborted();
    return { status: 'unavailable', code: 'attestation_unavailable', verified: false };
  }
}

export async function resolveAndDownloadNpmArtifact(params: Readonly<{
  input: NormalizeNpmArtifactRequestInput;
  destinationPath: string;
  artifactMaxBytes?: number | null;
  metadataMaxBytes?: number | null;
  signingKeysMaxBytes?: number | null;
  attestationsMaxBytes?: number | null;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  /** Automatic updates cannot acquire an artifact without generated compatibility facts. */
  requireCompatibleProjection?: boolean;
  client: NpmRegistryArtifactClient;
}>): Promise<DownloadedNpmArtifactCandidate> {
  const lifetime = createPluginAcquisitionLifetime({ ...params, errorLabel: 'Npm artifact operation' });
  const signal = lifetime.signal;
  try {
    signal?.throwIfAborted();
    const request = normalizeNpmArtifactRequest(params.input);
    const resolved = await awaitPluginAcquisition(resolveNpmArtifactMetadata({ request, client: params.client, metadataMaxBytes: params.metadataMaxBytes, signal }), signal);
    const mayDeferCompatibilityToPresentUserReview = (
      !params.requireCompatibleProjection && request.selector.kind === 'exact'
    );
    if (!resolved.compatibility?.automaticEligible && !mayDeferCompatibilityToPresentUserReview) {
      throw new Error('Npm artifact selection requires a compatible generated compatibility projection before archive download');
    }
    const registryKeys = resolved.signatures.length === 0 ? [] : parseRegistryKeys(await awaitPluginAcquisition(params.client.getJson({
      url: `${request.registryOrigin}/-/npm/v1/keys`,
      maxBytes: params.signingKeysMaxBytes,
      headers: { accept: 'application/json' },
      signal,
    }), signal));
    const candidate = await downloadResolvedNpmArtifact({
      resolved, destinationPath: params.destinationPath, maxBytes: params.artifactMaxBytes,
      client: params.client, registryKeys, signal,
    });
    const provenance = await retrieveProvenanceSignal({
      resolved,
      client: params.client,
      maxBytes: params.attestationsMaxBytes,
      signal,
    });
    signal?.throwIfAborted();
    return {
      ...candidate,
      provenance,
      ...(resolved.compatibility ? { compatibility: resolved.compatibility } : {}),
    };
  } finally {
    lifetime.dispose();
  }
}
