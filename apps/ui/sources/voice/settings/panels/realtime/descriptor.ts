import {
  ConnectedAccountPurposeIdSchema,
} from '@happier-dev/protocol';

import { VOICE_PROVIDER_CONVERSATION_RETENTION_MS } from '@/voice/persistence/voiceProviderConversationRetention';

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parsePath(value: unknown): readonly string[] | null {
  if (!isNonEmptyString(value) || value.length > 256) return null;
  const segments = value.split('.');
  if (segments.length === 0 || segments.length > 12) return null;
  if (segments.some((segment) => (
    !/^[A-Za-z][A-Za-z0-9_]*$/u.test(segment) || UNSAFE_PATH_SEGMENTS.has(segment)
  ))) return null;
  return Object.freeze(segments);
}

export type RealtimeSettingsFieldDescriptor = Readonly<Record<string, unknown> & {
  kind: string;
  path: string;
  pathSegments: readonly string[];
  titleKey?: unknown;
  subtitleKey?: unknown;
}>;

export type RealtimeSettingsDescriptor = Readonly<{
  kind: 'voice.provider-settings.v1';
  providerId: string;
  mode: 'byo' | 'multi';
  modes: readonly string[];
  titleKey: string | null;
  footerKey: string | null;
  credential: Readonly<Record<string, unknown> & {
    kind: 'api_key' | 'none';
    catalog: 'voices' | null;
    credentialPurpose?: string;
  }>;
  links: Readonly<Record<string, unknown>>;
  fields: readonly RealtimeSettingsFieldDescriptor[];
}>;

export type RealtimeProviderSettingsOwner = Readonly<{
  schemaVersion: number;
  defaultConfig: Readonly<Record<string, unknown>>;
  parseConfig(value: unknown): Readonly<Record<string, unknown>> | null;
  readLegacySecret?(value: unknown): unknown | null;
  migrateLegacy?(value: unknown): Readonly<{ config: Readonly<Record<string, unknown>>; root?: unknown }> | null;
}>;

export function readRealtimeSavedSecretCredentialPurpose(
  descriptor: RealtimeSettingsDescriptor | null | undefined,
): string | null {
  const purpose = descriptor?.credential.credentialPurpose;
  const parsed = ConnectedAccountPurposeIdSchema.safeParse(purpose);
  return parsed.success ? parsed.data : null;
}

export function parseRealtimeSettingsDescriptor(
  providerId: string,
  value: unknown,
): RealtimeSettingsDescriptor | null {
  if (!isNonEmptyString(providerId)
    || !isRecord(value)
    || value.kind !== 'voice.provider-settings.v1'
    || !Array.isArray(value.modes)
    || value.modes.length === 0
    || !value.modes.every((mode) => mode === 'byo' || mode === 'happier')
    || !isRecord(value.credential)
    || !isRecord(value.links)
    || !Array.isArray(value.fields)
    || !value.fields.every((field) => isRecord(field)
      && isNonEmptyString(field.kind)
      && isNonEmptyString(field.path)
      && (field.subfields === undefined || (Array.isArray(field.subfields) && field.subfields.every((subfield) => (
        isRecord(subfield) && isNonEmptyString(subfield.path)
      )))))) return null;
  const presentation = value as Readonly<{
    modes: readonly ('byo' | 'happier')[];
    titleKey?: unknown;
    footerKey?: unknown;
    credential: Readonly<Record<string, unknown>>;
    links: Readonly<Record<string, unknown>>;
    fields: readonly Readonly<Record<string, unknown> & { kind: string; path: string; subfields?: readonly Readonly<Record<string, unknown> & { path: string }>[] }>[];
  }>;
  const fields = presentation.fields.map((field): RealtimeSettingsFieldDescriptor => Object.freeze({
    ...field,
    pathSegments: Object.freeze(field.path.split('.')),
    ...(field.subfields
      ? {
          subfields: Object.freeze(field.subfields.map((subfield) => Object.freeze({
            ...subfield,
            pathSegments: Object.freeze(subfield.path.split('.')),
          }))),
        }
      : {}),
    ...(field.kind === 'privacy_opt_in'
      ? { retentionMinutes: VOICE_PROVIDER_CONVERSATION_RETENTION_MS / 60_000 }
      : {}),
  }));

  return Object.freeze({
    kind: 'voice.provider-settings.v1',
    providerId,
    mode: presentation.modes.length === 1 && presentation.modes[0] === 'byo' ? 'byo' : 'multi',
    modes: Object.freeze([...presentation.modes]),
    titleKey: typeof presentation.titleKey === 'string' ? presentation.titleKey : presentation.titleKey?.fallback ?? null,
    footerKey: typeof presentation.footerKey === 'string' ? presentation.footerKey : presentation.footerKey?.fallback ?? null,
    credential: Object.freeze({ ...presentation.credential }),
    links: Object.freeze({ ...presentation.links }),
    fields: Object.freeze(fields),
  });
}

export type ResolvedRealtimeProviderConfig =
  | Readonly<{ status: 'ready'; source: 'default' | 'persisted' | 'legacy'; config: Readonly<Record<string, unknown>>; legacySecretValue: unknown | null }>
  | Readonly<{ status: 'needs_migration' | 'unsupported_version' | 'invalid' }>;

export function resolveRealtimeProviderConfig(
  owner: RealtimeProviderSettingsOwner,
  envelope: Readonly<{ schemaVersion: number; config: unknown }> | null,
): ResolvedRealtimeProviderConfig {
  if (!envelope) {
    const parsedDefault = owner.parseConfig(owner.defaultConfig);
    return parsedDefault
      ? Object.freeze({ status: 'ready', source: 'default', config: parsedDefault, legacySecretValue: null })
      : Object.freeze({ status: 'invalid' });
  }
  if (!Number.isInteger(envelope.schemaVersion) || envelope.schemaVersion < 1) return Object.freeze({ status: 'invalid' });
  if (envelope.schemaVersion > owner.schemaVersion) return Object.freeze({ status: 'unsupported_version' });
  if (envelope.schemaVersion < owner.schemaVersion) {
    const migrated = owner.migrateLegacy?.(envelope.config) ?? null;
    const parsed = migrated ? owner.parseConfig(migrated.config) : null;
    return parsed
      ? Object.freeze({
        status: 'ready', source: 'legacy', config: parsed,
        legacySecretValue: owner.readLegacySecret?.(envelope.config) ?? null,
      })
      : Object.freeze({ status: 'needs_migration' });
  }
  const parsed = owner.parseConfig(envelope.config);
  return parsed
    ? Object.freeze({ status: 'ready', source: 'persisted', config: parsed, legacySecretValue: null })
    : Object.freeze({ status: 'invalid' });
}

export function readRealtimeProviderConfigPath(config: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let current: unknown = config;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function writePath(
  current: Readonly<Record<string, unknown>>,
  path: readonly string[],
  value: unknown,
  offset: number,
): Readonly<Record<string, unknown>> {
  const segment = path[offset]!;
  if (offset === path.length - 1) return Object.freeze({ ...current, [segment]: value });
  const child = isRecord(current[segment]) ? current[segment] : {};
  return Object.freeze({ ...current, [segment]: writePath(child, path, value, offset + 1) });
}

export function updateRealtimeProviderConfig(
  owner: RealtimeProviderSettingsOwner,
  config: Readonly<Record<string, unknown>>,
  path: string | readonly string[],
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  const segments = typeof path === 'string' ? parsePath(path) : path;
  if (!segments || segments.length === 0 || segments.some((segment) => UNSAFE_PATH_SEGMENTS.has(segment))) return null;
  return owner.parseConfig(writePath(config, segments, value, 0));
}
