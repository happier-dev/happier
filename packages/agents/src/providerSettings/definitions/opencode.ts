import type { z } from 'zod';

import type { ProviderSettingsDefinition, ProviderSettingsShape } from '../types.js';

export type OpenCodeBackendMode = 'server' | 'acp';

export function normalizeOpenCodeBackendMode(raw: unknown): OpenCodeBackendMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'acp') return 'acp';
  return 'server';
}

export function normalizeOpenCodeServerBaseUrl(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === 'http:') {
      const hostname = parsed.hostname.trim().toLowerCase();
      const isLoopback =
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '[::1]';
      if (!isLoopback) return null;
    }
    return parsed.origin.endsWith('/') ? parsed.origin : `${parsed.origin}/`;
  } catch {
    return null;
  }
}

export function normalizeOpenCodeServerBaseUrlExplicit(raw: unknown): boolean {
  if (raw === true) return true;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === '1' || value === 'true' || value === 'yes';
}

export function readOpenCodeExplicitServerBaseUrl(rawUrl: unknown, rawExplicit: unknown): string | null {
  if (!normalizeOpenCodeServerBaseUrlExplicit(rawExplicit)) return null;
  return normalizeOpenCodeServerBaseUrl(rawUrl);
}

export const OPENCODE_PROVIDER_SETTINGS_DEFAULTS = Object.freeze({
  opencodeBackendMode: 'server' satisfies OpenCodeBackendMode,
});

export function buildOpenCodeProviderSettingsShape(zod: typeof z): ProviderSettingsShape {
  return {
    opencodeBackendMode: zod.enum(['server', 'acp']),
  } as const;
}

export const OPENCODE_PROVIDER_SETTINGS_DEFINITION: ProviderSettingsDefinition = Object.freeze({
  providerId: 'opencode',
  buildSettingsShape: buildOpenCodeProviderSettingsShape,
  settingsDefaults: OPENCODE_PROVIDER_SETTINGS_DEFAULTS,
  buildOutgoingMessageMetaExtras: () => ({}),
});
