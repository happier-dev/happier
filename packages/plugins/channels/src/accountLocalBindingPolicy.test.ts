import type { JsonValue } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import {
  readConversationConnectionManagementRows,
  readConversationConnectionUpdateRow,
  readConversationIngressAttentionPage,
  type ChannelStateRow,
} from './accountLocalBindingPolicy.js';
import {
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import {
  createCurrentConversationConnectionFixture,
  createCurrentConversationPendingOldTransportStopFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';

const CONNECTION_ID = 'connection-frozen-old-selection';

const replacementAuthority = {
  providerPluginId: 'happier.channel.example',
  providerContributionSelection: {
    contributionId: 'replacement-contribution',
    immutableGenerationId: 'replacement-generation',
  },
  providerSetupInput: {},
  credentialRef: null,
  transportOrigin: {
    serverIdentityId: 'server-example',
    materializationRef: {
      pluginId: 'happier.channel.example',
      machineId: 'machine-example',
      materializationId: 'materialization-example',
    },
  },
  providerConnectionKey: 'provider:connection-frozen-old-selection',
  providerConfig: {},
  integrationPrincipal: { id: 'example-bot' },
  routingIdentityKey: 'r'.repeat(43),
  authorityEpoch: 8,
} as const satisfies ConversationConnectionFixtureAuthority;

const oldAuthority = {
  ...replacementAuthority,
  providerContributionSelection: {
    contributionId: 'old-contribution',
    immutableGenerationId: 'old-generation',
  },
  transportOrigin: {
    serverIdentityId: 'server-old',
    materializationRef: {
      pluginId: 'happier.channel.example',
      machineId: 'machine-old',
      materializationId: 'materialization-old',
    },
  },
} as const satisfies ConversationConnectionFixtureAuthority;

function connectionRow(
  pendingOldTransportStop: JsonValue,
  payloadOverrides: Readonly<Record<string, JsonValue>> = {},
): ChannelStateRow {
  const connection = createCurrentConversationConnectionFixture({
    connectionId: CONNECTION_ID,
    authority: replacementAuthority,
    transport: { kind: 'socket' },
    overlapSafety: 'safe',
    replayContinuity: 'sessionBound',
  });
  return {
    rowId: CONNECTION_ID,
    revision: 4,
    value: {
      ...connection,
      payload: {
        ...connection.payload,
        ...payloadOverrides,
        pendingOldTransportStop,
      },
    },
  };
}

function frozenOldStop(overrides: Readonly<Record<string, JsonValue>> = {}): JsonValue {
  return {
    ...createCurrentConversationPendingOldTransportStopFixture({
      connectionId: CONNECTION_ID,
      authority: oldAuthority,
      predecessorCheckpointedPollInvocation: {
        connectionRevision: 3,
        authorityEpoch: 7,
        transportOrigin: oldAuthority.transportOrigin,
      },
      authorityEpoch: 8,
      reason: 'transfer',
      overlapSafety: 'destructive',
    }),
    ...overrides,
  };
}

describe('readConversationConnectionUpdateRow frozen provider selection', () => {
  it('retains the old slot selection independently from the replacement row selection', () => {
    const current = readConversationConnectionUpdateRow({
      row: connectionRow(frozenOldStop()),
      connectionId: CONNECTION_ID,
    });

    expect(current.providerContributionSelection).toEqual({
      contributionId: 'replacement-contribution',
      immutableGenerationId: 'replacement-generation',
    });
    expect(current.lifecycle.pendingOldTransportStop?.providerContributionSelection).toEqual({
      contributionId: 'old-contribution',
      immutableGenerationId: 'old-generation',
    });
    expect(current.lifecycle.pendingOldTransportStop?.predecessorCheckpointedPollInvocation).toEqual({
      connectionRevision: 3,
      authorityEpoch: 7,
      transportOrigin: oldAuthority.transportOrigin,
    });
  });

  it('fails closed when a retained old-stop slot has no exact predecessor checkpointed-poll invocation', () => {
    const { predecessorCheckpointedPollInvocation: _omitted, ...withoutPredecessor } = (
      frozenOldStop() as Record<string, JsonValue>
    );

    expect(() => readConversationConnectionUpdateRow({
      row: connectionRow(withoutPredecessor),
      connectionId: CONNECTION_ID,
    })).toThrow(expect.objectContaining({ code: 'channels_connection_update_corrupt' }));
  });

  it('fails closed when a retained old-stop slot has a malformed predecessor checkpointed-poll invocation', () => {
    expect(() => readConversationConnectionUpdateRow({
      row: connectionRow(frozenOldStop({
        predecessorCheckpointedPollInvocation: {
          connectionRevision: 0,
          authorityEpoch: 7,
          transportOrigin: oldAuthority.transportOrigin,
        },
      })),
      connectionId: CONNECTION_ID,
    })).toThrow(expect.objectContaining({ code: 'channels_connection_update_corrupt' }));
  });

  it('fails closed when a retained old-stop slot has no exact contribution selection', () => {
    const { providerContributionSelection: _omitted, ...withoutSelection } = frozenOldStop() as Record<string, JsonValue>;

    expect(() => readConversationConnectionUpdateRow({
      row: connectionRow(withoutSelection),
      connectionId: CONNECTION_ID,
    })).toThrow(expect.objectContaining({ code: 'channels_connection_update_corrupt' }));
  });

  it('fails closed when a retained old-stop slot has malformed contribution selection', () => {
    expect(() => readConversationConnectionUpdateRow({
      row: connectionRow(frozenOldStop({
        providerContributionSelection: {
          contributionId: 7,
          immutableGenerationId: 'old-generation',
        },
      })),
      connectionId: CONNECTION_ID,
    })).toThrow(expect.objectContaining({ code: 'channels_connection_update_corrupt' }));
  });

  it('rejects a poll failure outside the collection union', () => {
    expect(() => readConversationConnectionUpdateRow({
      row: connectionRow(frozenOldStop(), {
        pollFailure: {
          phase: 'retryDue',
          attemptCount: 5,
          retryNotBeforeMs: 1_000,
          evidence: { kind: 'provider', reason: 'network' },
        },
      }),
      connectionId: CONNECTION_ID,
    })).toThrow(expect.objectContaining({ code: 'channels_connection_update_corrupt' }));
  });
});

describe('Channels ingress conflict Account projections', () => {
  function conflictCensusRow(): ChannelStateRow {
    return {
      rowId: 'census-conflict',
      revision: 6,
      value: {
        id: 'census-conflict',
        'record-kind': CHANNEL_STATE_RECORD_KIND.ingressCensus,
        v: 1,
        'connection-id': CONNECTION_ID,
        attention: true,
        'created-at': 100,
        'updated-at': 101,
        payload: { conflict: { kind: 'occurrenceEvidenceMismatch' } },
      },
    };
  }

  function conflictProjectionCollection() {
    const connection = connectionRow(null);
    const conflict = conflictCensusRow();
    const queries: Array<Readonly<{ index: string; prefix?: readonly unknown[] }>> = [];
    return {
      queries,
      collection: {
        async query(request: Readonly<{
          index: string;
          prefix?: readonly unknown[];
        }>) {
          queries.push({ index: request.index, prefix: request.prefix });
          if (request.index === CHANNEL_STATE_INDEX_ID.byKind) {
            return { rows: [connection], changeCursor: 1 };
          }
          if (request.index === CHANNEL_STATE_INDEX_ID.byConnectionBindingV2) {
            return { rows: [conflict], changeCursor: 1 };
          }
          if (request.index === CHANNEL_STATE_INDEX_ID.byAttention) {
            return { rows: [conflict], changeCursor: 1 };
          }
          throw new Error(`Unexpected index ${request.index}.`);
        },
      },
    };
  }

  it('derives one redacted ingress conflict from each connection’s exact V2 census prefix', async () => {
    const fixture = conflictProjectionCollection();

    const projected = await readConversationConnectionManagementRows({
      collection: fixture.collection as never,
    });

    expect(projected.connections).toEqual([expect.objectContaining({
      connectionId: CONNECTION_ID,
      attention: expect.objectContaining({
        ingressConflict: { kind: 'occurrenceEvidenceMismatch' },
      }),
    })]);
    expect(fixture.queries).toContainEqual({
      index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
      prefix: [
        CONNECTION_ID,
        null,
        CHANNEL_STATE_RECORD_KIND.ingressCensus,
        true,
      ],
    });
  });

  it('projects an occurrence conflict into the shared attention union without evidence or retry data', async () => {
    const fixture = conflictProjectionCollection();

    const attention = await readConversationIngressAttentionPage({
      collection: fixture.collection as never,
    });

    expect(attention).toEqual({
      obligations: [{
        kind: 'occurrenceConflict',
        censusId: 'census-conflict',
        revision: 6,
        connectionId: CONNECTION_ID,
      }],
    });
  });
});
