import { z } from 'zod';

import { ProviderConnectionV1Schema, type ProviderConnectionV1 } from '../connections/v1.js';
import { ProviderConnectionTombstoneV1Schema } from '../connections/tombstoneV1.js';
import { canonicalizeProviderContributionKeyV1 } from '../contributionIdentityV1.js';
import { ProviderAccountGrantV1Schema, ProviderMachineGrantV1Schema } from '../grants/v1.js';
import { ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderContributionKeySchema, ProviderLocalIdSchema, ProviderMachineIdSchema, ProviderModelIdSchema } from '../ids.js';
import { deserializeModelVisibilityRefV1, ProviderBoundModelRefSchema, SessionModelSelectionV1Schema } from '../selection/v1.js';
import { PROVIDER_SETTINGS_LIMITS_V1 } from './limits.js';
export { PROVIDER_SETTINGS_LIMITS_V1 } from './limits.js';

export const ProviderManualModelV1Schema = z.object({
  id: ProviderModelIdSchema,
  name: z.string().trim().min(1).max(256).optional(),
  addedAt: z.number().finite().nonnegative(),
}).strict();
export type ProviderManualModelV1 = z.infer<typeof ProviderManualModelV1Schema>;

export const ProviderMigrationSourceProfileIdSchema = z.string().min(1).max(256)
  .refine((value) => value === value.trim(), 'Source profile id must be canonical')
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Source profile id must not contain controls');

export const ProviderSettingsMigrationSourceOutcomeV1Schema = z.discriminatedUnion('kind', [
  z.object({
    sourceProfileId: ProviderMigrationSourceProfileIdSchema,
    kind: z.literal('default_environment'),
  }).strict(),
  z.object({
    sourceProfileId: ProviderMigrationSourceProfileIdSchema,
    kind: z.literal('connection'),
    connectionId: ProviderConnectionIdSchema,
    sourceRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    modelSelectionOrigin: z.enum(['implicit_default', 'explicit_process_environment']).optional(),
    modelSelection: ProviderBoundModelRefSchema.optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.modelSelection && value.modelSelection.providerConnectionId !== value.connectionId) {
      ctx.addIssue({ code: 'custom', path: ['modelSelection', 'providerConnectionId'], message: 'Migrated model selection must reference the winning connection' });
    }
    if (value.modelSelectionOrigin && !value.modelSelection) {
      ctx.addIssue({ code: 'custom', path: ['modelSelectionOrigin'], message: 'Model selection provenance requires a migrated model selection' });
    }
  }),
  z.object({
    sourceProfileId: ProviderMigrationSourceProfileIdSchema,
    kind: z.literal('skipped_disabled'),
  }).strict(),
]);
export type ProviderSettingsMigrationSourceOutcomeV1 = z.infer<typeof ProviderSettingsMigrationSourceOutcomeV1Schema>;

export const ProviderSettingsMigrationConflictKindV1Schema = z.enum([
  'credential_binding',
  'manual_model',
  'edited_default_connection',
]);
export type ProviderSettingsMigrationConflictKindV1 = z.infer<typeof ProviderSettingsMigrationConflictKindV1Schema>;

export const ProviderSettingsMigrationModelChoiceV1Schema = z.object({
  kind: z.enum(['legacy', 'existing']),
  selection: z.object({
    agentTargetKey: ProviderAgentTargetKeySchema,
    modelId: ProviderModelIdSchema,
  }).strict(),
  label: z.string().trim().min(1).max(256).optional(),
}).strict();
export type ProviderSettingsMigrationModelChoiceV1 = z.infer<
  typeof ProviderSettingsMigrationModelChoiceV1Schema
>;

export const ProviderSettingsMigrationPendingConflictV1Schema = z.object({
  v: z.literal(1),
  sourceProfileId: ProviderMigrationSourceProfileIdSchema,
  contributionKey: ProviderContributionKeySchema,
  existingConnectionId: ProviderConnectionIdSchema.nullable(),
  kinds: z.array(ProviderSettingsMigrationConflictKindV1Schema).min(1).max(3),
  modelChoices: z.array(ProviderSettingsMigrationModelChoiceV1Schema).max(2).default([]),
  candidateFingerprint: z.string().startsWith('legacy-profile-migration-conflict:v1:').max(256),
  detectedAt: z.number().finite().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.kinds).size !== value.kinds.length) {
    ctx.addIssue({ code: 'custom', path: ['kinds'], message: 'Migration conflict kinds must be unique' });
  }
  const choiceKeys = value.modelChoices.map((choice) =>
    `${choice.selection.agentTargetKey}\0${choice.selection.modelId}`);
  if (new Set(choiceKeys).size !== choiceKeys.length) {
    ctx.addIssue({ code: 'custom', path: ['modelChoices'], message: 'Migration model choices must have unique selections' });
  }
  if (!value.kinds.includes('manual_model') && value.modelChoices.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['modelChoices'], message: 'Only model conflicts may expose model choices' });
  }
});
export type ProviderSettingsMigrationPendingConflictV1 = z.infer<typeof ProviderSettingsMigrationPendingConflictV1Schema>;

export const ProviderSettingsMigrationStateV1Schema = z.object({
  v: z.literal(1),
  completedSources: z.array(ProviderSettingsMigrationSourceOutcomeV1Schema)
    .max(PROVIDER_SETTINGS_LIMITS_V1.migrationCompletedSources),
  pendingCustomProfileIds: z.array(ProviderMigrationSourceProfileIdSchema)
    .max(PROVIDER_SETTINGS_LIMITS_V1.migrationPendingCustomProfiles),
  pendingConflicts: z.array(ProviderSettingsMigrationPendingConflictV1Schema)
    .max(PROVIDER_SETTINGS_LIMITS_V1.migrationPendingConflicts).default([]),
  migratedAt: z.number().finite().nonnegative().optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.completedSources.map((entry) => entry.sourceProfileId)).size !== value.completedSources.length) {
    ctx.addIssue({ code: 'custom', path: ['completedSources'], message: 'Completed source-profile outcomes must be unique' });
  }
  if (new Set(value.pendingCustomProfileIds).size !== value.pendingCustomProfileIds.length) {
    ctx.addIssue({ code: 'custom', path: ['pendingCustomProfileIds'], message: 'Pending profile ids must be unique' });
  }
  if (new Set(value.pendingConflicts.map((entry) => entry.sourceProfileId)).size !== value.pendingConflicts.length) {
    ctx.addIssue({ code: 'custom', path: ['pendingConflicts'], message: 'Pending migration conflicts must have unique sources' });
  }
  const completedIds = new Set(value.completedSources.map((entry) => entry.sourceProfileId));
  if (value.pendingCustomProfileIds.some((id) => completedIds.has(id))) {
    ctx.addIssue({ code: 'custom', path: ['pendingCustomProfileIds'], message: 'A source profile cannot be both completed and pending' });
  }
  if (value.pendingConflicts.some((entry) => completedIds.has(entry.sourceProfileId))) {
    ctx.addIssue({ code: 'custom', path: ['pendingConflicts'], message: 'A source profile cannot be both completed and conflicted' });
  }
});
export type ProviderSettingsMigrationStateV1 = z.infer<typeof ProviderSettingsMigrationStateV1Schema>;

export const ProviderExperimentalBindingConfirmationV1Schema = z.object({
  v: z.literal(1),
  connectionId: ProviderConnectionIdSchema,
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: ProviderModelIdSchema.nullable(),
  compatibilityFingerprint: z.string().trim().min(1).max(256),
  confirmedAt: z.number().finite().nonnegative(),
}).strict();

export function isCanonicalProviderSavedSecretIdV1(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 256
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

const SavedSecretSlotRecordV1Schema = z.record(
  ProviderLocalIdSchema,
  z.string().refine(isCanonicalProviderSavedSecretIdV1, 'Saved-secret id must be canonical'),
).superRefine((value, ctx) => {
  if (Object.keys(value).length > PROVIDER_SETTINGS_LIMITS_V1.credentialSlotsPerScope) {
    ctx.addIssue({ code: 'custom', message: 'Too many credential-slot bindings' });
  }
});

export const SavedSecretSlotBindingsV1Schema = z.object({
  account: SavedSecretSlotRecordV1Schema.optional(),
  byMachineId: z.record(ProviderMachineIdSchema, SavedSecretSlotRecordV1Schema).optional(),
}).strict();
export type SavedSecretSlotBindingsV1 = Readonly<z.infer<typeof SavedSecretSlotBindingsV1Schema>>;

const ProviderSettingsV1BaseSchema = z.object({
  v: z.literal(1),
  connections: z.array(ProviderConnectionV1Schema),
  connectionTombstones: z.array(ProviderConnectionTombstoneV1Schema).max(PROVIDER_SETTINGS_LIMITS_V1.connectionTombstones),
  accountGrants: z.array(ProviderAccountGrantV1Schema),
  machineGrants: z.array(ProviderMachineGrantV1Schema),
  secretBindingsByConnectionId: z.record(ProviderConnectionIdSchema, SavedSecretSlotBindingsV1Schema),
  manualModelsByConnectionId: z.record(
    ProviderConnectionIdSchema,
    z.array(ProviderManualModelV1Schema).max(PROVIDER_SETTINGS_LIMITS_V1.manualModelsPerConnection),
  ),
  modelVisibilityByRef: z.record(z.string().startsWith('mvr1:'), z.literal('hidden')),
  experimentalBindingConfirmations: z.array(ProviderExperimentalBindingConfirmationV1Schema)
    .max(PROVIDER_SETTINGS_LIMITS_V1.experimentalBindingConfirmations),
  defaultsByAgentTargetKey: z.record(ProviderAgentTargetKeySchema, SessionModelSelectionV1Schema),
  migration: ProviderSettingsMigrationStateV1Schema.optional(),
}).strict();

export const ProviderSettingsV1Schema = ProviderSettingsV1BaseSchema.superRefine((value, ctx) => {
  const connectionIds = new Set<string>();
  const defaultContributionKeys = new Set<string>();
  value.connections.forEach((connection, index) => {
    if (connectionIds.has(connection.id)) ctx.addIssue({ code: 'custom', path: ['connections', index, 'id'], message: 'Duplicate connection id' });
    connectionIds.add(connection.id);
    if (connection.role === 'default' && connection.source.kind === 'contribution') {
      const contributionKey = canonicalizeProviderContributionKeyV1(connection.source.contributionKey);
      if (defaultContributionKeys.has(contributionKey)) {
        ctx.addIssue({ code: 'custom', path: ['connections', index, 'role'], message: 'Only one default connection is allowed per contribution' });
      }
      defaultContributionKeys.add(contributionKey);
    }
  });

  const tombstoneIds = new Set<string>();
  value.connectionTombstones.forEach((tombstone, index) => {
    if (connectionIds.has(tombstone.id) || tombstoneIds.has(tombstone.id)) {
      ctx.addIssue({ code: 'custom', path: ['connectionTombstones', index, 'id'], message: 'Tombstone id must be unique and non-active' });
    }
    tombstoneIds.add(tombstone.id);
  });

  const assertConnectionRef = (id: string, path: (string | number)[]) => {
    if (!connectionIds.has(id)) ctx.addIssue({ code: 'custom', path, message: 'Record references an unknown connection' });
  };
  const accountGrantIds = new Set<string>();
  value.accountGrants.forEach((grant, index) => {
    assertConnectionRef(grant.connectionId, ['accountGrants', index, 'connectionId']);
    if (accountGrantIds.has(grant.connectionId)) ctx.addIssue({ code: 'custom', path: ['accountGrants', index], message: 'Duplicate account grant' });
    accountGrantIds.add(grant.connectionId);
  });
  const machineGrantIds = new Set<string>();
  value.machineGrants.forEach((grant, index) => {
    assertConnectionRef(grant.connectionId, ['machineGrants', index, 'connectionId']);
    const key = `${grant.machineId}\0${grant.connectionId}`;
    if (machineGrantIds.has(key)) ctx.addIssue({ code: 'custom', path: ['machineGrants', index], message: 'Duplicate machine grant' });
    machineGrantIds.add(key);
  });
  Object.keys(value.secretBindingsByConnectionId).forEach((connectionId) => assertConnectionRef(connectionId, ['secretBindingsByConnectionId', connectionId]));

  let manualModelsTotal = 0;
  for (const [connectionId, models] of Object.entries(value.manualModelsByConnectionId)) {
    assertConnectionRef(connectionId, ['manualModelsByConnectionId', connectionId]);
    manualModelsTotal += models.length;
    if (new Set(models.map((model) => model.id)).size !== models.length) {
      ctx.addIssue({ code: 'custom', path: ['manualModelsByConnectionId', connectionId], message: 'Manual model ids must be unique per connection' });
    }
  }
  if (manualModelsTotal > PROVIDER_SETTINGS_LIMITS_V1.manualModelsTotal) {
    ctx.addIssue({ code: 'custom', path: ['manualModelsByConnectionId'], message: 'Too many manual models' });
  }

  const visibilityEntries = Object.keys(value.modelVisibilityByRef);
  if (visibilityEntries.length > PROVIDER_SETTINGS_LIMITS_V1.modelVisibilityExceptions) {
    ctx.addIssue({ code: 'custom', path: ['modelVisibilityByRef'], message: 'Too many model visibility records' });
  }
  for (const key of visibilityEntries) {
    try {
      const ref = deserializeModelVisibilityRefV1(key);
      if (ref.providerConnectionId !== null) assertConnectionRef(ref.providerConnectionId, ['modelVisibilityByRef', key]);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['modelVisibilityByRef', key], message: 'Invalid model visibility key' });
    }
  }

  const confirmations = new Set<string>();
  value.experimentalBindingConfirmations.forEach((confirmation, index) => {
    assertConnectionRef(confirmation.connectionId, ['experimentalBindingConfirmations', index, 'connectionId']);
    const key = `${confirmation.connectionId}\0${confirmation.agentTargetKey}\0${confirmation.modelId ?? ''}\0${confirmation.compatibilityFingerprint}`;
    if (confirmations.has(key)) ctx.addIssue({ code: 'custom', path: ['experimentalBindingConfirmations', index], message: 'Duplicate experimental confirmation' });
    confirmations.add(key);
  });
  for (const [agentTargetKey, selection] of Object.entries(value.defaultsByAgentTargetKey)) {
    if (selection.ref.agentTargetKey !== agentTargetKey) {
      ctx.addIssue({ code: 'custom', path: ['defaultsByAgentTargetKey', agentTargetKey], message: 'Default selection agent target does not match its key' });
    }
    if (selection.ref.providerConnectionId !== null) assertConnectionRef(selection.ref.providerConnectionId, ['defaultsByAgentTargetKey', agentTargetKey, 'ref', 'providerConnectionId']);
  }
  if (Object.keys(value.defaultsByAgentTargetKey).length > PROVIDER_SETTINGS_LIMITS_V1.defaultsByAgentTargetKey) {
    ctx.addIssue({ code: 'custom', path: ['defaultsByAgentTargetKey'], message: 'Too many per-agent defaults' });
  }
});
export type ProviderSettingsV1 = z.infer<typeof ProviderSettingsV1Schema>;

export const DEFAULT_PROVIDER_SETTINGS_V1: ProviderSettingsV1 = Object.freeze({
  v: 1,
  connections: [],
  connectionTombstones: [],
  accountGrants: [],
  machineGrants: [],
  secretBindingsByConnectionId: {},
  manualModelsByConnectionId: {},
  modelVisibilityByRef: {},
  experimentalBindingConfirmations: [],
  defaultsByAgentTargetKey: {},
});

export class ProviderSettingsLimitError extends Error {
  readonly code = 'provider_settings_limit_exceeded';
  constructor(message: string) { super(message); this.name = 'ProviderSettingsLimitError'; }
}

export function assertProviderSettingsV1WithinLimits(value: unknown): ProviderSettingsV1 {
  const record = rawRecord(value);
  const count = (key: string) => Array.isArray(record[key]) ? record[key].length : 0;
  if (count('connectionTombstones') > PROVIDER_SETTINGS_LIMITS_V1.connectionTombstones
    || count('experimentalBindingConfirmations') > PROVIDER_SETTINGS_LIMITS_V1.experimentalBindingConfirmations
    || Object.keys(rawRecord(record.modelVisibilityByRef)).length > PROVIDER_SETTINGS_LIMITS_V1.modelVisibilityExceptions
    || Object.keys(rawRecord(record.defaultsByAgentTargetKey)).length > PROVIDER_SETTINGS_LIMITS_V1.defaultsByAgentTargetKey) {
    throw new ProviderSettingsLimitError('Provider settings exceed a record-count limit');
  }
  const manualModelsByConnectionId = rawRecord(record.manualModelsByConnectionId);
  let manualModelsTotal = 0;
  for (const models of Object.values(manualModelsByConnectionId)) {
    if (!Array.isArray(models)) continue;
    if (models.length > PROVIDER_SETTINGS_LIMITS_V1.manualModelsPerConnection) {
      throw new ProviderSettingsLimitError('Provider settings exceed the per-connection manual-model limit');
    }
    manualModelsTotal += models.length;
    if (manualModelsTotal > PROVIDER_SETTINGS_LIMITS_V1.manualModelsTotal) {
      throw new ProviderSettingsLimitError('Provider settings exceed the total manual-model limit');
    }
  }
  for (const bindings of Object.values(rawRecord(record.secretBindingsByConnectionId))) {
    const bindingRecord = rawRecord(bindings);
    if (Object.keys(rawRecord(bindingRecord.account)).length > PROVIDER_SETTINGS_LIMITS_V1.credentialSlotsPerScope) {
      throw new ProviderSettingsLimitError('Provider settings exceed the credential-slot limit');
    }
    const byMachineId = rawRecord(bindingRecord.byMachineId);
    for (const machineBindings of Object.values(byMachineId)) {
      if (Object.keys(rawRecord(machineBindings)).length > PROVIDER_SETTINGS_LIMITS_V1.credentialSlotsPerScope) {
        throw new ProviderSettingsLimitError('Provider settings exceed the credential-slot limit');
      }
    }
  }
  const migration = rawRecord(record.migration);
  if ((Array.isArray(migration.completedSources)
      && migration.completedSources.length > PROVIDER_SETTINGS_LIMITS_V1.migrationCompletedSources)
    || (Array.isArray(migration.pendingCustomProfileIds)
      && migration.pendingCustomProfileIds.length > PROVIDER_SETTINGS_LIMITS_V1.migrationPendingCustomProfiles)
    || (Array.isArray(migration.pendingConflicts)
      && migration.pendingConflicts.length > PROVIDER_SETTINGS_LIMITS_V1.migrationPendingConflicts)) {
    throw new ProviderSettingsLimitError('Provider settings exceed the migration-record limit');
  }
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch {
    throw new ProviderSettingsLimitError('Provider settings must be serializable JSON');
  }
  if (serialized === undefined) throw new ProviderSettingsLimitError('Provider settings must be serializable JSON');
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > PROVIDER_SETTINGS_LIMITS_V1.decodedJsonBytes) throw new ProviderSettingsLimitError('Provider settings exceed the decoded-size limit');
  const parsed = ProviderSettingsV1Schema.safeParse(value);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

export type ProviderSettingsParseDiagnosticV1 = Readonly<{ path: string; reason: string }>;

function rawRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseProviderSettingsV1Narrow(value: unknown): Readonly<{
  settings: ProviderSettingsV1;
  diagnostics: readonly ProviderSettingsParseDiagnosticV1[];
}> {
  const diagnostics: ProviderSettingsParseDiagnosticV1[] = [];
  const raw = rawRecord(value);
  const parseArray = <T>(key: string, schema: z.ZodType<T>, max?: number): T[] => {
    const rawEntries = Array.isArray(raw[key]) ? raw[key] : [];
    if (max !== undefined && rawEntries.length > max) diagnostics.push({ path: key, reason: 'limit_exceeded' });
    const entries = max === undefined ? rawEntries : rawEntries.slice(0, max);
    return entries.flatMap((entry, index) => {
      const parsed = schema.safeParse(entry);
      if (parsed.success) return [parsed.data];
      diagnostics.push({ path: `${key}[${index}]`, reason: 'invalid_record' });
      return [];
    });
  };
  const uniqueFirst = <T>(
    entries: readonly T[],
    keyOf: (entry: T) => string,
    path: string,
  ): T[] => {
    const seen = new Set<string>();
    return entries.filter((entry, index) => {
      const key = keyOf(entry);
      if (!seen.has(key)) { seen.add(key); return true; }
      diagnostics.push({ path: `${path}[${index}]`, reason: 'duplicate_identity' });
      return false;
    });
  };

  const connections: ProviderConnectionV1[] = [];
  const connectionIds = new Set<string>();
  const defaultContributionKeys = new Set<string>();
  for (const parsed of parseArray('connections', ProviderConnectionV1Schema)) {
    const connection: ProviderConnectionV1 = parsed.source.kind === 'contribution'
      ? {
          ...parsed,
          source: {
            ...parsed.source,
            contributionKey: canonicalizeProviderContributionKeyV1(parsed.source.contributionKey),
          },
        }
      : parsed;
    const defaultKey = connection.role === 'default' && connection.source.kind === 'contribution'
      ? connection.source.contributionKey
      : null;
    if (connectionIds.has(connection.id) || (defaultKey && defaultContributionKeys.has(defaultKey))) {
      diagnostics.push({ path: 'connections', reason: 'duplicate_identity' });
      continue;
    }
    connectionIds.add(connection.id);
    if (defaultKey) defaultContributionKeys.add(defaultKey);
    connections.push(connection);
  }
  const keepRef = <T extends { connectionId: string }>(entries: T[], key: string): T[] => entries.filter((entry, index) => {
    if (connectionIds.has(entry.connectionId)) return true;
    diagnostics.push({ path: `${key}[${index}]`, reason: 'unknown_connection' });
    return false;
  });

  const accountGrants = uniqueFirst(
    keepRef(parseArray('accountGrants', ProviderAccountGrantV1Schema), 'accountGrants'),
    (grant) => grant.connectionId,
    'accountGrants',
  );
  const machineGrants = uniqueFirst(
    keepRef(parseArray('machineGrants', ProviderMachineGrantV1Schema), 'machineGrants'),
    (grant) => `${grant.machineId}\0${grant.connectionId}`,
    'machineGrants',
  );

  const connectionTombstones = uniqueFirst(
    parseArray('connectionTombstones', ProviderConnectionTombstoneV1Schema, PROVIDER_SETTINGS_LIMITS_V1.connectionTombstones)
      .map((entry) => entry.contributionKey === null
        ? entry
        : {
            ...entry,
            contributionKey: canonicalizeProviderContributionKeyV1(entry.contributionKey),
          })
      .filter((entry, index) => {
        if (!connectionIds.has(entry.id)) return true;
        diagnostics.push({ path: `connectionTombstones[${index}]`, reason: 'duplicate_identity' });
        return false;
      }),
    (entry) => entry.id,
    'connectionTombstones',
  );

  const secretBindingsByConnectionId: ProviderSettingsV1['secretBindingsByConnectionId'] = {};
  for (const [connectionId, bindings] of Object.entries(rawRecord(raw.secretBindingsByConnectionId))) {
    const parsed = SavedSecretSlotBindingsV1Schema.safeParse(bindings);
    const parsedConnectionId = ProviderConnectionIdSchema.safeParse(connectionId);
    if (connectionIds.has(connectionId) && parsed.success && parsedConnectionId.success) secretBindingsByConnectionId[parsedConnectionId.data] = parsed.data;
    else diagnostics.push({ path: `secretBindingsByConnectionId.${connectionId}`, reason: parsed.success ? 'unknown_connection' : 'invalid_record' });
  }

  const manualModelsByConnectionId: ProviderSettingsV1['manualModelsByConnectionId'] = {};
  let remainingManual = PROVIDER_SETTINGS_LIMITS_V1.manualModelsTotal;
  for (const [connectionId, entries] of Object.entries(rawRecord(raw.manualModelsByConnectionId))) {
    const parsedConnectionId = ProviderConnectionIdSchema.safeParse(connectionId);
    if (!connectionIds.has(connectionId) || !parsedConnectionId.success) { diagnostics.push({ path: `manualModelsByConnectionId.${connectionId}`, reason: 'unknown_connection' }); continue; }
    const rawModels = Array.isArray(entries) ? entries : [];
    const modelLimit = Math.min(PROVIDER_SETTINGS_LIMITS_V1.manualModelsPerConnection, remainingManual);
    if (rawModels.length > modelLimit) diagnostics.push({ path: `manualModelsByConnectionId.${connectionId}`, reason: 'limit_exceeded' });
    const parsedModels = uniqueFirst(rawModels.slice(0, modelLimit)
      .flatMap((entry, index) => {
        const parsed = ProviderManualModelV1Schema.safeParse(entry);
        if (parsed.success) return [parsed.data];
        diagnostics.push({ path: `manualModelsByConnectionId.${connectionId}[${index}]`, reason: 'invalid_record' });
        return [];
      }),
      (model) => model.id,
      `manualModelsByConnectionId.${connectionId}`,
    );
    manualModelsByConnectionId[parsedConnectionId.data] = parsedModels;
    remainingManual -= parsedModels.length;
  }

  const modelVisibilityByRef: Record<string, 'hidden'> = {};
  const visibilityEntries = Object.entries(rawRecord(raw.modelVisibilityByRef));
  if (visibilityEntries.length > PROVIDER_SETTINGS_LIMITS_V1.modelVisibilityExceptions) diagnostics.push({ path: 'modelVisibilityByRef', reason: 'limit_exceeded' });
  for (const [key, state] of visibilityEntries.slice(0, PROVIDER_SETTINGS_LIMITS_V1.modelVisibilityExceptions)) {
    try {
      const ref = deserializeModelVisibilityRefV1(key);
      if (state === 'hidden' && (ref.providerConnectionId === null || connectionIds.has(ref.providerConnectionId))) modelVisibilityByRef[key] = 'hidden';
      else diagnostics.push({ path: `modelVisibilityByRef.${key}`, reason: 'invalid_reference' });
    } catch { diagnostics.push({ path: `modelVisibilityByRef.${key}`, reason: 'invalid_record' }); }
  }

  const experimentalBindingConfirmations = uniqueFirst(
    keepRef(
      parseArray('experimentalBindingConfirmations', ProviderExperimentalBindingConfirmationV1Schema, PROVIDER_SETTINGS_LIMITS_V1.experimentalBindingConfirmations),
      'experimentalBindingConfirmations',
    ),
    (entry) => `${entry.connectionId}\0${entry.agentTargetKey}\0${entry.modelId ?? ''}\0${entry.compatibilityFingerprint}`,
    'experimentalBindingConfirmations',
  );

  const defaultsByAgentTargetKey: Record<string, z.infer<typeof SessionModelSelectionV1Schema>> = {};
  const defaultEntries = Object.entries(rawRecord(raw.defaultsByAgentTargetKey));
  if (defaultEntries.length > PROVIDER_SETTINGS_LIMITS_V1.defaultsByAgentTargetKey) {
    diagnostics.push({ path: 'defaultsByAgentTargetKey', reason: 'limit_exceeded' });
  }
  for (const [agentTargetKey, selection] of defaultEntries.slice(
    0,
    PROVIDER_SETTINGS_LIMITS_V1.defaultsByAgentTargetKey,
  )) {
    const parsed = SessionModelSelectionV1Schema.safeParse(selection);
    if (parsed.success && parsed.data.ref.agentTargetKey === agentTargetKey
      && (parsed.data.ref.providerConnectionId === null || connectionIds.has(parsed.data.ref.providerConnectionId))) {
      defaultsByAgentTargetKey[agentTargetKey] = parsed.data;
    } else diagnostics.push({ path: `defaultsByAgentTargetKey.${agentTargetKey}`, reason: 'invalid_record' });
  }
  let migration: z.infer<typeof ProviderSettingsMigrationStateV1Schema> | undefined;
  if (raw.migration !== undefined) {
    const rawMigration = rawRecord(raw.migration);
    if (rawMigration.v !== 1) {
      diagnostics.push({ path: 'migration', reason: 'invalid_record' });
    } else {
      const rawCompleted = Array.isArray(rawMigration.completedSources) ? rawMigration.completedSources : [];
      const rawPending = Array.isArray(rawMigration.pendingCustomProfileIds) ? rawMigration.pendingCustomProfileIds : [];
      const rawPendingConflicts = Array.isArray(rawMigration.pendingConflicts) ? rawMigration.pendingConflicts : [];
      if (!Array.isArray(rawMigration.completedSources)) diagnostics.push({ path: 'migration.completedSources', reason: 'invalid_record' });
      if (!Array.isArray(rawMigration.pendingCustomProfileIds)) diagnostics.push({ path: 'migration.pendingCustomProfileIds', reason: 'invalid_record' });
      if (rawMigration.pendingConflicts !== undefined && !Array.isArray(rawMigration.pendingConflicts)) diagnostics.push({ path: 'migration.pendingConflicts', reason: 'invalid_record' });
      if (rawCompleted.length > 2_048) diagnostics.push({ path: 'migration.completedSources', reason: 'limit_exceeded' });
      if (rawPending.length > 2_048) diagnostics.push({ path: 'migration.pendingCustomProfileIds', reason: 'limit_exceeded' });
      if (rawPendingConflicts.length > PROVIDER_SETTINGS_LIMITS_V1.migrationPendingConflicts) diagnostics.push({ path: 'migration.pendingConflicts', reason: 'limit_exceeded' });

      const completedSources: ProviderSettingsMigrationSourceOutcomeV1[] = [];
      const completedIds = new Set<string>();
      for (const [index, entry] of rawCompleted.slice(0, 2_048).entries()) {
        const parsed = ProviderSettingsMigrationSourceOutcomeV1Schema.safeParse(entry);
        if (!parsed.success) {
          diagnostics.push({ path: `migration.completedSources[${index}]`, reason: 'invalid_record' });
          continue;
        }
        if (completedIds.has(parsed.data.sourceProfileId)) {
          diagnostics.push({ path: `migration.completedSources[${index}]`, reason: 'duplicate_identity' });
          continue;
        }
        completedIds.add(parsed.data.sourceProfileId);
        completedSources.push(parsed.data);
      }

      const pendingCustomProfileIds: string[] = [];
      const pendingIds = new Set<string>();
      for (const [index, entry] of rawPending.slice(0, 2_048).entries()) {
        const parsed = ProviderMigrationSourceProfileIdSchema.safeParse(entry);
        if (!parsed.success) {
          diagnostics.push({ path: `migration.pendingCustomProfileIds[${index}]`, reason: 'invalid_record' });
          continue;
        }
        if (completedIds.has(parsed.data)) {
          diagnostics.push({ path: `migration.pendingCustomProfileIds[${index}]`, reason: 'already_completed' });
          continue;
        }
        if (pendingIds.has(parsed.data)) {
          diagnostics.push({ path: `migration.pendingCustomProfileIds[${index}]`, reason: 'duplicate_identity' });
          continue;
        }
        pendingIds.add(parsed.data);
        pendingCustomProfileIds.push(parsed.data);
      }

      const pendingConflicts: ProviderSettingsMigrationPendingConflictV1[] = [];
      const conflictIds = new Set<string>();
      for (const [index, entry] of rawPendingConflicts.slice(0, PROVIDER_SETTINGS_LIMITS_V1.migrationPendingConflicts).entries()) {
        const parsed = ProviderSettingsMigrationPendingConflictV1Schema.safeParse(entry);
        if (!parsed.success) {
          diagnostics.push({ path: `migration.pendingConflicts[${index}]`, reason: 'invalid_record' });
          continue;
        }
        if (completedIds.has(parsed.data.sourceProfileId)) {
          diagnostics.push({ path: `migration.pendingConflicts[${index}]`, reason: 'already_completed' });
          continue;
        }
        if (conflictIds.has(parsed.data.sourceProfileId)) {
          diagnostics.push({ path: `migration.pendingConflicts[${index}]`, reason: 'duplicate_identity' });
          continue;
        }
        conflictIds.add(parsed.data.sourceProfileId);
        pendingConflicts.push({
          ...parsed.data,
          contributionKey: canonicalizeProviderContributionKeyV1(parsed.data.contributionKey),
        });
      }

      const migratedAt = z.number().finite().nonnegative().safeParse(rawMigration.migratedAt);
      if (rawMigration.migratedAt !== undefined && !migratedAt.success) {
        diagnostics.push({ path: 'migration.migratedAt', reason: 'invalid_record' });
      }
      migration = {
        v: 1,
        completedSources,
        pendingCustomProfileIds,
        pendingConflicts,
        ...(migratedAt.success ? { migratedAt: migratedAt.data } : {}),
      };
    }
  }

  const settings = ProviderSettingsV1Schema.parse({
    v: 1,
    connections,
    connectionTombstones,
    accountGrants,
    machineGrants,
    secretBindingsByConnectionId,
    manualModelsByConnectionId,
    modelVisibilityByRef,
    experimentalBindingConfirmations,
    defaultsByAgentTargetKey,
    ...(migration ? { migration } : {}),
  });
  return { settings, diagnostics };
}
