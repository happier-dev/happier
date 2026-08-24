import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createServerUrlComparableKey } from '@happier-dev/protocol/server/urls';

import { deriveServerIdFromUrl, sanitizeServerIdForFilesystem } from '@/server/serverId';
import { isLocalishServerUrl } from '@/server/serverUrlClassification';

type PersistedServerProfile = Readonly<{
  id: string;
  serverUrl: string;
  localServerUrl?: string;
  webappUrl: string;
}>;

type PersistedServerSettings = Readonly<{
  activeServerId: string;
  servers: Record<string, PersistedServerProfile>;
}>;

export function readActiveServerFromSettingsFile(path: string): PersistedServerSettings | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const schemaVersion = Number((raw as any).schemaVersion ?? 0);
    if (!Number.isFinite(schemaVersion) || schemaVersion < 5) return null;
    const activeServerId = sanitizeServerIdForFilesystem((raw as any).activeServerId ?? '', '');
    const serversRaw = (raw as any).servers;
    if (!activeServerId || !serversRaw || typeof serversRaw !== 'object') return null;

    const servers: Record<string, PersistedServerProfile> = {};
    const normalizeUrl = (value: unknown): string => String(value ?? '').trim().replace(/\/+$/, '');
    for (const [id, value] of Object.entries(serversRaw as Record<string, any>)) {
      const server = value as Record<string, unknown> | null | undefined;
      const sid = sanitizeServerIdForFilesystem(String(server?.id ?? id), '');
      const serverUrlRaw = normalizeUrl(server?.serverUrl);
      const legacyPublicServerUrl = normalizeUrl(server?.publicServerUrl);
      const localServerUrlRaw = normalizeUrl(server?.localServerUrl);
      const webappUrl = normalizeUrl(server?.webappUrl);
      if (!sid || !serverUrlRaw || !webappUrl) continue;

      const serverUrl =
        legacyPublicServerUrl && legacyPublicServerUrl !== serverUrlRaw
          ? legacyPublicServerUrl
          : serverUrlRaw;

      const localServerUrl =
        localServerUrlRaw
          ? localServerUrlRaw
          : (legacyPublicServerUrl && legacyPublicServerUrl !== serverUrlRaw && isLocalishServerUrl(serverUrlRaw)
            ? serverUrlRaw
            : '');

      servers[sid] = {
        id: sid,
        serverUrl,
        ...(localServerUrl ? { localServerUrl } : {}),
        webappUrl,
      };
    }
    if (!servers[activeServerId]) return null;
    return { activeServerId, servers };
  } catch {
    return null;
  }
}

function normalizeServerUrl(url: string): string {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

function safeCreateComparableServerUrlKey(url: string | null | undefined): string {
  const value = String(url ?? '').trim();
  if (!value) return '';
  try {
    return createServerUrlComparableKey(value);
  } catch {
    return '';
  }
}

export function resolveServerSelection(params: Readonly<{
  envServerUrl: string | null;
  envLocalServerUrl: string | null;
  envPublicServerUrl: string | null;
  envWebappUrl: string | null;
  envActiveServerId: string | null;
  persisted: PersistedServerSettings | null;
  serversDir: string;
}>): Readonly<{ activeServerId: string; serverUrl: string; apiServerUrl: string; webappUrl: string }> {
  const DEFAULT_SERVER_URL = 'https://api.happier.dev';
  const DEFAULT_WEBAPP_URL = 'https://app.happier.dev';
  const resolveActiveServerId = (fallbackId: string): string =>
    sanitizeServerIdForFilesystem(params.envActiveServerId ?? fallbackId, 'cloud');

  const normalizeUrl = (value: string | null): string | null => {
    const out = normalizeServerUrl(value ?? '');
    return out ? out : null;
  };
  const matchesUrl = (server: Readonly<{ serverUrl: string; localServerUrl?: string | null }>, url: string): boolean => {
    const targetComparableKey = safeCreateComparableServerUrlKey(url);
    const serverComparableKey = safeCreateComparableServerUrlKey(server.serverUrl);
    if (targetComparableKey && serverComparableKey && targetComparableKey === serverComparableKey) return true;
    if (normalizeServerUrl(server.serverUrl) === url) return true;
    const local = normalizeServerUrl(server.localServerUrl ?? '');
    if (local && local === url) return true;
    const localComparableKey = safeCreateComparableServerUrlKey(server.localServerUrl ?? '');
    return Boolean(targetComparableKey && localComparableKey && targetComparableKey === localComparableKey);
  };

  const envCanonicalServerUrl = normalizeUrl(params.envPublicServerUrl) ?? normalizeUrl(params.envServerUrl);
  if (envCanonicalServerUrl) {
    const explicitActiveServerId = params.envActiveServerId
      ? sanitizeServerIdForFilesystem(params.envActiveServerId, '')
      : '';
    const explicitActivePersisted = explicitActiveServerId && params.persisted
      ? params.persisted.servers[explicitActiveServerId] ?? null
      : null;
    if (explicitActivePersisted && !matchesUrl(explicitActivePersisted, envCanonicalServerUrl)) {
      const canonical = normalizeServerUrl(explicitActivePersisted.serverUrl);
      const apiServerUrl = normalizeServerUrl(explicitActivePersisted.localServerUrl ?? '') || canonical;
      return {
        activeServerId: resolveActiveServerId(explicitActivePersisted.id),
        serverUrl: canonical,
        apiServerUrl,
        webappUrl: explicitActivePersisted.webappUrl,
      };
    }

    const envPublicServerUrl = normalizeUrl(params.envPublicServerUrl);
    const envLocalServerUrl = normalizeUrl(params.envLocalServerUrl);
    const ignoreStaleLocalOverride =
      !envPublicServerUrl
      && isLocalishServerUrl(envCanonicalServerUrl)
      && !!envLocalServerUrl
      && normalizeServerUrl(envLocalServerUrl) !== normalizeServerUrl(envCanonicalServerUrl);
    const envApiServerUrl =
      (ignoreStaleLocalOverride ? null : envLocalServerUrl)
      ?? (envPublicServerUrl ? normalizeUrl(params.envServerUrl) : null)
      ?? envCanonicalServerUrl;

    const persistedMatch = params.persisted
      ? (() => {
          const hasAccessKeyForServerId = (id: string): boolean => {
            try {
              return existsSync(join(params.serversDir, id, 'access.key'));
            } catch {
              return false;
            }
          };

          const explicitActive = explicitActiveServerId ? params.persisted.servers[explicitActiveServerId] ?? null : null;
          if (
            explicitActive
            && (
              matchesUrl(explicitActive, envCanonicalServerUrl)
              || (!!envApiServerUrl && matchesUrl(explicitActive, envApiServerUrl))
            )
          ) {
            return explicitActive;
          }

          const persistedActive = params.persisted.servers[params.persisted.activeServerId] ?? null;
          const findMatch = (url: string): Readonly<{
            id: string;
            serverUrl: string;
            localServerUrl?: string | null;
            webappUrl: string;
          }> | null =>
            Object.values(params.persisted!.servers).find((server) => matchesUrl(server, url)) ?? null;

          const canonicalMatch =
            (persistedActive && matchesUrl(persistedActive, envCanonicalServerUrl) ? persistedActive : null)
            ?? findMatch(envCanonicalServerUrl);

          if (envApiServerUrl && envApiServerUrl !== envCanonicalServerUrl) {
            const apiMatch =
              (persistedActive && matchesUrl(persistedActive, envApiServerUrl) ? persistedActive : null)
              ?? findMatch(envApiServerUrl);

            if (canonicalMatch && apiMatch && canonicalMatch.id !== apiMatch.id) {
              const canonicalHasAccessKey = hasAccessKeyForServerId(canonicalMatch.id);
              const apiHasAccessKey = hasAccessKeyForServerId(apiMatch.id);
              if (apiHasAccessKey && !canonicalHasAccessKey) return apiMatch;
              if (canonicalHasAccessKey && !apiHasAccessKey) return canonicalMatch;
              return canonicalMatch;
            }

            return canonicalMatch ?? apiMatch;
          }

          return canonicalMatch;
        })()
      : null;

    let webappUrl = params.envWebappUrl;
    if (!webappUrl) {
      if (persistedMatch?.webappUrl) {
        webappUrl = persistedMatch.webappUrl;
      } else if (envCanonicalServerUrl === DEFAULT_SERVER_URL) {
        webappUrl = DEFAULT_WEBAPP_URL;
      } else {
        try {
          webappUrl = new URL(envCanonicalServerUrl).origin;
        } catch {
          webappUrl = DEFAULT_WEBAPP_URL;
        }
      }
    }
    const activeServerId = sanitizeServerIdForFilesystem(
      params.envActiveServerId ?? persistedMatch?.id ?? deriveServerIdFromUrl(envCanonicalServerUrl),
      'cloud',
    );
    return { activeServerId, serverUrl: envCanonicalServerUrl, apiServerUrl: envApiServerUrl, webappUrl };
  }

  if (params.persisted) {
    const active = params.persisted.servers[params.persisted.activeServerId];
    if (active) {
      const canonical = normalizeServerUrl(active.serverUrl);
      const apiServerUrl = normalizeServerUrl(active.localServerUrl ?? '') || canonical;
      return {
        activeServerId: resolveActiveServerId(active.id),
        serverUrl: canonical,
        apiServerUrl,
        webappUrl: active.webappUrl,
      };
    }
  }

  return {
    activeServerId: resolveActiveServerId('cloud'),
    serverUrl: DEFAULT_SERVER_URL,
    apiServerUrl: DEFAULT_SERVER_URL,
    webappUrl: DEFAULT_WEBAPP_URL,
  };
}
