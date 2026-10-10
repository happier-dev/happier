import type { PluginConnectedAccountAuthenticationModeV2 } from './pluginConnectedAccountAuthenticationV2.js';
import type { ConnectedAccountConfigurationTarget } from './connectedAccountDaemonRpcV1.js';
import type { ConnectedAccountCatalogSnapshotV1 } from './connectedAccountCatalogV1.js';
import { ConnectedConfigurationCatalogV1Schema, type ConnectedAccountCatalogRecordV1,
  type ConnectedAccountCatalogRowMutationResponseV1 } from './connectedAccountConfigurationRowsV1.js';
import { normalizeStrictJsonValue, sameStrictJsonValue, type JsonValue } from '../json/strictJsonValue.js';
import { compilePluginJsonSchema } from '../plugins/actions/jsonSchemaValidation.js';
import { isValidPluginJsonSchemaValue } from '../plugins/actions/protocolComposableSchema.js';

function invalid(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'connected_account_configuration_invalid' });
}

export function normalizeConnectedAccountConfiguredOrigin(value: string): Readonly<{ origin: string }> {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.origin !== value.replace(/\/+$/, '')) {
    throw new TypeError('Connected-account configured origin must be an exact credential-free HTTPS origin');
  }
  return Object.freeze({ origin: url.origin });
}

function cloneRecord<T>(value: Readonly<Record<string, unknown>>, clone: (entry: unknown, key: string) => T): Readonly<Record<string, T>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid('Configuration fields must be plain data');
  const output: Record<string, T> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw invalid('Configuration fields must use string keys');
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !('value' in property)) throw invalid('Configuration fields must be plain data');
    output[key] = clone(property.value, key);
  }
  return Object.freeze(output);
}

/** The same descriptor schema validates inline credentials and transient SavedSecret replacements. */
export function normalizeConnectedAccountConfigurationSecretValuesV1(mode: PluginConnectedAccountAuthenticationModeV2,
  values: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const fields = new Map(('configuration' in mode ? mode.configuration?.fields ?? [] : []).map(field => [field.id, field]));
  return cloneRecord(values, (value, key) => {
    const field = fields.get(key);
    if (!field?.secret || typeof value !== 'string' || !value.length || value.length > 64 * 1024
      || !isValidPluginJsonSchemaValue(compilePluginJsonSchema(field.schema), value)) throw invalid(`Configuration secret '${key}' is invalid`);
    return value;
  });
}

/** One descriptor normalizer for Account authoring, daemon control and runtime admission. */
export async function normalizeConnectedAccountConfigurationV1(input: Readonly<{
  target: ConnectedAccountConfigurationTarget;
  mode: PluginConnectedAccountAuthenticationModeV2;
  record: Readonly<{ revision: string; values: Readonly<Record<string, JsonValue>>;
    secretRefs: Readonly<Record<string, string>>; secretValues?: Readonly<Record<string, string>> }> | null;
  replacement?: Readonly<{ values: Readonly<Record<string, unknown>>; secretRefs: Readonly<Record<string, unknown>>;
    secretValues?: Readonly<Record<string, unknown>> }>;
  hasSecret(reference: string): Promise<boolean>;
}>) {
  const configuration = 'configuration' in input.mode ? input.mode.configuration : undefined;
  const fields = configuration?.fields ?? [];
  const byId = new Map(fields.map(field => [field.id, field]));
  const values = cloneRecord(input.replacement?.values ?? input.record?.values ?? {}, (entry, key) => {
    const field = byId.get(key);
    if (!field || field.secret === true) throw invalid(`Undeclared or secret configuration field '${key}' was supplied as plaintext`);
    let cloned: JsonValue;
    try { cloned = normalizeStrictJsonValue(entry); } catch { throw invalid(`Configuration field '${key}' must be plain data`); }
    if (!isValidPluginJsonSchemaValue(compilePluginJsonSchema(field.schema), cloned)) throw invalid(`Configuration field '${key}' does not match its declared schema`);
    if (field.semantic === 'connectedAccountOrigin') {
      try {
        if (typeof cloned !== 'string') throw invalid('Origin must be a string');
        normalizeConnectedAccountConfiguredOrigin(cloned);
      } catch { throw invalid(`Configuration field '${key}' must be an exact credential-free HTTPS origin`); }
    }
    return cloned;
  });
  const secrets = (source: Readonly<Record<string, unknown>>, maximum: number) => cloneRecord(source, (entry, key) => {
    if (byId.get(key)?.secret !== true || typeof entry !== 'string' || entry.length === 0 || entry.length > maximum) {
      throw invalid(`Configuration secret '${key}' is invalid`);
    }
    return entry;
  });
  // Existing control/configuration envelopes own these field budgets.
  const secretRefs = secrets(input.replacement?.secretRefs ?? input.record?.secretRefs ?? {}, 512);
  const secretValues = normalizeConnectedAccountConfigurationSecretValuesV1(input.mode,
    input.replacement?.secretValues ?? input.record?.secretValues ?? {});
  if (Object.keys(secretRefs).some(key => Object.hasOwn(secretValues, key))) throw invalid('A configuration secret field cannot have both inline bytes and a SavedSecret reference');
  if (input.target.kind === 'service' && Object.keys(secretValues).length) throw invalid('Service configuration secrets must use SavedSecret references');
  if (input.target.kind !== 'service' && Object.keys(secretRefs).length) throw invalid('Account and attempt configuration secrets must stay inline with their owning record');
  const normalizedValues = { ...values };
  const missingFieldIds: string[] = [];
  for (const field of fields) {
    if (field.secret === true) {
      const reference = secretRefs[field.id];
      const present = reference !== undefined && await input.hasSecret(reference);
      if (reference !== undefined && !present) throw invalid(`Configuration secret reference '${field.id}' is dangling`);
      if (field.required && !present && secretValues[field.id] === undefined) missingFieldIds.push(field.id);
    } else {
      if (normalizedValues[field.id] === undefined && field.default !== undefined) {
        const value = normalizeStrictJsonValue(field.default);
        if (!isValidPluginJsonSchemaValue(compilePluginJsonSchema(field.schema), value)) throw invalid(`Configuration default '${field.id}' does not match its declared schema`);
        normalizedValues[field.id] = value;
      }
      if (field.required && normalizedValues[field.id] === undefined) missingFieldIds.push(field.id);
    }
  }
  const revision = input.record?.revision ?? null;
  if (revision !== null && (revision.length === 0 || revision.length > 256)) throw invalid('Configuration revision must be a bounded non-empty string');
  return Object.freeze({ revision, values: Object.freeze(normalizedValues), secretRefs, secretValues,
    missingFieldIds: Object.freeze(missingFieldIds.sort()) });
}

export type ConnectedServiceConfigurationCatalogWriteV1 = Readonly<{
  expectedRevision: number;
  record: Extract<ConnectedAccountCatalogRecordV1, { key: 'configurations' }>;
  /** Transient bytes are committed with their references by the existing SavedSecret transaction. */
  newSecrets: readonly Readonly<{ id: string; fieldId: string; value: string }>[];
}>;
export type ConnectedServiceConfigurationCatalogHostV1 = Readonly<{
  read(): Promise<ConnectedAccountCatalogSnapshotV1>;
  resolveMode(service: ConnectedAccountConfigurationTarget & { kind: 'service' }): Promise<PluginConnectedAccountAuthenticationModeV2 | null>;
  hasSecret(reference: string): Promise<boolean>;
  createRevision(): string;
  write(input: ConnectedServiceConfigurationCatalogWriteV1): Promise<ConnectedAccountCatalogRowMutationResponseV1 | Readonly<{ status: 'applied' }>>;
}>;

/** Target revision admission and complete catalog replacement have a single owner. */
export function replaceConnectedServiceConfigurationCatalogV1(input: Readonly<{
  catalog: Extract<ConnectedAccountCatalogSnapshotV1, { status: 'ready' }>;
  target: Extract<ConnectedAccountConfigurationTarget, { kind: 'service' }>;
  expectedRevision: string | null; values: Readonly<Record<string, JsonValue>>;
  secretRefs: Readonly<Record<string, string>>; secretValues: Readonly<Record<string, string>>;
  expectedSecretRefs?: Readonly<Record<string, string>>;
  createSecretId?: () => string;
  createRevision(): string;
}>): ConnectedServiceConfigurationCatalogWriteV1 | null {
  if (input.catalog.record.key !== 'configurations') throw invalid('Configuration catalog is unavailable');
  const catalog = input.catalog.record.value;
  const matches = (entry: typeof catalog.entries[number]) => entry.service.pluginId === input.target.service.pluginId
    && entry.service.localId === input.target.service.localId && entry.modeId === input.target.modeId;
  const current = input.catalog.record.value.entries.find(matches);
  if ((current?.revision ?? null) !== input.expectedRevision || input.expectedSecretRefs !== undefined
    && !sameStrictJsonValue(current?.secretRefs ?? {}, input.expectedSecretRefs)) return null;
  const secretRefs = { ...input.secretRefs };
  const newSecrets = Object.entries(input.secretValues).map(([fieldId, value]) => {
    const id = (input.createSecretId ?? input.createRevision)(); secretRefs[fieldId] = id; return { id, fieldId, value };
  });
  return { expectedRevision: input.catalog.revision, newSecrets, record: { key: 'configurations', value: ConnectedConfigurationCatalogV1Schema.parse({
    v: 1, entries: [...input.catalog.record.value.entries.filter(entry => !matches(entry)), {
      service: input.target.service, modeId: input.target.modeId, revision: input.createRevision(), values: input.values, secretRefs,
    }],
  }) } };
}
