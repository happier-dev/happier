export function connectedServiceProfileKey(params: Readonly<{ serviceId: string; profileId: string }>): string {
  const serviceId = encodeURIComponent(String(params.serviceId).trim());
  const profileId = encodeURIComponent(String(params.profileId).trim());
  return `${serviceId}/${profileId}`;
}

function connectedServiceProfileLegacyKey(params: Readonly<{ serviceId: string; profileId: string }>): string {
  return `${String(params.serviceId).trim()}/${String(params.profileId).trim()}`;
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
