import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import type { ConnectedServiceId } from './connectedServiceBindings.js';

export function connectedServiceProfileKey(params: Readonly<{ serviceId: string; profileId: string }>): string {
  const serviceId = encodeURIComponent(String(params.serviceId).trim());
  const profileId = encodeURIComponent(String(params.profileId).trim());
  return `${serviceId}/${profileId}`;
}

export function qualifiedConnectedAccountPreferenceServiceKey(
  service: PluginContributionIdentityV1,
): string {
  return buildQualifiedPluginContributionKey(service);
}

function qualifiedConnectedAccountPreferenceServiceKeys(params: Readonly<{
  service: PluginContributionIdentityV1;
  legacyServiceId: ConnectedServiceId | null;
}>): readonly string[] {
  const qualifiedKey = qualifiedConnectedAccountPreferenceServiceKey(params.service);
  return params.legacyServiceId
    ? [qualifiedKey, params.legacyServiceId]
    : [qualifiedKey];
}

export function resolveQualifiedConnectedAccountLabel(params: Readonly<{
  labelsByKey: Readonly<Record<string, string | undefined>>;
  service: PluginContributionIdentityV1;
  accountId: string;
}>): string | null {
  const value = params.labelsByKey[connectedServiceProfileKey({
    serviceId: qualifiedConnectedAccountPreferenceServiceKey(params.service),
    profileId: params.accountId,
  })];
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

export function resolveQualifiedConnectedAccountDefaultId(params: Readonly<{
  service: PluginContributionIdentityV1;
  legacyServiceId: ConnectedServiceId | null;
  connectedAccountIds: readonly string[];
  defaultAccountByServiceKey: Readonly<Record<string, string | undefined>>;
}>): string | null {
  const fallback = params.connectedAccountIds[0] ?? null;
  if (!fallback) return null;
  for (const serviceKey of qualifiedConnectedAccountPreferenceServiceKeys(params)) {
    const candidate = params.defaultAccountByServiceKey[serviceKey]?.trim();
    if (candidate && params.connectedAccountIds.includes(candidate)) {
      return candidate;
    }
  }
  return fallback;
}

/** One per-account preference: the qualified key first, then its released built-in alias. */
export function resolveQualifiedConnectedAccountProfilePreference<T>(params: Readonly<{
  valuesByKey: Readonly<Record<string, T | undefined>>;
  service: PluginContributionIdentityV1;
  legacyServiceId: ConnectedServiceId | null;
  accountId: string;
}>): T | undefined {
  for (const serviceId of qualifiedConnectedAccountPreferenceServiceKeys(params)) {
    const value = params.valuesByKey[connectedServiceProfileKey({ serviceId, profileId: params.accountId })]
      ?? params.valuesByKey[connectedServiceProfileLegacyKey({ serviceId, profileId: params.accountId })];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Writes only the qualified key and drops the account's aliases; `null` removes the preference. */
export function updateQualifiedConnectedAccountProfilePreference<T>(params: Readonly<{
  valuesByKey: Readonly<Record<string, T | undefined>>;
  service: PluginContributionIdentityV1;
  legacyServiceId: ConnectedServiceId | null;
  accountId: string;
  value: T | null;
}>): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(params.valuesByKey)) {
    if (value !== undefined) next[key] = value;
  }
  for (const serviceId of qualifiedConnectedAccountPreferenceServiceKeys(params)) {
    delete next[connectedServiceProfileKey({ serviceId, profileId: params.accountId })];
    delete next[connectedServiceProfileLegacyKey({ serviceId, profileId: params.accountId })];
  }
  if (params.value !== null) {
    next[connectedServiceProfileKey({
      serviceId: qualifiedConnectedAccountPreferenceServiceKey(params.service),
      profileId: params.accountId,
    })] = params.value;
  }
  return next;
}

export function updateQualifiedConnectedAccountDefaultId(params: Readonly<{
  service: PluginContributionIdentityV1;
  legacyServiceId: ConnectedServiceId | null;
  accountId: string | null;
  defaultAccountByServiceKey: Readonly<Record<string, string | undefined>>;
}>): Record<string, string> {
  const next = copyDefinedStringRecord(params.defaultAccountByServiceKey);
  for (const serviceKey of qualifiedConnectedAccountPreferenceServiceKeys(params)) {
    delete next[serviceKey];
  }
  if (params.accountId) {
    next[qualifiedConnectedAccountPreferenceServiceKey(params.service)] =
      params.accountId;
  }
  return next;
}

function connectedServiceProfileLegacyKey(params: Readonly<{ serviceId: string; profileId: string }>): string {
  return `${String(params.serviceId).trim()}/${String(params.profileId).trim()}`;
}


function copyDefinedStringRecord(input: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

export function resolveConnectedServiceProfileLabel(params: Readonly<{
  labelsByKey: Readonly<Record<string, string | undefined>>;
  serviceId: string;
  profileId: string;
}>): string | null {
  const key = connectedServiceProfileKey({ serviceId: params.serviceId, profileId: params.profileId });
  const raw = params.labelsByKey[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

export function resolveConnectedServiceDefaultProfileId(params: Readonly<{
  serviceId: string;
  connectedProfileIds: ReadonlyArray<string>;
  defaultProfileByServiceId: Readonly<Record<string, string | undefined>>;
}>): string | null {
  const fallback = params.connectedProfileIds[0] ?? null;
  if (!fallback) return null;
  const preferredRaw = params.defaultProfileByServiceId[String(params.serviceId).trim()];
  const preferred = typeof preferredRaw === 'string' ? preferredRaw.trim() : '';
  if (!preferred) return fallback;
  return params.connectedProfileIds.includes(preferred) ? preferred : fallback;
}
