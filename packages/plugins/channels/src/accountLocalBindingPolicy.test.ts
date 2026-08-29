import type { JsonValue } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  asChannelStateRow,
  readConversationConnectionManagementRows,
  readConversationConnectionUpdateRow,
  readConversationIngressAttentionPage,
  updateConversationBindingPolicyInAccountCollection,
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

import { assertChannelsTestCollectionQueryLimit } from './testkit/collectionQueryBound.js';
const CONNECTION_ID = 'connection-frozen-old-selection';

describe('asChannelStateRow', () => {
  it('narrows the shared Collection envelope without deciding a row family', () => {
    const row = { rowId: 'row-1', revision: 3, value: { kind: 'future-family' } } as const;
    expect(asChannelStateRow(row)).toEqual(row);
    expect(asChannelStateRow({ ...row, value: [] })).toBeUndefined();
    expect(asChannelStateRow({ ...row, value: null })).toBeUndefined();
    expect(asChannelStateRow(null)).toBeUndefined();
  });
});

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
          limit?: number;
        }>) {
          assertChannelsTestCollectionQueryLimit(request.limit);
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

  it('keeps connection-owned Event custody alongside binding attention in one Account page', async () => {
    const eventObligationId = 'E'.repeat(43);
    const bindingObligationId = 'B'.repeat(43);
    const query = vi.fn(async () => ({
      rows: [{
        rowId: eventObligationId,
        revision: 4,
        value: {
          id: eventObligationId,
          'record-kind': 'ingress-obligation',
          v: 1,
          'connection-id': CONNECTION_ID,
          terminal: false,
          attention: true,
          'created-at': 10,
          'updated-at': 20,
          payload: {
            occurrenceIds: ['provider:event:1'],
            censusId: 'C'.repeat(43),
            target: { kind: 'event' },
            sourceAuthority: {
              connectionAuthorityEpoch: 3,
              bindingRevision: null,
              bindingAuthorityEpoch: null,
            },
            lifecycle: { phase: 'blocked', attemptCount: 5, dueAt: null },
            disposition: null,
            nonAdmission: null,
          },
        },
      }, {
        rowId: bindingObligationId,
        revision: 7,
        value: {
          id: bindingObligationId,
          'record-kind': 'ingress-obligation',
          v: 1,
          'connection-id': CONNECTION_ID,
          'binding-id': 'binding-1',
          terminal: true,
          attention: true,
          'created-at': 11,
          'updated-at': 21,
          payload: {
            occurrenceIds: ['provider:message:1'],
            censusId: 'D'.repeat(43),
            target: null,
            sourceAuthority: {
              connectionAuthorityEpoch: 3,
              bindingRevision: 2,
              bindingAuthorityEpoch: 4,
            },
            lifecycle: { phase: 'terminal', attemptCount: 1, dueAt: null },
            disposition: 'rejected',
            nonAdmission: { reason: 'messageTooLarge', senderFeedbackEligible: true },
          },
        },
      }],
      changeCursor: 1,
    }));

    await expect(readConversationIngressAttentionPage({
      collection: { query } as never,
    })).resolves.toEqual({
      obligations: [{
        kind: 'blocked',
        obligationId: eventObligationId,
        revision: 4,
        connectionId: CONNECTION_ID,
        attemptCount: 5,
        updatedAt: 20,
      }, {
        kind: 'terminal',
        obligationId: bindingObligationId,
        revision: 7,
        connectionId: CONNECTION_ID,
        bindingId: 'binding-1',
        updatedAt: 21,
      }],
    });
  });
});

describe('updateConversationBindingPolicyInAccountCollection Account-resolvable target', () => {
  const BINDING_ID = 'binding-account-local-target';
  const BINDING_CONNECTION_ID = 'connection-account-local-target';

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

  function bindingRow(): ChannelStateRow {
    return {
      rowId: BINDING_ID,
      revision: 5,
      value: {
        id: BINDING_ID,
        'record-kind': CHANNEL_STATE_RECORD_KIND.binding,
        v: 1,
        'connection-id': BINDING_CONNECTION_ID,
        'binding-id': BINDING_ID,
        'created-at': 1_000,
        'updated-at': 1_000,
        payload: {
          endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1', label: 'Example conversation' },
          target: sessionTarget,
          allowedPrincipalIds: ['person-1'],
          allowBotSenders: false,
          inputMode: 'allAllowedMessages',
          inboundDebounceMs: 750,
          linkPreviewPolicy: 'suppress',
          senderFeedback: 'off',
          authorityEpoch: 1,
          enabled: false,
          deletionState: 'none',
        },
      },
    } as unknown as ChannelStateRow;
  }

  function ownerConnectionRow(): ChannelStateRow {
    const connection = createCurrentConversationConnectionFixture({
      connectionId: BINDING_CONNECTION_ID,
      authority: { ...replacementAuthority, authorityEpoch: 1 },
      transport: { kind: 'socket' },
      overlapSafety: 'safe',
      replayContinuity: 'none',
    });
    return {
      rowId: BINDING_CONNECTION_ID,
      revision: 4,
      value: connection,
    } as unknown as ChannelStateRow;
  }

  /** The Account Collection is the only boundary this canonical writer crosses. */
  function accountCollection() {
    const rows = new Map<string, ChannelStateRow>([
      [BINDING_ID, bindingRow()],
      [BINDING_CONNECTION_ID, ownerConnectionRow()],
    ]);
    const batches: unknown[][] = [];
    return {
      rows,
      batches,
      async get(rowId: string) { return rows.get(rowId) ?? null; },
      async query(request: Readonly<{ limit?: number }>) {
        assertChannelsTestCollectionQueryLimit(request.limit);
        return { rows: [], changeCursor: 1 };
      },
      async batch(operations: readonly Readonly<{
        kind: string;
        rowId?: string;
        value?: ChannelStateRow['value'];
        expectedRevision?: number | 'absent';
      }>[]) {
        batches.push([...operations]);
        for (const operation of operations) {
          const rowId = operation.kind === 'put'
            ? (operation.value as unknown as Readonly<{ id: string }>).id
            : operation.rowId!;
          if (rows.get(rowId)?.revision !== operation.expectedRevision) {
            return { status: 'conflict' as const, results: [] };
          }
        }
        const results = operations.flatMap((operation) => {
          if (operation.kind !== 'put' || operation.value === undefined) return [];
          const id = (operation.value as unknown as Readonly<{ id: string }>).id;
          const revision = (rows.get(id)?.revision ?? 0) + 1;
          rows.set(id, { rowId: id, revision, value: operation.value });
          return [{ rowId: id, revision, deleted: false as const }];
        });
        return { status: 'updated' as const, results };
      },
    };
  }

  it('persists a Session target policy change offline through the one binding transition and CAS owner', async () => {
    const collection = accountCollection();

    await expect(updateConversationBindingPolicyInAccountCollection({
      collection: collection as never,
      bindingId: BINDING_ID,
      expectedRevision: 5,
      target: {
        ...sessionTarget,
        policy: { ...sessionTarget.policy, deliveryMode: 'mirrorSession' },
      },
    })).resolves.toMatchObject({ kind: 'updated', bindingId: BINDING_ID, revision: 6 });

    expect(collection.rows.get(BINDING_ID)?.value).toMatchObject({
      payload: {
        target: {
          kind: 'session',
          sessionId: 'session-1',
          policy: { deliveryMode: 'mirrorSession', permissionCeiling: 'read-only' },
        },
        // The remaining policy is carried, not reset, by a target-only edit.
        inputMode: 'allAllowedMessages',
        inboundDebounceMs: 750,
      },
    });
  });

  it('refuses an Automation target offline because only the Automation owner can verify current eligibility', async () => {
    const collection = accountCollection();

    await expect(updateConversationBindingPolicyInAccountCollection({
      collection: collection as never,
      bindingId: BINDING_ID,
      expectedRevision: 5,
      target: {
        kind: 'automation',
        automationId: 'automation-1',
        policy: { resultDelivery: 'finalResult' },
      },
    })).rejects.toMatchObject({ code: 'channels_binding_update_target_not_account_resolvable' });
    expect(collection.batches).toHaveLength(0);
    expect(collection.rows.get(BINDING_ID)?.value).toMatchObject({
      payload: { target: { kind: 'session' } },
    });
  });

  it('persists an owner-enabled approval policy offline, exactly as the online writer does', async () => {
    const collection = accountCollection();

    await expect(updateConversationBindingPolicyInAccountCollection({
      collection: collection as never,
      bindingId: BINDING_ID,
      expectedRevision: 5,
      target: {
        ...sessionTarget,
        policy: {
          ...sessionTarget.policy,
          approvals: { kind: 'enabled', maximumScope: 'session' },
        },
      },
    })).resolves.toMatchObject({ kind: 'updated', bindingId: BINDING_ID, revision: 6 });

    // The persisted binding policy is the only chat-approval control: an
    // offline Account writer stores exactly the owner's chosen ceiling.
    expect(collection.rows.get(BINDING_ID)?.value).toMatchObject({
      payload: {
        target: {
          kind: 'session',
          policy: { approvals: { kind: 'enabled', maximumScope: 'session' } },
        },
      },
    });
  });
});

describe('updateConversationBindingPolicyInAccountCollection Account-resolvable revocation', () => {
  const BINDING_ID = 'binding-account-local-revoke';
  const BINDING_CONNECTION_ID = 'connection-account-local-revoke';

  /**
   * A retained binding whose `/new` authority names exactly the sender under
   * revocation, which is what makes a revocation that only subtracts from the
   * audience observably wrong rather than merely incomplete.
   */
  const sessionTarget = {
    kind: 'session',
    sessionId: 'session-1',
    policy: {
      deliveryMode: 'repliesOnly',
      permissionCeiling: 'read-only',
      approvals: { kind: 'off' },
      newSession: { kind: 'enabled', principalIds: ['person-2'], recipe: {} },
    },
  } as const;

  function bindingRow(): ChannelStateRow {
    return {
      rowId: BINDING_ID,
      revision: 5,
      value: {
        id: BINDING_ID,
        'record-kind': CHANNEL_STATE_RECORD_KIND.binding,
        v: 1,
        'connection-id': BINDING_CONNECTION_ID,
        'binding-id': BINDING_ID,
        'created-at': 1_000,
        'updated-at': 1_000,
        payload: {
          endpoint: { kind: 'shared', audience: 'shared', id: 'chat-1', label: 'Example conversation' },
          target: sessionTarget,
          allowedPrincipalIds: ['person-1', 'person-2'],
          allowBotSenders: false,
          inputMode: 'directMentionsOnly',
          inboundDebounceMs: 750,
          linkPreviewPolicy: 'suppress',
          senderFeedback: 'off',
          authorityEpoch: 1,
          enabled: true,
          deletionState: 'none',
        },
      },
    } as unknown as ChannelStateRow;
  }

  function accountCollection() {
    const connection = createCurrentConversationConnectionFixture({
      connectionId: BINDING_CONNECTION_ID,
      authority: { ...replacementAuthority, authorityEpoch: 1 },
      transport: { kind: 'socket' },
      overlapSafety: 'safe',
      replayContinuity: 'none',
    });
    const rows = new Map<string, ChannelStateRow>([
      [BINDING_ID, bindingRow()],
      [BINDING_CONNECTION_ID, { rowId: BINDING_CONNECTION_ID, revision: 4, value: connection } as unknown as ChannelStateRow],
    ]);
    const batches: unknown[][] = [];
    return {
      rows,
      batches,
      async get(rowId: string) { return rows.get(rowId) ?? null; },
      async query(request: Readonly<{ limit?: number }>) {
        assertChannelsTestCollectionQueryLimit(request.limit);
        return { rows: [], changeCursor: 1 };
      },
      async batch(operations: readonly Readonly<{
        kind: string;
        rowId?: string;
        value?: ChannelStateRow['value'];
        expectedRevision?: number | 'absent';
      }>[]) {
        batches.push([...operations]);
        for (const operation of operations) {
          const rowId = operation.kind === 'put'
            ? (operation.value as unknown as Readonly<{ id: string }>).id
            : operation.rowId!;
          if (rows.get(rowId)?.revision !== operation.expectedRevision) {
            return { status: 'conflict' as const, results: [] };
          }
        }
        const results = operations.flatMap((operation) => {
          if (operation.kind !== 'put' || operation.value === undefined) return [];
          const id = (operation.value as unknown as Readonly<{ id: string }>).id;
          const revision = (rows.get(id)?.revision ?? 0) + 1;
          rows.set(id, { rowId: id, revision, value: operation.value });
          return [{ rowId: id, revision, deleted: false as const }];
        });
        return { status: 'updated' as const, results };
      },
    };
  }

  it('revokes a retained sender offline and withdraws the authority that named them', async () => {
    const collection = accountCollection();

    await expect(updateConversationBindingPolicyInAccountCollection({
      collection: collection as never,
      bindingId: BINDING_ID,
      expectedRevision: 5,
      revokedPrincipalIds: ['person-2'],
    })).resolves.toMatchObject({ kind: 'updated', bindingId: BINDING_ID, revision: 6 });

    expect(collection.rows.get(BINDING_ID)?.value).toMatchObject({
      payload: {
        allowedPrincipalIds: ['person-1'],
        // Revoking a sender withdraws every authority that named them; leaving
        // the `/new` allow-list behind would keep a revoked sender able to
        // start Sessions, and the shared transition owner would refuse the
        // write outright.
        target: { policy: { newSession: { kind: 'off' } } },
        // Membership changed, so in-flight authority is superseded.
        authorityEpoch: 2,
      },
    });
  });

  it('refuses to revoke the last remaining sender because a binding with no audience cannot persist', async () => {
    const collection = accountCollection();

    await expect(updateConversationBindingPolicyInAccountCollection({
      collection: collection as never,
      bindingId: BINDING_ID,
      expectedRevision: 5,
      revokedPrincipalIds: ['person-1', 'person-2'],
    })).rejects.toMatchObject({ code: 'channels_binding_update_audience_would_be_empty' });
    expect(collection.batches).toHaveLength(0);
    expect(collection.rows.get(BINDING_ID)?.value).toMatchObject({
      payload: { allowedPrincipalIds: ['person-1', 'person-2'] },
    });
  });

  it('refuses a sender the binding does not already allow, so revocation can never add one', async () => {
    const collection = accountCollection();

    await expect(updateConversationBindingPolicyInAccountCollection({
      collection: collection as never,
      bindingId: BINDING_ID,
      expectedRevision: 5,
      revokedPrincipalIds: ['person-3'],
    })).rejects.toMatchObject({ code: 'channels_binding_update_principal_not_allowed' });
    expect(collection.batches).toHaveLength(0);
  });
});
