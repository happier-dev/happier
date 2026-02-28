import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { normalizeBaseUrl } from '@/diagnostics/httpClient';

function normalizeHttpUrl(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
  }
  return normalizeBaseUrl(url.toString());
}

export type ServerAdvertisedUrls = Readonly<{
  canonicalServerUrl: string | null;
  webappUrl: string | null;
}>;

export async function fetchServerAdvertisedUrls(params: Readonly<{
  apiServerUrl: string;
  timeoutMs?: number;
}>): Promise<ServerAdvertisedUrls | null> {
  const snapshot = await fetchServerFeaturesSnapshot({ serverUrl: params.apiServerUrl, timeoutMs: params.timeoutMs ?? 1500 });
  if (snapshot.status !== 'ready') return null;

  const serverCaps = snapshot.features.capabilities.server ?? null;
  if (!serverCaps) {
    return { canonicalServerUrl: null, webappUrl: null };
  }

  return {
    canonicalServerUrl: normalizeHttpUrl(serverCaps.canonicalServerUrl),
    webappUrl: normalizeHttpUrl(serverCaps.webappUrl),
  };
}
