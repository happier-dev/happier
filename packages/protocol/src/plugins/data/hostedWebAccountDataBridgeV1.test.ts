import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as Collections from './hostedWebAccountDataBridgeV1.js';

type SchemaLike = Readonly<{
  safeParse(value: unknown): Readonly<{ success: boolean }>;
}>;

function requireSchema(name: string): SchemaLike {
  const candidate = Reflect.get(Collections, name);
  expect(candidate, `${name} must be published by the Data-owned hosted bridge contract`)
    .toMatchObject({ safeParse: expect.any(Function) });
  return candidate as SchemaLike;
}

const tasksDeclaration = {
  id: 'tasks',
  schemaVersion: 1,
  schema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  rowIdField: 'id',
  identityFields: [],
  serverReadable: ['id'],
  indexes: [{ id: 'by-id', fields: [{ field: 'id', direction: 'asc' }] }],
  uiQueries: [],
  relations: [],
  migrations: [],
} as const;

describe('hosted-web Collection UI-query bridge contract', () => {
  it('uses the Account Data bridge operation kind', () => {
    expect(Collections.PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1)
      .toBe('accountData');
  });

  it('keeps hosted bridge schemas in a crypto-free Data wire leaf while legacy Collection imports stay identical', async () => {
    const bridgeSource = readFileSync(new URL('./hostedWebAccountDataBridgeV1.ts', import.meta.url), 'utf8');

    expect(bridgeSource).toContain("from './collectionUiQueryWireV1.js';");
    expect(bridgeSource).not.toContain("from './collectionsV1.js';");
    expect(bridgeSource).toContain("from './accountKvValueV1.js';");
    expect(bridgeSource).not.toContain("from './accountKvV1.js';");

    const wireSource = readFileSync(new URL('./collectionUiQueryWireV1.ts', import.meta.url), 'utf8');
    expect(wireSource).not.toContain('../../crypto/');
    expect(wireSource).not.toContain('accountScopedCipher');
    expect(wireSource).not.toContain('canonicalDigest');

    const accountKvValueSource = readFileSync(new URL('./accountKvValueV1.ts', import.meta.url), 'utf8');
    expect(accountKvValueSource).not.toContain('../../crypto');
    expect(accountKvValueSource).not.toContain('accountScopedCipher');

    const [wire, collections, accountKvValue, accountKv] = await Promise.all([
      import('./collectionUiQueryWireV1.js'),
      import('./collectionsV1.js'),
      import('./accountKvValueV1.js'),
      import('./accountKvV1.js'),
    ]);

    expect(collections.PluginCollectionOpaqueCursorV1Schema).toBe(wire.PluginCollectionOpaqueCursorV1Schema);
    expect(collections.PluginCollectionRowIdV1Schema).toBe(wire.PluginCollectionRowIdV1Schema);
    expect(collections.PluginCollectionUiQueryRequestV1Schema).toBe(wire.PluginCollectionUiQueryRequestV1Schema);
    expect(collections.PluginCollectionUiRowContextV1Schema).toBe(wire.PluginCollectionUiRowContextV1Schema);
    expect(collections.PluginCollectionUiRowV1Schema).toBe(wire.PluginCollectionUiRowV1Schema);
    expect(collections.PluginCollectionUiQueryResultV1Schema).toBe(wire.PluginCollectionUiQueryResultV1Schema);
    expect(collections.PluginCollectionUiQueryErrorCodeV1Schema).toBe(wire.PluginCollectionUiQueryErrorCodeV1Schema);
    expect(collections.PluginCollectionUiQueryErrorV1Schema).toBe(wire.PluginCollectionUiQueryErrorV1Schema);
    expect(accountKv.PluginAccountStorageJsonValueV1Schema)
      .toBe(accountKvValue.PluginAccountStorageJsonValueV1Schema);
    expect(accountKv.PluginAccountStorageLogicalKeyV1Schema)
      .toBe(accountKvValue.PluginAccountStorageLogicalKeyV1Schema);
  });

  it('admits only same-surface logical Account-data operations and outer-sequence cancellation', () => {
    const request = requireSchema('PluginHostedWebAccountDataBridgeRequestV1Schema');

    expect(request.safeParse({
      kind: 'request',
      operation: {
        kind: 'open',
        collectionId: 'tasks',
        uiQueryId: 'open',
        parameters: { status: 'open' },
      },
    }).success).toBe(true);
    expect(request.safeParse({ kind: 'cancel', requestSequence: 7 }).success).toBe(true);
    expect(request.safeParse({
      kind: 'request',
      operation: {
        kind: 'data',
        operation: 'collection.get',
        definition: tasksDeclaration,
        arguments: ['task-1'],
      },
    }).success).toBe(true);
    expect(request.safeParse({
      kind: 'request',
      operation: {
        kind: 'data',
        operation: 'accountSettings.set',
        arguments: ['view', 'mine', { expectedRevision: '7' }],
      },
    }).success).toBe(false);
    expect(request.safeParse({
      kind: 'request',
      operation: {
        kind: 'data',
        operation: 'accountKv.get',
        arguments: [{ key: 'not-a-logical-key' }],
      },
    }).success).toBe(false);
    expect(request.safeParse({
      kind: 'request',
      operation: {
        kind: 'data',
        operation: 'accountKv.set',
        arguments: ['theme', 'dark', { expectedVersion: 'wrong-type' }],
      },
    }).success).toBe(false);
    expect(request.safeParse({
      kind: 'request',
      operation: {
        kind: 'data',
        operation: 'accountSettings.reset',
        arguments: ['view', { expectedRevision: 7 }],
      },
    }).success).toBe(false);

    // The mounted host stamps plugin, Account, admitted contract and cursor.
    // None may be supplied by the hosted guest, including through an otherwise
    // valid logical static-query request.
    for (const forbidden of [
      'pluginId',
      'accountId',
      'contractDigest',
      'writerContext',
      'cursor',
      'credential',
      'rawEnvelope',
    ]) {
      expect(request.safeParse({
        kind: 'request',
        operation: {
          kind: 'open',
          collectionId: 'tasks',
          uiQueryId: 'open',
          parameters: { status: 'open' },
          [forbidden]: 'forged-authority',
        },
      }).success).toBe(false);
    }
    expect(request.safeParse({
      kind: 'cancel',
      requestSequence: 7,
      requestId: 'guest-owned-correlation-is-forbidden',
    }).success).toBe(false);
    expect(request.safeParse({
      kind: 'request',
      operation: {
        kind: 'data',
        operation: 'collection.get',
        definition: { id: 'tasks' },
        arguments: ['task-1'],
        accountId: 'forged-account',
      },
    }).success).toBe(false);
    expect(request.safeParse({
      kind: 'request',
      operation: {
        kind: 'data',
        operation: 'collection.get',
        definition: { ...tasksDeclaration, forgedPluginId: 'other.plugin' },
        arguments: ['task-1'],
      },
    }).success).toBe(false);
    expect(request.safeParse({
      kind: 'request',
      operation: {
        kind: 'data',
        operation: 'accountSettings.set',
        arguments: ['view', 'mine', { expectedRevision: '7', accountId: 'forged-account' }],
      },
    }).success).toBe(false);
    expect(request.safeParse({
      kind: 'request',
      operation: {
        kind: 'data',
        operation: 'collection.query',
        definition: tasksDeclaration,
        arguments: [{ index: 'by-id', order: 'asc', credentialId: 'forged-credential' }],
      },
    }).success).toBe(false);
    expect(request.safeParse({
      kind: 'request',
      operation: {
        kind: 'data',
        operation: 'collection.unknown',
        arguments: [],
      },
    }).success).toBe(false);
  });

  it('allows safe fixed-row responses but only a content-free query wakeup', () => {
    const response = requireSchema('PluginHostedWebAccountDataBridgeResponseV1Schema');
    const change = requireSchema('PluginHostedWebAccountDataBridgeChangeV1Schema');
    const snapshot = {
      status: 'ready',
      rows: [{
        context: {
          collection: { pluginId: 'example.tasks', collectionId: 'tasks' },
          rowId: 'task-1',
          revision: 3,
        },
        fields: { status: 'open', title: 'Ship the hosted adapter' },
      }],
      hasMore: true,
    };

    expect(response.safeParse({
      kind: 'snapshot',
      queryId: 'query-1',
      snapshot,
    }).success).toBe(true);
    expect(response.safeParse({
      kind: 'snapshot',
      queryId: 'query-1',
      snapshot: { ...snapshot, nextCursor: 'host-private-cursor' },
    }).success).toBe(false);
    expect(response.safeParse({ kind: 'data', value: { version: 3 } }).success).toBe(true);
    expect(response.safeParse({
      kind: 'error',
      error: { code: 'plugin_collection_conflict', message: 'stale row' },
    }).success).toBe(true);
    expect(response.safeParse({
      kind: 'error',
      error: { code: 'plugin_collection_conflict', accountId: 'must-not-leak' },
    }).success).toBe(false);
    expect(change.safeParse({
      kind: 'change',
      queryId: 'query-1',
    }).success).toBe(true);
    // AccountChange reaches the direct pager as `onInvalidated(): void`.
    // The hosted bridge therefore forwards only the opaque query correlation;
    // rows remain exclusively in authenticated query responses after reread.
    for (const forbidden of ['snapshot', 'rows', 'accountId', 'contractDigest', 'revision']) {
      expect(change.safeParse({
        kind: 'change',
        queryId: 'query-1',
        [forbidden]: forbidden === 'snapshot' ? snapshot : 'must-not-cross-the-bridge',
      }).success).toBe(false);
    }
  });
});
