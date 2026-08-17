import { readFile } from 'node:fs/promises';

import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
  parsePluginManifest,
  type PluginManifest,
} from '@happier-dev/plugin-sdk/manifest';
import {
  decodeTargetedContributionPointSemantics,
  readTargetedContributionPointSemanticRefs,
} from '@happier-dev/plugin-sdk/host/targeted-contributions';
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1,
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1,
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  MAX_CONVERSATION_DELIVERY_ATTEMPTS,
  MAX_CONVERSATION_DELIVERY_CHUNKS,
  MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES,
} from '@happier-dev/channels-protocol/v1';

import {
  CHANNEL_DELIVERIES_COLLECTION_ID,
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_DELIVERIES_FIELD,
  CHANNEL_DELIVERIES_INDEX_ID,
  CHANNEL_DELIVERIES_RECORD_KIND,
  CHANNEL_STATE_COLLECTION_ID,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_FIXED_ROW_ID,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { CONVERSATION_DELIVERY_CUSTODY_STATES } from './deliveryCustody.js';
import {
  CHANNELS_PLUGIN_ID,
  CHANNELS_PROVIDER_POINT_ID,
  CHANNELS_PROVIDER_POINT_REF,
  PLUGIN_MANIFEST,
} from './manifest.js';
import {
  createCurrentConversationConnectionFixture,
  createCurrentConversationPendingOldTransportStopFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';

function firstNonJsonPath(value: unknown, path = '$'): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : path;
  if (typeof value !== 'object') return path;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const invalidPath = firstNonJsonPath(entry, `${path}[${index}]`);
      if (invalidPath !== null) return invalidPath;
    }
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return path;
  if (Object.getOwnPropertySymbols(value).length > 0) return path;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return `${path}.${key}`;
    const invalidPath = firstNonJsonPath(descriptor.value, `${path}.${key}`);
    if (invalidPath !== null) return invalidPath;
  }
  return null;
}

const PRIVATE_PROTOCOL_PACKAGE = ['@happier-dev', 'protocol'].join('/');

const C1_PUBLIC_BOUNDARY_SOURCE_FILES = [
  'activate.ts',
  'activate.test.ts',
  'collections.ts',
  'manifest.ts',
  'manifest.test.ts',
  'reconciliation.ts',
] as const;

describe('Channels core manifest', () => {
  it('keeps the C1 implementation and verification boundary on public SDK seams', async () => {
    const sources = await Promise.all(C1_PUBLIC_BOUNDARY_SOURCE_FILES.map(
      async (path) => await readFile(new URL(`./${path}`, import.meta.url), 'utf8'),
    ));
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Readonly<{
      dependencies?: Readonly<Record<string, string>>;
      devDependencies?: Readonly<Record<string, string>>;
    }>;

    for (const source of sources) {
      expect(source).not.toContain(PRIVATE_PROTOCOL_PACKAGE);
    }
    expect(packageJson.dependencies?.[PRIVATE_PROTOCOL_PACKAGE]).toBeUndefined();
    expect(packageJson.devDependencies?.[PRIVATE_PROTOCOL_PACKAGE]).toBeUndefined();
  });

  it('emits its manifest declaration through the public SDK manifest type', async () => {
    const declaration = await readFile(new URL('../dist/manifest.d.ts', import.meta.url), 'utf8');

    expect(declaration).toContain(
      "import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';",
    );
    expect(declaration).toMatch(/export declare const PLUGIN_MANIFEST: PluginManifest;/u);
    expect(declaration).not.toContain(PRIVATE_PROTOCOL_PACKAGE);
  });

  it('passes canonical manifest ingestion with the complete Channels surface', () => {
    expect(firstNonJsonPath(PLUGIN_MANIFEST)).toBeNull();
    const serializedManifest = JSON.parse(JSON.stringify(PLUGIN_MANIFEST));

    expect(serializedManifest).toEqual(PLUGIN_MANIFEST);
    const parsed = parsePluginManifest(serializedManifest);
    if (!parsed.ok) {
      throw new Error([
        ...parsed.diagnostics.map((diagnostic) => diagnostic.message),
        `first non-JSON value: ${firstNonJsonPath(PLUGIN_MANIFEST) ?? 'none'}`,
      ].join('; '));
    }

    expect(parsed.manifest.id).toBe(CHANNELS_PLUGIN_ID);
  });

  it('declares and observes the one Channels-owned provider contribution point', () => {
    const point = PLUGIN_MANIFEST.contributes?.pluginContributionPoints?.[0];

    expect(PLUGIN_MANIFEST.contributes?.pluginContributionPoints).toHaveLength(1);
    expect(readTargetedContributionPointSemanticRefs(PLUGIN_MANIFEST)[0])
      .toBe(CHANNELS_PROVIDER_POINT_REF);
    expect(point).toMatchObject({
      id: CHANNELS_PROVIDER_POINT_ID,
      maxContributionsPerContributor: 1,
      protocols: [{
        id: CHANNELS_PROVIDER_POINT_REF.protocol.id,
        version: CHANNELS_PROVIDER_POINT_REF.protocol.version,
      }],
    });
    expect(CHANNELS_PROVIDER_POINT_REF).toEqual({
      targetPluginId: CHANNELS_PLUGIN_ID,
      id: CHANNELS_PROVIDER_POINT_ID,
      protocol: {
        id: point?.protocols[0]?.id,
        version: point?.protocols[0]?.version,
      },
    });
    const operations = Object.keys(point?.protocols[0]?.operations ?? {})
      .sort()
      .map((role) => ({ role }));
    expect(decodeTargetedContributionPointSemantics(CHANNELS_PROVIDER_POINT_REF, {
      protocol: CHANNELS_PROVIDER_POINT_REF.protocol,
      operations,
      surfaces: [],
    })).toEqual({
      ok: true,
      projection: {
        operations: operations.map(({ role }) => expect.objectContaining({ role })),
        surfaces: [],
      },
    });
  });

  it('declares the one core-owned retained outward-delivery supervisor', () => {
    expect(PLUGIN_MANIFEST.contributes?.backgroundServices).toEqual([
      {
        id: 'ingress-supervisor',
        title: 'Conversation ingress supervisor',
      },
      {
        id: 'outward-delivery-supervisor',
        title: 'Conversation outward delivery supervisor',
      },
    ]);
  });

  it('projects one Resource-driven native settings page through the generic settings catalog', () => {
    const ui = PLUGIN_MANIFEST.contributes?.ui;

    expect(ui).toMatchObject({
      views: [],
      renderers: [{
        id: 'channels-renderer',
        kind: 'reactNative',
        artifact: 'channels-app-native',
        requiredHostMethods: [],
      }],
      settingsGroups: [{
        id: 'channels',
        title: { key: 'plugins.channels.title', fallback: 'Conversation Channels' },
        icon: 'settings',
      }],
      settingsPages: [{
        id: 'connections',
        group: { kind: 'plugin', localId: 'channels' },
        title: { key: 'plugins.channels.settings.connections', fallback: 'Connections' },
        renderer: 'channels-renderer',
      }],
    });
    expect(ui?.translations[0]?.messages).toMatchObject({
      'plugins.channels.surface.saved': 'Saved to your Account. The selected machine will reconcile this policy when it is available.',
      'plugins.channels.surface.stopPending': 'Stop reconciliation pending',
      'plugins.channels.surface.providerFallback': 'Integration provider',
      'plugins.channels.surface.transportCheckpointedPull': 'Checkpointed pull',
      'plugins.channels.surface.selectedMachineSummary': 'Runs on your selected machine',
      'plugins.channels.surface.currentPolicy': 'Current connection policy',
      'plugins.channels.surface.technicalDetails': 'Technical details',
      'plugins.channels.surface.maximumObservationAgeDescription': 'Accept incoming observations no older than this limit.',
      'plugins.channels.surface.maximumObservationAgeInput': 'Maximum observation age in milliseconds',
      'plugins.channels.surface.minute': 'minute',
      'plugins.channels.surface.days': 'days',
    });
    expect(ui?.translations[0]?.messages).not.toHaveProperty('plugins.channels.surface.backToConnections');
  });

  it('declares the Account storage access its C1 reconciliation readers consume', () => {
    const manifest: PluginManifest = PLUGIN_MANIFEST;
    const collections = manifest.contributes?.accountCollections ?? [];

    expect(PLUGIN_MANIFEST.id).toBe('happier.channels');
    expect(manifest.hostAccess).toEqual({
      required: [{
        id: 'account-storage',
        capability: 'storage.account',
        reason: 'Read current Channel connection and binding state.',
        scope: { enabled: true },
      }],
      optional: [],
    });
    expect(collections).toHaveLength(2);
    expect(collections?.map(({ id }) => id)).toEqual([
      CHANNEL_STATE_COLLECTION_ID,
      CHANNEL_DELIVERIES_COLLECTION_ID,
    ]);
    expect(collections?.find(({ id }) => id === CHANNEL_STATE_COLLECTION_ID)).toMatchObject({
      id: CHANNEL_STATE_COLLECTION_ID,
      schemaVersion: 2,
      readableSchemaVersions: [1],
      migrations: [{
        id: 'channel-state-v1-to-v2',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
      }],
      rowIdField: CHANNEL_STATE_FIELD.id,
      serverReadable: [
        CHANNEL_STATE_FIELD.recordKind,
        CHANNEL_STATE_FIELD.version,
        CHANNEL_STATE_FIELD.connectionId,
        CHANNEL_STATE_FIELD.bindingId,
        CHANNEL_STATE_FIELD.terminal,
        CHANNEL_STATE_FIELD.attention,
        CHANNEL_STATE_FIELD.dueAt,
        CHANNEL_STATE_FIELD.createdAt,
        CHANNEL_STATE_FIELD.updatedAt,
      ],
      indexes: [
        {
          id: CHANNEL_STATE_INDEX_ID.byKind,
          fields: [
            { field: CHANNEL_STATE_FIELD.recordKind, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.id, direction: 'asc' },
          ],
        },
        {
          id: CHANNEL_STATE_INDEX_ID.byConnectionBinding,
          fields: [
            { field: CHANNEL_STATE_FIELD.connectionId, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.bindingId, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.id, direction: 'asc' },
          ],
        },
        {
          id: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
          fields: [
            { field: CHANNEL_STATE_FIELD.connectionId, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.bindingId, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.recordKind, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.attention, direction: 'asc' },
          ],
        },
        {
          id: CHANNEL_STATE_INDEX_ID.byAttention,
          fields: [
            { field: CHANNEL_STATE_FIELD.attention, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.updatedAt, direction: 'desc' },
            { field: CHANNEL_STATE_FIELD.id, direction: 'asc' },
          ],
        },
        {
          id: CHANNEL_STATE_INDEX_ID.byIngressDue,
          fields: [
            { field: CHANNEL_STATE_FIELD.recordKind, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.dueAt, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.id, direction: 'asc' },
          ],
        },
      ],
      quota: {
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
      },
      uiQueries: [],
      relations: [],
    });

    expect(collections?.find(({ id }) => id === CHANNEL_DELIVERIES_COLLECTION_ID)).toMatchObject({
      id: CHANNEL_DELIVERIES_COLLECTION_ID,
      schemaVersion: 1,
      rowIdField: CHANNEL_DELIVERIES_FIELD.id,
      serverReadable: [
        CHANNEL_DELIVERIES_FIELD.recordKind,
        CHANNEL_DELIVERIES_FIELD.version,
        CHANNEL_DELIVERIES_FIELD.connectionId,
        CHANNEL_DELIVERIES_FIELD.bindingId,
        CHANNEL_DELIVERIES_FIELD.terminal,
        CHANNEL_DELIVERIES_FIELD.attention,
        CHANNEL_DELIVERIES_FIELD.retryNotBefore,
        CHANNEL_DELIVERIES_FIELD.createdAt,
        CHANNEL_DELIVERIES_FIELD.updatedAt,
      ],
      indexes: [
        {
          id: CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention,
          fields: [
            { field: CHANNEL_DELIVERIES_FIELD.connectionId, direction: 'asc' },
            { field: CHANNEL_DELIVERIES_FIELD.bindingId, direction: 'asc' },
            { field: CHANNEL_DELIVERIES_FIELD.attention, direction: 'asc' },
            { field: CHANNEL_DELIVERIES_FIELD.id, direction: 'asc' },
          ],
        },
        {
          id: CHANNEL_DELIVERIES_INDEX_ID.byRetryDue,
          fields: [
            { field: CHANNEL_DELIVERIES_FIELD.terminal, direction: 'asc' },
            { field: CHANNEL_DELIVERIES_FIELD.retryNotBefore, direction: 'asc' },
            { field: CHANNEL_DELIVERIES_FIELD.id, direction: 'asc' },
          ],
        },
      ],
      quota: { maxRowEncodedBytes: 512 * 1024 },
      uiQueries: [],
      relations: [],
    });
    expect(collections?.[0]?.id).not.toMatch(/[A-Z]/u);
    expect(collections?.[0]?.serverReadable).not.toContain('recordKind');
    expect([
      CHANNEL_STATE_COLLECTION_ID,
      ...Object.values(CHANNEL_STATE_FIELD),
      ...Object.values(CHANNEL_STATE_INDEX_ID),
      ...Object.values(CHANNEL_STATE_RECORD_KIND),
    ].every((id) => /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/u.test(id))).toBe(true);
    expect(collections?.[0]?.schema).toMatchObject({
      properties: {
        [CHANNEL_STATE_FIELD.recordKind]: {
          enum: Object.values(CHANNEL_STATE_RECORD_KIND),
        },
      },
    });
    expect(manifest.contributes?.actions).toEqual([
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionPairingCreate,
        title: 'Create conversation pairing challenge',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Create conversation pairing challenge?',
          body: 'This creates a short-lived pairing challenge for the selected connection.',
          confirmLabel: 'Create challenge',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionPairingFinalize,
        title: 'Finalize conversation pairing',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Finalize conversation pairing?',
          body: 'This saves the authenticated pairing proposal as a paused conversation binding.',
          confirmLabel: 'Finalize pairing',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCancel,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionPairingCancel,
        title: 'Cancel conversation pairing',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['secondary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Cancel conversation pairing?',
          body: 'This cancels the selected unfinished pairing challenge or proposal.',
          confirmLabel: 'Cancel pairing',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionCreate,
        title: 'Create conversation connection',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Create conversation connection?',
          body: 'This saves the connection and its current transport configuration to this Happier Account.',
          confirmLabel: 'Create connection',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionTransfer,
        title: 'Transfer conversation connection',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Transfer conversation connection?',
          body: 'This replaces the saved provider setup and transport while retaining exact old-stop custody.',
          confirmLabel: 'Transfer connection',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionPrepare,
        title: 'Prepare conversation connection',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'safe',
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionUpdate,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionUpdate,
        title: 'Update conversation connection',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Update conversation connection?',
          body: 'This saves the edited connection policy to this Happier Account.',
          confirmLabel: 'Update connection',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionSetEnabled,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionSetEnabled,
        title: 'Set conversation connection enabled state',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Change conversation connection enabled state?',
          body: 'This changes whether the connection may accept or deliver under its saved Account policy.',
          confirmLabel: 'Save connection state',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionDelete,
        title: 'Delete conversation connection',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Delete conversation connection?',
          body: 'This disables the connection and waits for exact transport-stop proof before cleanup.',
          confirmLabel: 'Delete connection',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionAbandon,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionAbandon,
        title: 'Abandon pending conversation connection stop',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['secondary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Accept possible message loss?',
          body: 'This permits the connection lifecycle to continue without claiming the old physical transport stopped.',
          confirmLabel: 'Accept possible loss',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamBaselineAccept,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.streamBaselineAccept,
        title: 'Accept conversation history baseline',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Accept a new conversation history baseline?',
          body: 'This accepts the provider’s current replay baseline and resumes the saved connection without replaying unavailable history.',
          confirmLabel: 'Accept baseline',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPollRetry,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionPollRetry,
        title: 'Retry blocked conversation poll',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Retry this blocked conversation poll?',
          body: 'This clears the saved blocked poll state so the current connection can retry it.',
          confirmLabel: 'Retry poll',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingRead,
        title: 'Read conversation binding',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['secondary'],
        dangerLevel: 'safe',
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingResolve,
        title: 'Resolve conversation binding candidates',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['secondary'],
        dangerLevel: 'safe',
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingCreate,
        title: 'Create conversation binding',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Create conversation binding?',
          body: 'This saves the external conversation binding and its target policy to this Happier Account.',
          confirmLabel: 'Create binding',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingUpdate,
        title: 'Update conversation binding',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Update conversation binding?',
          body: 'This saves the edited external conversation binding policy to this Happier Account.',
          confirmLabel: 'Update binding',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingSetEnabled,
        title: 'Set conversation binding enabled state',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Change conversation binding enabled state?',
          body: 'This changes whether the binding may route eligible external messages to its saved target.',
          confirmLabel: 'Save binding state',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingDelete,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingDelete,
        title: 'Delete conversation binding',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Delete conversation binding?',
          body: 'This immediately disables new binding effects while retained ingress and delivery custody finish safely.',
          confirmLabel: 'Delete binding',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingTargetRotate,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingTargetRotate,
        title: 'Rotate conversation binding target',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Rotate conversation binding target?',
          body: 'This changes the external conversation target and verifies the current Automation template when applicable.',
          confirmLabel: 'Rotate target',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.ingressRetry,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.ingressRetry,
        title: 'Retry blocked conversation ingress',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Retry this blocked conversation input?',
          body: 'This re-enables the same frozen admission request for bounded retry.',
          confirmLabel: 'Retry input',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryResolve,
        ...CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.deliveryResolve,
        title: 'Resolve ambiguous conversation delivery',
        scopes: ['global'],
        surfaces: ['cli', 'ui'],
        placementBindings: ['primary'],
        dangerLevel: 'writesLocal',
        confirmation: {
          title: 'Record this delivery decision?',
          body: 'This records whether you accept or discard the current delivery outcome. It does not resend the message.',
          confirmLabel: 'Record decision',
        },
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest,
        ...CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1.observationIngest,
        title: 'Ingest authenticated provider observation',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
        ...CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1.connectionsList,
        title: 'List current provider connections',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead,
        ...CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1.connectionRead,
        title: 'Read current provider connection',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.transportFactReport,
        ...CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1.transportFactReport,
        title: 'Report current transport fact',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'safe',
        hostAccess: ['account-storage'],
      },
      {
        id: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.automationResultDeliver,
        ...CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1.automationResultDeliver,
        title: 'Accept Automation result delivery custody',
        scopes: ['global'],
        surfaces: ['plugin'],
        dangerLevel: 'writesLocal',
        hostAccess: ['account-storage'],
      },
    ]);
    expect(manifest.contributes?.resources).toEqual([
      {
        id: 'connections-v1',
        source: 'dynamic',
        kind: 'config',
        contentType: 'application/json',
        maxBytes: 196_608,
        hostAccess: ['account-storage'],
      },
      {
        id: 'bindings-v1',
        source: 'dynamic',
        kind: 'config',
        contentType: 'application/json',
        maxBytes: 212_992,
        hostAccess: ['account-storage'],
      },
      {
        id: 'pairing-v1',
        source: 'dynamic',
        kind: 'config',
        contentType: 'application/json',
        maxBytes: 524_288,
        hostAccess: ['account-storage'],
      },
      {
        id: 'outward-delivery-activities-v1',
        source: 'dynamic',
        kind: 'config',
        scope: 'session',
        contentType: 'application/vnd.happier.transcript-activity+json;v=1',
        maxBytes: 65_536,
        hostAccess: ['account-storage'],
      },
    ]);
    expect(manifest.contributes?.transcriptActivities).toEqual([
      {
        id: 'outward-delivery',
        resourceId: 'outward-delivery-activities-v1',
        actions: [],
      },
    ]);
  });

  it('keeps the four C1 record kinds strict without admitting a generic details payload', () => {
    const validate = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    const credentialRef = {
      service: { pluginId: 'happier.channel.telegram', localId: 'telegram-bot' },
      accountId: 'account-1',
    } as const;
    const connectionAuthority = {
      providerPluginId: 'happier.channel.telegram',
      providerContributionSelection: {
        contributionId: 'telegram-schema-provider',
        immutableGenerationId: 'telegram-schema-generation',
      },
      providerSetupInput: { source: 'manifest-schema' },
      credentialRef: null,
      transportOrigin: {
        serverIdentityId: 'srv_account_one',
        materializationRef: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.channels',
        },
      },
      providerConnectionKey: 'provider-connection-1',
      providerConfig: { opaqueProviderFact: 'kept-private' },
      routingIdentityKey: 'A'.repeat(43),
      integrationPrincipal: { id: 'principal-1' },
      authorityEpoch: 1,
    } as const satisfies ConversationConnectionFixtureAuthority;
    const connectionFixture = (authority: ConversationConnectionFixtureAuthority) => (
      createCurrentConversationConnectionFixture({
        connectionId: 'connection-1',
        authority,
        transport: { kind: 'checkpointedPull' },
        overlapSafety: 'safe',
        replayContinuity: 'checkpointed',
        outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
        pairingDeepLinkTemplate: 'https://t.me/happier_bot?start={{token}}',
      })
    );
    const connection = connectionFixture(connectionAuthority);

    expect(isValidPluginJsonSchemaValue(validate, connection)).toBe(true);
    const { outboundTextLimit: _outboundTextLimit, ...connectionWithoutOutboundTextLimit } = connection.payload;
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connection,
      payload: connectionWithoutOutboundTextLimit,
    })).toBe(false);
    for (const providerPluginId of [
      'telegram',
      'Happier.channel.telegram',
      'happier.channel telegram',
      'happier.__proto__',
      ' happier.channel.telegram ',
    ]) {
      expect(isValidPluginJsonSchemaValue(validate, {
        ...connection,
        payload: { ...connection.payload, providerPluginId },
      })).toBe(false);
    }
    const connectionWithCredential = connectionFixture({
      ...connectionAuthority,
      credentialRef,
    });
    expect(isValidPluginJsonSchemaValue(validate, connectionWithCredential)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connectionWithCredential,
      payload: {
        ...connectionWithCredential.payload,
        credentialRef: {
          ...credentialRef,
          service: { ...credentialRef.service, localId: 'Telegram-bot' },
        },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connectionWithCredential,
      payload: {
        ...connectionWithCredential.payload,
        credentialRef: {
          ...connectionWithCredential.payload.credentialRef,
          service: { ...connectionWithCredential.payload.credentialRef.service, localId: 'telegram bot' },
        },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connectionWithCredential,
      payload: {
        ...connectionWithCredential.payload,
        credentialRef: { ...connectionWithCredential.payload.credentialRef, accountId: 'a'.repeat(257) },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connectionWithCredential,
      payload: {
        ...connectionWithCredential.payload,
        credentialRef: { service: { localId: 'telegram-bot' }, accountId: 'account-1' },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connection,
      payload: {
        ...connection.payload,
        historyGap: {
          reportedAt: 2,
          reason: 'providerHistoryUnavailable',
        },
      },
    })).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connection,
      payload: {
        ...connection.payload,
        historyGap: {
          reportedAt: 2,
          reason: 'providerSessionExpired',
        },
      },
    })).toBe(false);
    // The static schema validates the relation-ID grammar; the canonical
    // correspondence validator owns equality with the sibling connection ID.
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connection,
      [CHANNEL_STATE_FIELD.id]: CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey,
    })).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connection,
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.binding,
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connection,
      payload: { ...connection.payload, details: {} },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connection,
      [CHANNEL_STATE_FIELD.attention]: true,
    })).toBe(false);
  });

  it('keeps the reservation identity HMAC key distinct from a connection routing key', () => {
    const validate = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    const identityKey = {
      [CHANNEL_STATE_FIELD.id]: CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey,
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.connectionIdentityKey,
      [CHANNEL_STATE_FIELD.version]: 1,
      [CHANNEL_STATE_FIELD.createdAt]: 1,
      [CHANNEL_STATE_FIELD.updatedAt]: 1,
      payload: { connectionIdentityKey: 'B'.repeat(43) },
    };

    expect(isValidPluginJsonSchemaValue(validate, identityKey)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...identityKey,
      payload: { routingIdentityKey: 'B'.repeat(43) },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...identityKey,
      [CHANNEL_STATE_FIELD.id]: 'another-identity-key',
    })).toBe(false);
  });

  it('requires the C1 owner relations on binding and reservation records', () => {
    const validate = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    const binding = {
      [CHANNEL_STATE_FIELD.id]: 'binding-1',
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.binding,
      [CHANNEL_STATE_FIELD.version]: 1,
      [CHANNEL_STATE_FIELD.connectionId]: 'connection-1',
      [CHANNEL_STATE_FIELD.bindingId]: 'binding-1',
      [CHANNEL_STATE_FIELD.createdAt]: 1,
      [CHANNEL_STATE_FIELD.updatedAt]: 1,
      payload: {
        endpoint: { kind: 'direct', audience: 'direct', id: 'endpoint-1' },
        target: {
          kind: 'session',
          sessionId: 'session-1',
          policy: {
            deliveryMode: 'repliesOnly',
            permissionCeiling: 'default',
            approvals: { kind: 'off' },
            newSession: { kind: 'off' },
          },
        },
        allowedPrincipalIds: ['principal-1'],
        allowBotSenders: false,
        inputMode: 'directMentionsOnly',
        inboundDebounceMs: 750,
        linkPreviewPolicy: 'suppress',
        senderFeedback: 'off',
        authorityEpoch: 1,
        enabled: true,
        deletionState: 'none',
      },
    };
    const reservation = {
      [CHANNEL_STATE_FIELD.id]: 'R'.repeat(43),
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.connectionReservation,
      [CHANNEL_STATE_FIELD.version]: 1,
      [CHANNEL_STATE_FIELD.connectionId]: 'connection-1',
      [CHANNEL_STATE_FIELD.createdAt]: 1,
      [CHANNEL_STATE_FIELD.updatedAt]: 1,
      payload: {
        providerPluginId: 'happier.channel.telegram',
        providerConnectionKey: 'provider-connection-1',
        integrationPrincipalId: 'principal-1',
      },
    };
    const { [CHANNEL_STATE_FIELD.connectionId]: _bindingConnectionId, ...bindingWithoutConnection } = binding;
    const { [CHANNEL_STATE_FIELD.bindingId]: _bindingId, ...bindingWithoutBindingId } = binding;
    const { [CHANNEL_STATE_FIELD.connectionId]: _reservationConnectionId, ...reservationWithoutConnection } = reservation;

    expect(isValidPluginJsonSchemaValue(validate, binding)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...binding,
      payload: {
        ...binding.payload,
        endpoint: { kind: 'direct', audience: 'shared', id: 'endpoint-1' },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...binding,
      payload: {
        ...binding.payload,
        endpoint: { kind: 'direct', id: 'endpoint-1' },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...binding,
      payload: {
        ...binding.payload,
        endpoint: { kind: 'thread', audience: 'direct', id: 'private-thread-1' },
      },
    })).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...binding,
      payload: {
        ...binding.payload,
        endpoint: { kind: 'thread', audience: 'shared', id: 'shared-thread-1' },
      },
    })).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...binding,
      payload: {
        ...binding.payload,
        endpoint: { kind: 'shared', audience: 'direct', id: 'shared-1' },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, reservation)).toBe(true);
    for (const providerPluginId of [
      'telegram',
      'Happier.channel.telegram',
      'happier.channel telegram',
      'happier.__proto__',
      ' happier.channel.telegram ',
    ]) {
      expect(isValidPluginJsonSchemaValue(validate, {
        ...reservation,
        payload: { ...reservation.payload, providerPluginId },
      })).toBe(false);
    }
    // Binding row-ID equality is a writer-time correspondence, not a JSON
    // Schema comparison; this remains grammatically valid at the static seam.
    expect(isValidPluginJsonSchemaValue(validate, {
      ...binding,
      [CHANNEL_STATE_FIELD.id]: CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey,
    })).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...reservation,
      [CHANNEL_STATE_FIELD.id]: CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey,
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...reservation,
      [CHANNEL_STATE_FIELD.id]: 'reservation-1',
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, bindingWithoutConnection)).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, bindingWithoutBindingId)).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, reservationWithoutConnection)).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...binding,
      [CHANNEL_STATE_FIELD.connectionId]: 'x'.repeat(96),
      [CHANNEL_STATE_FIELD.bindingId]: 'x'.repeat(96),
    })).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...binding,
      [CHANNEL_STATE_FIELD.connectionId]: 'x'.repeat(97),
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...binding,
      [CHANNEL_STATE_FIELD.bindingId]: '🦊'.repeat(25),
    })).toBe(false);
  });

  it('owns C3/C4 ingress, checkpoint, frontier, and rotation state in the same strict collection', () => {
    const validate = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    const ingress = {
      [CHANNEL_STATE_FIELD.id]: 'C'.repeat(43),
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.ingressObligation,
      [CHANNEL_STATE_FIELD.version]: 1,
      [CHANNEL_STATE_FIELD.connectionId]: 'connection-1',
      [CHANNEL_STATE_FIELD.bindingId]: 'binding-1',
      [CHANNEL_STATE_FIELD.terminal]: false,
      [CHANNEL_STATE_FIELD.attention]: false,
      [CHANNEL_STATE_FIELD.dueAt]: 1,
      [CHANNEL_STATE_FIELD.createdAt]: 1,
      [CHANNEL_STATE_FIELD.updatedAt]: 1,
      payload: {
        occurrenceIds: ['occurrence-1'],
        target: {
          kind: 'session',
          sessionId: 'session-1',
          idempotencyKey: `channels:input:v1:${'C'.repeat(43)}`,
          requestedPermissionCeiling: 'default',
        },
        censusId: 'D'.repeat(43),
        sourceAuthority: {
          connectionAuthorityEpoch: 1,
          bindingRevision: 1,
          bindingAuthorityEpoch: 1,
        },
        lifecycle: { phase: 'ready', attemptCount: 0, dueAt: 1 },
        disposition: null,
        nonAdmission: null,
      },
    };
    const checkpoint = {
      [CHANNEL_STATE_FIELD.id]: 'checkpoint-1',
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.checkpoint,
      [CHANNEL_STATE_FIELD.version]: 1,
      [CHANNEL_STATE_FIELD.connectionId]: 'connection-1',
      [CHANNEL_STATE_FIELD.createdAt]: 1,
      [CHANNEL_STATE_FIELD.updatedAt]: 1,
      payload: {
        authorityEpoch: 1,
        opaqueToken: { offset: 1 },
        lastOccurrenceId: 'occurrence-1',
        revision: 1,
        nextPollNotBeforeMs: null,
      },
    };
    const ingressCensus = {
      [CHANNEL_STATE_FIELD.id]: 'D'.repeat(43),
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.ingressCensus,
      [CHANNEL_STATE_FIELD.version]: 1,
      [CHANNEL_STATE_FIELD.connectionId]: 'connection-1',
      [CHANNEL_STATE_FIELD.attention]: false,
      [CHANNEL_STATE_FIELD.createdAt]: 1,
      [CHANNEL_STATE_FIELD.updatedAt]: 1,
      payload: {
        normalizedIngress: {
          kind: 'fullText',
          observation: {
            v: 1,
            occurrenceId: 'occurrence-1',
            occurredAt: 1,
            transport: { kind: 'poll' },
            endpoint: {
              kind: 'direct',
              audience: 'direct',
              id: 'chat-1',
            },
            actor: {
              principalId: 'principal-1',
              kind: 'human',
              isIntegrationSelf: false,
            },
            message: {
              id: 'message-1',
              revision: '1',
              text: 'Investigate this.',
              addressingEvidence: 'none',
              contentProvenance: 'original',
              providerTimestamp: 1,
            },
          },
        },
        phase: 'prepared',
        connectionAuthorityEpoch: 1,
        maximumObservationAgeMs: 60_000,
        checkpointCoveredAt: null,
        conflict: null,
        matchedBindings: [
          { bindingId: 'binding-1', bindingRevision: 1, bindingAuthorityEpoch: 2 },
          { bindingId: 'binding-2', bindingRevision: 3, bindingAuthorityEpoch: 4 },
        ],
      },
    };
    const frontier = {
      [CHANNEL_STATE_FIELD.id]: 'frontier-1',
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.projectionFrontier,
      [CHANNEL_STATE_FIELD.version]: 1,
      [CHANNEL_STATE_FIELD.bindingId]: 'binding-1',
      [CHANNEL_STATE_FIELD.createdAt]: 1,
      [CHANNEL_STATE_FIELD.updatedAt]: 1,
      payload: {
        targetSessionId: 'session-1',
        transcriptCursor: { cursor: 'next' },
        lastScannedSeq: 1,
        revision: 1,
      },
    };
    const rotation = {
      [CHANNEL_STATE_FIELD.id]: 'rotation-1',
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.sessionRotation,
      [CHANNEL_STATE_FIELD.version]: 1,
      [CHANNEL_STATE_FIELD.bindingId]: 'binding-1',
      [CHANNEL_STATE_FIELD.createdAt]: 1,
      [CHANNEL_STATE_FIELD.updatedAt]: 1,
      payload: {
        commandOccurrenceId: 'telegram-update-9001',
        expectedOldSessionId: 'session-1',
        creationKey: 'channel-new:binding-1:telegram-update-9001',
        initialPromptIdempotencyKey: null,
        revision: 1,
      },
    };

    expect(Object.values(CHANNEL_STATE_RECORD_KIND)).toEqual([
      'connection',
      'binding',
      'connection-identity-key',
      'connection-reservation',
      'ingress-obligation',
      'ingress-census',
      'checkpoint',
      'projection-frontier',
      'session-rotation',
    ]);
    expect(isValidPluginJsonSchemaValue(validate, ingress)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, ingressCensus)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      payload: {
        ...ingressCensus.payload,
        matchedBindings: [{ bindingId: 'binding-1', bindingRevision: 1 }],
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      [CHANNEL_STATE_FIELD.terminal]: true,
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      [CHANNEL_STATE_FIELD.attention]: true,
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      [CHANNEL_STATE_FIELD.attention]: true,
      payload: {
        ...ingressCensus.payload,
        conflict: { kind: 'occurrenceEvidenceMismatch' },
      },
    })).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      payload: { ...ingressCensus.payload, phase: 'active' },
    })).toBe(false);
    const {
      maximumObservationAgeMs: _maximumObservationAgeMs,
      ...ingressCensusWithoutObservationAge
    } = ingressCensus.payload;
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      payload: ingressCensusWithoutObservationAge,
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      payload: { ...ingressCensus.payload, text: 'must not become a prompt store' },
    })).toBe(false);
    const { censusId: _censusId, ...ingressWithoutCensus } = ingress.payload;
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingress,
      payload: ingressWithoutCensus,
    })).toBe(false);
    const { occurredAt: _occurredAt, ...observationWithoutOccurredAt } = ingressCensus.payload.normalizedIngress.observation;
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      payload: {
        ...ingressCensus.payload,
        normalizedIngress: {
          ...ingressCensus.payload.normalizedIngress,
          observation: observationWithoutOccurredAt,
        },
      },
    })).toBe(false);
    const automationIngress = {
      ...ingress,
      payload: {
        ...ingress.payload,
        target: {
          kind: 'automation',
          automationId: 'automation-1',
          templateVersion: 3,
          occurrenceKey: 'automation-occurrence-1',
          resultDelivery: {
            kind: 'finalResult',
            actionRef: {
              pluginId: 'happier.channels',
              localId: 'automation/result-deliver-v1',
            },
            opaqueContext: {
              connectionId: 'connection-1',
              bindingId: 'binding-1',
              messageId: 'message-1',
            },
          },
        },
      },
    };
    expect(isValidPluginJsonSchemaValue(validate, automationIngress)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...automationIngress,
      payload: {
        ...automationIngress.payload,
        target: {
          ...automationIngress.payload.target,
          resultDelivery: { kind: 'none' },
        },
      },
    })).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...automationIngress,
      payload: {
        ...automationIngress.payload,
        target: {
          ...automationIngress.payload.target,
          resultDelivery: {
            ...automationIngress.payload.target.resultDelivery,
            actionRef: {
              pluginId: 'untrusted.provider',
              localId: 'automation/result-deliver-v1',
            },
          },
        },
      },
    })).toBe(false);
    const { resultDelivery: _resultDelivery, ...automationTargetWithoutDelivery } = automationIngress.payload.target;
    expect(isValidPluginJsonSchemaValue(validate, {
      ...automationIngress,
      payload: {
        ...automationIngress.payload,
        target: automationTargetWithoutDelivery,
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...automationIngress,
      payload: {
        ...automationIngress.payload,
        target: {
          ...automationIngress.payload.target,
          idempotencyKey: `channels:input:v1:${'C'.repeat(43)}`,
        },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingress,
      payload: {
        ...ingress.payload,
        target: {
          ...ingress.payload.target,
          occurrenceKey: 'automation-occurrence-1',
        },
      },
    })).toBe(false);
    const { [CHANNEL_STATE_FIELD.dueAt]: _activeDueAt, ...ingressWithoutDueAt } = ingress;
    const connectionDeletedIngress = {
      ...ingressWithoutDueAt,
      [CHANNEL_STATE_FIELD.terminal]: true,
      payload: {
        ...ingress.payload,
        lifecycle: { ...ingress.payload.lifecycle, phase: 'terminal', dueAt: null },
        disposition: 'connectionDeleted',
      },
    };
    expect(isValidPluginJsonSchemaValue(validate, connectionDeletedIngress)).toBe(true);
    const blockedIngress = {
      ...ingressWithoutDueAt,
      [CHANNEL_STATE_FIELD.attention]: true,
      payload: {
        ...ingress.payload,
        lifecycle: { phase: 'blocked', attemptCount: 5, dueAt: null },
      },
    };
    expect(isValidPluginJsonSchemaValue(validate, blockedIngress)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connectionDeletedIngress,
      [CHANNEL_STATE_FIELD.terminal]: false,
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, checkpoint)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, frontier)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, rotation)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingress,
      [CHANNEL_STATE_FIELD.terminal]: true,
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingress,
      payload: { ...ingress.payload, details: {} },
    })).toBe(false);
    const { [CHANNEL_STATE_FIELD.connectionId]: _connectionId, ...ingressWithoutConnection } = ingress;
    const { [CHANNEL_STATE_FIELD.bindingId]: _bindingId, ...frontierWithoutBinding } = frontier;
    expect(isValidPluginJsonSchemaValue(validate, ingressWithoutConnection)).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, frontierWithoutBinding)).toBe(false);
  });

  it('rejects C1 transport and delete-state combinations that would leave unsafe authority live', () => {
    const validate = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    const connectionAuthority = {
      providerPluginId: 'happier.channel.github',
      providerContributionSelection: {
        contributionId: 'github-schema-provider',
        immutableGenerationId: 'github-schema-generation',
      },
      providerSetupInput: { source: 'manifest-schema' },
      credentialRef: null,
      transportOrigin: {
        serverIdentityId: 'srv_account_one',
        materializationRef: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'happier.channels',
        },
      },
      providerConnectionKey: 'provider-connection-1',
      providerConfig: {},
      routingIdentityKey: 'A'.repeat(43),
      integrationPrincipal: { id: 'principal-1' },
      authorityEpoch: 1,
    } as const satisfies ConversationConnectionFixtureAuthority;
    const connection = createCurrentConversationConnectionFixture({
      connectionId: 'connection-1',
      authority: connectionAuthority,
      transport: {
        kind: 'durablePush',
        webhookContributionRef: {
          pluginId: 'happier.channel.github',
          localId: 'github-webhook',
        },
        webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA',
        webhookSourceInstanceId: 'source-1',
      },
      overlapSafety: 'destructive',
      replayContinuity: 'checkpointed',
      outboundTextLimit: { maximum: 4_096, unit: 'unicodeCodePoints' },
    });
    const pendingDeleteStop = createCurrentConversationPendingOldTransportStopFixture({
      connectionId: connection[CHANNEL_STATE_FIELD.connectionId],
      authority: connectionAuthority,
      predecessorCheckpointedPollInvocation: {
        connectionRevision: 1,
        authorityEpoch: connectionAuthority.authorityEpoch,
        transportOrigin: connectionAuthority.transportOrigin,
      },
      authorityEpoch: 1,
      reason: 'delete',
      overlapSafety: connection.payload.overlapSafety,
    });

    expect(isValidPluginJsonSchemaValue(validate, connection)).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connection,
      payload: {
        ...connection.payload,
        transport: { kind: 'checkpointedPull' },
        overlapSafety: 'safe',
        deletionState: 'pendingStopReconciliation',
        pendingOldTransportStop: pendingDeleteStop,
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connection,
      payload: {
        ...connection.payload,
        overlapSafety: 'safe',
        replayContinuity: 'checkpointed',
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connection,
      payload: {
        ...connection.payload,
        overlapSafety: 'safe',
        replayContinuity: 'none',
        enabled: false,
        deletionState: 'pendingStopReconciliation',
        pendingOldTransportStop: pendingDeleteStop,
      },
    })).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connection,
      payload: {
        ...connection.payload,
        overlapSafety: 'safe',
        replayContinuity: 'none',
        enabled: false,
        deletionState: 'pendingStopReconciliation',
        pendingOldTransportStop: pendingDeleteStop,
        historyGap: {
          reportedAt: 1,
          reason: 'providerHistoryUnavailable',
        },
      },
    })).toBe(false);

    const retainedAcceptedTransfer = {
      ...connection,
      payload: {
        ...connection.payload,
        transport: { kind: 'checkpointedPull' },
        overlapSafety: 'safe',
        replayContinuity: 'checkpointed',
        authorityEpoch: 2,
        pendingOldTransportStop: {
          ...pendingDeleteStop,
          stopRequest: {
            ...pendingDeleteStop.stopRequest,
            reason: 'transfer',
            authorityEpoch: 1,
          },
          acceptedPossibleLoss: true,
        },
      },
    };
    const roundTrippedAcceptedTransfer = JSON.parse(JSON.stringify(retainedAcceptedTransfer));
    expect(isValidPluginJsonSchemaValue(validate, roundTrippedAcceptedTransfer)).toBe(true);
    expect(roundTrippedAcceptedTransfer.payload.pendingOldTransportStop).toEqual(
      retainedAcceptedTransfer.payload.pendingOldTransportStop,
    );
  });

  it('retains archive-specific delivery recovery privately instead of flattening it into generic failure data', () => {
    const validate = compilePluginJsonSchema(CHANNEL_DELIVERIES_COLLECTION.schema);
    const archived = {
      [CHANNEL_DELIVERIES_FIELD.id]: 'D'.repeat(43),
      [CHANNEL_DELIVERIES_FIELD.recordKind]: CHANNEL_DELIVERIES_RECORD_KIND.outwardDelivery,
      [CHANNEL_DELIVERIES_FIELD.version]: 1,
      [CHANNEL_DELIVERIES_FIELD.connectionId]: 'connection-1',
      [CHANNEL_DELIVERIES_FIELD.bindingId]: 'binding-1',
      [CHANNEL_DELIVERIES_FIELD.terminal]: true,
      [CHANNEL_DELIVERIES_FIELD.attention]: true,
      [CHANNEL_DELIVERIES_FIELD.createdAt]: 1,
      [CHANNEL_DELIVERIES_FIELD.updatedAt]: 2,
      payload: {
        source: { kind: 'controlResponse', controlId: 'recovery-1', controlKind: 'recovery' },
        routeAuthority: {
          connectionAuthorityEpoch: 1,
          bindingRevision: 1,
          bindingAuthorityEpoch: 1,
        },
        endpoint: { kind: 'thread', audience: 'shared', id: 'thread-1', parentId: 'channel-1' },
        content: 'Please unarchive the thread before retrying.',
        deliveryKey: 'binding-1:recovery-1',
        replyContext: null,
        mentionPolicy: 'suppress',
        linkPreviewPolicy: 'suppress',
        state: 'notDelivered',
        attemptCount: 1,
        attemptId: null,
        startedAt: null,
        providerMessageIds: [],
        failedChunk: null,
        archiveRecovery: 'ownerMustUnarchiveOrRebind',
      },
    };

    expect(isValidPluginJsonSchemaValue(validate, archived)).toBe(true);
    const suppressed = {
      ...archived,
      [CHANNEL_DELIVERIES_FIELD.attention]: false,
      payload: {
        ...archived.payload,
        state: 'suppressed',
        archiveRecovery: null,
      },
    };
    // A policy/currentness suppression is terminal without owner attention;
    // the production CAS must be accepted by the exact collection contract.
    expect(isValidPluginJsonSchemaValue(validate, suppressed)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...archived,
      payload: { ...archived.payload, state: 'delivered' },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...archived,
      payload: { ...archived.payload, providerErrorCode: 50_083 },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...archived,
      [CHANNEL_DELIVERIES_FIELD.id]: 'delivery-1',
    })).toBe(false);
    expect(CHANNEL_DELIVERIES_COLLECTION.schema).toMatchObject({
      properties: {
        payload: {
          properties: {
            state: { enum: [...CONVERSATION_DELIVERY_CUSTODY_STATES] },
          },
        },
      },
    });
  });

  it('persists one state-derived delivery projection and an active attempt timestamp', () => {
    const validate = compilePluginJsonSchema(CHANNEL_DELIVERIES_COLLECTION.schema);
    const retryDue = {
      [CHANNEL_DELIVERIES_FIELD.id]: 'E'.repeat(43),
      [CHANNEL_DELIVERIES_FIELD.recordKind]: CHANNEL_DELIVERIES_RECORD_KIND.outwardDelivery,
      [CHANNEL_DELIVERIES_FIELD.version]: 1,
      [CHANNEL_DELIVERIES_FIELD.connectionId]: 'connection-1',
      [CHANNEL_DELIVERIES_FIELD.bindingId]: 'binding-1',
      [CHANNEL_DELIVERIES_FIELD.terminal]: false,
      [CHANNEL_DELIVERIES_FIELD.attention]: false,
      [CHANNEL_DELIVERIES_FIELD.retryNotBefore]: 100,
      [CHANNEL_DELIVERIES_FIELD.createdAt]: 1,
      [CHANNEL_DELIVERIES_FIELD.updatedAt]: 2,
      payload: {
        source: { kind: 'controlResponse', controlId: 'retry-1', controlKind: 'recovery' },
        routeAuthority: {
          connectionAuthorityEpoch: 1,
          bindingRevision: 1,
          bindingAuthorityEpoch: 1,
        },
        endpoint: { kind: 'direct', audience: 'direct', id: 'direct-1' },
        content: 'Retrying shortly.',
        deliveryKey: 'binding-1:retry-1',
        replyContext: null,
        mentionPolicy: 'suppress',
        linkPreviewPolicy: 'suppress',
        state: 'retryDue',
        attemptCount: 1,
        attemptId: null,
        startedAt: null,
        providerMessageIds: [],
        failedChunk: null,
        archiveRecovery: null,
      },
    };

    expect(isValidPluginJsonSchemaValue(validate, retryDue)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...retryDue,
      payload: {
        ...retryDue.payload,
        deliveryKey: 'x'.repeat(MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES + 1),
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...retryDue,
      payload: {
        ...retryDue.payload,
        attemptCount: MAX_CONVERSATION_DELIVERY_ATTEMPTS + 1,
      },
    })).toBe(false);
    const { [CHANNEL_DELIVERIES_FIELD.retryNotBefore]: _connectionDeleteRetryNotBefore, ...connectionDeleted } = {
      ...retryDue,
      [CHANNEL_DELIVERIES_FIELD.terminal]: true,
      [CHANNEL_DELIVERIES_FIELD.attention]: false,
      payload: {
        ...retryDue.payload,
        state: 'connectionDeleted',
      },
    };
    expect(isValidPluginJsonSchemaValue(validate, connectionDeleted)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connectionDeleted,
      [CHANNEL_DELIVERIES_FIELD.attention]: true,
    })).toBe(false);
    const { [CHANNEL_DELIVERIES_FIELD.retryNotBefore]: _retryNotBefore, ...retryDueWithoutDue } = retryDue;
    expect(isValidPluginJsonSchemaValue(validate, retryDueWithoutDue)).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...retryDue,
      [CHANNEL_DELIVERIES_FIELD.terminal]: true,
      payload: { ...retryDue.payload, state: 'ready' },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...retryDue,
      payload: {
        ...retryDue.payload,
        state: 'attempting',
        attemptId: 'attempt-1',
        startedAt: null,
      },
      [CHANNEL_DELIVERIES_FIELD.retryNotBefore]: undefined,
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...retryDue,
      payload: { ...retryDue.payload, mentionPolicy: 'providerDefault' },
    })).toBe(false);

    const { [CHANNEL_DELIVERIES_FIELD.retryNotBefore]: _due, ...partial } = {
      ...retryDue,
      [CHANNEL_DELIVERIES_FIELD.terminal]: true,
      [CHANNEL_DELIVERIES_FIELD.attention]: true,
      payload: {
        ...retryDue.payload,
        state: 'partial',
        providerMessageIds: ['message-1'],
        failedChunk: 1,
      },
    };
    expect(isValidPluginJsonSchemaValue(validate, partial)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...partial,
      payload: { ...partial.payload, failedChunk: null },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...partial,
      payload: {
        ...partial.payload,
        failedChunk: MAX_CONVERSATION_DELIVERY_CHUNKS + 1,
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...retryDue,
      payload: {
        ...retryDue.payload,
        providerMessageIds: ['message-1'],
        failedChunk: 1,
      },
    })).toBe(false);
    for (const state of ['resolvedAccepted', 'resolvedDiscarded'] as const) {
      const resolved = {
        ...partial,
        [CHANNEL_DELIVERIES_FIELD.attention]: false,
        payload: {
          ...partial.payload,
          state,
          failedChunk: null,
        },
      };
      expect(isValidPluginJsonSchemaValue(validate, resolved)).toBe(true);
      expect(isValidPluginJsonSchemaValue(validate, {
        ...resolved,
        [CHANNEL_DELIVERIES_FIELD.attention]: true,
      })).toBe(false);
    }
  });
});
