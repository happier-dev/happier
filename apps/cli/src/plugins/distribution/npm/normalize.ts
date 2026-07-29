import semver from 'semver';

import type { NormalizeNpmArtifactRequestInput, NormalizedNpmArtifactRequest, NpmArtifactSelector, NpmRegistryProfile, NpmRegistrySelection } from './types';

const PUBLIC_NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const NPM_PACKAGE_PART = /^[a-z0-9][a-z0-9._~-]*$/;
const NPM_TAG = /^[a-zA-Z0-9][a-zA-Z0-9._~-]*$/;

export function normalizeNpmRegistryOrigin(value: string): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid npm registry origin');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Invalid npm registry origin');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Expected a canonical HTTPS npm registry origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

export function normalizeNpmPackageName(value: string): string {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid npm package name');
  const name = value.trim();
  if (name.length > 214) throw new Error(`Invalid npm package name '${name}'`);
  if (name.startsWith('@') && !name.includes('/')) throw new Error(`Invalid npm package name '${name}'`);
  const parts = name.startsWith('@') ? name.slice(1).split('/') : [name];
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => !NPM_PACKAGE_PART.test(part)) || name !== name.toLowerCase()) {
    throw new Error(`Invalid npm package name '${name}'`);
  }
  return name.startsWith('@') && parts.length === 2 ? `@${parts[0]}/${parts[1]}` : parts.length === 1 ? parts[0]! : (() => { throw new Error(`Invalid npm package name '${name}'`); })();
}

export function normalizeNpmArtifactSelector(value?: string): NpmArtifactSelector {
  if (value !== undefined && (typeof value !== 'string' || value.length > 512)) throw new Error('Invalid npm version, range, or tag');
  const selector = value?.trim() || 'latest';
  if (selector.length > 256) throw new Error(`Invalid npm version, range, or tag '${selector}'`);
  const exact = semver.valid(selector);
  if (exact) return { kind: 'exact', value: exact };

  const range = semver.validRange(selector);
  if (range) return { kind: 'range', value: selector };
  if (!NPM_TAG.test(selector)) throw new Error(`Invalid npm version, range, or tag '${selector}'`);
  return { kind: 'tag', value: selector };
}

function packageScope(packageName: string): string | null {
  return packageName.startsWith('@') ? packageName.slice(0, packageName.indexOf('/')) : null;
}

function canonicalProfile(value: unknown): NpmRegistryProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid npm registry profile');
  const profile = value as Record<string, unknown>;
  const optionalStrings = ['credentialSecretRef', 'trustedCaProfileId', 'proxyProfileId'] as const;
  const rawScopes = Array.isArray(profile.scopes) ? profile.scopes : [];
  if (
    typeof profile.id !== 'string' || profile.id.length > 256
    || typeof profile.displayName !== 'string' || profile.displayName.length > 512
    || typeof profile.origin !== 'string' || profile.origin.length > 2048
    || !Array.isArray(profile.scopes) || rawScopes.length > 64
    || rawScopes.some((scope) => typeof scope !== 'string' || scope.length > 214)
    || optionalStrings.some((key) => profile[key] !== undefined && (typeof profile[key] !== 'string' || (profile[key] as string).length > 512))
  ) throw new Error('Invalid npm registry profile');
  const id = profile.id.trim();
  const displayName = profile.displayName.trim();
  const scopes = rawScopes.map((scope) => (scope as string).trim().toLowerCase());
  if (
    profile.version !== 1 || !id || id.length > 128 || !displayName || displayName.length > 256
    || scopes.some((scope) => !/^@[a-z0-9][a-z0-9._~-]*$/.test(scope) || scope.length > 214)
    || new Set(scopes).size !== scopes.length || typeof profile.useAsDefault !== 'boolean'
    || !Number.isSafeInteger(profile.createdAtMs) || (profile.createdAtMs as number) < 0
    || !Number.isSafeInteger(profile.updatedAtMs) || (profile.updatedAtMs as number) < 0
    || optionalStrings.some((key) => profile[key] !== undefined && !(profile[key] as string).trim())
  ) throw new Error(`Invalid npm registry profile '${id}'`);
  return {
    version: 1, id, displayName, origin: normalizeNpmRegistryOrigin(profile.origin), scopes,
    useAsDefault: profile.useAsDefault,
    ...(typeof profile.credentialSecretRef === 'string' ? { credentialSecretRef: profile.credentialSecretRef.trim() } : {}),
    ...(typeof profile.trustedCaProfileId === 'string' ? { trustedCaProfileId: profile.trustedCaProfileId.trim() } : {}),
    ...(typeof profile.proxyProfileId === 'string' ? { proxyProfileId: profile.proxyProfileId.trim() } : {}),
    createdAtMs: profile.createdAtMs as number,
    updatedAtMs: profile.updatedAtMs as number,
  };
}

export function normalizeNpmArtifactRequest(input: NormalizeNpmArtifactRequestInput): NormalizedNpmArtifactRequest {
  const packageName = normalizeNpmPackageName(input.packageName);
  if (input.profiles !== undefined && !Array.isArray(input.profiles)) throw new Error('Invalid npm registry profiles');
  if ((input.profiles?.length ?? 0) > 64) throw new Error('Npm registry profiles exceed the configured limit (64)');
  const profiles = (input.profiles ?? []).map(canonicalProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw new Error('Duplicate npm registry profile id');
  if (input.explicitProfileId !== undefined && (typeof input.explicitProfileId !== 'string' || input.explicitProfileId.length > 256)) throw new Error('Invalid npm registry profile id');
  const explicitProfileId = input.explicitProfileId?.trim();
  if (explicitProfileId && explicitProfileId.length > 128) throw new Error('Invalid npm registry profile id');
  const explicit = explicitProfileId ? profiles.find((profile) => profile.id === explicitProfileId) : undefined;
  if (explicitProfileId && !explicit) throw new Error(`Unknown npm registry profile '${explicitProfileId}'`);

  const scope = packageScope(packageName);
  const mappedProfiles = scope ? profiles.filter((profile) => profile.scopes.includes(scope)) : [];
  const defaultProfiles = profiles.filter((profile) => profile.useAsDefault);
  if (!input.curatedExactOrigin && !input.registryOrigin && !explicit && mappedProfiles.length > 1) throw new Error(`Ambiguous npm registry scope mapping for '${scope}'`);
  if (!input.curatedExactOrigin && !input.registryOrigin && !explicit && mappedProfiles.length === 0 && defaultProfiles.length > 1) throw new Error('Ambiguous default npm registry profile');
  const inferredProfile = explicit ?? mappedProfiles[0] ?? defaultProfiles[0];
  const requestedOrigin = normalizeNpmRegistryOrigin(input.curatedExactOrigin ?? input.registryOrigin ?? inferredProfile?.origin ?? PUBLIC_NPM_REGISTRY_ORIGIN);
  if (explicit && explicit.origin !== requestedOrigin) throw new Error(`Npm registry profile '${explicit.id}' does not match the requested registry origin`);
  if (explicit && scope && !explicit.scopes.includes(scope)) throw new Error(`Npm registry profile '${explicit.id}' does not match the requested package scope`);
  if (explicit && !scope && !explicit.useAsDefault) throw new Error(`Npm registry profile '${explicit.id}' is not allowed for unscoped packages`);

  const scopedMatches = scope ? profiles.filter((profile) => profile.origin === requestedOrigin && profile.scopes.includes(scope)) : [];
  const defaultMatches = profiles.filter((profile) => profile.origin === requestedOrigin && profile.useAsDefault);
  const originMatches = profiles.filter((profile) => profile.origin === requestedOrigin);
  if (!explicit && !input.curatedExactOrigin && scopedMatches.length > 1) throw new Error(`Ambiguous npm registry scope mapping for '${scope}'`);
  if (!explicit && !input.curatedExactOrigin && scopedMatches.length === 0 && defaultMatches.length > 1) throw new Error('Ambiguous default npm registry profile');
  if (!explicit && input.registryOrigin && originMatches.length > 1) throw new Error('Ambiguous npm registry origin profile');
  const scoped = scopedMatches[0];
  const configuredDefault = defaultMatches[0];
  const selected = explicit ?? (input.curatedExactOrigin
    ? undefined
    : input.registryOrigin ? originMatches[0] : scoped ?? configuredDefault);

  let selection: NpmRegistrySelection;
  if (input.curatedExactOrigin) selection = { packageName, origin: requestedOrigin, reason: 'curatedExact', ...(selected ? { profileId: selected.id } : {}) };
  else if (explicit) selection = { packageName, origin: requestedOrigin, reason: 'explicitProfile', profileId: explicit.id };
  else if (input.registryOrigin && selected) selection = { packageName, origin: requestedOrigin, reason: 'originMapping', profileId: selected.id };
  else if (scoped) selection = { packageName, origin: requestedOrigin, reason: 'scopeMapping', profileId: scoped.id };
  else if (configuredDefault) selection = { packageName, origin: requestedOrigin, reason: 'configuredDefault', profileId: configuredDefault.id };
  else selection = { packageName, origin: requestedOrigin, reason: 'publicDefault' };

  return {
    registryOrigin: requestedOrigin,
    packageName,
    selector: normalizeNpmArtifactSelector(input.selector),
    selection,
    ...(selected?.credentialSecretRef ? { credentialSecretRef: selected.credentialSecretRef } : {}),
  };
}
