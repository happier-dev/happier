import { z } from 'zod';
import { buildSettingArtifacts, type SettingDefinitionMap } from '@happier-dev/protocol';

import type { ProviderSettingsDefinition } from '../types.js';

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

function countConfiguredOpenCodeServerBaseUrls(raw: unknown): number {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;

  let count = 0;
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (normalizeOpenCodeServerBaseUrl(value)) {
      count += 1;
    }
  }
  return count;
}

function hasConfiguredOpenCodeServerBaseUrl(rawValue: unknown, record: Readonly<Record<string, unknown>>): boolean {
  return Boolean(normalizeOpenCodeServerBaseUrl(rawValue))
    || countConfiguredOpenCodeServerBaseUrls(record.opencodeServerBaseUrlByServerIdV1) > 0;
}

const OpenCodeServerBaseUrlByServerIdV1Schema = z.preprocess((raw) => {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};

  return Object.fromEntries(
    Object.entries(record).flatMap(([serverId, value]) => {
      const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
      if (!normalizedServerId) return [];
      if (typeof value !== 'string') return [];
      return [[normalizedServerId, value]];
    }),
  );
}, z.record(z.string().min(1), z.string()).default({}));

export const OPENCODE_PROVIDER_FIELDS = {
  opencodeBackendMode: {
    schema: z.enum(['server', 'acp']),
    default: 'server' satisfies OpenCodeBackendMode,
    description: 'Preferred OpenCode backend mode',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
  },
  opencodeServerBaseUrl: {
    schema: z.string(),
    default: '',
    description: 'Optional override for a user-managed OpenCode server URL',
    storageScope: 'account',
    analytics: {
      trackCurrentState: true,
      trackChanges: true,
      valueKind: 'presence',
      privacy: 'presence_only',
      identityScope: 'person',
      serializeCurrentWithContext: hasConfiguredOpenCodeServerBaseUrl,
    },
  },
  opencodeServerBaseUrlByServerIdV1: {
    schema: OpenCodeServerBaseUrlByServerIdV1Schema,
    default: {} as Record<string, string>,
    description: 'Per-server overrides for user-managed OpenCode server URLs',
    storageScope: 'account',
    analytics: {
      trackCurrentState: false,
      trackChanges: false,
      valueKind: 'count',
      privacy: 'count_only',
      identityScope: 'person',
      serializeCurrent: countConfiguredOpenCodeServerBaseUrls,
    },
  },
} as const satisfies SettingDefinitionMap;

const OPENCODE_PROVIDER_ARTIFACTS = buildSettingArtifacts(OPENCODE_PROVIDER_FIELDS);

export const OPENCODE_PROVIDER_SETTINGS_DEFAULTS = Object.freeze(OPENCODE_PROVIDER_ARTIFACTS.defaults);

export function buildOpenCodeProviderSettingsShape(_zod: typeof z) {
  return OPENCODE_PROVIDER_ARTIFACTS.shape;
}

export const OPENCODE_PROVIDER_SETTINGS_DEFINITION: ProviderSettingsDefinition = Object.freeze({
  providerId: 'opencode',
  fields: OPENCODE_PROVIDER_ARTIFACTS.definitions,
  buildOutgoingMessageMetaExtras: () => ({}),
});
