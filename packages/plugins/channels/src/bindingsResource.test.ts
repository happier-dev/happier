import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { SessionIndexedIdentifierMaxLengthV1 } from '@happier-dev/plugin-sdk/sessions';
import {
  MAX_CONVERSATION_BINDING_ID_ASCII_BYTES,
  MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
  MAX_CONVERSATION_CONNECTION_ID_ASCII_BYTES,
  MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS,
} from '@happier-dev/channels-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { BINDINGS_RESOURCE_RUNTIME } from './bindingsResource.js';

class MemoryAccountCollection {
  readonly rows = new Map<string, Readonly<{
    rowId: string;
    revision: number;
    value: Record<string, unknown>;
  }>>();

  async query(request: Readonly<{
    prefix?: readonly string[];
    cursor?: string;
    limit?: number;
  }>) {
    const recordKind = request.prefix?.[0];
    const matching = [...this.rows.values()]
      .filter((row) => row.value['record-kind'] === recordKind)
      .sort((left, right) => left.rowId.localeCompare(right.rowId));
    const start = request.cursor === undefined
      ? 0
      : matching.findIndex((row) => row.rowId === request.cursor) + 1;
    const limit = request.limit ?? matching.length;
    const rows = matching.slice(Math.max(0, start), Math.max(0, start) + limit);
    const next = matching[Math.max(0, start) + limit];
    return {
      rows,
      ...(next === undefined ? {} : { nextCursor: rows.at(-1)?.rowId }),
      changeCursor: 1,
    };
  }
}

function bindingRecord(input: Readonly<{
  bindingId: string;
  connectionId?: string;
  endpointLabel?: string;
  endpointParentLabel?: string;
  target?: 'session' | 'automation';
  targetId?: string;
  enabled?: boolean;
}>) {
  const target = input.target ?? 'session';
  const targetId = input.targetId ?? 'session-support';
  return {
    id: input.bindingId,
    'record-kind': 'binding',
    v: 1,
    'connection-id': input.connectionId ?? 'connection-1',
    'binding-id': input.bindingId,
    'created-at': 1,
    'updated-at': 1,
    payload: {
      endpoint: {
        kind: 'shared',
        audience: 'shared',
        id: 'endpoint-id-must-not-be-projected',
        ...(input.endpointLabel === undefined ? {} : { label: input.endpointLabel }),
        ...(input.endpointParentLabel === undefined ? {} : { parentLabel: input.endpointParentLabel }),
      },
      target: target === 'session'
        ? {
          kind: 'session',
          sessionId: targetId,
          policy: {
            deliveryMode: 'mirrorSession',
            permissionCeiling: 'yolo',
            approvals: { kind: 'enabled', maximumScope: 'session', principalIds: ['principal-sensitive'] },
            newSession: { kind: 'enabled', principalIds: ['principal-sensitive'], recipe: { secret: 'recipe-sensitive' } },
          },
        }
        : {
          kind: 'automation',
          automationId: targetId,
          templateVersion: 7,
          policy: { resultDelivery: 'finalResult' },
        },
      allowedPrincipalIds: ['principal-sensitive'],
      allowBotSenders: true,
      inputMode: 'addressedMessages',
      inboundDebounceMs: 4_000,
      linkPreviewPolicy: 'providerDefault',
      senderFeedback: 'eligibleRefusals',
      authorityEpoch: 6,
      enabled: input.enabled ?? true,
      deletionState: 'none',
    },
  };
}

function accountStorageFor(collection: unknown): PluginAccountStorageScope {
  return {
    collection(definition: Readonly<{ id: string }>) {
      if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('Unexpected Account Collection.');
      return collection;
    },
  } as unknown as PluginAccountStorageScope;
}

function resourceReadOptions(accountStorage: PluginAccountStorageScope) {
  return {
    signal: new AbortController().signal,
    context: { kind: 'global' as const },
    accountStorage,
  };
}

function createWatchableCollection() {
  let listener: (() => void) | undefined;
  const dispose = vi.fn(() => { listener = undefined; });
  return {
    watch: vi.fn((_request: unknown, next: () => void) => {
      listener = next;
      return { dispose };
    }),
    emit() {
      listener?.();
    },
    dispose,
  };
}

describe('Channels bindings Resource', () => {
  it('projects only management-safe bounded binding facts from the canonical binding rows', async () => {
    const state = new MemoryAccountCollection();
    const session = bindingRecord({
      bindingId: 'binding-session',
      endpointLabel: 'Release support',
      target: 'session',
      targetId: 'session-support',
    });
    const automation = bindingRecord({
      bindingId: 'binding-automation',
      endpointParentLabel: 'Operations',
      target: 'automation',
      targetId: 'automation-nightly',
      enabled: false,
    });
    state.rows.set(session.id, { rowId: session.id, revision: 4, value: session });
    state.rows.set(automation.id, { rowId: automation.id, revision: 7, value: automation });

    const serialized = await BINDINGS_RESOURCE_RUNTIME.read(resourceReadOptions(accountStorageFor(state)));

    expect(JSON.parse(serialized)).toEqual({
      bindings: [
        {
          bindingId: 'binding-automation',
          revision: 7,
          connectionId: 'connection-1',
          endpoint: { audience: 'shared', label: 'Operations' },
          target: { kind: 'automation', summary: 'automation-nightly' },
          inputMode: 'addressedMessages',
          deliveryMode: 'finalResult',
          approval: { kind: 'notApplicable' },
          enabled: false,
          deletionState: 'none',
        },
        {
          bindingId: 'binding-session',
          revision: 4,
          connectionId: 'connection-1',
          endpoint: { audience: 'shared', label: 'Release support' },
          target: { kind: 'session', summary: 'session-support' },
          inputMode: 'addressedMessages',
          deliveryMode: 'mirrorSession',
          approval: { kind: 'unavailable', maximumScope: 'session' },
          enabled: true,
          deletionState: 'none',
        },
      ],
    });
    expect(serialized).not.toContain('endpoint-id-must-not-be-projected');
    expect(serialized).not.toContain('principal-sensitive');
    expect(serialized).not.toContain('recipe-sensitive');
    expect(serialized).not.toContain('permissionCeiling');
    expect(serialized).not.toContain('templateVersion');
  });

  it('fails closed when a by-kind result is not a canonical binding row', async () => {
    const invalidStateCollection = {
      async query() {
        return {
          rows: [{
            rowId: 'connection-1',
            revision: 1,
            value: { id: 'connection-1', 'record-kind': 'connection' },
          }],
          changeCursor: 1,
        };
      },
    };

    await expect(BINDINGS_RESOURCE_RUNTIME.read(
      resourceReadOptions(accountStorageFor(invalidStateCollection)),
    )).rejects.toMatchObject({ code: 'channels_bindings_resource_binding_row_invalid' });
  });

  it('rejects a binding page beyond the canonical 256-row bound', async () => {
    const state = new MemoryAccountCollection();
    for (let index = 0; index <= MAX_CONVERSATION_BINDINGS_PER_ACCOUNT; index += 1) {
      const binding = bindingRecord({ bindingId: `binding-${String(index).padStart(3, '0')}` });
      state.rows.set(binding.id, { rowId: binding.id, revision: index + 1, value: binding });
    }

    await expect(BINDINGS_RESOURCE_RUNTIME.read(
      resourceReadOptions(accountStorageFor(state)),
    )).rejects.toMatchObject({ code: 'channels_bindings_resource_binding_page_invalid' });
  });

  it('keeps the full canonical 256-row projection within its declared Resource byte bound', async () => {
    const state = new MemoryAccountCollection();
    const maximumEscapedSummary = String.fromCharCode(0).repeat(
      MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS,
    );
    for (let index = 0; index < MAX_CONVERSATION_BINDINGS_PER_ACCOUNT; index += 1) {
      const bindingPrefix = `binding-${String(index).padStart(3, '0')}-`;
      const connectionPrefix = `connection-${String(index).padStart(3, '0')}-`;
      const bindingId = `${bindingPrefix}${'b'.repeat(MAX_CONVERSATION_BINDING_ID_ASCII_BYTES - bindingPrefix.length)}`;
      const connectionId = `${connectionPrefix}${'c'.repeat(MAX_CONVERSATION_CONNECTION_ID_ASCII_BYTES - connectionPrefix.length)}`;
      const binding = bindingRecord({
        bindingId,
        connectionId,
        endpointLabel: maximumEscapedSummary,
        target: index % 2 === 0 ? 'session' : 'automation',
        // Resource summaries retain only 28 code points, but Collection rows
        // must still satisfy the canonical Session ID admission bound.
        targetId: maximumEscapedSummary.slice(0, SessionIndexedIdentifierMaxLengthV1),
      });
      state.rows.set(binding.id, {
        rowId: binding.id,
        revision: Number.MAX_SAFE_INTEGER,
        value: binding,
      });
    }

    const serialized = await BINDINGS_RESOURCE_RUNTIME.read(resourceReadOptions(accountStorageFor(state)));
    const declaredResource = PLUGIN_MANIFEST.contributes.resources.find(
      (resource) => resource.id === 'bindings-v1',
    );
    if (declaredResource === undefined) throw new Error('Expected the bindings-v1 Resource declaration.');

    const projection = JSON.parse(serialized) as Readonly<{ bindings: readonly Readonly<{
      endpoint: Readonly<{ label?: string }>;
      target: Readonly<{ summary: string }>;
    }>[] }>;
    expect(projection.bindings).toHaveLength(MAX_CONVERSATION_BINDINGS_PER_ACCOUNT);
    expect(projection.bindings.every((binding) => (
      Array.from(binding.endpoint.label ?? '').length <= 28
      && Array.from(binding.target.summary).length <= 28
    ))).toBe(true);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(declaredResource.maxBytes);
  });

  it('invalidates the current snapshot on a binding-row change and disposes its one Collection watch', () => {
    const state = createWatchableCollection();
    const invalidate = vi.fn();
    const observation = BINDINGS_RESOURCE_RUNTIME.observe(invalidate, {
      signal: new AbortController().signal,
      context: { kind: 'global' },
      accountStorage: accountStorageFor(state),
    });

    state.emit();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(state.watch).toHaveBeenCalledWith({
      index: 'by-kind',
      prefix: [CHANNEL_STATE_RECORD_KIND.binding],
      order: 'asc',
    }, expect.any(Function));

    observation.dispose();
    state.emit();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(state.dispose).toHaveBeenCalledOnce();
  });
});
