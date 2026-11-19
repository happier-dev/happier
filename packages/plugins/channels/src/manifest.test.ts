import { readdir, readFile } from 'node:fs/promises';

import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
  parsePluginManifest,
  type PluginManifest,
} from '@happier-dev/plugin-sdk/manifest';
import {
  MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1,
  MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1,
  PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1,
  PluginTranscriptActivityResourceSnapshotV1Schema,
} from '@happier-dev/plugin-sdk/resources';
import {
  COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
  ComposerControlStateV1Schema,
  MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1,
} from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1,
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1,
  CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES,
  SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1,
  SessionPullRequestBindingInputV1Schema,
  SessionPullRequestBindingResultV1Schema,
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

/**
 * `PluginManifest` types every contribution entry as `{ id, [key: string]: unknown }`,
 * so these assertions narrow the exact declared protocol shape they compare
 * against and fail loudly on a manifest that stops declaring one.
 */
type DeclaredPointProtocol = Readonly<{
  id: string;
  version: number;
  operations?: Readonly<Record<string, unknown>>;
}>;

function declaredPointProtocols(
  point: Readonly<{ readonly [key: string]: unknown }> | undefined,
): readonly DeclaredPointProtocol[] {
  const protocols = point?.protocols;
  if (!Array.isArray(protocols)) {
    throw new Error('Expected the Channels contribution point to declare its protocols.');
  }
  return protocols as readonly DeclaredPointProtocol[];
}

import {
  CHANNELS_PLUGIN,
  CHANNELS_PLUGIN_ID,
  CHANNELS_PROVIDER_POINT_ID,
  CHANNELS_PROVIDER_POINT_REF,
  CHANNELS_SESSION_COMPOSER_ATTENTION_CONTROL_ID,
  CHANNELS_SESSION_COMPOSER_ATTENTION_STATE_RESOURCE_ID,
  CHANNELS_SESSION_COMPOSER_CONTROL_ID,
  CHANNELS_SESSION_COMPOSER_STATE_RESOURCE_ID,
  CHANNELS_SESSION_CONVERSATIONS_HEADER_ACTION_ID,
  CHANNELS_SESSION_CONVERSATIONS_RESOURCE_ID,
  CHANNELS_SESSION_CONVERSATIONS_VIEW_ID,
  CHANNELS_SESSION_CONVERSATIONS_WIDGET_ID,
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

async function readChannelsTranslationMessages(locale: string): Promise<Readonly<Record<string, unknown>>> {
  const translation = PLUGIN_MANIFEST.contributes?.ui?.translations?.find(entry => entry.locale === locale);
  if (!translation || !('resourceId' in translation)) throw new Error(`Expected a Channels locale Resource: ${locale}`);
  const resource = PLUGIN_MANIFEST.contributes?.resources?.find(({ id }) => id === translation.resourceId);
  if (typeof resource?.path !== 'string') throw new Error('Expected a packaged locale path');
  const messages: unknown = JSON.parse(await readFile(new URL(`../${resource.path}`, import.meta.url), 'utf8'));
  if (!messages || typeof messages !== 'object' || Array.isArray(messages)) throw new Error('Expected a locale message map');
  return messages as Readonly<Record<string, unknown>>;
}

/**
 * Every TypeScript file this plugin ships or tests with, not a hand-kept
 * sample of them: `@happier-dev/protocol` is a host-internal package the
 * plugin never declares, so any file reaching it crosses the public seam
 * silently. An allowlist here would only re-open the gap it just closed.
 */
async function listPluginSourceUrls(directory: URL): Promise<readonly URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    return entry.isDirectory() ? await listPluginSourceUrls(entryUrl) : [entryUrl];
  }));
  return nested.flat().filter((fileUrl) => fileUrl.href.endsWith('.ts') || fileUrl.href.endsWith('.tsx'));
}

describe('Channels core manifest', () => {
  it('declares every UI locale through a packaged JSON Resource without inline copy', async () => {
    const admitted = parsePluginManifest(PLUGIN_MANIFEST);
    if (!admitted.ok) throw new Error(admitted.diagnostics.map(diagnostic => diagnostic.message).join('; '));
    const normalized = admitted.manifest;
    const translations = normalized.contributes?.ui?.translations ?? [];
    expect(translations).toHaveLength(12);
    for (const translation of translations) {
      expect(translation).not.toHaveProperty('messages');
      expect(translation).toHaveProperty('resourceId');
      if (!('resourceId' in translation)) throw new Error('Expected a locale Resource reference');
      const resource = normalized.contributes?.resources?.find(({ id }) => id === translation.resourceId);
      expect(resource).toMatchObject({ kind: 'asset', contentType: 'application/json' });
      if (typeof resource?.path !== 'string') throw new Error('Expected a packaged locale path');
      const messages: unknown = JSON.parse(await readFile(new URL(`../${resource.path}`, import.meta.url), 'utf8'));
      expect(messages).toBeTypeOf('object');
      expect(messages).not.toBeNull();
      expect(Object.values(messages as Record<string, unknown>).every(value => typeof value === 'string')).toBe(true);
    }
  });

  it('makes every management Action requestable by agents and MCP without changing confirmation policy', () => {
    const noUiConfirmation = new Set<string>([
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCancel,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.streamNoticeDismiss,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.sessionProjectionNoticeDismiss,
    ]);
    const observational = new Set<string>([
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionList,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingList,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.ingressAttention,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryAttention,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryRead,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingRead,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPrepare,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionRetest,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingRead,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve,
    ]);
    for (const id of Object.values(CONVERSATION_MANAGEMENT_ACTION_IDS_V1)) {
      const action = PLUGIN_MANIFEST.contributes?.actions?.find((entry) => entry.id === id);
      expect(action, id).toBeDefined();
      expect(action?.surfaces, id).toEqual(expect.arrayContaining(['agent', 'mcp']));
      if (noUiConfirmation.has(id)) {
        expect(action?.confirmationWhen, id).toEqual({ presentUserUi: false });
      }
      if (id === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.conversationStart) {
        expect(action?.hostAccess).toEqual(['account-storage', 'bound-session']);
      }
      if (observational.has(id)) {
        expect(action?.dangerLevel, id).toBe('safe');
        expect(action?.confirmation, id).toBeUndefined();
      } else {
        expect(action?.dangerLevel, id).toBe(id === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionDelete
          || id === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingDelete
          || id === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionTransfer ? 'destructive'
          : id === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.conversationStart
            || id === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionSetupRemediate ? 'writesRemote' : 'writesLocal');
        expect(action?.confirmation, id).toMatchObject({
          title: expect.any(String), body: expect.any(String), confirmLabel: expect.any(String),
        });
      }
    }
  });

  it('records a delivery resolution without requesting another confirmation', () => {
    expect(PLUGIN_MANIFEST.contributes?.actions?.find(action => action.id === CONVERSATION_MANAGEMENT_ACTION_IDS_V1.deliveryResolve))
      .toMatchObject({ confirmationWhen: { presentUserUi: false } });
  });

  it('declares binding changes as confirmed by the person\'s own UI click only', () => {
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    if (!parsed.ok) throw new Error(parsed.diagnostics.map(diagnostic => diagnostic.message).join('; '));
    for (const id of [CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate,
      CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingUpdate, CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingSetEnabled]) {
      const action = parsed.manifest.contributes.actions?.find(declaration => declaration.id === id);
      expect(action, id).toMatchObject({
        dangerLevel: 'writesLocal',
        confirmationWhen: { presentUserUi: false },
        confirmation: { title: expect.any(String), body: expect.any(String), confirmLabel: expect.any(String) },
      });
    }
  });

  it('consumes the canonical transcript-activity Resource contract through public SDK resources', () => {
    const declaredResource = PLUGIN_MANIFEST.contributes?.resources?.find(
      (resource) => resource.id === 'outward-delivery-activities-v1',
    );

    expect(declaredResource).toMatchObject({
      scope: 'session',
      contentType: PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1,
      maxBytes: MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1,
    });
    expect(MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1).toBe(16);
    expect(PluginTranscriptActivityResourceSnapshotV1Schema.safeParse({
      version: 1,
      activities: [],
    }).success).toBe(true);
  });

  it('projects its prior cold identity and declared contribution families through one definePlugin value', () => {
    const normalized = parsePluginManifest(CHANNELS_PLUGIN.manifest);

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw new Error('Expected the Channels definePlugin manifest to normalize');
    expect(CHANNELS_PLUGIN.manifest).toBe(PLUGIN_MANIFEST);
    expect({
      id: normalized.manifest.id,
      version: normalized.manifest.version,
      displayName: normalized.manifest.displayName,
      entrypoints: normalized.manifest.entrypoints,
    }).toEqual({
      id: 'happier.channels',
      version: '0.0.0',
      displayName: 'Conversation Channels',
      entrypoints: { daemon: './.happier-plugin/daemon.js' },
    });
    expect(Object.keys(CHANNELS_PLUGIN.manifest.contributes).sort()).toEqual([
      'accountCollections',
      'actions',
      'backgroundServices',
      'composerAttachments',
      'composerControls',
      'events',
      'notifications',
      'pluginContributionPoints',
      'resources',
      'sessionHeaderActions',
      'sessionInfoSections',
      'settings',
      'transcriptActivities',
      'ui',
    ]);
  });

  it('keeps the C1 implementation and verification boundary on public SDK seams', async () => {
    const sourceUrls = await listPluginSourceUrls(new URL('./', import.meta.url));
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Readonly<{
      dependencies?: Readonly<Record<string, string>>;
      devDependencies?: Readonly<Record<string, string>>;
    }>;

    expect(sourceUrls.length).toBeGreaterThan(0);
    for (const sourceUrl of sourceUrls) {
      const source = await readFile(sourceUrl, 'utf8');
      expect(source, sourceUrl.pathname).not.toContain(`from '${PRIVATE_PROTOCOL_PACKAGE}`);
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
    expect(parsed.manifest.contributes.actions?.find(
      (action) => action.id === SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1,
    )).toMatchObject({
      dangerLevel: 'writesLocal',
      confirmation: {
        title: expect.any(String),
        body: expect.any(String),
        confirmLabel: expect.any(String),
      },
    });
  });

  it('admits the binding read/write confirmation predicate through canonical manifest normalization', () => {
    const binding = PLUGIN_MANIFEST.contributes?.actions?.find(
      action => action.id === SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1,
    );
    if (!binding) throw new Error('Expected the Session PR binding Action');
    // Retain the declared Resources required by the real manifest's brand icon.
    const manifest = { ...PLUGIN_MANIFEST, contributes: { ...PLUGIN_MANIFEST.contributes, actions: [binding] } };
    const parsed = parsePluginManifest(manifest);
    if (!parsed.ok) throw new Error(parsed.diagnostics.map(diagnostic => diagnostic.message).join('; '));
    expect(parsed.manifest.contributes.actions?.[0]).toMatchObject({
      dangerLevel: 'writesLocal',
      confirmationWhen: {
        default: { op: 'and', all: [
          { op: 'not', predicate: { op: 'eq', path: 'kind', value: 'list' } },
          { op: 'not', predicate: { op: 'eq', path: 'kind', value: 'readRelations' } },
          { op: 'not', predicate: { op: 'eq', path: 'kind', value: 'unlink' } },
          { op: 'or', any: [
            { op: 'not', predicate: { op: 'eq', path: 'kind', value: 'attach' } },
            { op: 'truthy', path: 'target' },
          ] },
        ] },
        presentUserUi: false,
      },
      confirmation: { title: expect.any(String) },
    });
    expect(parsePluginManifest({ ...manifest, contributes: { actions: [{ ...binding,
      confirmationWhen: { default: { op: 'and', predicates: [] }, presentUserUi: false },
    }] } }).ok).toBe(false);
  });

  it('declares and observes the one Channels-owned provider contribution point', () => {
    const providerPoints = PLUGIN_MANIFEST.contributes?.pluginContributionPoints?.filter(
      point => point.id === CHANNELS_PROVIDER_POINT_ID,
    );
    const point = providerPoints?.[0];

    expect(providerPoints).toHaveLength(1);
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
        id: declaredPointProtocols(point)[0]?.id,
        version: declaredPointProtocols(point)[0]?.version,
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

  it('projects one Resource-driven native settings page through the generic settings catalog', async () => {
    const ui = PLUGIN_MANIFEST.contributes?.ui;

    expect(ui).toMatchObject({
      views: [{
        id: 'session-conversations',
        container: 'rightSidebarTab',
        target: { kind: 'session' },
        renderer: 'channels-renderer',
      }, {
        id: 'session-conversations-widget',
        container: 'widget',
        target: { kind: 'session' },
        renderer: 'channels-renderer',
      }, {
        id: 'conversations',
        container: 'appPage',
      }, {
        id: 'conversations-widget',
        container: 'widget',
      }],
      renderers: [{
        id: 'channels-renderer',
        kind: 'reactNative',
        artifact: 'channels-app-native',
        requiredHostMethods: [],
      }, {
        id: 'channels-glance',
        kind: 'reactNative',
        artifact: 'channels-glance-native',
      }],
      // Owner Q2 (2026-10-30): Channels setup lives at Settings → Channels, a host Settings group row.
      settingsPages: [{
        id: 'connections',
        group: { kind: 'host', id: 'sessionsBehavior' },
        title: { key: 'plugins.channels.page.title', fallback: 'Channels' },
        renderer: 'channels-renderer',
      }],
    });
    expect(ui).not.toHaveProperty('settingsGroups');
    const messages = await readChannelsTranslationMessages('en');
    expect(messages).toMatchObject({
      'plugins.channels.surface.saved': 'Saved to your Account. The selected machine will reconcile this policy when it is available.',
      'plugins.channels.surface.deleteRecoveryRequired': 'Delete again to finish cleanup',
      'plugins.channels.surface.providerFallback': 'Integration provider',
      'plugins.channels.surface.transportCheckpointedPull': 'Checkpointed pull',
      'plugins.channels.surface.selectedMachineSummary': 'Runs on your selected machine',
      'plugins.channels.surface.currentPolicy': 'Current connection policy',
      'plugins.channels.surface.technicalDetails': 'Technical details',
      'plugins.channels.surface.maximumObservationAgeDescription': 'Accept incoming observations no older than this limit.',
      'plugins.channels.surface.maximumObservationAgeInput': 'How long incoming messages stay eligible',
      'plugins.channels.surface.minute': 'minute',
      'plugins.channels.surface.days': 'days',
    });
    expect(messages).not.toHaveProperty('plugins.channels.surface.backToConnections');
  });

  it('leaves Channels encoded-row ceilings to the deployment Collection owner', () => {
    const parsed = parsePluginManifest(PLUGIN_MANIFEST);
    if (!parsed.ok) throw new Error(parsed.diagnostics.map(diagnostic => diagnostic.message).join('; '));
    const collections = parsed.manifest.contributes.accountCollections ?? [];
    expect(collections.map(({ id }) => id)).toEqual([
      CHANNEL_STATE_COLLECTION_ID,
      CHANNEL_DELIVERIES_COLLECTION_ID,
    ]);
    for (const collection of collections) expect(collection).not.toHaveProperty('quota');
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
      }, {
        id: 'bound-session',
        capability: 'sessions',
        reason: 'Observe bound Session transcript and Permission changes for Channel delivery, and place inbound attachments in bound Sessions.',
        scope: { access: ['read', 'write'] },
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
      schemaVersion: 21,
      readableSchemaVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
      migrations: [{
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
        id: 'channel-state-v7-to-v8',
        fromSchemaVersion: 7,
        toSchemaVersion: 8,
      }, {
        id: 'channel-state-v8-to-v9',
        fromSchemaVersion: 8,
        toSchemaVersion: 9,
      }, {
        id: 'channel-state-v9-to-v10',
        fromSchemaVersion: 9,
        toSchemaVersion: 10,
      }, {
        id: 'channel-state-v10-to-v11',
        fromSchemaVersion: 10,
        toSchemaVersion: 11,
      }, {
        id: 'channel-state-v11-to-v12',
        fromSchemaVersion: 11,
        toSchemaVersion: 12,
      }, {
        id: 'channel-state-v12-to-v13',
        fromSchemaVersion: 12,
        toSchemaVersion: 13,
      }, {
        id: 'channel-state-v13-to-v14',
        fromSchemaVersion: 13,
        toSchemaVersion: 14,
      }, {
        id: 'channel-state-v14-to-v15',
        fromSchemaVersion: 14,
        toSchemaVersion: 15,
      }, {
        id: 'channel-state-v15-to-v16',
        fromSchemaVersion: 15,
        toSchemaVersion: 16,
      }, {
        id: 'channel-state-v16-to-v17',
        fromSchemaVersion: 16,
        toSchemaVersion: 17,
      }, {
        id: 'channel-state-v17-to-v18',
        fromSchemaVersion: 17,
        toSchemaVersion: 18,
      }, {
        id: 'channel-state-v18-to-v19',
        fromSchemaVersion: 18,
        toSchemaVersion: 19,
      }, {
        id: 'channel-state-v19-to-v20',
        fromSchemaVersion: 19,
        toSchemaVersion: 20,
      }, {
        id: 'channel-state-v20-to-v21',
        fromSchemaVersion: 20,
        toSchemaVersion: 21,
      }],
      rowIdField: CHANNEL_STATE_FIELD.id,
      serverReadable: [
        CHANNEL_STATE_FIELD.recordKind,
        CHANNEL_STATE_FIELD.version,
        CHANNEL_STATE_FIELD.connectionId,
        CHANNEL_STATE_FIELD.bindingId,
        CHANNEL_STATE_FIELD.sessionId,
        CHANNEL_STATE_FIELD.prBinding,
        CHANNEL_STATE_FIELD.prUpdateAt,
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
          id: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
          fields: [
            { field: CHANNEL_STATE_FIELD.connectionId, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.bindingId, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.recordKind, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.attention, direction: 'asc' },
          ],
        },
        {
          id: CHANNEL_STATE_INDEX_ID.byConnectionKindV1,
          fields: [
            { field: CHANNEL_STATE_FIELD.connectionId, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.recordKind, direction: 'asc' },
          ],
        },
        {
          id: CHANNEL_STATE_INDEX_ID.bySessionKindBindingUpdateV1,
          fields: [
            { field: CHANNEL_STATE_FIELD.sessionId, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.recordKind, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.bindingId, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.prUpdateAt, direction: 'desc' },
          ],
        },
        {
          id: CHANNEL_STATE_INDEX_ID.byPullRequestSessionBindingV1,
          fields: [
            { field: CHANNEL_STATE_FIELD.recordKind, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.prBinding, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.sessionId, direction: 'asc' },
            { field: CHANNEL_STATE_FIELD.bindingId, direction: 'asc' },
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
      uiQueries: [],
      relations: [],
    });
    expect(collections?.find(({ id }) => id === CHANNEL_DELIVERIES_COLLECTION_ID)).toMatchObject({
      id: CHANNEL_DELIVERIES_COLLECTION_ID,
      schemaVersion: 6,
      readableSchemaVersions: [1, 2, 3, 4, 5],
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
          id: CHANNEL_DELIVERIES_INDEX_ID.byConnectionAttention,
          fields: [
            { field: CHANNEL_DELIVERIES_FIELD.connectionId, direction: 'asc' },
            { field: CHANNEL_DELIVERIES_FIELD.attention, direction: 'asc' },
            { field: CHANNEL_DELIVERIES_FIELD.bindingId, direction: 'asc' },
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
        {
          id: CHANNEL_DELIVERIES_INDEX_ID.byTerminalUpdatedAt,
          fields: [
            { field: CHANNEL_DELIVERIES_FIELD.terminal, direction: 'asc' },
            { field: CHANNEL_DELIVERIES_FIELD.updatedAt, direction: 'asc' },
            { field: CHANNEL_DELIVERIES_FIELD.id, direction: 'asc' },
          ],
        },
      ],
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
    for (const id of [CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList, CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead]) {
      const action = manifest.contributes?.actions?.find((entry) => entry.id === id);
      expect(action?.hostAccess, id).toEqual(expect.arrayContaining(['account-storage']));
    }
    expect(manifest.contributes?.resources?.filter((resource) => resource.source === 'dynamic')).toEqual([
      {
        id: 'connections-v1',
        source: 'dynamic',
        kind: 'config',
        // Declared, not defaulted: the author path requires a dynamic Resource
        // to name its scope, and `global` is the same value the shipped
        // artifact already carried.
        scope: 'global',
        contentType: 'application/json',
        hostAccess: ['account-storage'],
      },
      {
        id: 'bindings-v1',
        source: 'dynamic',
        kind: 'config',
        // Declared, not defaulted: the author path requires a dynamic Resource
        // to name its scope, and `global` is the same value the shipped
        // artifact already carried.
        scope: 'global',
        contentType: 'application/json',
        hostAccess: ['account-storage'],
      },
      {
        id: 'pairing-v1',
        source: 'dynamic',
        kind: 'config',
        // Declared, not defaulted: the author path requires a dynamic Resource
        // to name its scope, and `global` is the same value the shipped
        // artifact already carried.
        scope: 'global',
        contentType: 'application/json',
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
      {
        id: 'session-conversations-v1',
        source: 'dynamic',
        kind: 'config',
        scope: 'session',
        contentType: 'application/json',
        // The canonical Account-wide bindings ceiling plus the one attention
        // entry each of the 256 bindings can carry.
        hostAccess: ['account-storage'],
      },
      {
        id: 'session-info-v1',
        source: 'dynamic',
        kind: 'config',
        scope: 'session',
        contentType: 'application/vnd.happier.declarative-document+json;version=1',
        maxBytes: 65_536,
        hostAccess: ['account-storage'],
      },
      {
        id: 'session-conversations-state-v1',
        source: 'dynamic',
        kind: 'config',
        scope: 'session',
        contentType: 'application/vnd.happier.composer-control-state+json;v=1',
        maxBytes: 65_536,
        hostAccess: ['account-storage'],
      },
      {
        id: 'session-conversations-attention-state-v1',
        source: 'dynamic',
        kind: 'config',
        scope: 'session',
        contentType: 'application/vnd.happier.composer-control-state+json;v=1',
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
    expect(manifest.contributes?.sessionInfoSections).toEqual([
      {
        id: 'external-conversations',
        resourceId: 'session-info-v1',
        order: 50,
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
    })).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...connection,
      payload: { ...connection.payload, outboundTextLimit: { maximum: 0, unit: 'unicodeCodePoints' } },
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
          ...credentialRef,
          service: { ...credentialRef.service, localId: 'telegram bot' },
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
    const observationShell = {
      v: 1, occurrenceId: 'occurrence-1', occurredAt: 1, transport: { kind: 'poll' },
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
      actor: { principalId: 'principal-1', kind: 'human', isIntegrationSelf: false },
      message: { id: 'message-1', revision: '1', addressingEvidence: 'none', contentProvenance: 'original', providerTimestamp: 1 },
    };
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
          remoteApprovalMaxScope: 'off',
        },
        normalizedIngress: { kind: 'fullText', observation: {
          ...observationShell, message: { ...observationShell.message, text: 'Investigate this.' },
        } },
        observationShell,
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
        compacted: null,
        phase: 'prepared',
        connectionAuthorityEpoch: 1,
        // Historical census rows stay schema-readable, but have no live reader.
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
    // The frozen chat-approval command and its owner ceiling ride the same
    // closed Session-target branch, so the real Account Collection accepts a
    // mediating obligation and rejects one whose ceiling is missing or unknown.
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingress,
      payload: {
        ...ingress.payload,
        target: {
          ...ingress.payload.target,
          remoteApprovalMaxScope: 'session',
          approval: { requestId: 'permission-request-1', decision: 'allow', scope: 'session' },
        },
      },
    })).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingress,
      payload: {
        ...ingress.payload,
        target: {
          kind: 'session',
          sessionId: 'session-1',
          idempotencyKey: `channels:input:v1:${'C'.repeat(43)}`,
          requestedPermissionCeiling: 'default',
        },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingress,
      payload: {
        ...ingress.payload,
        target: { ...ingress.payload.target, remoteApprovalMaxScope: 'always' },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingress,
      payload: {
        ...ingress.payload,
        target: {
          ...ingress.payload.target,
          approval: { requestId: 'permission-request-1', decision: 'allow' },
        },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, ingressCensus)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      payload: {
        ...ingressCensus.payload,
        matchedBindings: [{ bindingId: 'binding-1', arbitraryAuthority: true }],
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
    // A settled census keeps only the body-free replay identity.
    const compactedCensusPayload = {
      ...ingressCensus.payload,
      normalizedIngress: null,
      compacted: {
        shell: {
          ...ingressCensus.payload.normalizedIngress.observation,
          message: {
            id: 'message-1',
            revision: '1',
            addressingEvidence: 'none',
            contentProvenance: 'original',
            providerTimestamp: 1,
          },
        },
        replayDigest: 'E'.repeat(43),
        retainedAttentionObligationRowIds: [],
      },
    };
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      payload: compactedCensusPayload,
    })).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      payload: {
        ...compactedCensusPayload,
        compacted: { ...compactedCensusPayload.compacted, replayDigest: 'not-a-digest' },
      },
    })).toBe(false);
    // The retired digest remains readable, but new compacted rows need only
    // their body-free occurrence envelope and exact member identities.
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      payload: {
        ...compactedCensusPayload,
        compacted: {
          shell: compactedCensusPayload.compacted.shell,
          textDigest: 'E'.repeat(43),
          retainedAttentionObligationRowIds: [],
        },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      payload: {
        ...compactedCensusPayload,
        compacted: {
          shell: compactedCensusPayload.compacted.shell,
          retainedAttentionObligationRowIds: [],
        },
      },
    })).toBe(true);
    // Retirement is atomic at the Collection owner, so a compact census never
    // stages member tombstone revisions of its own.
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      payload: {
        ...compactedCensusPayload,
        compacted: {
          ...compactedCensusPayload.compacted,
          prunedObligationTombstones: [],
        },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      payload: {
        ...compactedCensusPayload,
        compacted: {
          ...compactedCensusPayload.compacted,
          retainedAttentionObligationRowIds: ['not-a-row-id'],
        },
      },
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingressCensus,
      payload: {
        ...compactedCensusPayload,
        compacted: {
          ...compactedCensusPayload.compacted,
          shell: {
            ...compactedCensusPayload.compacted.shell,
            message: {
              ...compactedCensusPayload.compacted.shell.message,
              text: 'must not become a prompt store',
            },
          },
        },
      },
    })).toBe(false);
    const {
      maximumObservationAgeMs,
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
    const { normalizedIngress: _normalizedIngress, ...ingressWithoutInput } = ingress.payload;
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingress,
      payload: ingressWithoutInput,
    })).toBe(false);
    const { observationShell: _observationShell, ...ingressWithoutShell } = ingress.payload;
    expect(isValidPluginJsonSchemaValue(validate, {
      ...ingress,
      payload: ingressWithoutShell,
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
      overlapSafety: 'providerExclusive',
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
      predecessorTransportKind: 'durablePush',
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
    })).toBe(true);

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
        content: { text: 'Please unarchive the thread before retrying.' },
        deliveryKey: 'binding-1:recovery-1',
        replyContext: null,

        linkPreviewPolicy: 'suppress',
        state: 'notDelivered',
        attemptCount: 1,
        attemptId: null,

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

  it('persists state-derived delivery projection and active attempt identity without an unused timestamp', () => {
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
        content: { text: 'Retrying shortly.' },
        deliveryKey: 'binding-1:retry-1',
        replyContext: null,

        linkPreviewPolicy: 'suppress',
        state: 'retryDue',
        attemptCount: 1,
        attemptId: null,

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
        attemptCount: Number.MAX_SAFE_INTEGER + 1,
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
      },
      [CHANNEL_DELIVERIES_FIELD.retryNotBefore]: undefined,
    })).toBe(false);
    expect(isValidPluginJsonSchemaValue(validate, {
      ...retryDueWithoutDue,
      payload: { ...retryDue.payload, state: 'attempting', attemptId: 'attempt-1' },
    })).toBe(true);

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
        failedChunk: Number.MAX_SAFE_INTEGER + 1,
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

describe('Channels Session-facing surfaces (CU-03)', () => {
  // Contribution local ids are the persisted routing identity, and the manifest
  // parser rejects the SAME local id in two families. They are asserted as
  // literals rather than through the exported constants: a guard built from the
  // constant it asserts cannot fail when the constant changes.
  it('exports the exact persisted local ids its Session destinations route on', () => {
    expect({
      view: CHANNELS_SESSION_CONVERSATIONS_VIEW_ID,
      widget: CHANNELS_SESSION_CONVERSATIONS_WIDGET_ID,
      headerAction: CHANNELS_SESSION_CONVERSATIONS_HEADER_ACTION_ID,
      control: CHANNELS_SESSION_COMPOSER_CONTROL_ID,
      attentionControl: CHANNELS_SESSION_COMPOSER_ATTENTION_CONTROL_ID,
      listResource: CHANNELS_SESSION_CONVERSATIONS_RESOURCE_ID,
      stateResource: CHANNELS_SESSION_COMPOSER_STATE_RESOURCE_ID,
      attentionStateResource: CHANNELS_SESSION_COMPOSER_ATTENTION_STATE_RESOURCE_ID,
    }).toEqual({
      view: 'session-conversations',
      widget: 'session-conversations-widget',
      headerAction: 'open-session-conversations',
      control: 'session-conversations-chip',
      attentionControl: 'session-conversations-attention-chip',
      listResource: 'session-conversations-v1',
      stateResource: 'session-conversations-state-v1',
      attentionStateResource: 'session-conversations-attention-state-v1',
    });
  });

  it('offers the Channels app destination in the rail with its own column and the Home widget in Customize', async () => {
    const ui = PLUGIN_MANIFEST.contributes?.ui;
    const views = ui?.views ?? [];

    // The page is the one owner of conversation bindings. Its location is the
    // open binding, so its local id is persisted routing identity.
    expect(views.find((view) => view.id === 'conversations')).toEqual({
      id: 'conversations',
      container: 'appPage',
      target: { kind: 'app' },
      renderer: 'channels-renderer',
      title: { key: 'plugins.channels.page.title', fallback: 'Channels' },
      icon: 'send',
      placement: { kind: 'rail' },
      column: { renderer: 'channels-glance' },
    });
    // Channels is bundled: a card on every Home would be empty for people who
    // never connect a bot, so the widget is only offered.
    expect(views.find((view) => view.id === 'conversations-widget')).toEqual({
      id: 'conversations-widget',
      container: 'widget',
      sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' },
      target: { kind: 'app' },
      renderer: 'channels-glance',
      resources: [
        { pluginId: 'happier.channels', localId: 'bindings-v1' },
        { pluginId: 'happier.channels', localId: 'connections-v1' },
      ],
      title: { key: 'plugins.channels.widget.title', fallback: 'Channels' },
      icon: 'send',
      home: { default: 'available' },
    });
    // The column and the widget share one small artifact; both only navigate.
    expect(ui?.renderers?.find((renderer) => renderer.id === 'channels-glance')).toEqual({
      id: 'channels-glance',
      kind: 'reactNative',
      artifact: 'channels-glance-native',
      requiredHostMethods: ['openSurface'],
    });
    expect(await readChannelsTranslationMessages('en')).toMatchObject({
      'plugins.channels.page.title': 'Channels',
      'plugins.channels.widget.title': 'Channels',
    });
  });

  it('mounts one Session destination, one Session-header entry, and the Composer chips through the generic families', () => {
    const ui = PLUGIN_MANIFEST.contributes?.ui;

    expect(ui?.views).toEqual([{
      id: 'session-conversations',
      container: 'rightSidebarTab',
      target: { kind: 'session' },
      renderer: 'channels-renderer',
      title: {
        key: 'plugins.channels.session.title',
        fallback: 'External conversations',
      },
      icon: 'send',
    }, expect.objectContaining({
      id: 'session-conversations-widget',
      container: 'widget',
      target: { kind: 'session' },
      renderer: 'channels-renderer',
      resources: [
        { pluginId: 'happier.channels', localId: 'session-conversations-v1' },
        { pluginId: 'happier.channels', localId: 'connections-v1' },
      ],
      inputs: {
        fields: [{ path: 'session', title: 'Session', widget: 'json', required: true, optionsSourceId: 'sessions' }],
      },
      inputSchema: {
        type: 'object',
        properties: {
          session: {
            type: 'object',
            properties: {
              serverId: { type: 'string', minLength: 1 },
              sessionId: { type: 'string', minLength: 1 },
            },
            required: ['serverId', 'sessionId'],
            additionalProperties: false,
          },
        },
        required: ['session'],
        additionalProperties: false,
      },
      sessionInputPath: 'session',
      title: {
        key: 'plugins.channels.session.title',
        fallback: 'External conversations',
      },
    }), expect.objectContaining({ id: 'conversations' }), expect.objectContaining({ id: 'conversations-widget' })]);

    const sessionWidget = ui?.views?.find((view) => view.id === CHANNELS_SESSION_CONVERSATIONS_WIDGET_ID);
    if (!sessionWidget || !('inputSchema' in sessionWidget) || !sessionWidget.inputSchema) {
      throw new Error('Expected the Session conversations widget to declare its input value schema');
    }
    const validateSessionInput = compilePluginJsonSchema(sessionWidget.inputSchema);
    const session = { serverId: 'home', sessionId: 'session-a' };
    expect(isValidPluginJsonSchemaValue(validateSessionInput, { session })).toBe(true);
    for (const invalidInput of [
      {},
      { session: 'session-a' },
      { session: { sessionId: 'session-a' } },
      { session: { serverId: 'home' } },
      { session: { ...session, serverId: '' } },
      { session: { ...session, sessionId: '' } },
      { session: { ...session, extra: true } },
      { session, extra: true },
    ]) {
      expect(isValidPluginJsonSchemaValue(validateSessionInput, invalidInput)).toBe(false);
    }

    expect(PLUGIN_MANIFEST.contributes?.sessionHeaderActions).toEqual([{
      id: 'open-session-conversations',
      title: {
        key: 'plugins.channels.session.title',
        fallback: 'External conversations',
      },
      icon: 'send',
      command: {
        kind: 'openSurface',
        destination: 'session-conversations',
      },
    }]);

    // Both chips open the SAME Session destination the header entry opens, so
    // the Composer never becomes a second navigation owner, and both are scoped
    // to the only Composer that can carry a Session binding.
    expect(PLUGIN_MANIFEST.contributes?.composerControls).toEqual([{
      id: 'session-conversations-chip',
      label: {
        key: 'plugins.channels.session.composerChip',
        fallback: 'External conversations',
      },
      icon: 'send',
      scopes: ['session'],
      state: { resource: 'session-conversations-state-v1' },
      interaction: {
        kind: 'destination',
        destination: 'session-conversations',
      },
    }, {
      id: 'session-conversations-attention-chip',
      label: {
        key: 'plugins.channels.session.composerChipAttention',
        fallback: 'External delivery needs attention',
      },
      icon: 'warning',
      scopes: ['session'],
      state: { resource: 'session-conversations-attention-state-v1' },
      interaction: {
        kind: 'destination',
        destination: 'session-conversations',
      },
    }]);
  });

  it('declares both Composer control-state Resources as Session-scoped producers of the canonical control-state media type', () => {
    const resources = (PLUGIN_MANIFEST.contributes?.resources ?? []) as readonly Readonly<{
      id: string;
      scope?: string;
      contentType?: string;
      maxBytes?: number;
      hostAccess?: readonly string[];
    }>[];

    for (const id of [
      'session-conversations-state-v1',
      'session-conversations-attention-state-v1',
    ]) {
      expect(resources.find((resource) => resource.id === id)).toMatchObject({
        id,
        scope: 'session',
        contentType: COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
        maxBytes: MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1,
        hostAccess: ['account-storage'],
      });
    }
    expect(COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1).toBe('application/vnd.happier.composer-control-state+json;v=1');
    expect(ComposerControlStateV1Schema.safeParse({ visible: true, count: 1 }).success).toBe(true);
  });

  it('localizes every Session-facing string it contributes', async () => {
    expect(await readChannelsTranslationMessages('en')).toMatchObject({
      'plugins.channels.session.title': 'External conversations',
      'plugins.channels.session.composerChip': 'External conversations',
      'plugins.channels.session.composerChipAttention': 'External delivery needs attention',
    });
  });
});
