import { describe, expect, it } from 'vitest';
import {
  PluginMachineExecutionOriginV1JsonSchema,
} from '@happier-dev/plugin-sdk/collections';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { PluginContributionIdentityV1JsonSchema } from '@happier-dev/plugin-sdk/manifest';
import { PluginWebhookEndpointIdV1JsonSchema } from '@happier-dev/plugin-sdk/webhooks';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
  ConversationBindingTargetV1JsonSchema,
  ConversationNormalizedIngressV1JsonSchema,
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

/**
 * The shipped static declarations and their executable half, both projected by
 * the one `definePlugin` owner. Asserting them here rather than a package-local
 * pre-projection is what keeps this file measuring what a host installs.
 */
const CHANNEL_ACCOUNT_COLLECTION_DECLARATIONS =
  PLUGIN_MANIFEST.contributes?.accountCollections ?? [];
const CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS = collectionMigrations;

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
      PluginMachineExecutionOriginV1JsonSchema,
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
    expect(censusPayload?.properties?.normalizedIngress)
      .toBe(ConversationNormalizedIngressV1JsonSchema);
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

  it('declares the V2 census conflict pair and pure V1 migration beside the immutable V2 index', () => {
    const censusPayload = findChannelStateRecordPayload(
      CHANNEL_STATE_RECORD_KIND.ingressCensus,
    );
    const migration = CHANNEL_ACCOUNT_COLLECTION_MIGRATIONS['channel-state']?.[0];
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

    expect(CHANNEL_STATE_COLLECTION.schemaVersion).toBe(2);
    expect(CHANNEL_STATE_COLLECTION.readableSchemaVersions).toEqual([1]);
    expect(JSON.parse(JSON.stringify(CHANNEL_ACCOUNT_COLLECTION_DECLARATIONS)))
      .toEqual(CHANNEL_ACCOUNT_COLLECTION_DECLARATIONS);
    expect(staticDeclaration?.migrations).toEqual([{
      id: 'channel-state-v1-to-v2',
      fromSchemaVersion: 1,
      toSchemaVersion: 2,
    }]);
    expect(staticDeclaration).not.toHaveProperty('migrations.0.migrate');
    expect(censusPayload?.required).toContain('conflict');
    expect(migration).toMatchObject({
      id: 'channel-state-v1-to-v2',
      fromSchemaVersion: 1,
      toSchemaVersion: 2,
    });
    expect(migration?.migrate(source)).toEqual({
      ...source,
      attention: false,
      payload: { ...source.payload, conflict: null },
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

  it('declares exact generic indexed-prefix quotas for live connection and binding rows', () => {
    expect(CHANNEL_STATE_COLLECTION.quota).toEqual({
      maxRowEncodedBytes: 256 * 1024,
      maxRowsByIndexPrefix: [
        {
          indexId: CHANNEL_STATE_INDEX_ID.byKind,
          prefix: [CHANNEL_STATE_RECORD_KIND.connection],
          maxRows: 32,
        },
        {
          indexId: CHANNEL_STATE_INDEX_ID.byKind,
          prefix: [CHANNEL_STATE_RECORD_KIND.binding],
          maxRows: 256,
        },
      ],
    });
  });

  it('declares a 512 KiB delivery row quota without widening Channel state rows', () => {
    expect(CHANNEL_DELIVERIES_COLLECTION.quota).toEqual({
      maxRowEncodedBytes: 512 * 1024,
    });
    expect(CHANNEL_STATE_COLLECTION.quota?.maxRowEncodedBytes).toBe(256 * 1024);
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
    const frozenSlot = pendingOldTransportStop?.anyOf?.find((branch) => branch.type === 'object');
    expect(frozenSlot).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'predecessorCheckpointedPollInvocation',
        'transportOrigin',
        'providerContributionSelection',
        'stopRequest',
        'overlapSafety',
        'acceptedPossibleLoss',
      ],
    });
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

  it('persists the one strict bounded poll-failure union on connection rows', () => {
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
        attemptCount: { type: 'integer', minimum: 1, maximum: 4 },
        retryNotBeforeMs: { type: 'integer', minimum: 0, maximum: 9_007_199_254_740_991 },
        required: ['phase', 'attemptCount', 'retryNotBeforeMs', 'evidence'],
        additionalProperties: false,
      },
      {
        phase: 'blocked',
        attemptCount: { type: 'integer', minimum: 1, maximum: 5 },
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

  it('declares closed frozen session and Automation target branches for ingress obligations', () => {
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
          'newSession',
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
          'templateVersion',
          'occurrenceKey',
          'resultDelivery',
        ],
        required: ['kind', 'automationId', 'templateVersion', 'occurrenceKey', 'resultDelivery'],
        additionalProperties: false,
      },
    ]);
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
