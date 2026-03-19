import type { AIBackendProfile } from './backendProfileSchema.js';
import { DEFAULT_BUILT_IN_BACKEND_PROFILES, getBuiltInBackendProfile } from './builtInBackendProfiles.js';

export type BackendProfileRefCandidate = Readonly<{
  id: string;
  name: string;
  isBuiltIn: boolean;
}>;

export type ResolveBackendProfileResult =
  | Readonly<{ ok: true; profile: AIBackendProfile; resolvedBy: 'id' | 'name' }>
  | Readonly<{ ok: false; reason: 'not_found'; query: string }>
  | Readonly<{ ok: false; reason: 'ambiguous_name'; query: string; candidates: ReadonlyArray<BackendProfileRefCandidate> }>;

function normalizeQuery(query: string): string {
  return typeof query === 'string' ? query.trim() : '';
}

function normalizeName(name: string): string {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

function toCandidate(profile: Pick<AIBackendProfile, 'id' | 'name' | 'isBuiltIn'>): BackendProfileRefCandidate {
  return { id: profile.id, name: profile.name, isBuiltIn: profile.isBuiltIn === true };
}

export function resolveBackendProfile(params: Readonly<{
  query: string;
  customProfiles: ReadonlyArray<AIBackendProfile>;
}>): ResolveBackendProfileResult {
  const query = normalizeQuery(params.query);
  if (!query) return { ok: false, reason: 'not_found', query: '' };

  const customProfiles = params.customProfiles ?? [];

  const customById = customProfiles.find((p) => p.id === query) ?? null;
  if (customById) return { ok: true, profile: customById, resolvedBy: 'id' };

  const builtInById = getBuiltInBackendProfile(query);
  if (builtInById) return { ok: true, profile: builtInById, resolvedBy: 'id' };

  const byNameKey = normalizeName(query);
  const matchesByName: AIBackendProfile[] = [];

  for (const profile of customProfiles) {
    if (normalizeName(profile.name) === byNameKey) {
      matchesByName.push(profile);
    }
  }

  for (const profile of DEFAULT_BUILT_IN_BACKEND_PROFILES) {
    if (normalizeName(profile.name) === byNameKey) {
      matchesByName.push(profile);
    }
  }

  if (matchesByName.length === 1) {
    return { ok: true, profile: matchesByName[0]!, resolvedBy: 'name' };
  }

  if (matchesByName.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous_name',
      query,
      candidates: matchesByName.map((p) => toCandidate(p)),
    };
  }

  return { ok: false, reason: 'not_found', query };
}

