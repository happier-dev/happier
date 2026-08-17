import {
  ConnectedAccountPurposeIdSchema,
} from '@happier-dev/protocol';

const FIELD_KINDS = new Set([
  'welcome',
  'text',
  'remote_voice',
  'select',
  'nullable_boolean',
  'number',
  'model',
  'voice',
  'voice_catalog',
  'instructions',
  'turn_detection',
  'optional_model',
  'segmented',
  'range',
  'language_hint',
  'keyterms',
  'server_vad',
  'privacy_opt_in',
  'connected_services_binding',
] as const);

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const SETTINGS_MODES = new Set(['byo', 'happier']);
const LINK_KINDS = new Set(['account', 'apiKeys', 'privacy']);
const MAX_DESCRIPTOR_OPTIONS = 64;

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
  if (segments.some((segment) => !/^[A-Za-z][A-Za-z0-9_]*$/u.test(segment) || UNSAFE_PATH_SEGMENTS.has(segment))) return null;
  return Object.freeze(segments);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasValidNumericMetadata(value: Readonly<Record<string, unknown>>): boolean {
  const min = value.min;
  const max = value.max;
  const step = value.step;
  const reset = value.reset;
  if (min !== undefined && !isFiniteNumber(min)) return false;
  if (max !== undefined && !isFiniteNumber(max)) return false;
  if (isFiniteNumber(min) && isFiniteNumber(max) && min > max) return false;
  if (step !== undefined && (!isFiniteNumber(step) || step <= 0)) return false;
  if (reset !== undefined && (!isFiniteNumber(reset)
    || (isFiniteNumber(min) && reset < min)
    || (isFiniteNumber(max) && reset > max))) return false;
  if (value.integer !== undefined && typeof value.integer !== 'boolean') return false;
  if (value.requiresOptIn !== undefined && typeof value.requiresOptIn !== 'boolean') return false;
  return true;
}

function hasValidOptions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_DESCRIPTOR_OPTIONS) return false;
  return value.every((raw) => {
    if (typeof raw === 'string') return raw.length <= 256;
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length > 256) return false;
    if (raw.kind !== undefined && raw.kind !== 'pinned' && raw.kind !== 'moving_alias') return false;
    return true;
  });
}

function hasValidLinks(value: Readonly<Record<string, unknown>>): boolean {
  const entries = Object.entries(value);
  if (entries.length > LINK_KINDS.size) return false;
  return entries.every(([kind, rawUrl]) => {
    if (!LINK_KINDS.has(kind) || typeof rawUrl !== 'string' || rawUrl.length > 2_048) return false;
    try {
      const parsed = new URL(rawUrl);
      return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
    } catch {
      return false;
    }
  });
}

export type RealtimeSettingsFieldDescriptor = Readonly<Record<string, unknown> & {
  kind: string;
  path: string;
  pathSegments: readonly string[];
  titleKey?: string;
  subtitleKey?: string;
}>;

export type RealtimeSettingsDescriptor = Readonly<{
  kind: 'voice.internal.realtime-settings.v1' | 'voice.internal.conversation-settings.v1';
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
  if (!isNonEmptyString(providerId) || !isRecord(value)) return null;
  if (value.kind !== 'voice.internal.realtime-settings.v1'
    && value.kind !== 'voice.internal.conversation-settings.v1') return null;
  if (value.providerId !== providerId || !isRecord(value.credential)) return null;
  if (value.credential.kind !== 'api_key' && value.credential.kind !== 'none') return null;
  if (value.credential.credentialPurpose !== undefined
    && !ConnectedAccountPurposeIdSchema.safeParse(value.credential.credentialPurpose).success) return null;
  if (value.credential.catalog !== null && value.credential.catalog !== 'voices') return null;
  if (value.credential.kind === 'none' && value.credential.catalog !== null) return null;
  if (!isRecord(value.links) || !hasValidLinks(value.links)
    || !Array.isArray(value.fields) || value.fields.length > 64) return null;

  const fields: RealtimeSettingsFieldDescriptor[] = [];
  const fieldKindsByPath = new Map<string, Set<string>>();
  const concreteFieldPaths = new Set<string>();
  for (const raw of value.fields) {
    if (!isRecord(raw) || typeof raw.kind !== 'string' || !FIELD_KINDS.has(raw.kind as never)) return null;
    if (raw.kind === 'privacy_opt_in' && !isNonEmptyString(raw.titleKey)) return null;
    if (raw.kind === 'connected_services_binding') {
      if (!isNonEmptyString(raw.agentId)
        || !Array.isArray(raw.serviceIds)
        || raw.serviceIds.length === 0
        || raw.serviceIds.length > 16
        || !raw.serviceIds.every(isNonEmptyString)
        || new Set(raw.serviceIds).size !== raw.serviceIds.length) return null;
    }
    if (!hasValidOptions(raw.options)) return null;
    if ((raw.kind === 'number' || raw.kind === 'range') && !hasValidNumericMetadata(raw)) return null;
    const pathSegments = parsePath(raw.path);
    if (!pathSegments) return null;
    const path = String(raw.path);
    const existingKinds = fieldKindsByPath.get(path) ?? new Set<string>();
    if (existingKinds.has(raw.kind)) return null;
    const combinedKinds = new Set(existingKinds);
    combinedKinds.add(raw.kind);
    if (combinedKinds.size > 1) return null;
    fieldKindsByPath.set(path, combinedKinds);
    if (raw.kind !== 'server_vad') {
      if (concreteFieldPaths.has(path)) return null;
      concreteFieldPaths.add(path);
    }
    let normalizedSubfields: readonly Readonly<Record<string, unknown>>[] | undefined;
    if (raw.kind === 'server_vad') {
      if (!Array.isArray(raw.subfields) || raw.subfields.length === 0 || raw.subfields.length > 16) return null;
      const seenSubfieldPaths = new Set<string>();
      const subfields: Readonly<Record<string, unknown>>[] = [];
      for (const candidate of raw.subfields) {
        if (!isRecord(candidate)) return null;
        if (candidate.kind !== undefined && candidate.kind !== 'number') return null;
        if (!hasValidNumericMetadata(candidate)) return null;
        const subfieldSegments = parsePath(candidate.path);
        if (!subfieldSegments
          || subfieldSegments.length !== pathSegments.length + 1
          || !pathSegments.every((segment, index) => subfieldSegments[index] === segment)) return null;
        const subfieldPath = String(candidate.path);
        if (seenSubfieldPaths.has(subfieldPath) || concreteFieldPaths.has(subfieldPath)) return null;
        seenSubfieldPaths.add(subfieldPath);
        concreteFieldPaths.add(subfieldPath);
        subfields.push(Object.freeze({ ...candidate, path: subfieldPath, pathSegments: subfieldSegments }));
      }
      normalizedSubfields = Object.freeze(subfields);
    }
    fields.push(Object.freeze({
      ...raw,
      kind: raw.kind,
      path,
      pathSegments,
      ...(normalizedSubfields ? { subfields: normalizedSubfields } : {}),
      ...(isNonEmptyString(raw.titleKey) ? { titleKey: raw.titleKey } : {}),
      ...(isNonEmptyString(raw.subtitleKey) ? { subtitleKey: raw.subtitleKey } : {}),
    }));
  }

  if (value.mode !== undefined && value.modes !== undefined) return null;
  if (value.modes !== undefined && (!Array.isArray(value.modes) || !value.modes.every(isNonEmptyString))) return null;
  const declaredModes = Array.isArray(value.modes)
    ? value.modes
    : isNonEmptyString(value.mode) ? [value.mode] : [];
  if (declaredModes.length === 0
    || new Set(declaredModes).size !== declaredModes.length
    || declaredModes.some((mode) => !SETTINGS_MODES.has(mode))) return null;

  return Object.freeze({
    kind: value.kind,
    providerId,
    mode: declaredModes.length === 1 && declaredModes[0] === 'byo' ? 'byo' : 'multi',
    modes: Object.freeze([...declaredModes]),
    titleKey: isNonEmptyString(value.titleKey) ? value.titleKey : null,
    footerKey: isNonEmptyString(value.footerKey) ? value.footerKey : null,
    credential: Object.freeze({
      ...value.credential,
      kind: value.credential.kind,
      catalog: value.credential.catalog,
    }),
    links: Object.freeze({ ...value.links }),
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
