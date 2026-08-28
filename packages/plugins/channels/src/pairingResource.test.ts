import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import type { ConversationBindingTargetV1 } from '@happier-dev/channels-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { classifyConversationCommand } from './commands.js';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_RECORD_KIND } from './collections.js';
import { createConversationPairingManager } from './pairing.js';
import { createConversationPairingResourceRuntime } from './pairingResource.js';
import { resourceText } from './testkit/resourceContract.js';
import {
  createCurrentConversationConnectionFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';

import { assertChannelsTestCollectionQueryLimit } from './testkit/collectionQueryBound.js';
const materialization = {
  pluginId: 'example.channels.provider',
  machineId: 'machine-1',
  materializationId: 'materialization-1',
} as const;

const endpoint = {
  kind: 'direct',
  audience: 'direct',
  id: 'chat-1',
  label: 'Alice',
} as const;

const target = {
  kind: 'session',
  sessionId: 'session-1',
  policy: {
    deliveryMode: 'repliesOnly',
    permissionCeiling: 'read-only',
    approvals: { kind: 'off' },
    newSession: { kind: 'off' },
  },
} satisfies ConversationBindingTargetV1;

const authority = {
  providerPluginId: materialization.pluginId,
  providerContributionSelection: {
    contributionId: 'pairing-resource-provider',
    immutableGenerationId: 'pairing-resource-generation',
  },
  providerSetupInput: { source: 'pairing-resource-test' },
  credentialRef: null,
  transportOrigin: {
    serverIdentityId: 'server-1',
    materializationRef: materialization,
  },
  providerConnectionKey: 'provider-connection',
  providerConfig: { account: 'test' },
  routingIdentityKey: 'a'.repeat(43),
  integrationPrincipal: { id: 'provider-principal' },
  authorityEpoch: 1,
} as const satisfies ConversationConnectionFixtureAuthority;

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
    assertChannelsTestCollectionQueryLimit(request.limit);
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

function accountStorageFor(collection: unknown): PluginAccountStorageScope {
  return {
    collection(definition: Readonly<{ id: string }>) {
      if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('Unexpected Account Collection.');
      return collection;
    },
  } as unknown as PluginAccountStorageScope;
}

function resourceOptions(accountStorage: PluginAccountStorageScope) {
  return {
    signal: new AbortController().signal,
    context: { kind: 'global' as const },
    accountStorage,
  };
}

function addConnection(collection: MemoryAccountCollection, connectionId: string): void {
  const row = createCurrentConversationConnectionFixture({
    connectionId,
    authority,
  });
  collection.rows.set(row.id, {
    rowId: row.id,
    revision: 1,
    value: row as unknown as Record<string, unknown>,
  });
}

function createManager() {
  let identifier = 0;
  return createConversationPairingManager({
    generationId: 'generation-1',
    now: () => 1_000,
    randomBytes: () => Uint8Array.from([0, 0, 0, 0, ++identifier]),
    createId: (kind) => `${kind}-${++identifier}`,
  });
}

describe('Channels pairing Resource', () => {
  it('keeps each Account Resource snapshot within its canonical connection membership', async () => {
    const accountA = new MemoryAccountCollection();
    const accountB = new MemoryAccountCollection();
    addConnection(accountA, 'connection-a');
    addConnection(accountB, 'connection-b');
    const pairing = createManager();
    const challengeA = pairing.createChallenge({
      connectionId: 'connection-a',
      expectedConnectionRevision: 1,
      materialization,
      destinationLabel: 'Account A bot',
      endpoint,
      target,
    });
    pairing.createChallenge({
      connectionId: 'connection-b',
      expectedConnectionRevision: 1,
      materialization,
      destinationLabel: 'Account B bot',
      endpoint,
      target,
    });
    const prepared = pairing.preparePreBindingMessage({
      censusId: 'pairing-resource-census-a',
      connectionId: 'connection-a',
      materialization,
      endpoint: { kind: 'direct', audience: 'direct', id: 'endpoint-a', label: 'Ada' },
      actor: { principalId: 'principal-a', kind: 'human', isIntegrationSelf: false },
      contentProvenance: 'original',
      command: classifyConversationCommand(`/pair ${challengeA.manualToken}`),
    });
    const matched = prepared.kind === 'reserved'
      ? pairing.commitPreBindingMessage(prepared)
      : prepared;
    if (matched.kind !== 'matched') throw new Error('Expected Account A pairing proposal.');
    const resource = createConversationPairingResourceRuntime(pairing);

    const [projectionA, projectionB] = await Promise.all([
      resource.read(resourceOptions(accountStorageFor(accountA))),
      resource.read(resourceOptions(accountStorageFor(accountB))),
    ]);

    expect(JSON.parse(resourceText(projectionA))).toEqual(expect.objectContaining({
      challenges: [],
      proposals: [expect.objectContaining({
        connectionId: 'connection-a',
        endpointLabel: 'Ada',
      })],
    }));
    expect(projectionA).not.toContain('connection-b');
    expect(projectionA).not.toContain('Account B bot');
    expect(JSON.parse(resourceText(projectionB))).toEqual(expect.objectContaining({
      challenges: [expect.objectContaining({
        connectionId: 'connection-b',
        destinationLabel: 'Account B bot',
      })],
      proposals: [],
    }));
    expect(projectionB).not.toContain('connection-a');
    expect(projectionB).not.toContain('Ada');
  });

  it('invalidates on the manager or current Account connection index and disposes both observations', () => {
    let connectionListener: (() => void) | undefined;
    const connectionDispose = vi.fn(() => { connectionListener = undefined; });
    const collection = {
      watch: vi.fn((_request: unknown, listener: () => void) => {
        connectionListener = listener;
        return { dispose: connectionDispose };
      }),
    };
    const pairing = createManager();
    const resource = createConversationPairingResourceRuntime(pairing);
    const invalidate = vi.fn();

    const observation = resource.observe(invalidate, resourceOptions(accountStorageFor(collection)));
    pairing.createChallenge({
      connectionId: 'connection-a',
      expectedConnectionRevision: 1,
      materialization,
      destinationLabel: 'Account A bot',
      endpoint,
      target,
    });
    connectionListener?.();

    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(collection.watch).toHaveBeenCalledWith({
      index: 'by-kind',
      prefix: [CHANNEL_STATE_RECORD_KIND.connection],
      order: 'asc',
    }, expect.any(Function));

    observation.dispose();
    connectionListener?.();
    pairing.createChallenge({
      connectionId: 'connection-b',
      expectedConnectionRevision: 1,
      materialization,
      destinationLabel: 'Account B bot',
      endpoint,
      target,
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(connectionDispose).toHaveBeenCalledOnce();
  });
});
