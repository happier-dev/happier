import type {
  PluginInvocationContext,
  TargetedContributionPointRef,
  TargetedContributionSnapshot,
  TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import { describe, expect, it, vi } from 'vitest';

import * as management from './management.js';
import {
  createCurrentConversationConnectionFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';

type StateValue = Readonly<Record<string, unknown>> & Readonly<{ id: string }>;
type StateRow = Readonly<{ rowId: string; revision: number; value: StateValue }>;
type StateMutation =
  | Readonly<{ kind: 'assert'; rowId: string; expectedRevision: number }>
  | Readonly<{ kind: 'put'; value: StateValue; expectedRevision: number | 'absent' }>;

const providerPluginId = 'example.channels.provider';
function admittedProviderOperation(role: string, immutableGenerationId = 'provider-generation-a') {
  return Object.freeze({
    identity: Object.freeze({
      target: Object.freeze({ pluginId: 'happier.channels' }),
      point: Object.freeze({
        pointId: 'providers',
        protocol: Object.freeze({ id: 'happier.channels/providers', version: 1 }),
      }),
      contributor: Object.freeze({
        pluginId: providerPluginId,
        contributionId: 'example-provider',
        immutableGenerationId,
      }),
      role,
    }),
  });
}
const endpointResolveAction = admittedProviderOperation('endpointResolve');
const principalResolveAction = admittedProviderOperation('principalResolve');
const executionOrigin = Object.freeze({
  serverIdentityId: 'server-1',
  materializationRef: Object.freeze({
    pluginId: providerPluginId,
    machineId: 'machine-1',
    materializationId: 'materialization-1',
  }),
});

const endpointCandidate = Object.freeze({
  kind: 'direct' as const,
  audience: 'direct' as const,
  id: 'chat-1',
  label: 'Current conversation label',
});
const principalCandidate = Object.freeze({
  id: 'person-1',
  kind: 'human' as const,
  label: 'Current principal label',
});
type ProviderContributionSnapshot = Readonly<{
  targetGeneration: string;
  contributorGeneration: string;
}>;
const providerContributionA: ProviderContributionSnapshot = Object.freeze({
  targetGeneration: 'channels-generation-a',
  contributorGeneration: 'provider-generation-a',
});
const providerContributionB: ProviderContributionSnapshot = Object.freeze({
  targetGeneration: 'channels-generation-b',
  contributorGeneration: 'provider-generation-b',
});
const connectionAuthority = {
  providerPluginId,
  providerContributionSelection: {
    contributionId: 'example-provider',
    immutableGenerationId: 'provider-generation-a',
  },
  providerSetupInput: { source: 'binding-resolution-test' },
  credentialRef: null,
  transportOrigin: executionOrigin,
  providerConnectionKey: 'private-provider-connection-key',
  providerConfig: { privateProviderConfig: true },
  routingIdentityKey: 'r'.repeat(43),
  integrationPrincipal: { id: 'bot-1', label: 'Test bot' },
  authorityEpoch: 1,
} as const satisfies ConversationConnectionFixtureAuthority;

function connectionRow(): StateRow {
  const value = createCurrentConversationConnectionFixture({
    connectionId: 'connection-1',
    authority: connectionAuthority,
    createdAt: 1_000,
    updatedAt: 1_000,
    transport: { kind: 'socket' },
    overlapSafety: 'safe',
    replayContinuity: 'none',
    outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
  });
  return {
    rowId: value.id,
    revision: 4,
    value,
  };
}

function createCollection(initial: readonly StateRow[]) {
  const rows = new Map(initial.map((row) => [row.rowId, row]));
  const batches: StateMutation[][] = [];
  return {
    rows,
    batches,
    async get(rowId: string) {
      return rows.get(rowId) ?? null;
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

function targetedContributionsFixture(
  snapshots: readonly ProviderContributionSnapshot[] = [providerContributionA],
  onRead?: (readCount: number) => void,
  options: Readonly<{ principalResolve?: boolean }> = {},
): TargetedContributionsService {
  let readCount = 0;
  return {
    observeForSelf<TContribution>(
      _point: TargetedContributionPointRef<TContribution>,
      _options: Readonly<{ onInvalidated: () => void }>,
    ) {
      return {
        dispose() {},
        async readCurrent(): Promise<TargetedContributionSnapshot<TContribution>> {
          const current = snapshots[Math.min(readCount, snapshots.length - 1)];
          readCount += 1;
          onRead?.(readCount);
          if (current === undefined) throw new Error('Expected an admitted provider contribution snapshot.');
          return {
            generation: current.targetGeneration,
            contributions: [{
              contributor: {
                pluginId: providerPluginId,
                contributionId: 'example-provider',
                immutableGenerationId: current.contributorGeneration,
              },
              protocol: { id: 'happier.channels/providers', version: 1 },
              operations: {
                endpointResolve: endpointResolveAction,
                ...(options.principalResolve === false ? {} : { principalResolve: principalResolveAction }),
              },
            }] as unknown as readonly TContribution[],
          };
        },
      };
    },
  } as TargetedContributionsService;
}

function invocationContext(input: Readonly<{
  collection: ReturnType<typeof createCollection>;
  execute: ReturnType<typeof vi.fn>;
  executeAdmittedTargetedOperationWithExecutionOrigin: ReturnType<typeof vi.fn>;
  targetedContributions?: TargetedContributionsService;
}>): PluginInvocationContext {
  // Storage, action execution, and targeted contribution admission are the
  // genuine host boundaries; the owner itself remains unmocked.
  return {
    signal: new AbortController().signal,
    services: {
      actions: {
        execute: input.execute,
        executeAdmittedTargetedOperationWithExecutionOrigin: input.executeAdmittedTargetedOperationWithExecutionOrigin,
      } as unknown as ActionsService,
      storage: { account: { collection: () => input.collection } },
      targetedContributions: input.targetedContributions ?? targetedContributionsFixture(),
    },
  } as unknown as PluginInvocationContext;
}

describe('Conversation binding resolution and creation', () => {
  it('returns only current endpoint candidates after executing at the retained connection origin', async () => {
    const resolve = Reflect.get(management, 'resolveConversationBindingForInvocation');
    expect(resolve).toEqual(expect.any(Function));
    if (typeof resolve !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown, actionInput: unknown, options: unknown) => {
      expect(action).toBe(endpointResolveAction);
      expect(actionInput).toEqual({
        v: 1,
        connectionId: 'connection-1',
        providerConnectionKey: 'private-provider-connection-key',
        providerConfigVersion: 1,
        providerConfig: { privateProviderConfig: true },
        credentialRef: null,
        query: 'Alice',
      });
      expect(options).toEqual(expect.objectContaining({
        expectedExecutionOrigin: executionOrigin,
        signal: expect.any(AbortSignal),
      }));
      return { result: { kind: 'resolved', candidates: [endpointCandidate] }, executionOrigin };
    });

    const result = await resolve({
      kind: 'endpoint',
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      query: 'Alice',
    }, invocationContext({ collection, execute: vi.fn(), executeAdmittedTargetedOperationWithExecutionOrigin }));

    expect(result).toEqual({ kind: 'endpointCandidates', candidates: [endpointCandidate] });
    expect(result).not.toHaveProperty('providerConnectionKey');
    expect(result).not.toHaveProperty('providerConfig');
    expect(result).not.toHaveProperty('credentialRef');
    expect(result).not.toHaveProperty('witness');
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
  });

  it('accepts canonical principal candidates from a provider result reader', async () => {
    const resolve = Reflect.get(management, 'resolveConversationBindingForInvocation');
    expect(resolve).toEqual(expect.any(Function));
    if (typeof resolve !== 'function') return;

    const canonicalPrincipalCandidates = [
      { id: '1', label: 'ada', kind: 'human' as const },
      { id: '2', label: 'zoe', kind: 'human' as const },
    ];
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
      if (action === endpointResolveAction) {
        return { result: { kind: 'resolved', candidates: [endpointCandidate] }, executionOrigin };
      }
      expect(action).toBe(principalResolveAction);
      return {
        result: { kind: 'resolved', candidates: canonicalPrincipalCandidates },
        executionOrigin,
      };
    });

    const result = await resolve({
      kind: 'principal',
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      endpointSelection: {
        query: 'issue',
        selected: { kind: 'direct', audience: 'direct', id: endpointCandidate.id },
      },
      query: 'a',
    }, invocationContext({
      collection: createCollection([connectionRow()]),
      execute: vi.fn(),
      executeAdmittedTargetedOperationWithExecutionOrigin,
    }));

    expect(result).toEqual({ kind: 'principalCandidates', candidates: canonicalPrincipalCandidates });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
  });

  it('keeps arbitrary providers without a principal resolver on the generic pairing path', async () => {
    const resolve = Reflect.get(management, 'resolveConversationBindingForInvocation');
    expect(resolve).toEqual(expect.any(Function));
    if (typeof resolve !== 'function') return;

    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
      expect(action).toBe(endpointResolveAction);
      return { result: { kind: 'resolved', candidates: [endpointCandidate] }, executionOrigin };
    });

    await expect(resolve({
      kind: 'principal',
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      endpointSelection: {
        query: 'Alice',
        selected: { kind: 'direct', audience: 'direct', id: endpointCandidate.id },
      },
      query: 'Alice',
    }, invocationContext({
      collection: createCollection([connectionRow()]),
      execute: vi.fn(),
      executeAdmittedTargetedOperationWithExecutionOrigin,
      targetedContributions: targetedContributionsFixture(undefined, undefined, { principalResolve: false }),
    }))).resolves.toEqual({ kind: 'unavailable', reason: 'principalResolveUnsupported' });

    // The core re-proves the selected endpoint, but never invents a provider
    // principal fallback or executes a provider-specific branch.
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
  });

  it('rejects unordered and repeated-ID endpoint candidates at the shared management result-admission owner', async () => {
    const resolve = Reflect.get(management, 'resolveConversationBindingForInvocation');
    expect(resolve).toEqual(expect.any(Function));
    if (typeof resolve !== 'function') return;

    const invalidCandidateSets = [
      [
        { ...endpointCandidate, id: 'chat-z', label: 'Zulu' },
        { ...endpointCandidate, id: 'chat-a', label: 'Alpha' },
      ],
      [
        { ...endpointCandidate, id: 'chat-duplicate', label: 'Alpha' },
        { ...endpointCandidate, id: 'chat-duplicate', label: 'Beta' },
      ],
    ];

    for (const candidates of invalidCandidateSets) {
      const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
        expect(action).toBe(endpointResolveAction);
        return { result: { kind: 'resolved', candidates }, executionOrigin };
      });

      await expect(resolve({
        kind: 'endpoint',
        connectionId: 'connection-1',
        expectedConnectionRevision: 4,
        query: 'Alice',
      }, invocationContext({
        collection: createCollection([connectionRow()]),
        execute: vi.fn(),
        executeAdmittedTargetedOperationWithExecutionOrigin,
      }))).rejects.toMatchObject({ code: 'channels_binding_endpoint_resolve_result_invalid' });
      expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
    }
  });

  it('rejects unordered and repeated-ID principal candidates at the shared management result-admission owner', async () => {
    const resolve = Reflect.get(management, 'resolveConversationBindingForInvocation');
    expect(resolve).toEqual(expect.any(Function));
    if (typeof resolve !== 'function') return;

    const invalidCandidateSets = [
      [
        { ...principalCandidate, id: 'person-z', label: 'Zulu' },
        { ...principalCandidate, id: 'person-a', label: 'Alpha' },
      ],
      [
        { ...principalCandidate, id: 'person-duplicate', label: 'Alpha' },
        { ...principalCandidate, id: 'person-duplicate', label: 'Beta' },
      ],
    ];

    for (const candidates of invalidCandidateSets) {
      const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
        if (action === endpointResolveAction) {
          return { result: { kind: 'resolved', candidates: [endpointCandidate] }, executionOrigin };
        }
        expect(action).toBe(principalResolveAction);
        return { result: { kind: 'resolved', candidates }, executionOrigin };
      });

      await expect(resolve({
        kind: 'principal',
        connectionId: 'connection-1',
        expectedConnectionRevision: 4,
        endpointSelection: {
          query: 'Alice',
          selected: { kind: 'direct', audience: 'direct', id: 'chat-1' },
        },
        query: 'Alice',
      }, invocationContext({
        collection: createCollection([connectionRow()]),
        execute: vi.fn(),
        executeAdmittedTargetedOperationWithExecutionOrigin,
      }))).rejects.toMatchObject({ code: 'channels_binding_principal_resolve_result_invalid' });
      expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    }
  });

  it('reruns endpoint and principal resolution at create time and persists only their fresh evidence', async () => {
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
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
      if (action === endpointResolveAction) {
        return { result: { kind: 'resolved', candidates: [endpointCandidate] }, executionOrigin };
      }
      if (action === principalResolveAction) {
        return { result: { kind: 'resolved', candidates: [principalCandidate] }, executionOrigin };
      }
      throw new Error('Unexpected provider action.');
    });

    const result = await create({
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      endpointSelection: {
        query: 'Alice',
        selected: { kind: 'direct', audience: 'direct', id: 'chat-1' },
      },
      principalSelection: {
        query: 'Alice',
        selected: [{ id: 'person-1', kind: 'human' }],
      },
      target: {
        kind: 'session',
        sessionId: 'session-1',
        policy: {
          deliveryMode: 'repliesOnly',
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' },
          newSession: { kind: 'off' },
        },
      },
    }, invocationContext({ collection, execute, executeAdmittedTargetedOperationWithExecutionOrigin }));

    expect(result).toMatchObject({
      kind: 'created',
      binding: {
        endpoint: endpointCandidate,
        allowedPrincipalIds: ['person-1'],
        deletionState: 'none',
      },
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenNthCalledWith(
      1,
      endpointResolveAction,
      expect.objectContaining({ query: 'Alice' }),
      expect.objectContaining({ expectedExecutionOrigin: executionOrigin }),
    );
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenNthCalledWith(
      2,
      principalResolveAction,
      expect.objectContaining({ endpoint: endpointCandidate, query: 'Alice' }),
      expect.objectContaining({ expectedExecutionOrigin: executionOrigin }),
    );
    expect(collection.batches[0]).toEqual(expect.arrayContaining([
      { kind: 'assert', rowId: 'connection-1', expectedRevision: 4 },
      expect.objectContaining({
        kind: 'put',
        value: expect.objectContaining({
          payload: expect.objectContaining({ deletionState: 'none' }),
        }),
      }),
    ]));
  });

  it('rereads resolver facts after Automation target verification before binding persistence', async () => {
    const create = Reflect.get(management, 'createConversationBindingForInvocation');
    expect(create).toEqual(expect.any(Function));
    if (typeof create !== 'function') return;

    const collection = createCollection([connectionRow()]);
    let finalProviderCurrentnessRead = false;
    let automationTargetVerified = false;
    const execute = vi.fn(async (actionId: unknown) => {
      expect(actionId).toBe('automation.conversation.target.verify');
      expect(finalProviderCurrentnessRead).toBe(false);
      automationTargetVerified = true;
      return { kind: 'verified' as const, templateVersion: 7 };
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
      if (action === endpointResolveAction) {
        return { result: { kind: 'resolved', candidates: [endpointCandidate] }, executionOrigin };
      }
      if (action === principalResolveAction) {
        return { result: { kind: 'resolved', candidates: [principalCandidate] }, executionOrigin };
      }
      throw new Error('Unexpected provider action.');
    });

    await expect(create({
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      endpointSelection: {
        query: 'Alice',
        selected: { kind: 'direct', audience: 'direct', id: 'chat-1' },
      },
      principalSelection: {
        query: 'Alice',
        selected: [{ id: 'person-1', kind: 'human' }],
      },
      target: {
        kind: 'automation',
        automationId: 'automation-1',
        expectedTemplateVersion: 3,
        policy: { resultDelivery: 'none' },
      },
    }, invocationContext({
      collection,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
      targetedContributions: targetedContributionsFixture(
        [providerContributionA],
        (readCount) => {
          if (readCount < 5) return;
          expect(automationTargetVerified).toBe(true);
          finalProviderCurrentnessRead = true;
        },
      ),
    }))).resolves.toMatchObject({
      kind: 'created',
      binding: { target: { kind: 'automation', templateVersion: 7 } },
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(finalProviderCurrentnessRead).toBe(true);
    expect(collection.batches).toHaveLength(1);
  });

  it('returns stale before principal resolution when its rerun endpoint query no longer contains the selected identity', async () => {
    const resolve = Reflect.get(management, 'resolveConversationBindingForInvocation');
    expect(resolve).toEqual(expect.any(Function));
    if (typeof resolve !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: {
        kind: 'resolved',
        candidates: [{ ...endpointCandidate, id: 'different-chat' }],
      },
      executionOrigin,
    }));

    await expect(resolve({
      kind: 'principal',
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      endpointSelection: {
        query: 'Alice',
        selected: { kind: 'direct', audience: 'direct', id: 'chat-1' },
      },
      query: 'Alice',
    }, invocationContext({ collection, execute: vi.fn(), executeAdmittedTargetedOperationWithExecutionOrigin }))).resolves.toEqual({ kind: 'stale' });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledWith(
      endpointResolveAction,
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not carry endpoint evidence into a retired persisted provider selection before principal resolution', async () => {
    const resolve = Reflect.get(management, 'resolveConversationBindingForInvocation');
    expect(resolve).toEqual(expect.any(Function));
    if (typeof resolve !== 'function') return;

    const collection = createCollection([connectionRow()]);
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
      if (action === endpointResolveAction) {
        return { result: { kind: 'resolved', candidates: [endpointCandidate] }, executionOrigin };
      }
      if (action === principalResolveAction) {
        return { result: { kind: 'resolved', candidates: [principalCandidate] }, executionOrigin };
      }
      throw new Error('Unexpected provider resolution Action.');
    });

    await expect(resolve({
      kind: 'principal',
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      endpointSelection: {
        query: 'Alice',
        selected: { kind: 'direct', audience: 'direct', id: 'chat-1' },
      },
      query: 'Alice',
    }, invocationContext({
      collection,
      execute: vi.fn(),
      executeAdmittedTargetedOperationWithExecutionOrigin,
      // Endpoint pre/post reads observe the exact persisted A selection; the
      // next contributor reread observes B, so the retained selection is gone.
      targetedContributions: targetedContributionsFixture([
        providerContributionA,
        providerContributionA,
        providerContributionB,
      ]),
    }))).resolves.toEqual({ kind: 'unavailable', reason: 'providerUnavailable' });

    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledWith(
      endpointResolveAction,
      expect.anything(),
      expect.anything(),
    );
    expect(collection.batches).toEqual([]);
  });

  it('does not persist a binding when its persisted provider selection retires during target verification', async () => {
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
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
      if (action === endpointResolveAction) {
        return { result: { kind: 'resolved', candidates: [endpointCandidate] }, executionOrigin };
      }
      if (action === principalResolveAction) {
        return { result: { kind: 'resolved', candidates: [principalCandidate] }, executionOrigin };
      }
      throw new Error('Unexpected provider resolution Action.');
    });

    await expect(create({
      connectionId: 'connection-1',
      expectedConnectionRevision: 4,
      endpointSelection: {
        query: 'Alice',
        selected: { kind: 'direct', audience: 'direct', id: 'chat-1' },
      },
      principalSelection: {
        query: 'Alice',
        selected: [{ id: 'person-1', kind: 'human' }],
      },
      target: {
        kind: 'session',
        sessionId: 'session-1',
        policy: {
          deliveryMode: 'repliesOnly',
          permissionCeiling: 'read-only',
          approvals: { kind: 'off' },
          newSession: { kind: 'off' },
        },
      },
    }, invocationContext({
      collection,
      execute,
      executeAdmittedTargetedOperationWithExecutionOrigin,
      // The first four contributor reads fence endpoint and principal effects;
      // final persistence must reject B because the durable selection remains A.
      targetedContributions: targetedContributionsFixture([
        providerContributionA,
        providerContributionA,
        providerContributionA,
        providerContributionA,
        providerContributionB,
      ]),
    }))).resolves.toEqual({ kind: 'unavailable', reason: 'providerUnavailable' });

    expect(execute).toHaveBeenCalledOnce();
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    expect(collection.batches).toEqual([]);
  });
});
