import {
  buildQualifiedPluginContributionKey,
  type ConnectedServiceId,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

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
  legacyServiceId: ConnectedServiceId | null;
  accountId: string;
}>): string | null {
  for (const serviceId of qualifiedConnectedAccountPreferenceServiceKeys(params)) {
    const resolved = resolveConnectedServiceProfileLabel({
      labelsByKey: params.labelsByKey,
      serviceId,
      profileId: params.accountId,
    });
    if (resolved) return resolved;
  }
  return null;
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

export function updateQualifiedConnectedAccountLabel(params: Readonly<{
  service: PluginContributionIdentityV1;
  legacyServiceId: ConnectedServiceId | null;
  accountId: string;
  label: string | null;
  labelsByKey: Readonly<Record<string, string | undefined>>;
}>): Record<string, string> {
  const next = copyDefinedStringRecord(params.labelsByKey);
  for (const serviceKey of qualifiedConnectedAccountPreferenceServiceKeys(params)) {
    delete next[connectedServiceProfileKey({
      serviceId: serviceKey,
      profileId: params.accountId,
    })];
    delete next[connectedServiceProfileLegacyKey({
      serviceId: serviceKey,
      profileId: params.accountId,
    })];
  }
  const label = params.label?.trim() ?? '';
  if (label) {
    next[connectedServiceProfileKey({
      serviceId: qualifiedConnectedAccountPreferenceServiceKey(params.service),
      profileId: params.accountId,
    })] = label;
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

export function pruneQualifiedConnectedAccountPreferences(params: Readonly<{
  service: PluginContributionIdentityV1;
  legacyServiceId: ConnectedServiceId | null;
  accountId: string;
  defaultAccountByServiceKey: Readonly<Record<string, string | undefined>>;
  labelsByKey: Readonly<Record<string, string | undefined>>;
}>): Readonly<{
  connectedServicesDefaultProfileByServiceId: Record<string, string>;
  connectedServicesProfileLabelByKey: Record<string, string>;
}> {
  const connectedServicesDefaultProfileByServiceId = copyDefinedStringRecord(
    params.defaultAccountByServiceKey,
  );
  for (const serviceKey of qualifiedConnectedAccountPreferenceServiceKeys(params)) {
    if (
      connectedServicesDefaultProfileByServiceId[serviceKey]
      === params.accountId
    ) {
      delete connectedServicesDefaultProfileByServiceId[serviceKey];
    }
  }
  return {
    connectedServicesDefaultProfileByServiceId,
    connectedServicesProfileLabelByKey:
      updateQualifiedConnectedAccountLabel({
        service: params.service,
        legacyServiceId: params.legacyServiceId,
        accountId: params.accountId,
        label: null,
        labelsByKey: params.labelsByKey,
      }),
  };
}

function connectedServiceProfileLegacyKey(params: Readonly<{ serviceId: string; profileId: string }>): string {
  return `${String(params.serviceId).trim()}/${String(params.profileId).trim()}`;
}

export function pruneConnectedServiceProfilePreferencesForDeletedProfile(params: Readonly<{
  serviceId: string;
  profileId: string;
  connectedServicesDefaultProfileByServiceId: Readonly<Record<string, string | undefined>>;
  connectedServicesProfileLabelByKey: Readonly<Record<string, string | undefined>>;
}>): {
  connectedServicesDefaultProfileByServiceId: Record<string, string>;
  connectedServicesProfileLabelByKey: Record<string, string>;
} {
  const serviceId = String(params.serviceId).trim();
  const profileId = String(params.profileId).trim();
  const encodedKey = connectedServiceProfileKey({ serviceId, profileId });
  const legacyKey = connectedServiceProfileLegacyKey({ serviceId, profileId });

  const connectedServicesDefaultProfileByServiceId = copyDefinedStringRecord(
    params.connectedServicesDefaultProfileByServiceId,
  );
  if (connectedServicesDefaultProfileByServiceId[serviceId] === profileId) {
    delete connectedServicesDefaultProfileByServiceId[serviceId];
  }

  const connectedServicesProfileLabelByKey = copyDefinedStringRecord(params.connectedServicesProfileLabelByKey);
  delete connectedServicesProfileLabelByKey[encodedKey];
  delete connectedServicesProfileLabelByKey[legacyKey];

  return {
    connectedServicesDefaultProfileByServiceId,
    connectedServicesProfileLabelByKey,
  };
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
  const raw = params.labelsByKey[key]
    ?? params.labelsByKey[connectedServiceProfileLegacyKey({ serviceId: params.serviceId, profileId: params.profileId })];
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
