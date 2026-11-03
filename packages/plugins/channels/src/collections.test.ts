import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PLUGIN_COLLECTION_REVISION_MAX,
} from '@happier-dev/plugin-sdk/collections';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { PluginContributionIdentityV1JsonSchema, compilePluginJsonSchema, isValidPluginJsonSchemaValue, parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PluginWebhookEndpointIdV1JsonSchema } from '@happier-dev/plugin-sdk/webhooks';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
  ConversationAuthenticatedObservationShellV1JsonSchema,
  ConversationBindingTargetV1JsonSchema,
  ConversationBindingV1Schema,
  ConversationNormalizedIngressV1JsonSchema,
  ConversationScopedPullRequestTriggerV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { AutomationResultDeliverySourceV1JsonSchema } from '@happier-dev/plugin-sdk/automations';

import {
  CHANNEL_ACCOUNT_COLLECTIONS,
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
  ConversationProviderContributionSelectionJsonSchema,
  isCanonicalChannelStateRecordIdentity,
} from './collections.js';
import { collectionMigrations, PLUGIN_MANIFEST } from './manifest.js';
import { ConversationConnectionTransportOriginV1JsonSchema } from './connectionLifecycle.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';

/**
 * The shipped static declarations and their executable half, both projected by
 * the one `definePlugin` owner. Asserting them here rather than a package-local
 * pre-projection is what keeps this file measuring what a host installs.
 */
const CHANNEL_ACCOUNT_COLLECTION_DECLARATIONS =
  PLUGIN_MANIFEST.contributes?.accountCollections ?? [];
const CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS = collectionMigrations;
// Exact published declaration from 6386879ac0, before FIX-REV3 widened the
// freshness bounds. This fixture never follows the current generated manifest.
const retainedManifest = parsePluginManifest({
  ...PLUGIN_MANIFEST,
  contributes: { ...PLUGIN_MANIFEST.contributes, accountCollections: [
    JSON.parse(readFileSync(new URL('./testkit/fixtures/channelStateV5.json', import.meta.url), 'utf8')).collection,
  ] },
});
if (!retainedManifest.ok) throw new Error('Historical Channels v5 declaration must be admitted by the manifest owner.');
// The public manifest parser validated this schema; its generic contribution
// projection intentionally exposes the field as unknown to author callers.
const RETAINED_STATE_V5_SCHEMA = retainedManifest.manifest.contributes.accountCollections![0]!.schema as PluginJsonSchema;

function containsSchemaReference(
  schema: PluginJsonSchema,
  target: PluginJsonSchema,
): boolean {
  if (schema === target) return true;
  const children = [
    ...Object.values(schema.properties ?? {}),
    ...(schema.items ? [schema.items] : []),
    ...(typeof schema.additionalProperties === 'object' ? [schema.additionalProperties] : []),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ];
  return children.some((child) => containsSchemaReference(child, target));
}

function findSchemaProperty(schema: PluginJsonSchema, property: string): PluginJsonSchema | undefined {
  const direct = schema.properties?.[property];
  if (direct !== undefined) return direct;
  const children = [
    ...Object.values(schema.properties ?? {}),
    ...(schema.items ? [schema.items] : []),
    ...(typeof schema.additionalProperties === 'object' ? [schema.additionalProperties] : []),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ];
  for (const child of children) {
    const found = findSchemaProperty(child, property);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findChannelStateRecordBranch(recordKind: string): PluginJsonSchema | undefined {
  return (CHANNEL_STATE_COLLECTION.schema.allOf ?? [])
    .flatMap((schema) => schema.oneOf ?? [])
    .find((schema) => (
      schema.properties?.[CHANNEL_STATE_FIELD.recordKind]?.const === recordKind
    ));
}

function findChannelStateRecordPayload(recordKind: string): PluginJsonSchema | undefined {
  return findChannelStateRecordBranch(recordKind)?.properties?.payload;
}

describe('Channels collection declarations', () => {
  it('migrates the retained v9 native-limit contract without rewriting connection or checkpoint data', async () => {
    const historical = JSON.parse(readFileSync(new URL('./testkit/fixtures/channelStateV9.json', import.meta.url), 'utf8'));
    const v8 = JSON.parse(readFileSync(new URL('./testkit/fixtures/channelStateV8.json', import.meta.url), 'utf8'));
    const source = compilePluginJsonSchema(historical.collection.schema);
    const target = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    const connection = { ...v8.connection, payload: { ...v8.connection.payload, configurationRevision: 14 } };
    // The old strict native-limit object rejects the new provider fact even
    // though existing retained rows need no logical transformation.
    const formatted = { ...connection, payload: { ...connection.payload, outboundTextLimit: {
      maximum: 2_000, unit: 'utf16CodeUnits', formatting: 'preservesNativeUnits',
    } } };
    expect(isValidPluginJsonSchemaValue(source, connection)).toBe(true);
    expect(isValidPluginJsonSchemaValue(source, formatted)).toBe(false);
    expect(isValidPluginJsonSchemaValue(target, formatted)).toBe(true);
    expect(CHANNEL_STATE_COLLECTION.schemaVersion).toBeGreaterThan(historical.collection.schemaVersion);
    const edge = CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS['channel-state']?.find(step => step.fromSchemaVersion === 9);
    expect(edge).toMatchObject({ toSchemaVersion: CHANNEL_STATE_COLLECTION.schemaVersion });
    if (!edge) throw new Error('Missing retained v9 native-limit migration');
    for (const row of [connection, v8.checkpoint]) {
      expect(isValidPluginJsonSchemaValue(source, row)).toBe(true);
      const migrated = await edge.migrate(row, { currentRevision: 14 });
      expect(migrated).toEqual(row);
      expect(isValidPluginJsonSchemaValue(target, migrated)).toBe(true);
    }
  });
  it('migrates the provenance-pinned v6 declaration and admits exact source custody only at v7', async () => {
    const retained = JSON.parse(readFileSync(new URL('./testkit/fixtures/channelStateV6.json', import.meta.url), 'utf8'));
    const parsed = parsePluginManifest({ ...PLUGIN_MANIFEST, contributes: {
      ...PLUGIN_MANIFEST.contributes, accountCollections: [retained.collection],
    } });
    if (!parsed.ok) throw new Error('Historical Channels v6 declaration must be admitted.');
    const oldSchema = parsed.manifest.contributes.accountCollections![0]!.schema as PluginJsonSchema;
    const pinnedV7 = JSON.parse(readFileSync(new URL('./testkit/fixtures/channelStateV7.json', import.meta.url), 'utf8'));
    const materialized = pinnedV7.connection;
    const historical = compilePluginJsonSchema(oldSchema);
    expect(isValidPluginJsonSchemaValue(historical, materialized)).toBe(true);
    const migration = CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS['channel-state']?.find(edge => edge.fromSchemaVersion === 6);
    expect(migration).toMatchObject({ toSchemaVersion: 7 });
    const migrated = await migration!.migrate(materialized, { currentRevision: 1 });
    expect(migrated).toEqual(materialized);
    const current = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    const v7ToV8 = CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS['channel-state']!.find(edge => edge.fromSchemaVersion === 7)!;
    const v8ToV9 = CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS['channel-state']!.find(edge => edge.fromSchemaVersion === 8)!;
    expect(isValidPluginJsonSchemaValue(current, await v8ToV9.migrate(await v7ToV8.migrate(migrated, { currentRevision: 1 }), { currentRevision: 1 }))).toBe(true);
    const source = { ...materialized, payload: { ...materialized.payload, transportOrigin: {
      serverIdentityId: 'srv_example', sourceRef: {
        pluginId: 'happier.channel.example', machineId: 'machine-1',
        sourceCustody: { kind: 'development', registeredRootId: '/runtime-1/provider' },
      },
    } } };
    expect(isValidPluginJsonSchemaValue(historical, source)).toBe(false);
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(pinnedV7.collection.schema), source)).toBe(true);
    expect(isValidPluginJsonSchemaValue(current, await v8ToV9.migrate(await v7ToV8.migrate(source, { currentRevision: 1 }), { currentRevision: 1 }))).toBe(true);
    expect(isValidPluginJsonSchemaValue(current, { ...source, payload: { ...source.payload,
      transportOrigin: { ...source.payload.transportOrigin, ...materialized.payload.transportOrigin },
    } })).toBe(false);
  });
  it.each([
    { principalCount: 1, inboundDebounceMs: 5_001 },
    { principalCount: 257, inboundDebounceMs: 0 },
  ])('persists public binding policy beyond former limits: %j', ({ principalCount, inboundDebounceMs }) => {
    const { id, connectionId, v, createdAt, updatedAt, ...payload } = ConversationBindingV1Schema.parse({
      v: 1, id: 'binding-1', connectionId: 'connection-1', createdAt: 0, updatedAt: 0,
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
      target: { kind: 'session', sessionId: 'session-1', policy: {
        deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
        approvals: { kind: 'off' }, newSession: { kind: 'off' },
      } },
      allowedPrincipalIds: Array.from({ length: principalCount }, (_unused, index) => `principal-${index}`),
      allowBotSenders: false, inputMode: 'allAllowedMessages', inboundDebounceMs,
      linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1,
      enabled: true, deletionState: 'none',
    });
    const row = {
      id, v, 'record-kind': 'binding', 'connection-id': connectionId, 'binding-id': id,
      'created-at': createdAt, 'updated-at': updatedAt, payload,
    };
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), row)).toBe(true);
  });

  it('migrates retained v3 provider identities without changing materialized authority or provider-owned bytes', async () => {
    const current = createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority: {
        providerPluginId: 'happier.channel.telegram',
        providerContributionSelection: { contributionId: 'telegram' },
        providerSetupInput: { immutableGenerationId: 'provider-owned-data' },
        credentialRef: null,
        transportOrigin: { serverIdentityId: 'srv_account_one', materializationRef: {
          pluginId: 'happier.channel.telegram', machineId: 'machine-1', materializationId: 'retained-materialization',
        } },
        providerConnectionKey: 'provider-connection', providerConfig: {}, routingIdentityKey: 'a'.repeat(43),
        integrationPrincipal: { id: 'principal-1' }, authorityEpoch: 1,
      },
    });
    const { configurationRevision: _currentConfigurationRevision, ...historicalPayload } = current.payload;
    // Serialize through the same plain JSON boundary as a retained logical row.
    const retained = JSON.parse(JSON.stringify({ ...current, payload: {
      ...historicalPayload, providerContributionSelection: { contributionId: 'telegram', immutableGenerationId: 'retired-generation' },
      transportOrigin: { serverIdentityId: 'srv_account_one', materializationRef: {
        pluginId: 'happier.channel.telegram', machineId: 'machine-1', materializationId: 'retained-materialization',
      } },
    } })) as Readonly<Record<string, JsonValue>>;
    const migration = CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS['channel-state']?.find((edge) => edge.fromSchemaVersion === 3);
    expect(migration).toBeDefined();
    const migrated = await migration?.migrate(retained, { currentRevision: 1 });
    expect(migrated).toEqual({ ...current, payload: { ...historicalPayload, transportOrigin: (retained.payload as Readonly<Record<string, JsonValue>>).transportOrigin } });
    const v7ToV8 = CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS['channel-state']!.find(edge => edge.fromSchemaVersion === 7)!;
    const routing = await v7ToV8.migrate(migrated!, { currentRevision: 1 });
    expect(routing).toEqual({ ...current, payload: historicalPayload });
    const v8ToV9 = CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS['channel-state']!.find(edge => edge.fromSchemaVersion === 8)!;
    const configured = await v8ToV9.migrate(routing, { currentRevision: 1 });
    expect(configured).toEqual(current);
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), configured)).toBe(true);
    expect(retained).toMatchObject({ payload: { providerContributionSelection: { immutableGenerationId: 'retired-generation' } } });
  });

  it.each([4, 5])('migrates retained v%i connection and binding rows unchanged into the current state contract', async (sourceVersion) => {
    // Logical JSON rows accepted by the retained channel-state v4 contract
    // WcyeFW11n9ycj-viSm2YvRbT2qpNbK8pyXA5nr0l1dQ on agent-qa-channels.
    const connection = createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority: {
        providerPluginId: 'happier.channel.telegram',
        providerContributionSelection: { contributionId: 'telegram' },
        providerSetupInput: {}, credentialRef: null,
        transportOrigin: { serverIdentityId: 'srv_account_one', materializationRef: {
          pluginId: 'happier.channel.telegram', machineId: 'machine-1', materializationId: 'retained-materialization',
        } },
        providerConnectionKey: 'provider-connection', providerConfig: {}, routingIdentityKey: 'a'.repeat(43),
        integrationPrincipal: { id: 'principal-1' }, authorityEpoch: 1,
      },
    });
    const binding = {
      id: 'binding-1', v: 1, 'record-kind': 'binding',
      'connection-id': 'connection-1', 'binding-id': 'binding-1', 'created-at': 1, 'updated-at': 1,
      payload: {
        endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
        target: { kind: 'session', sessionId: 'session-1', policy: {
          deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
          approvals: { kind: 'off' }, newSession: { kind: 'off' },
        } },
        allowedPrincipalIds: ['principal-1'], allowBotSenders: false,
        inputMode: 'allAllowedMessages', inboundDebounceMs: 0,
        linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1,
        enabled: true, deletionState: 'none',
      },
    };
    const { configurationRevision: _currentConfigurationRevision, ...historicalConnectionPayload } = connection.payload;
    const historicalConnection = { ...connection, payload: historicalConnectionPayload };
    const migration = CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS['channel-state']?.find((edge) => edge.fromSchemaVersion === sourceVersion);
    expect(migration).toMatchObject({ toSchemaVersion: sourceVersion + 1 });
    const target = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    for (const source of [historicalConnection, binding]) {
      const historical = source['record-kind'] === 'connection'
        ? { ...source, payload: { ...source.payload, transportOrigin: { serverIdentityId: 'srv_account_one', materializationRef: {
          pluginId: 'happier.channel.telegram', machineId: 'machine-1', materializationId: 'retained-materialization',
        } } } } : source;
      const retained = JSON.parse(JSON.stringify(historical)) as Readonly<Record<string, JsonValue>>;
      expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(RETAINED_STATE_V5_SCHEMA), retained)).toBe(true);
      const before = JSON.stringify(retained);
      const migrated = await migration!.migrate(retained, { currentRevision: 1 });
      expect(migrated).toEqual(retained);
      let current = migrated;
      for (const edge of CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS['channel-state']!) {
        if (edge.fromSchemaVersion > sourceVersion) current = await edge.migrate(current, { currentRevision: 1 });
      }
      expect(isValidPluginJsonSchemaValue(target, current)).toBe(true);
      expect(JSON.stringify(retained)).toBe(before);
    }
  });

  it.each([
    { content: 'Retained delivery text', targetContent: { text: 'Retained delivery text' }, state: 'ready', terminal: false, providerMessageIds: [], contentFingerprint: null },
    { content: null, targetContent: null, state: 'delivered', terminal: true, providerMessageIds: ['message-1'], contentFingerprint: 'b'.repeat(43) },
    { content: { text: 'Structured delivery', html: '<p>Structured delivery</p>' }, targetContent: { text: 'Structured delivery', html: '<p>Structured delivery</p>' }, state: 'ready', terminal: false, providerMessageIds: [], contentFingerprint: null },
  ])('migrates v2 delivery custody without losing content or replay evidence: $state / $content', async (fixture) => {
    // V2 string/null vectors follow the persisted contract
    // --o6-Evg_8okqTaObgW5BZJiQfPwUMVBNEhft6YF5xE; the structured case
    // ensures a current logical value is never double-wrapped on replay.
    const retained: Readonly<Record<string, JsonValue>> = JSON.parse(JSON.stringify({
      id: 'a'.repeat(43), 'record-kind': 'outward-delivery', v: 1,
      'connection-id': 'connection-1', 'binding-id': 'binding-1',
      terminal: fixture.terminal, attention: false, 'created-at': 100, 'updated-at': 100,
      payload: {
        source: { kind: 'sessionProjection', sessionId: 'session-1', semanticItemId: 'semantic-1' },
        routeAuthority: { connectionAuthorityEpoch: 4, bindingRevision: 1, bindingAuthorityEpoch: 7 },
        endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
        content: fixture.content, contentFingerprint: fixture.contentFingerprint,
        deliveryKey: 'channels:delivery:v1:session-1:semantic-1', replyContext: null,
        mentionPolicy: 'suppress', linkPreviewPolicy: 'suppress', state: fixture.state,
        attemptCount: 0, attemptId: null, startedAt: null,
        providerMessageIds: fixture.providerMessageIds, failedChunk: null, archiveRecovery: null,
      },
    }));
    const before = JSON.stringify(retained);
    const migration = CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS['channel-deliveries']?.find((edge) => edge.fromSchemaVersion === 2);
    expect(migration).toMatchObject({ toSchemaVersion: 3 });
    expect(CHANNEL_DELIVERIES_COLLECTION.schemaVersion).toBe(5);
    expect(CHANNEL_DELIVERIES_COLLECTION.readableSchemaVersions).toEqual([1, 2, 3, 4]);
    const migrated = await migration?.migrate(retained, { currentRevision: 1 });
    expect(migrated).toEqual({ ...retained, payload: {
      ...(retained.payload as Readonly<Record<string, JsonValue>>), content: fixture.targetContent,
    } });
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_DELIVERIES_COLLECTION.schema), migrated)).toBe(true);
    expect(JSON.stringify(retained)).toBe(before);
  });

  it('declares no Account-mode identity tags in either static Collection contract', () => {
    const expectedIdentityFields = [
      { id: 'channel-state', identityFields: [] },
      { id: 'channel-deliveries', identityFields: [] },
    ];

    expect(CHANNEL_ACCOUNT_COLLECTIONS.map((collection) => ({
      id: collection.id,
      identityFields: collection.identityFields,
    }))).toEqual(expectedIdentityFields);
    expect(CHANNEL_ACCOUNT_COLLECTION_DECLARATIONS.map((collection) => ({
      id: collection.id,
      identityFields: collection.identityFields,
    }))).toEqual(expectedIdentityFields);
  });

  it('composes canonical Protocol identity JSON Schemas instead of redefining them', () => {
    expect(containsSchemaReference(
      CHANNEL_STATE_COLLECTION.schema,
      ConversationConnectionTransportOriginV1JsonSchema,
    )).toBe(true);
    expect(containsSchemaReference(
      CHANNEL_STATE_COLLECTION.schema,
      PluginWebhookEndpointIdV1JsonSchema,
    )).toBe(true);
    expect(containsSchemaReference(
      CHANNEL_STATE_COLLECTION.schema,
      PluginContributionIdentityV1JsonSchema,
    )).toBe(true);
    expect(containsSchemaReference(
      CHANNEL_STATE_COLLECTION.schema,
      QualifiedConnectedAccountRefJsonSchema,
    )).toBe(true);
  });

  it('uses the contract-owned binding target schema rather than a private Session or Automation copy', () => {
    expect(containsSchemaReference(
      CHANNEL_STATE_COLLECTION.schema,
      ConversationBindingTargetV1JsonSchema,
    )).toBe(true);
  });

  it('embeds the exact Protocol-owned Automation result source schema in custody', () => {
    expect(containsSchemaReference(
      CHANNEL_DELIVERIES_COLLECTION.schema,
      AutomationResultDeliverySourceV1JsonSchema,
    )).toBe(true);
  });

  it('declares the two canonical Channel persistence collections', () => {
    expect(PLUGIN_MANIFEST.contributes?.accountCollections?.map((collection) => collection.id)).toEqual([
      'channel-state',
      'channel-deliveries',
    ]);
  });

  it('persists one strict route-authority union correlated with outward custody scope', () => {
    const payload = CHANNEL_DELIVERIES_COLLECTION.schema.properties?.payload;
    const routeAuthority = payload?.properties?.routeAuthority;

    expect(payload?.required).toContain('routeAuthority');
    expect(routeAuthority?.oneOf?.map((branch) => ({
      properties: Object.keys(branch.properties ?? {}).sort(),
      required: branch.required,
      additionalProperties: branch.additionalProperties,
    }))).toEqual([
      {
        properties: ['connectionAuthorityEpoch'],
        required: ['connectionAuthorityEpoch'],
        additionalProperties: false,
      },
      {
        properties: [
          'bindingAuthorityEpoch',
          'bindingRevision',
          'connectionAuthorityEpoch',
        ],
        required: [
          'connectionAuthorityEpoch',
          'bindingRevision',
          'bindingAuthorityEpoch',
        ],
        additionalProperties: false,
      },
    ]);
    expect(payload?.properties?.source?.oneOf).toContain(AutomationResultDeliverySourceV1JsonSchema);
  });

  it('keeps one census body and projects the sixth ingress due-work query key', () => {
    const ingressPayload = findChannelStateRecordPayload(
      CHANNEL_STATE_RECORD_KIND.ingressObligation,
    );
    const censusPayload = findChannelStateRecordPayload(
      CHANNEL_STATE_RECORD_KIND.ingressCensus,
    );

    expect(ingressPayload?.required).toEqual(expect.arrayContaining([
      'censusId',
      'lifecycle',
      'nonAdmission',
    ]));
    expect(ingressPayload?.properties?.input).toBeUndefined();
    expect(censusPayload?.required).toEqual(expect.arrayContaining([
      'normalizedIngress',
      'phase',
      'connectionAuthorityEpoch',
      'maximumObservationAgeMs',
    ]));
    // The admitted arm stays the exact protocol schema object rather than a
    // drifting hand-rolled copy; only its settled-census null arm is added.
    expect(censusPayload?.properties?.normalizedIngress).toEqual({
      anyOf: [ConversationNormalizedIngressV1JsonSchema, { type: 'null' }],
    });
    expect((censusPayload?.properties?.normalizedIngress as { anyOf: readonly unknown[] }).anyOf[0])
      .toBe(ConversationNormalizedIngressV1JsonSchema);
    expect((censusPayload?.properties?.compacted as unknown as
      Readonly<{ anyOf: readonly [Readonly<{ properties: Record<string, unknown> }>, unknown] }>)
      .anyOf[0].properties.shell)
      .toBe(ConversationAuthenticatedObservationShellV1JsonSchema);
    expect(ingressPayload?.properties?.text).toBeUndefined();
    expect(CHANNEL_STATE_COLLECTION.serverReadable).toContain('due-at');
    expect(CHANNEL_STATE_COLLECTION.serverReadable).toContain('attention');
    expect(CHANNEL_STATE_COLLECTION.indexes).toEqual([
      {
        id: 'by-kind',
        fields: [
          { field: 'record-kind', direction: 'asc' },
          { field: 'id', direction: 'asc' },
        ],
      },
      {
        id: 'by-connection-binding-v2',
        fields: [
          { field: 'connection-id', direction: 'asc' },
          { field: 'binding-id', direction: 'asc' },
          { field: 'record-kind', direction: 'asc' },
          { field: 'attention', direction: 'asc' },
        ],
      },
      {
        id: 'by-connection-kind-v1',
        fields: [
          { field: 'connection-id', direction: 'asc' },
          { field: 'record-kind', direction: 'asc' },
        ],
      },
      {
        id: 'by-session-kind-binding-update-v1',
        fields: [
          { field: 'session-id', direction: 'asc' },
          { field: 'record-kind', direction: 'asc' },
          { field: 'binding-id', direction: 'asc' },
          { field: 'pr-update-at', direction: 'desc' },
        ],
      },
      {
        id: 'by-pr-session-binding-v1',
        fields: [
          { field: 'record-kind', direction: 'asc' },
          { field: 'pr-binding', direction: 'asc' },
          { field: 'session-id', direction: 'asc' },
          { field: 'binding-id', direction: 'asc' },
        ],
      },
      {
        id: 'by-attention',
        fields: [
          { field: 'attention', direction: 'asc' },
          { field: 'updated-at', direction: 'desc' },
          { field: 'id', direction: 'asc' },
        ],
      },
      {
        id: 'by-ingress-due',
        fields: [
          { field: 'record-kind', direction: 'asc' },
          { field: 'due-at', direction: 'asc' },
          { field: 'id', direction: 'asc' },
        ],
      },
    ]);
  });

  it('declares the current state contract and its ordered retained-row migrations', () => {
    const censusPayload = findChannelStateRecordPayload(
      CHANNEL_STATE_RECORD_KIND.ingressCensus,
    );
    const [v1ToV2, v2ToV3, v3ToV4] = CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS['channel-state'] ?? [];
    const staticDeclaration = CHANNEL_ACCOUNT_COLLECTION_DECLARATIONS.find(
      (collection) => collection.id === 'channel-state',
    );
    const source = {
      id: 'census-1',
      'record-kind': 'ingress-census',
      v: 1,
      'connection-id': 'connection-1',
      'created-at': 10,
      'updated-at': 20,
      payload: {
        normalizedIngress: { kind: 'routableNonAdmission', shell: { v: 1 } },
        phase: 'prepared',
        connectionAuthorityEpoch: 2,
        maximumObservationAgeMs: 60_000,
        checkpointCoveredAt: 15,
        matchedBindings: [],
      },
    } as const;

    expect(CHANNEL_STATE_COLLECTION.schemaVersion).toBe(19);
    expect(CHANNEL_STATE_COLLECTION.readableSchemaVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(JSON.parse(JSON.stringify(CHANNEL_ACCOUNT_COLLECTION_DECLARATIONS)))
      .toEqual(CHANNEL_ACCOUNT_COLLECTION_DECLARATIONS);
    expect(staticDeclaration?.migrations).toEqual([{
      id: 'channel-state-v1-to-v2',
      fromSchemaVersion: 1,
      toSchemaVersion: 2,
    }, {
      id: 'channel-state-v2-to-v3',
      fromSchemaVersion: 2,
      toSchemaVersion: 3,
    }, {
      id: 'channel-state-v3-to-v4',
      fromSchemaVersion: 3,
      toSchemaVersion: 4,
    }, {
      id: 'channel-state-v4-to-v5',
      fromSchemaVersion: 4,
      toSchemaVersion: 5,
    }, {
      id: 'channel-state-v5-to-v6',
      fromSchemaVersion: 5,
      toSchemaVersion: 6,
    }, {
      id: 'channel-state-v6-to-v7',
      fromSchemaVersion: 6,
      toSchemaVersion: 7,
    }, {
      id: 'channel-state-v7-to-v8', fromSchemaVersion: 7, toSchemaVersion: 8,
    }, {
      id: 'channel-state-v8-to-v9', fromSchemaVersion: 8, toSchemaVersion: 9,
    }, {
      id: 'channel-state-v9-to-v10', fromSchemaVersion: 9, toSchemaVersion: 10,
    }, {
      id: 'channel-state-v10-to-v11', fromSchemaVersion: 10, toSchemaVersion: 11,
    }, {
      id: 'channel-state-v11-to-v12', fromSchemaVersion: 11, toSchemaVersion: 12,
    }, {
      id: 'channel-state-v12-to-v13', fromSchemaVersion: 12, toSchemaVersion: 13,
    }, {
      id: 'channel-state-v13-to-v14', fromSchemaVersion: 13, toSchemaVersion: 14,
    }, {
      id: 'channel-state-v14-to-v15', fromSchemaVersion: 14, toSchemaVersion: 15,
    }, {
      id: 'channel-state-v15-to-v16', fromSchemaVersion: 15, toSchemaVersion: 16,
    }, {
      id: 'channel-state-v16-to-v17', fromSchemaVersion: 16, toSchemaVersion: 17,
    }, {
      id: 'channel-state-v17-to-v18', fromSchemaVersion: 17, toSchemaVersion: 18,
    }, {
      id: 'channel-state-v18-to-v19', fromSchemaVersion: 18, toSchemaVersion: 19,
    }]);
    expect(staticDeclaration).not.toHaveProperty('migrations.0.migrate');
    expect(censusPayload?.required).toContain('conflict');
    expect(censusPayload?.required).toContain('compacted');
    expect(v1ToV2).toMatchObject({
      id: 'channel-state-v1-to-v2',
      fromSchemaVersion: 1,
      toSchemaVersion: 2,
    });
    expect(v1ToV2?.migrate(source, { currentRevision: 1 })).toEqual({
      ...source,
      attention: false,
      payload: { ...source.payload, conflict: null, compacted: null },
    });
    const retainedV3 = { ...source, attention: false, payload: { ...source.payload, conflict: null, compacted: null } };
    expect(v3ToV4?.migrate(retainedV3, { currentRevision: 1 })).toEqual(retainedV3);
    expect(v2ToV3?.migrate({
      id: 'connection-1',
      'record-kind': 'connection',
      v: 1,
      'connection-id': 'connection-1',
      'created-at': 10,
      'updated-at': 20,
      payload: {
        providerContributionSelection: {
          contributionId: 'telegram',
          immutableGenerationId: 'provider-generation-a',
        },
        providerSetupInput: {
          providerContributionSelection: {
            contributionId: 'provider-owned',
            immutableGenerationId: 'opaque-provider-value',
          },
        },
        pendingOldTransportStop: {
          providerContributionSelection: {
            contributionId: 'telegram',
            immutableGenerationId: 'provider-generation-old',
          },
        },
      },
    }, { currentRevision: 1 })).toEqual({
      id: 'connection-1',
      'record-kind': 'connection',
      v: 1,
      'connection-id': 'connection-1',
      'created-at': 10,
      'updated-at': 20,
      payload: {
        providerContributionSelection: { contributionId: 'telegram' },
        providerSetupInput: {
          providerContributionSelection: {
            contributionId: 'provider-owned',
            immutableGenerationId: 'opaque-provider-value',
          },
        },
        pendingOldTransportStop: {
          providerContributionSelection: { contributionId: 'telegram' },
        },
      },
    });
    expect(v2ToV3?.migrate({
      id: 'obligation-1',
      'record-kind': 'ingress-obligation',
      v: 1,
      'connection-id': 'connection-1',
      'created-at': 10,
      'updated-at': 20,
      payload: {
        target: {
          kind: 'event',
          providerContributionSelection: {
            contributionId: 'telegram',
            immutableGenerationId: 'provider-generation-a',
          },
        },
      },
    }, { currentRevision: 1 })).toEqual({
      id: 'obligation-1',
      'record-kind': 'ingress-obligation',
      v: 1,
      'connection-id': 'connection-1',
      'created-at': 10,
      'updated-at': 20,
      payload: {
        target: {
          kind: 'event',
          providerContributionSelection: { contributionId: 'telegram' },
        },
      },
    });
    expect(findChannelStateRecordBranch(CHANNEL_STATE_RECORD_KIND.ingressCensus)?.allOf)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          oneOf: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({ attention: { type: 'boolean', const: false } }),
            }),
            expect.objectContaining({
              properties: expect.objectContaining({ attention: { type: 'boolean', const: true } }),
            }),
          ]),
        }),
      ]));
  });

  it('permits server-readable attention only on ingress obligations and conflict censuses', () => {
    const attentionForbidden = expect.objectContaining({
      properties: expect.objectContaining({ attention: { type: 'null' } }),
    });
    for (const recordKind of Object.values(CHANNEL_STATE_RECORD_KIND)) {
      if (
        recordKind === CHANNEL_STATE_RECORD_KIND.ingressObligation
        || recordKind === CHANNEL_STATE_RECORD_KIND.ingressCensus
      ) continue;
      expect(findChannelStateRecordBranch(recordKind)?.allOf).toEqual(expect.arrayContaining([
        attentionForbidden,
      ]));
    }
  });

  it('admits body-free not-delivered custody through the canonical delivery schema', () => {
    const payload = CHANNEL_DELIVERIES_COLLECTION.schema.properties?.payload;
    const bodyFreeArm = payload?.allOf
      ?.flatMap((schema) => schema.oneOf ?? [])
      .find((schema) => schema.properties?.content?.type === 'null');

    expect(bodyFreeArm?.properties?.state?.enum).toContain('notDelivered');
  });

  it('persists the exact three-arm input policy without persisting reconciliation demand', () => {
    expect(findSchemaProperty(CHANNEL_STATE_COLLECTION.schema, 'inputMode')).toMatchObject({
      type: 'string',
      enum: ['directMentionsOnly', 'addressedMessages', 'allAllowedMessages'],
    });
    expect(findSchemaProperty(CHANNEL_STATE_COLLECTION.schema, 'requiresFullSharedMessageContent')).toBeUndefined();
  });

  it('requires one nullable frozen old-transport stop slot on every connection row', () => {
    const connectionPayload = findChannelStateRecordPayload(CHANNEL_STATE_RECORD_KIND.connection);
    const pendingOldTransportStop = connectionPayload?.properties?.pendingOldTransportStop;

    expect(connectionPayload?.required).toContain('pendingOldTransportStop');
    expect(pendingOldTransportStop?.anyOf).toHaveLength(2);
    const custody = pendingOldTransportStop?.anyOf?.find((branch) => branch.anyOf !== undefined);
    const frozenSlot = custody?.anyOf?.find((branch) => branch.properties?.stopRequest !== undefined);
    expect(frozenSlot).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'predecessorCheckpointedPollInvocation',
        'transportOrigin',
        'providerContributionSelection',
        'stopRequest',
        'predecessorTransportKind',
        'endpointRetarget',
        'overlapSafety',
        'acceptedPossibleLoss',
      ],
    });
    // The retired transport and its outstanding endpoint obligation are frozen
    // with the slot; the replaced row transport can never answer for them.
    expect(frozenSlot?.properties?.predecessorTransportKind).toEqual({
      type: 'string',
      enum: ['checkpointedPull', 'socket', 'durablePush'],
    });
    expect(frozenSlot?.properties?.endpointRetarget).toEqual({
      type: 'string',
      const: 'notRequired',
    });
    const endpointIntent = custody?.anyOf?.find((branch) => branch.properties?.kind?.const === 'endpointRetarget');
    expect(endpointIntent?.required).toEqual(['kind', 'webhookEndpointId', 'webhookContributionRef', 'webhookSourceInstanceId', 'targetMaterialization', 'transferAuthorityEpoch']);
    expect(endpointIntent?.additionalProperties).toBe(false);
    expect(frozenSlot?.properties?.predecessorCheckpointedPollInvocation).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['connectionRevision', 'authorityEpoch', 'transportOrigin'],
    });
    expect(frozenSlot?.properties?.providerContributionSelection)
      .toBe(ConversationProviderContributionSelectionJsonSchema);
    expect(frozenSlot?.properties?.overlapSafety).toEqual({
      type: 'string',
      enum: ['safe', 'providerExclusive', 'destructive'],
    });
    expect(frozenSlot?.properties?.acceptedPossibleLoss).toEqual({ type: 'boolean' });
  });

  it('persists the one strict poll-failure union on connection rows', () => {
    const connectionPayload = findChannelStateRecordPayload(CHANNEL_STATE_RECORD_KIND.connection);
    const pollFailure = connectionPayload?.properties?.pollFailure;
    const branches = pollFailure?.anyOf
      ?.flatMap((branch) => branch.oneOf ?? [branch])
      .filter((branch) => branch.type === 'object');

    expect(connectionPayload?.required).toContain('pollFailure');
    expect(branches?.map((branch) => ({
      phase: branch.properties?.phase?.const,
      attemptCount: branch.properties?.attemptCount,
      retryNotBeforeMs: branch.properties?.retryNotBeforeMs,
      required: branch.required,
      additionalProperties: branch.additionalProperties,
    }))).toEqual([
      {
        phase: 'retryDue',
        attemptCount: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        retryNotBeforeMs: { type: 'integer', minimum: 0, maximum: 9_007_199_254_740_991 },
        required: ['phase', 'attemptCount', 'retryNotBeforeMs', 'evidence'],
        additionalProperties: false,
      },
      {
        phase: 'blocked',
        attemptCount: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        retryNotBeforeMs: { type: 'null' },
        required: ['phase', 'attemptCount', 'retryNotBeforeMs', 'evidence'],
        additionalProperties: false,
      },
    ]);
    const evidence = branches?.[0]?.properties?.evidence;
    expect(evidence?.oneOf?.map((branch) => ({
      kind: branch.properties?.kind?.const,
      required: branch.required,
      additionalProperties: branch.additionalProperties,
    }))).toEqual([
      { kind: 'provider', required: ['kind', 'reason'], additionalProperties: false },
      { kind: 'action', required: ['kind', 'code', 'message'], additionalProperties: false },
    ]);
  });

  it('declares closed frozen Session, Automation, and Event target branches for ingress obligations', () => {
    const ingressTarget = findChannelStateRecordPayload(
      CHANNEL_STATE_RECORD_KIND.ingressObligation,
    )?.properties?.target;

    const frozenTarget = ingressTarget?.anyOf?.find((branch) => branch.oneOf !== undefined);
    // `additionalProperties: false` means the declared property set is the
    // writer's contract: a frozen field the ingress owner writes but does not
    // declare here is rejected by the real Account Collection, which an
    // in-memory harness cannot observe. Pin the names, not just the required
    // subset.
    expect(frozenTarget?.oneOf?.map((branch) => ({
      kind: branch.properties?.kind?.const,
      properties: Object.keys(branch.properties ?? {}),
      required: branch.required,
      additionalProperties: branch.additionalProperties,
    }))).toEqual([
      {
        kind: 'session',
        properties: [
          'kind',
          'sessionId',
          'idempotencyKey',
          'requestedPermissionCeiling',
          'remoteApprovalMaxScope',
          'approval',
          'userActionAnswer',
          'newSession',
          'stop',
        ],
        required: [
          'kind',
          'sessionId',
          'idempotencyKey',
          'requestedPermissionCeiling',
          'remoteApprovalMaxScope',
        ],
        additionalProperties: false,
      },
      {
        kind: 'automation',
        properties: [
          'kind',
          'automationId',
          'occurrenceKey',
          'scopedTrigger',
          'resultDelivery',
        ],
        required: ['kind', 'automationId', 'occurrenceKey', 'resultDelivery'],
        additionalProperties: false,
      },
      {
        kind: 'event',
        properties: [
          'kind',
          'candidate',
          'providerPluginId',
          'providerContributionSelection',
          'executionOrigin',
        ],
        required: [
          'kind',
          'candidate',
          'providerPluginId',
          'providerContributionSelection',
          'executionOrigin',
        ],
        additionalProperties: false,
      },
    ]);
    const automationTarget = frozenTarget?.oneOf?.find((branch) => branch.properties?.kind?.const === 'automation');
    expect(automationTarget?.properties?.scopedTrigger).toEqual(ConversationScopedPullRequestTriggerV1Schema.jsonSchema);
  });

  it('makes connection and binding row identity equal their persisted relation', () => {
    expect(isCanonicalChannelStateRecordIdentity({
      rowId: 'connection-1',
      recordKind: 'connection',
      connectionId: 'connection-1',
    })).toBe(true);
    expect(isCanonicalChannelStateRecordIdentity({
      rowId: 'connection-row-2',
      recordKind: 'connection',
      connectionId: 'connection-2',
    })).toBe(false);
    expect(isCanonicalChannelStateRecordIdentity({
      rowId: 'binding-1',
      recordKind: 'binding',
      bindingId: 'binding-1',
    })).toBe(true);
    expect(isCanonicalChannelStateRecordIdentity({
      rowId: 'binding-row-2',
      recordKind: 'binding',
      bindingId: 'binding-2',
    })).toBe(false);
    expect(isCanonicalChannelStateRecordIdentity({
      rowId: '🦊',
      recordKind: 'connection',
      connectionId: '🦊',
    })).toBe(false);
    expect(isCanonicalChannelStateRecordIdentity({
      rowId: 'rotation-1',
      recordKind: 'session-rotation',
      bindingId: 'binding-1',
      commandOccurrenceId: 'telegram-update-9001',
      creationKey: 'channel-new:wrong',
    })).toBe(false);
    expect(isCanonicalChannelStateRecordIdentity({
      rowId: 'rotation-1',
      recordKind: 'session-rotation',
      bindingId: 'binding-1',
      commandOccurrenceId: 'telegram-update-9001',
      creationKey: 'channel-new:binding-1:telegram-update-9001',
    })).toBe(true);
    expect(isCanonicalChannelStateRecordIdentity({
      rowId: 'C'.repeat(43),
      recordKind: 'ingress-obligation',
      ingressTargetKind: 'session',
      sessionIdempotencyKey: 'not-the-derived-key',
    })).toBe(false);
    expect(isCanonicalChannelStateRecordIdentity({
      rowId: 'C'.repeat(43),
      recordKind: 'ingress-obligation',
      ingressTargetKind: 'session',
      sessionIdempotencyKey: `channels:input:v1:${'C'.repeat(43)}`,
    })).toBe(true);
    expect(isCanonicalChannelStateRecordIdentity({
      rowId: 'C'.repeat(43),
      recordKind: 'ingress-obligation',
      ingressTargetKind: 'automation',
    })).toBe(true);
  });
});

describe('Channel Collection currentness witnesses', () => {
  type SchemaNode = Readonly<Record<string, unknown>>;

  function collectIntegerBounds(
    node: unknown,
    propertyName: string | null,
    found: Map<string, Set<unknown>>,
  ): void {
    if (Array.isArray(node)) {
      for (const entry of node) collectIntegerBounds(entry, propertyName, found);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const schema = node as SchemaNode;
    if (propertyName !== null && schema['type'] === 'integer') {
      const bounds = found.get(propertyName) ?? new Set<unknown>();
      bounds.add(schema['maximum']);
      found.set(propertyName, bounds);
    }
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties') {
        for (const [child, childSchema] of Object.entries(value as SchemaNode)) {
          collectIntegerBounds(childSchema, child, found);
        }
        continue;
      }
      const inherits = key === 'anyOf' || key === 'oneOf' || key === 'allOf' || key === 'items';
      collectIntegerBounds(value, inherits ? propertyName : null, found);
    }
  }

  // The static declarations are what a host installs and validates rows
  // against, so the shipped contract is measured rather than a local schema.
  function persistedBounds(): Map<string, Set<unknown>> {
    const found = new Map<string, Set<unknown>>();
    for (const collection of CHANNEL_ACCOUNT_COLLECTION_DECLARATIONS) {
      collectIntegerBounds(collection.schema, null, found);
    }
    collectIntegerBounds(CHANNEL_STATE_COLLECTION.schema, null, found);
    collectIntegerBounds(CHANNEL_DELIVERIES_COLLECTION.schema, null, found);
    return found;
  }

  it('bounds every retained Collection row revision witness by the Collection column ceiling', () => {
    const found = persistedBounds();
    // Named explicitly: a witness that silently disappeared from the persisted
    // contract would otherwise make this assertion vacuous.
    for (const witness of ['connectionRevision', 'bindingRevision']) {
      expect({ [witness]: [...(found.get(witness) ?? [])] })
        .toEqual({ [witness]: [PLUGIN_COLLECTION_REVISION_MAX] });
    }
  });

  it('keeps Channels-owned authority epochs and payload counters on the wider bound', () => {
    const found = persistedBounds();
    // `revision` here is the Channels-owned checkpoint/frontier/rotation
    // counter this plugin advances itself, not a Collection row revision.
    for (const counter of [
      'authorityEpoch',
      'connectionAuthorityEpoch',
      'bindingAuthorityEpoch',
      'revision',
    ]) {
      expect({ [counter]: [...(found.get(counter) ?? [])] })
        .toEqual({ [counter]: [Number.MAX_SAFE_INTEGER] });
    }
  });
});
