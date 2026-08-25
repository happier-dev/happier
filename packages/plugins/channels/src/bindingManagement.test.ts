import { describe, expect, it, vi } from 'vitest';

import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';

import * as management from './management.js';
import {
  createCurrentConversationConnectionFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';

import { assertChannelsTestCollectionQueryLimit } from './testkit/collectionQueryBound.js';
type StateValue = Readonly<Record<string, JsonValue>>
  & Readonly<{ id: string; payload?: Readonly<Record<string, JsonValue>> }>;
type StateRow = Readonly<{ rowId: string; revision: number; value: StateValue }>;
/** Mirrors the canonical Collection query request the host actually passes. */
type StateQueryInput = Readonly<{
  index: string;
  prefix?: readonly (string | number | boolean | null)[];
  order: 'asc' | 'desc';
  cursor?: string;
  limit?: number;
}>;
type StateMutation =
  | Readonly<{ kind: 'assert'; rowId: string; expectedRevision: number }>
  | Readonly<{ kind: 'put'; value: StateValue; expectedRevision: number | 'absent' }>;

const materialization = {
  machineId: 'machine-1',
  materializationId: 'materialization-1',
  pluginId: 'happier.channel.test',
} as const;

const sessionTarget = {
  kind: 'session',
  sessionId: 'session-1',
  policy: {
    deliveryMode: 'repliesOnly',
    permissionCeiling: 'read-only',
    approvals: { kind: 'off' },
    newSession: { kind: 'off' },
  },
} as const;

const approvalEnabledSessionTarget = {
  ...sessionTarget,
  policy: {
    ...sessionTarget.policy,
    approvals: { kind: 'enabled', maximumScope: 'request' },
  },
} as const;

const automationTarget = {
  kind: 'automation',
  automationId: 'automation-1',
  expectedTemplateVersion: 3,
  policy: { resultDelivery: 'none' },
} as const;

const finalResultAutomationTarget = {
  ...automationTarget,
  policy: { resultDelivery: 'finalResult' },
} as const;

const retainedFinalResultAutomationTarget = {
  kind: 'automation',
  automationId: 'automation-1',
  templateVersion: 3,
  policy: { resultDelivery: 'finalResult' },
} as const;

function admittedProviderOperation(role: string, immutableGenerationId = 'provider-generation-1') {
  return Object.freeze({
    identity: Object.freeze({
      target: Object.freeze({ pluginId: 'happier.channels' }),
      point: Object.freeze({
        pointId: 'providers',
        protocol: Object.freeze({ id: 'happier.channels/providers', version: 1 }),
      }),
      contributor: Object.freeze({
        pluginId: materialization.pluginId,
        contributionId: 'test-provider',
        immutableGenerationId,
      }),
      role,
    }),
  });
}

const endpointResolveAction = admittedProviderOperation('endpointResolve');
const principalResolveAction = admittedProviderOperation('principalResolve');
const bindingResolutionEndpoint = Object.freeze({
  kind: 'direct' as const,
  audience: 'direct' as const,
  id: 'chat-1',
  label: 'Alice',
});
const bindingResolutionPrincipal = Object.freeze({
  id: 'person-1',
  kind: 'human' as const,
  label: 'Person one',
});

function bindingCreateInput(
  target: JsonValue,
  selected: readonly Readonly<{ id: string; kind: string }>[] = [{ id: 'person-1', kind: 'human' }],
) {
  return {
    connectionId: 'connection-1',
    expectedConnectionRevision: 4,
    endpointSelection: {
      query: 'Alice',
      selected: { kind: 'direct' as const, audience: 'direct' as const, id: 'chat-1' },
    },
    principalSelection: { query: 'Person one', selected },
    target,
  };
}

function providerContributionSnapshot(
  immutableGenerationId = 'provider-generation-1',
  targetGeneration = `channels-generation-${immutableGenerationId}`,
) {
  const endpointResolve = admittedProviderOperation('endpointResolve', immutableGenerationId);
  const principalResolve = admittedProviderOperation('principalResolve', immutableGenerationId);
  return {
    endpointResolve,
    principalResolve,
    snapshot: {
      generation: targetGeneration,
      contributions: [{
        contributor: {
          pluginId: materialization.pluginId,
          contributionId: 'test-provider',
          immutableGenerationId,
        },
        protocol: { id: 'happier.channels/providers', version: 1 },
        operations: {
          endpointResolve,
          principalResolve,
        },
      }],
    },
  };
}

function createCollection(initial: readonly StateRow[]) {
  const rows = new Map(initial.map((row) => [row.rowId, row]));
  const batches: StateMutation[][] = [];
  const gets: string[] = [];
  const queries: StateQueryInput[] = [];
  return {
    rows,
    batches,
    gets,
    queries,
    async get(rowId: string) {
      gets.push(rowId);
      return rows.get(rowId) ?? null;
    },
    async query(input: StateQueryInput) {
      assertChannelsTestCollectionQueryLimit(input.limit);
      queries.push(input);
      if (input.index !== 'by-kind' || input.order !== 'asc') {
        throw new Error('Expected the canonical ascending Channel binding index.');
      }
      const matching = [...rows.values()]
        .filter((row) => row.value['record-kind'] === input.prefix?.[0])
        .sort((left, right) => left.rowId.localeCompare(right.rowId));
      const start = input.cursor === undefined
        ? 0
        : matching.findIndex((row) => row.rowId === input.cursor) + 1;
      const limit = input.limit ?? matching.length;
      const page = matching.slice(Math.max(0, start), Math.max(0, start) + limit);
      const next = matching[Math.max(0, start) + limit];
      return {
        rows: page,
        ...(next === undefined ? {} : { nextCursor: page.at(-1)?.rowId }),
        changeCursor: 1,
      };
    },
    async batch(operations: readonly StateMutation[]) {
      batches.push([...operations]);
      // The Account Data owner answers a conflict with the exact conflicting
      // rows, and `management.ts` iterates them. Publish them here so the
      // fake cannot silently exercise a shape the writer never receives.
      const conflicts = operations.flatMap((operation) => {
        const rowId = operation.kind === 'put' ? operation.value.id : operation.rowId;
        const current = rows.get(rowId);
        const matches = operation.expectedRevision === 'absent'
          ? current === undefined
          : current?.revision === operation.expectedRevision;
        return matches ? [] : [{ rowId, revision: current?.revision ?? 0, deleted: false as const }];
      });
      if (conflicts.length > 0) return { status: 'conflict' as const, conflicts };
      const results = operations.flatMap((operation) => {
        if (operation.kind !== 'put') return [];
        const revision = (rows.get(operation.value.id)?.revision ?? 0) + 1;
        rows.set(operation.value.id, { rowId: operation.value.id, revision, value: operation.value });
        return [{ rowId: operation.value.id, revision, deleted: false as const }];
      });
      // These cases never reread across a write, so the fake reports the same
      // stable change cursor its query pages publish.
      return { status: 'updated' as const, results, changeCursor: 1 };
    },
  };
}

function connectionRow(payloadOverrides: Readonly<Record<string, JsonValue>> = {}): StateRow {
  const authority = {
    providerPluginId: materialization.pluginId,
    providerContributionSelection: {
      contributionId: 'test-provider',
      immutableGenerationId: 'provider-generation-1',
    },
    providerSetupInput: { source: 'test' },
    credentialRef: null,
    transportOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
    providerConnectionKey: 'connection-key-1',
    providerConfig: {},
    routingIdentityKey: 'r'.repeat(43),
    integrationPrincipal: { id: 'bot-1', label: 'Test bot' },
    authorityEpoch: 1,
  } as const satisfies ConversationConnectionFixtureAuthority;
  const connection = createCurrentConversationConnectionFixture({
    connectionId: 'connection-1',
    authority,
    createdAt: 1_000,
    updatedAt: 1_000,
    transport: { kind: 'socket' },
    overlapSafety: 'safe',
    replayContinuity: 'none',
    outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
  });
  return {
    rowId: 'connection-1',
    revision: 4,
    value: {
      ...connection,
      payload: {
        ...connection.payload,
        ...payloadOverrides,
      },
    },
  };
}

function bindingRow(
  target: JsonValue,
  revision = 5,
  payloadOverrides: Readonly<Record<string, JsonValue>> = {},
): StateRow {
  return {
    rowId: 'binding-1',
    revision,
    value: {
      id: 'binding-1',
      'record-kind': 'binding',
      v: 1,
      'connection-id': 'connection-1',
      'binding-id': 'binding-1',
      'created-at': 1_000,
      'updated-at': 1_000,
      payload: {
        endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1', label: 'Alice' },
        target,
        allowedPrincipalIds: ['person-1'],
        allowBotSenders: false,
        inputMode: 'allAllowedMessages',
        inboundDebounceMs: 750,
        linkPreviewPolicy: 'suppress',
        senderFeedback: 'off',
        authorityEpoch: 1,
        enabled: false,
        deletionState: 'none',
        ...payloadOverrides,
      },
    },
  };
}

function context(
  collection: ReturnType<typeof createCollection>,
  execute: ReturnType<typeof vi.fn>,
  executeAdmittedTargetedOperationWithExecutionOrigin: (action: unknown) => Promise<unknown> = vi.fn(async (action: unknown) => {
    if (action === endpointResolveAction) {
      return {
        result: { kind: 'resolved' as const, candidates: [bindingResolutionEndpoint] },
        executionOrigin: {
          serverIdentityId: 'server-1',
          materializationRef: materialization,
        },
      };
    }
    if (action === principalResolveAction) {
      return {
        result: { kind: 'resolved' as const, candidates: [bindingResolutionPrincipal] },
        executionOrigin: {
          serverIdentityId: 'server-1',
          materializationRef: materialization,
        },
      };
    }
    throw new Error('Unexpected provider resolution Action.');
  }),
  readCurrent: () => Promise<unknown> = vi.fn(async () => ({
    generation: 'channels-generation-1',
    contributions: [{
      contributor: {
        pluginId: materialization.pluginId,
        contributionId: 'test-provider',
        immutableGenerationId: 'provider-generation-1',
      },
      protocol: { id: 'happier.channels/providers', version: 1 },
      operations: {
        endpointResolve: endpointResolveAction,
        principalResolve: principalResolveAction,
      },
    }],
  })),
): PluginInvocationContext {
  return {
    signal: new AbortController().signal,
    services: {
      actions: { execute, executeAdmittedTargetedOperationWithExecutionOrigin },
      storage: { account: { collection: () => collection } },
      targetedContributions: {
        observeForSelf() {
          return {
            dispose() {},
            async readCurrent() {
              return await readCurrent();
            },
          };
        },
      },
    },
  } as unknown as PluginInvocationContext;
}

describe('Channels target-persisting binding management', () => {
  it('reads only one exact retained binding, distinguishes absence, and fails corrupt rows closed', async () => {
    const read = Reflect.get(management, 'readConversationBindingForInvocation');
    expect(read).toEqual(expect.any(Function));
    if (typeof read !== 'function') return;

    const hidden = bindingRow(sessionTarget);
    const collection = createCollection([
      bindingRow(sessionTarget),
      {
        ...hidden,
        rowId: 'binding-2',
        value: {
          ...hidden.value,
          id: 'binding-2',
          'binding-id': 'binding-2',
          payload: {
            ...hidden.value.payload,
            endpoint: { kind: 'shared', audience: 'shared', id: 'private-room-2', label: 'Private room' },
          },
        },
      },
    ]);
    const execute = vi.fn();

    await expect(read({ bindingId: 'binding-1' }, context(collection, execute))).resolves.toMatchObject({
      kind: 'ready',
      revision: 5,
      binding: {
        id: 'binding-1',
        connectionId: 'connection-1',
        endpoint: { id: 'chat-1', audience: 'direct' },
        allowedPrincipalIds: ['person-1'],
        target: sessionTarget,
      },
    });
    expect(collection.gets).toEqual(['binding-1']);
    expect(collection.queries).toEqual([]);
    expect(collection.batches).toEqual([]);
    expect(execute).not.toHaveBeenCalled();

    const absent = createCollection([]);
    await expect(read({ bindingId: 'binding-1' }, context(absent, execute))).resolves.toEqual({ kind: 'notFound' });
    expect(absent.gets).toEqual(['binding-1']);
    expect(absent.batches).toEqual([]);

    const finalizing = createCollection([
      bindingRow(sessionTarget, 5, { deletionState: 'finalizingDelete' }),
    ]);
    await expect(read({ bindingId: 'binding-1' }, context(finalizing, execute))).resolves.toMatchObject({
      kind: 'ready',
      binding: { deletionState: 'finalizingDelete' },
    });
    expect(finalizing.batches).toEqual([]);

    const corrupt = createCollection([
      bindingRow(sessionTarget, 5, { allowedPrincipalIds: [] }),
    ]);
    await expect(read({ bindingId: 'binding-1' }, context(corrupt, execute))).rejects.toMatchObject({
      code: 'channels_binding_read_corrupt',
    });
    expect(corrupt.batches).toEqual([]);
  });

  it('resolves an arbitrary admitted provider audience and atomically persists its endpoint, allowlist, clamp, target, and frontier', async () => {
    const update = Reflect.get(management, 'updateConversationBindingForInvocation');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const resolvedEndpoint = {
      kind: 'shared' as const,
      audience: 'shared' as const,
      id: 'external-room-2',
      label: 'External support room',
    };
    const resolvedPrincipal = {
      id: 'external-principal-2',
      kind: 'human' as const,
      label: 'External operator',
    };
    const resolve = vi.fn(async (action: unknown) => {
      if (action === endpointResolveAction) {
        return {
          result: { kind: 'resolved' as const, candidates: [resolvedEndpoint] },
          executionOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
        };
      }
      if (action === principalResolveAction) {
        return {
          result: { kind: 'resolved' as const, candidates: [resolvedPrincipal] },
          executionOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
        };
      }
      throw new Error('Unexpected external provider resolver.');
    });
    const execute = vi.fn(async (action: string, request: unknown) => {
      expect(action).toBe('session.transcript.get');
      expect(request).toMatchObject({ sessionId: 'session-2', projection: 'externalShareableV1' });
      return {
        ok: true,
        projection: 'externalShareableV1',
        sessionId: 'session-2',
        scannedThroughSeq: 12,
        nextCursor: 'cursor-12',
        hasMore: false,
        items: [],
      };
    });
    const wideSessionTarget = {
      ...sessionTarget,
      policy: { ...sessionTarget.policy, permissionCeiling: 'yolo' },
    } as const;
    const collection = createCollection([connectionRow(), bindingRow(wideSessionTarget)]);

    await expect(update({
      bindingId: 'binding-1',
      expectedRevision: 5,
      audienceSelection: {
        expectedConnectionRevision: 4,
        endpointSelection: {
          query: 'external support',
          selected: { kind: 'shared', audience: 'shared', id: 'external-room-2' },
        },
        principalSelection: {
          query: 'external operator',
          selected: [{ id: 'external-principal-2', kind: 'human' }],
        },
      },
      target: {
        ...wideSessionTarget,
        sessionId: 'session-2',
      },
    }, context(collection, execute, resolve))).resolves.toMatchObject({
      kind: 'updated',
      bindingId: 'binding-1',
      authorityEpoch: 2,
    });

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(collection.batches).toHaveLength(1);
    expect(collection.batches[0]).toEqual([
      { kind: 'assert', rowId: 'connection-1', expectedRevision: 4 },
      expect.objectContaining({
        kind: 'put',
        expectedRevision: 5,
        value: expect.objectContaining({
          id: 'binding-1',
          payload: expect.objectContaining({
            endpoint: resolvedEndpoint,
            allowedPrincipalIds: ['external-principal-2'],
            authorityEpoch: 2,
            target: expect.objectContaining({
              kind: 'session',
              sessionId: 'session-2',
              policy: expect.objectContaining({
                permissionCeiling: 'read-only',
                approvals: { kind: 'off' },
              }),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        kind: 'put',
        expectedRevision: 'absent',
        value: expect.objectContaining({
          'record-kind': 'projection-frontier',
          payload: expect.objectContaining({ targetSessionId: 'session-2' }),
        }),
      }),
    ]);
  });

  it('returns stale with zero writes when a selected resolver candidate no longer matches', async () => {
    const update = Reflect.get(management, 'updateConversationBindingForInvocation');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(sessionTarget)]);
    const resolve = vi.fn(async (action: unknown) => {
      if (action !== endpointResolveAction) throw new Error('Principal resolution must not run after endpoint mismatch.');
      return {
        result: {
          kind: 'resolved' as const,
          candidates: [{ kind: 'direct' as const, audience: 'direct' as const, id: 'different-endpoint' }],
        },
        executionOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
      };
    });

    await expect(update({
      bindingId: 'binding-1',
      expectedRevision: 5,
      audienceSelection: {
        expectedConnectionRevision: 4,
        endpointSelection: {
          query: 'expected endpoint',
          selected: { kind: 'direct', audience: 'direct', id: 'missing-endpoint' },
        },
        principalSelection: {
          query: 'operator',
          selected: [{ id: 'person-1', kind: 'human' }],
        },
      },
    }, context(collection, vi.fn(), resolve))).resolves.toEqual({ kind: 'stale' });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(collection.batches).toEqual([]);
  });

  it('rejects repeated update principal identities before any resolver or binding write', async () => {
    const update = Reflect.get(management, 'updateConversationBindingForInvocation');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(sessionTarget)]);
    const resolve = vi.fn();
    await expect(update({
      bindingId: 'binding-1',
      expectedRevision: 5,
      allowBotSenders: true,
      audienceSelection: {
        expectedConnectionRevision: 4,
        endpointSelection: {
          query: 'Alice',
          selected: { kind: 'direct', audience: 'direct', id: 'chat-1' },
        },
        principalSelection: {
          query: 'person',
          selected: [
            { id: 'person-1', kind: 'human' },
            { id: 'person-1', kind: 'bot' },
          ],
        },
      },
    }, context(collection, vi.fn(), resolve))).rejects.toMatchObject({
      code: 'channels_binding_update_principal_selection_invalid',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(collection.batches).toEqual([]);
  });

  it('returns stale with zero writes when the admitted provider target generation changes during audience resolution', async () => {
    const update = Reflect.get(management, 'updateConversationBindingForInvocation');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const original = providerContributionSnapshot('provider-generation-1');
    const replacement = providerContributionSnapshot(
      'provider-generation-1',
      'channels-generation-2',
    );
    const readCurrent = vi.fn()
      .mockResolvedValueOnce(original.snapshot)
      .mockResolvedValue(replacement.snapshot);
    const collection = createCollection([connectionRow(), bindingRow(sessionTarget)]);
    const resolve = vi.fn(async (action: unknown) => {
      if (action !== original.endpointResolve) throw new Error('Principal resolution must not run after contribution drift.');
      return {
        result: {
          kind: 'resolved' as const,
          candidates: [{ kind: 'direct' as const, audience: 'direct' as const, id: 'chat-1', label: 'Alice' }],
        },
        executionOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
      };
    });

    await expect(update({
      bindingId: 'binding-1',
      expectedRevision: 5,
      audienceSelection: {
        expectedConnectionRevision: 4,
        endpointSelection: {
          query: 'Alice',
          selected: { kind: 'direct', audience: 'direct', id: 'chat-1' },
        },
        principalSelection: {
          query: 'person',
          selected: [{ id: 'person-1', kind: 'human' }],
        },
      },
    }, context(collection, vi.fn(), resolve, readCurrent))).resolves.toEqual({ kind: 'stale' });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(collection.batches).toEqual([]);
  });

  it('revalidates the binding connection after target verification before an audience mutation can reach storage', async () => {
    const update = Reflect.get(management, 'updateConversationBindingForInvocation');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(sessionTarget)]);
    const resolve = vi.fn(async (action: unknown) => {
      if (action === endpointResolveAction) {
        return {
          result: { kind: 'resolved' as const, candidates: [bindingResolutionEndpoint] },
          executionOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
        };
      }
      if (action === principalResolveAction) {
        return {
          result: { kind: 'resolved' as const, candidates: [bindingResolutionPrincipal] },
          executionOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
        };
      }
      throw new Error('Unexpected provider resolver.');
    });
    const execute = vi.fn(async (action: string) => {
      expect(action).toBe('automation.conversation.target.verify');
      const current = collection.rows.get('connection-1');
      if (current === undefined) throw new Error('Expected current connection row.');
      collection.rows.set('connection-1', { ...current, revision: current.revision + 1 });
      return { kind: 'verified' as const, templateVersion: 8 };
    });

    await expect(update({
      bindingId: 'binding-1',
      expectedRevision: 5,
      audienceSelection: {
        expectedConnectionRevision: 4,
        endpointSelection: {
          query: 'Alice',
          selected: { kind: 'direct', audience: 'direct', id: 'chat-1' },
        },
        principalSelection: {
          query: 'person',
          selected: [{ id: 'person-1', kind: 'human' }],
        },
      },
      target: automationTarget,
    }, context(collection, execute, resolve))).resolves.toEqual({ kind: 'stale' });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(collection.batches).toEqual([]);
    expect(collection.rows.get('binding-1')?.value.payload).toMatchObject({ target: sessionTarget });
  });

  it('starts binding deletion with one finalizing CAS, while stale active revisions write nothing and finalizing retries rejoin', async () => {
    const remove = Reflect.get(management, 'deleteConversationBindingForInvocation');
    expect(remove).toEqual(expect.any(Function));
    if (typeof remove !== 'function') return;

    const execute = vi.fn();
    const active = createCollection([
      connectionRow(),
      bindingRow(sessionTarget, 5, { enabled: true }),
    ]);
    await expect(remove({
      bindingId: 'binding-1',
      expectedRevision: 5,
    }, context(active, execute))).resolves.toEqual({ kind: 'deletionPending' });
    expect(active.batches).toEqual([[
      expect.objectContaining({
        kind: 'put',
        expectedRevision: 4,
        value: expect.objectContaining({ id: 'connection-1' }),
      }),
      expect.objectContaining({
        kind: 'put',
        expectedRevision: 5,
        value: expect.objectContaining({
          id: 'binding-1',
          'binding-id': 'binding-1',
          payload: expect.objectContaining({
            enabled: false,
            authorityEpoch: 2,
            deletionState: 'finalizingDelete',
          }),
        }),
      }),
    ]]);
    expect(execute).not.toHaveBeenCalled();

    const stale = createCollection([connectionRow(), bindingRow(sessionTarget, 6)]);
    await expect(remove({
      bindingId: 'binding-1',
      expectedRevision: 5,
    }, context(stale, execute))).rejects.toMatchObject({
      code: 'channels_binding_delete_conflict',
      retryable: true,
    });
    expect(stale.batches).toEqual([]);

    const rejoining = createCollection([
      connectionRow(),
      bindingRow(sessionTarget, 6, {
        enabled: false,
        authorityEpoch: 2,
        deletionState: 'finalizingDelete',
      }),
    ]);
    await expect(remove({
      bindingId: 'binding-1',
      expectedRevision: 5,
    }, context(rejoining, execute))).resolves.toEqual({ kind: 'deletionPending' });
    expect(rejoining.batches).toEqual([]);

    const absent = createCollection([connectionRow()]);
    await expect(remove({
      bindingId: 'binding-1',
      expectedRevision: 5,
    }, context(absent, execute))).resolves.toEqual({ kind: 'deleted' });
    expect(absent.batches).toEqual([]);
  });

  it('persists the owner-chosen enabled approval policy on create', async () => {
    const create = Reflect.get(management, 'createConversationBindingForInvocation');
    expect(create).toEqual(expect.any(Function));
    if (typeof create !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const execute = vi.fn(async () => ({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-1',
      scannedThroughSeq: 12,
      nextCursor: 'cursor-12',
      hasMore: false,
      items: [],
    }));

    await expect(create(
      { ...bindingCreateInput(approvalEnabledSessionTarget), enabled: true },
      context(collection, execute),
    )).resolves.toMatchObject({ kind: 'created' });

    // The persisted policy is the only chat-approval control, so the writer
    // stores the owner's exact ceiling instead of clamping it away.
    const created = [...collection.rows.values()].find(
      (row) => row.value['record-kind'] === 'binding',
    );
    expect(created?.value.payload).toMatchObject({
      target: {
        kind: 'session',
        policy: { approvals: { kind: 'enabled', maximumScope: 'request' } },
      },
    });
    expect(created?.value.payload).toMatchObject({ enabled: true });
    expect(collection.rows.get('connection-1')?.revision).toBe(5);
  });

  it('refuses to persist an incoming message policy the integration cannot deliver in a shared conversation', async () => {
    // Telegram's group privacy mode is the real case: the platform withholds
    // ordinary supergroup messages, so `allAllowedMessages` is a promise it
    // will silently never keep.
    const create = Reflect.get(management, 'createConversationBindingForInvocation');
    expect(create).toEqual(expect.any(Function));
    if (typeof create !== 'function') return;

    const sharedEndpoint = Object.freeze({
      kind: 'shared' as const,
      audience: 'shared' as const,
      id: 'room-1',
      label: 'Project room',
    });
    const collection = createCollection([connectionRow({
      sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
    })]);
    const execute = vi.fn();
    const resolveShared = vi.fn(async (action: unknown) => ({
      result: action === endpointResolveAction
        ? { kind: 'resolved' as const, candidates: [sharedEndpoint] }
        : { kind: 'resolved' as const, candidates: [bindingResolutionPrincipal] },
      executionOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
    }));

    await expect(create({
      ...bindingCreateInput(sessionTarget),
      endpointSelection: {
        query: 'Project room',
        selected: { kind: 'shared' as const, audience: 'shared' as const, id: 'room-1' },
      },
      inputMode: 'allAllowedMessages',
    }, context(collection, execute, resolveShared))).rejects.toMatchObject({
      code: 'channels_binding_create_input_mode_unsupported',
      details: {
        inputMode: 'allAllowedMessages',
        deliverableInputModes: ['directMentionsOnly', 'addressedMessages'],
      },
    });
    expect(collection.batches).toHaveLength(0);
    expect([...collection.rows.keys()]).toEqual(['connection-1']);
  });

  it('persists a shared-conversation policy the integration proved it can deliver', async () => {
    const create = Reflect.get(management, 'createConversationBindingForInvocation');
    expect(create).toEqual(expect.any(Function));
    if (typeof create !== 'function') return;

    const sharedEndpoint = Object.freeze({
      kind: 'shared' as const,
      audience: 'shared' as const,
      id: 'room-1',
      label: 'Project room',
    });
    const collection = createCollection([connectionRow({
      sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
    })]);
    const execute = vi.fn(async () => ({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-1',
      scannedThroughSeq: 12,
      nextCursor: 'cursor-12',
      hasMore: false,
      items: [],
    }));
    const resolveShared = vi.fn(async (action: unknown) => ({
      result: action === endpointResolveAction
        ? { kind: 'resolved' as const, candidates: [sharedEndpoint] }
        : { kind: 'resolved' as const, candidates: [bindingResolutionPrincipal] },
      executionOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
    }));

    await expect(create({
      ...bindingCreateInput(sessionTarget),
      endpointSelection: {
        query: 'Project room',
        selected: { kind: 'shared' as const, audience: 'shared' as const, id: 'room-1' },
      },
      inputMode: 'addressedMessages',
    }, context(collection, execute, resolveShared))).resolves.toMatchObject({
      kind: 'created',
      binding: { inputMode: 'addressedMessages' },
    });
  });

  it('creates a Session target with its public no-history frontier in the same guarded binding batch', async () => {
    const create = Reflect.get(management, 'createConversationBindingForInvocation');
    expect(create).toEqual(expect.any(Function));
    if (typeof create !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const execute = vi.fn(async () => ({
      ok: true,
      projection: 'externalShareableV1',
      sessionId: 'session-1',
      scannedThroughSeq: 12,
      nextCursor: 'cursor-12',
      hasMore: false,
      items: [],
    }));

    await expect(create(
      bindingCreateInput(sessionTarget),
      context(collection, execute),
    )).resolves.toMatchObject({
      kind: 'created',
      binding: { target: { kind: 'session', sessionId: 'session-1' } },
    });

    expect(execute).toHaveBeenCalledWith(
      'session.transcript.get',
      {
        sessionId: 'session-1',
        projection: 'externalShareableV1',
        cursor: null,
        limit: 100,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const frontier = collection.batches[0]?.find((operation) => (
      operation.kind === 'put'
      && operation.value['record-kind'] === 'projection-frontier'
    ));
    expect(frontier).toMatchObject({
      kind: 'put',
      expectedRevision: 'absent',
      value: {
        'binding-id': expect.any(String),
        payload: {
          targetSessionId: 'session-1',
          transcriptCursor: 'cursor-12',
          lastScannedSeq: 12,
          revision: 1,
        },
      },
    });
  });

  it('creates an Automation binding only from the verifier-returned template version', async () => {
    const create = Reflect.get(management, 'createConversationBindingForInvocation');
    expect(create).toEqual(expect.any(Function));
    if (typeof create !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const execute = vi.fn(async () => ({ kind: 'verified' as const, templateVersion: 7 }));
    const result = await create(
      bindingCreateInput(automationTarget),
      context(collection, execute),
    );

    // The exact binding named to the verifier is this create's own freshly
    // minted identity, not any id the caller could have known beforehand.
    const createdBindingId = (result as Readonly<{ binding: Readonly<{ id: string }> }>).binding.id;
    expect(execute).toHaveBeenCalledWith(
      'automation.conversation.target.verify',
      {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toMatchObject({
      kind: 'created',
      binding: {
        target: {
          kind: 'automation',
          automationId: 'automation-1',
          templateVersion: 7,
          policy: { resultDelivery: 'none' },
        },
      },
    });
    const row = [...collection.rows.values()].find((candidate) => candidate.rowId !== 'connection-1');
    expect(row?.value.payload).toMatchObject({
      target: {
        kind: 'automation',
        automationId: 'automation-1',
        templateVersion: 7,
      },
    });
    expect((row?.value.payload as Readonly<Record<string, unknown>>).target).not.toHaveProperty('expectedTemplateVersion');
  });

  it.each([
    {
      name: 'the connection revision changes',
      expected: { kind: 'stale' },
      changeCurrentness(input: Readonly<{
        collection: ReturnType<typeof createCollection>;
        replaceProviderSnapshot: (snapshot: unknown) => void;
      }>) {
        const current = input.collection.rows.get('connection-1');
        if (current === undefined) throw new Error('Expected current connection row.');
        input.collection.rows.set('connection-1', { ...current, revision: current.revision + 1 });
      },
    },
    {
      name: 'the provider contribution retires',
      expected: { kind: 'unavailable', reason: 'providerUnavailable' },
      changeCurrentness(input: Readonly<{
        collection: ReturnType<typeof createCollection>;
        replaceProviderSnapshot: (snapshot: unknown) => void;
      }>) {
        input.replaceProviderSnapshot({
          generation: 'channels-generation-retired',
          contributions: [],
        });
      },
    },
    {
      name: 'the provider target generation changes',
      expected: { kind: 'stale' },
      changeCurrentness(input: Readonly<{
        collection: ReturnType<typeof createCollection>;
        replaceProviderSnapshot: (snapshot: unknown) => void;
      }>) {
        input.replaceProviderSnapshot(providerContributionSnapshot(
          'provider-generation-1',
          'channels-generation-2',
        ).snapshot);
      },
    },
  ] as const)('does not persist a binding when $name during Automation target verification', async ({
    expected,
    changeCurrentness,
  }) => {
    const create = Reflect.get(management, 'createConversationBindingForInvocation');
    expect(create).toEqual(expect.any(Function));
    if (typeof create !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const original = providerContributionSnapshot();
    let providerSnapshot: unknown = original.snapshot;
    const readCurrent = vi.fn(async () => providerSnapshot);
    const resolve = vi.fn(async (action: unknown) => {
      if (action === original.endpointResolve) {
        return {
          result: { kind: 'resolved' as const, candidates: [bindingResolutionEndpoint] },
          executionOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
        };
      }
      if (action === original.principalResolve) {
        return {
          result: { kind: 'resolved' as const, candidates: [bindingResolutionPrincipal] },
          executionOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
        };
      }
      throw new Error('Unexpected provider resolution Action.');
    });
    const execute = vi.fn(async (action: string) => {
      expect(action).toBe('automation.conversation.target.verify');
      changeCurrentness({
        collection,
        replaceProviderSnapshot(snapshot) {
          providerSnapshot = snapshot;
        },
      });
      return { kind: 'verified' as const, templateVersion: 8 };
    });

    await expect(create(
      bindingCreateInput(automationTarget),
      context(collection, execute, resolve, readCurrent),
    )).resolves.toEqual(expected);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(collection.batches).toEqual([]);
    expect([...collection.rows.keys()]).toEqual(['connection-1']);
  });

  it('persists final-result delivery after the Automation verifier accepts its Session target', async () => {
    const create = Reflect.get(management, 'createConversationBindingForInvocation');
    expect(create).toEqual(expect.any(Function));
    if (typeof create !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const execute = vi.fn(async () => ({ kind: 'verified' as const, templateVersion: 3 }));

    await expect(create(
      bindingCreateInput(finalResultAutomationTarget),
      context(collection, execute),
    )).resolves.toMatchObject({
      kind: 'created',
      binding: { target: { policy: { resultDelivery: 'finalResult' } } },
    });

    expect(execute).toHaveBeenCalledWith(
      'automation.conversation.target.verify',
      {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
        resultDelivery: 'finalResult',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(collection.batches).toHaveLength(1);
  });

  it('rejects an execution-run final-result target before saving a binding', async () => {
    const create = Reflect.get(management, 'createConversationBindingForInvocation');
    expect(create).toEqual(expect.any(Function));
    if (typeof create !== 'function') return;

    const collection = createCollection([connectionRow()]);
    // The verifier owns the Automation target type. This is its typed result
    // for an execution_run target that cannot produce a final result.
    const execute = vi.fn(async () => ({
      kind: 'notVerified' as const,
      reason: 'resultDeliveryUnsupported' as const,
    }));

    await expect(create(
      bindingCreateInput(finalResultAutomationTarget),
      context(collection, execute),
    )).resolves.toEqual({ kind: 'notVerified', reason: 'resultDeliveryUnsupported' });

    expect(execute).toHaveBeenCalledWith(
      'automation.conversation.target.verify',
      {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
        resultDelivery: 'finalResult',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(collection.batches).toEqual([]);
    expect([...collection.rows.keys()]).toEqual(['connection-1']);
  });

  it('rejects a repeated immutable principal ID across structurally distinct create selections before any Channel write', async () => {
    const create = Reflect.get(management, 'createConversationBindingForInvocation');
    expect(create).toEqual(expect.any(Function));
    if (typeof create !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const execute = vi.fn();
    await expect(create(
      {
        ...bindingCreateInput(sessionTarget, [
          { id: 'person-1', kind: 'human' },
          { id: 'person-1', kind: 'bot' },
        ]),
        allowBotSenders: true,
      },
      context(collection, execute),
    )).rejects.toMatchObject({
      code: 'channels_binding_create_principal_selection_invalid',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(collection.batches).toHaveLength(0);
  });

  it('returns verifier feedback from create without creating a Channel row', async () => {
    const create = Reflect.get(management, 'createConversationBindingForInvocation');
    expect(create).toEqual(expect.any(Function));
    if (typeof create !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const execute = vi.fn(async () => ({ kind: 'notVerified' as const, reason: 'templateVersionMismatch' as const }));
    await expect(create(
      bindingCreateInput(automationTarget),
      context(collection, execute),
    )).resolves.toEqual({ kind: 'notVerified', reason: 'templateVersionMismatch' });

    expect(execute).toHaveBeenCalledWith(
      'automation.conversation.target.verify',
      {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(collection.batches).toHaveLength(0);
    expect([...collection.rows.keys()]).toEqual(['connection-1']);
  });

  it('updates an Automation target from the verifier result rather than the caller precondition', async () => {
    const update = Reflect.get(management, 'updateConversationBindingForInvocation');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(sessionTarget)]);
    const execute = vi.fn(async () => ({ kind: 'verified' as const, templateVersion: 8 }));
    await expect(update({
      bindingId: 'binding-1',
      expectedRevision: 5,
      target: automationTarget,
    }, context(collection, execute))).resolves.toMatchObject({ kind: 'updated', bindingId: 'binding-1' });

    expect(execute).toHaveBeenCalledWith(
      'automation.conversation.target.verify',
      {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(collection.rows.get('binding-1')?.value.payload).toMatchObject({
      target: { kind: 'automation', automationId: 'automation-1', templateVersion: 8 },
    });
  });

  it('persists final-result delivery through the Automation verifier before the canonical binding update', async () => {
    const mutate = Reflect.get(management, 'updateConversationBindingForInvocation');
    expect(mutate).toEqual(expect.any(Function));
    if (typeof mutate !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(sessionTarget)]);
    const execute = vi.fn(async () => ({ kind: 'verified' as const, templateVersion: 3 }));

    await expect(mutate({
      bindingId: 'binding-1',
      expectedRevision: 5,
      target: finalResultAutomationTarget,
    }, context(collection, execute))).resolves.toMatchObject({ kind: 'updated', bindingId: 'binding-1' });

    expect(execute).toHaveBeenCalledWith(
      'automation.conversation.target.verify',
      {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
        resultDelivery: 'finalResult',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(collection.batches).toHaveLength(1);
    expect(collection.rows.get('binding-1')?.value.payload).toMatchObject({
      target: retainedFinalResultAutomationTarget,
    });
  });

  it('rejects a retained UTF-8-overflow allowlist before an existing binding update can write it back', async () => {
    const update = Reflect.get(management, 'updateConversationBindingForInvocation');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([
      connectionRow(),
      bindingRow(sessionTarget, 5, { allowedPrincipalIds: ['😀'.repeat(128)] }),
    ]);
    const execute = vi.fn();

    await expect(update({
      bindingId: 'binding-1',
      expectedRevision: 5,
      senderFeedback: 'eligibleRefusals',
    }, context(collection, execute))).rejects.toMatchObject({
      code: 'channels_binding_set_enabled_corrupt',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(collection.batches).toHaveLength(0);
    expect(collection.rows.get('binding-1')?.value.payload).toMatchObject({
      allowedPrincipalIds: ['😀'.repeat(128)],
      senderFeedback: 'off',
    });
  });

  it('persists an owner-enabled approval policy through the canonical binding update', async () => {
    const mutate = Reflect.get(management, 'updateConversationBindingForInvocation');
    expect(mutate).toEqual(expect.any(Function));
    if (typeof mutate !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(sessionTarget)]);
    const execute = vi.fn();

    await expect(mutate({
      bindingId: 'binding-1',
      expectedRevision: 5,
      target: approvalEnabledSessionTarget,
    }, context(collection, execute))).resolves.toMatchObject({ kind: 'updated' });

    expect(collection.rows.get('binding-1')?.value.payload).toMatchObject({
      target: approvalEnabledSessionTarget,
    });
  });

  it('carries a retained enabled approval policy unchanged through an unrelated binding update', async () => {
    const update = Reflect.get(management, 'updateConversationBindingForInvocation');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(approvalEnabledSessionTarget)]);
    const execute = vi.fn();

    await expect(update({
      bindingId: 'binding-1',
      expectedRevision: 5,
      senderFeedback: 'eligibleRefusals',
    }, context(collection, execute))).resolves.toMatchObject({ kind: 'updated' });

    // An unrelated field edit must neither reset nor widen the retained
    // approval ceiling: the target is carried, not rebuilt.
    expect(collection.rows.get('binding-1')?.value.payload).toMatchObject({
      target: approvalEnabledSessionTarget,
      senderFeedback: 'eligibleRefusals',
    });
  });

  it('reactivates a retained final-result binding through Account-local enablement', async () => {
    const setEnabled = Reflect.get(management, 'setConversationBindingEnabledInAccountCollection');
    expect(setEnabled).toEqual(expect.any(Function));
    if (typeof setEnabled !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(retainedFinalResultAutomationTarget)]);
    await expect(setEnabled({
      collection,
      bindingId: 'binding-1',
      expectedRevision: 5,
      enabled: true,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'updated',
      bindingId: 'binding-1',
      revision: 6,
      authorityEpoch: 2,
    });

    expect(collection.batches).toHaveLength(1);
    expect(collection.rows.get('binding-1')?.value.payload).toMatchObject({
      target: retainedFinalResultAutomationTarget,
      enabled: true,
    });
  });

  it('does not persist an Automation update when the connection changes during verification', async () => {
    const update = Reflect.get(management, 'updateConversationBindingForInvocation');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(sessionTarget)]);
    const execute = vi.fn(async () => {
      const current = collection.rows.get('connection-1');
      if (current === undefined) throw new Error('Expected current connection row.');
      collection.rows.set('connection-1', { ...current, revision: current.revision + 1 });
      return { kind: 'verified' as const, templateVersion: 8 };
    });
    await expect(update({
      bindingId: 'binding-1',
      expectedRevision: 5,
      target: automationTarget,
    }, context(collection, execute))).rejects.toMatchObject({
      code: 'channels_binding_update_conflict',
      retryable: true,
    });

    expect(collection.batches).toHaveLength(1);
    expect(collection.rows.get('binding-1')?.value.payload).toMatchObject({ target: sessionTarget });
  });

  it('leaves a target-bearing update entirely unwritten when the verifier rejects it', async () => {
    const update = Reflect.get(management, 'updateConversationBindingForInvocation');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(sessionTarget)]);
    const execute = vi.fn(async () => ({ kind: 'notVerified' as const, reason: 'templateVersionMismatch' as const }));
    await expect(update({
      bindingId: 'binding-1',
      expectedRevision: 5,
      target: automationTarget,
    }, context(collection, execute))).resolves.toEqual({
      kind: 'notVerified',
      reason: 'templateVersionMismatch',
    });

    expect(execute).toHaveBeenCalledWith(
      'automation.conversation.target.verify',
      {
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(collection.batches).toHaveLength(0);
    expect(collection.rows.get('binding-1')?.value.payload).toMatchObject({ target: sessionTarget });
  });

  it('shares one direct Account Collection binding index with the 200-row page ceiling and safe management projection', async () => {
    const read = Reflect.get(management, 'readConversationBindingManagementRows');
    expect(read).toEqual(expect.any(Function));
    if (typeof read !== 'function') return;

    const bindings = Array.from({ length: 256 }, (_, index) => {
      const id = `binding-${String(index + 1).padStart(3, '0')}`;
      return {
        ...bindingRow(sessionTarget),
        rowId: id,
        revision: index + 1,
        value: {
          ...bindingRow(sessionTarget).value,
          id,
          'binding-id': id,
          payload: {
            ...bindingRow(sessionTarget).value.payload,
            endpoint: {
              kind: 'direct',
              audience: 'direct',
              id: `endpoint-private-${id}`,
              label: `Support ${id}`,
            },
          },
        },
      } satisfies StateRow;
    });
    const collection = createCollection([connectionRow(), ...bindings]);

    await expect(read({
      collection,
      signal: new AbortController().signal,
    })).resolves.toEqual(expect.objectContaining({
      bindings: expect.arrayContaining([
        expect.objectContaining({
          bindingId: 'binding-001',
          endpoint: { audience: 'direct', label: 'Support binding-001' },
          target: { kind: 'session', summary: 'session-1' },
        }),
        expect.objectContaining({ bindingId: 'binding-256' }),
      ]),
    }));
    expect(collection.batches).toHaveLength(0);
    expect(collection.queries).toEqual([
      expect.objectContaining({
        index: 'by-kind',
        prefix: ['binding'],
        order: 'asc',
        limit: 200,
      }),
      expect.objectContaining({
        index: 'by-kind',
        prefix: ['binding'],
        order: 'asc',
        cursor: 'binding-200',
        limit: 56,
      }),
    ]);
  });

  it('shares one paginated direct Account Collection attention query with retry CAS facts', async () => {
    const read = Reflect.get(management, 'readConversationIngressAttentionPage');
    expect(read).toEqual(expect.any(Function));
    if (typeof read !== 'function') return;

    const query = vi.fn(async () => ({
      rows: [{
        rowId: 'A'.repeat(43),
        revision: 7,
        value: {
          id: 'A'.repeat(43),
          'record-kind': 'ingress-obligation',
          v: 1,
          'connection-id': 'connection-1',
          'binding-id': 'binding-1',
          terminal: false,
          attention: true,
          'created-at': 10,
          'updated-at': 20,
          payload: {
            occurrenceIds: ['occurrence-1'],
            censusId: 'B'.repeat(43),
            target: { kind: 'session' },
            sourceAuthority: {
              connectionAuthorityEpoch: 1,
              bindingRevision: 2,
              bindingAuthorityEpoch: 3,
            },
            lifecycle: { phase: 'blocked', attemptCount: 5, dueAt: null },
            disposition: null,
            nonAdmission: null,
          },
        },
      }],
      nextCursor: 'cursor-2',
      changeCursor: 1,
    }));

    await expect(read({
      collection: { query },
      cursor: 'cursor-1',
      limit: 500,
    })).resolves.toEqual({
      obligations: [{
        kind: 'blocked',
        obligationId: 'A'.repeat(43),
        revision: 7,
        connectionId: 'connection-1',
        bindingId: 'binding-1',
        attemptCount: 5,
        updatedAt: 20,
      }],
      nextCursor: 'cursor-2',
    });
    expect(query).toHaveBeenCalledWith({
      index: 'by-attention',
      prefix: [true],
      order: 'asc',
      cursor: 'cursor-1',
      limit: 200,
    }, undefined);
  });

  it('pages terminal ingress attention without turning a recorded refusal into a retry candidate', async () => {
    const read = Reflect.get(management, 'readConversationIngressAttentionPage');
    expect(read).toEqual(expect.any(Function));
    if (typeof read !== 'function') return;

    const query = vi.fn(async () => ({
      rows: [{
        rowId: 'T'.repeat(43),
        revision: 8,
        value: {
          id: 'T'.repeat(43),
          'record-kind': 'ingress-obligation',
          v: 1,
          'connection-id': 'connection-1',
          'binding-id': 'binding-1',
          terminal: true,
          attention: true,
          'created-at': 10,
          'updated-at': 21,
          payload: {
            occurrenceIds: ['occurrence-1'],
            censusId: 'B'.repeat(43),
            target: null,
            sourceAuthority: {
              connectionAuthorityEpoch: 1,
              bindingRevision: 2,
              bindingAuthorityEpoch: 3,
            },
            lifecycle: { phase: 'terminal', attemptCount: 0, dueAt: null },
            disposition: 'rejected',
            nonAdmission: { reason: 'messageTooLarge', senderFeedbackEligible: true },
          },
        },
      }],
      changeCursor: 1,
    }));

    await expect(read({ collection: { query } })).resolves.toEqual({
      obligations: [{
        kind: 'terminal',
        obligationId: 'T'.repeat(43),
        revision: 8,
        connectionId: 'connection-1',
        bindingId: 'binding-1',
        updatedAt: 21,
      }],
    });
  });

  it('shares the guarded Account-local binding enablement CAS with the online Action owner', async () => {
    const setEnabled = Reflect.get(management, 'setConversationBindingEnabledInAccountCollection');
    expect(setEnabled).toEqual(expect.any(Function));
    if (typeof setEnabled !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(sessionTarget)]);
    await expect(setEnabled({
      collection,
      bindingId: 'binding-1',
      expectedRevision: 5,
      enabled: true,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'updated',
      bindingId: 'binding-1',
      revision: 6,
      authorityEpoch: 2,
    });
    expect(collection.batches).toEqual([[
      expect.objectContaining({
        kind: 'put',
        expectedRevision: 4,
        value: expect.objectContaining({ id: 'connection-1' }),
      }),
      expect.objectContaining({
        kind: 'put',
        expectedRevision: 5,
        value: expect.objectContaining({
          id: 'binding-1',
          'binding-id': 'binding-1',
          payload: expect.objectContaining({
            enabled: true,
            authorityEpoch: 2,
          }),
        }),
      }),
    ]]);
  });

  it('refuses to enable a retained shared binding whose resulting policy exceeds the connection capability', async () => {
    const setEnabled = Reflect.get(management, 'setConversationBindingEnabledInAccountCollection');
    expect(setEnabled).toEqual(expect.any(Function));
    if (typeof setEnabled !== 'function') return;

    const collection = createCollection([
      connectionRow({
        sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
      }),
      bindingRow(sessionTarget, 5, {
        endpoint: { kind: 'shared', audience: 'shared', id: 'room-1', label: 'Project room' },
        inputMode: 'allAllowedMessages',
        enabled: false,
      }),
    ]);

    await expect(setEnabled({
      collection,
      bindingId: 'binding-1',
      expectedRevision: 5,
      enabled: true,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'channels_binding_set_enabled_input_mode_unsupported',
    });
    expect(collection.batches).toEqual([]);
  });

  it('validates the complete resulting enabled policy through the online binding update owner', async () => {
    const update = Reflect.get(management, 'updateConversationBindingForInvocation');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([
      connectionRow({
        sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
      }),
      bindingRow(sessionTarget, 5, {
        endpoint: { kind: 'shared', audience: 'shared', id: 'room-1', label: 'Project room' },
        inputMode: 'allAllowedMessages',
        enabled: false,
      }),
    ]);

    await expect(update({
      bindingId: 'binding-1',
      expectedRevision: 5,
      enabled: true,
    }, context(collection, vi.fn()))).rejects.toMatchObject({
      code: 'channels_binding_update_input_mode_unsupported',
    });
    expect(collection.batches).toEqual([]);
  });

  it('generalizes the offline Account-local writer only across locally decidable binding policy', async () => {
    const update = Reflect.get(management, 'updateConversationBindingPolicyInAccountCollection');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(sessionTarget)]);
    await expect(update({
      collection,
      bindingId: 'binding-1',
      expectedRevision: 5,
      allowBotSenders: true,
      inputMode: 'addressedMessages',
      inboundDebounceMs: 1_500,
      linkPreviewPolicy: 'providerDefault',
      senderFeedback: 'eligibleRefusals',
      enabled: true,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'updated',
      bindingId: 'binding-1',
      revision: 6,
      authorityEpoch: 2,
    });

    expect(collection.batches).toEqual([[
      expect.objectContaining({
        kind: 'put',
        expectedRevision: 4,
        value: expect.objectContaining({ id: 'connection-1' }),
      }),
      expect.objectContaining({
        kind: 'put',
        expectedRevision: 5,
        value: expect.objectContaining({
          id: 'binding-1',
          payload: expect.objectContaining({
            allowBotSenders: true,
            inputMode: 'addressedMessages',
            inboundDebounceMs: 1_500,
            linkPreviewPolicy: 'providerDefault',
            senderFeedback: 'eligibleRefusals',
            enabled: true,
            authorityEpoch: 2,
            endpoint: bindingResolutionEndpoint,
            allowedPrincipalIds: ['person-1'],
            target: sessionTarget,
          }),
        }),
      }),
    ]]);
  });

  it('does not let Account-local enablement reopen a finalizing direct binding delete', async () => {
    const setEnabled = Reflect.get(management, 'setConversationBindingEnabledInAccountCollection');
    expect(setEnabled).toEqual(expect.any(Function));
    if (typeof setEnabled !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(sessionTarget, 5, {
      enabled: false,
      authorityEpoch: 2,
      deletionState: 'finalizingDelete',
    })]);

    await expect(setEnabled({
      collection,
      bindingId: 'binding-1',
      expectedRevision: 5,
      enabled: true,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'channels_binding_set_enabled_delete_in_progress',
      retryable: false,
    });
    expect(collection.batches).toEqual([]);
    expect(collection.rows.get('binding-1')?.value.payload).toMatchObject({
      enabled: false,
      authorityEpoch: 2,
      deletionState: 'finalizingDelete',
    });
  });

  it('carries a retained enabled approval policy unchanged through Account-local enablement', async () => {
    const setEnabled = Reflect.get(management, 'setConversationBindingEnabledInAccountCollection');
    expect(setEnabled).toEqual(expect.any(Function));
    if (typeof setEnabled !== 'function') return;

    const collection = createCollection([connectionRow(), bindingRow(approvalEnabledSessionTarget)]);
    await expect(setEnabled({
      collection,
      bindingId: 'binding-1',
      expectedRevision: 5,
      enabled: true,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ kind: 'updated', bindingId: 'binding-1', revision: 6 });

    expect(collection.rows.get('binding-1')?.value.payload).toMatchObject({
      target: approvalEnabledSessionTarget,
      enabled: true,
    });
  });

  it('shares the guarded Account-local connection policy CAS with the online Action owner', async () => {
    const update = Reflect.get(management, 'updateConversationConnectionInAccountCollection');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([connectionRow()]);
    await expect(update({
      collection,
      connectionId: 'connection-1',
      expectedRevision: 4,
      enabled: false,
      maximumObservationAgeMs: 120_000,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'updated',
      connectionId: 'connection-1',
      revision: 5,
      authorityEpoch: 2,
    });
    expect(collection.batches).toEqual([[
      expect.objectContaining({
        kind: 'put',
        expectedRevision: 4,
        value: expect.objectContaining({
          id: 'connection-1',
          'connection-id': 'connection-1',
          payload: expect.objectContaining({
            enabled: false,
            authorityEpoch: 2,
            maximumObservationAgeMs: 120_000,
            historyGap: null,
            pollFailure: null,
          }),
        }),
      }),
    ]]);
  });

  it('rejects unknown connection-update fields before the lifecycle writer', async () => {
    const update = Reflect.get(management, 'updateConversationConnectionForInvocation');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([connectionRow()]);
    await expect(update({
      connectionId: 'connection-1',
      expectedRevision: 4,
      enabled: false,
      maximumObservationAgeMs: 120_000,
      unexpected: true,
    }, context(collection, vi.fn()))).rejects.toMatchObject({
      code: 'channels_connection_update_input_invalid',
    });
    expect(collection.batches).toEqual([]);
  });

  it('uses the public connection-update range before the lifecycle writer', async () => {
    const update = Reflect.get(management, 'updateConversationConnectionForInvocation');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([connectionRow()]);
    await expect(update({
      connectionId: 'connection-1',
      expectedRevision: 4,
      enabled: false,
      maximumObservationAgeMs: 30 * 86_400_000 + 1,
    }, context(collection, vi.fn()))).rejects.toMatchObject({
      code: 'channels_connection_update_input_invalid',
    });
    expect(collection.batches).toEqual([]);
  });

  it('cannot bypass frozen transfer-stop custody through the Account-local connection policy writer', async () => {
    const update = Reflect.get(management, 'updateConversationConnectionInAccountCollection');
    expect(update).toEqual(expect.any(Function));
    if (typeof update !== 'function') return;

    const collection = createCollection([connectionRow({
      authorityEpoch: 2,
      pendingOldTransportStop: {
        predecessorCheckpointedPollInvocation: {
          connectionRevision: 3,
          authorityEpoch: 1,
          transportOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
        },
        transportOrigin: { serverIdentityId: 'server-1', materializationRef: materialization },
        providerContributionSelection: {
          contributionId: 'test-provider',
          immutableGenerationId: 'provider-generation-1',
        },
        overlapSafety: 'safe',
        stopRequest: {
          v: 1,
          connectionId: 'connection-1',
          providerConnectionKey: 'connection-key-1',
          providerConfigVersion: 1,
          providerConfig: {},
          credentialRef: null,
          authorityEpoch: 2,
          reason: 'transfer',
        },
        acceptedPossibleLoss: false,
      },
    })]);

    await expect(update({
      collection,
      connectionId: 'connection-1',
      expectedRevision: 4,
      enabled: false,
      maximumObservationAgeMs: 60_000,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'channels_connection_update_old_transport_stop_pending',
      retryable: true,
    });
    expect(collection.batches).toEqual([]);
  });
});
