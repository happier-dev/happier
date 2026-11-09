import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANNEL_COLLECTION_MIGRATIONS, migrateChannelStateV7ToV8 } from './collectionMigrations.js';
import { CHANNEL_STATE_COLLECTION } from './collections.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { ConversationBindingV1Schema } from '@happier-dev/channels-protocol/v1';

const retained = JSON.parse(readFileSync(new URL('./testkit/fixtures/channelStateV7.json', import.meta.url), 'utf8'));
const retainedV8 = JSON.parse(readFileSync(new URL('./testkit/fixtures/channelStateV8.json', import.meta.url), 'utf8'));
describe('Channels retained checkpoint compatibility', () => {
  it('keeps retained provider cursor, generation and historical counters readable without rewriting data', async () => {
    const adoption = CHANNEL_COLLECTION_MIGRATIONS['channel-state'].find(step => step.fromSchemaVersion === 18);
    if (!adoption) throw new Error('Missing retained checkpoint contract adoption');
    const before = structuredClone(retainedV8.checkpoint);
    let migrated = before;
    for (const edge of CHANNEL_COLLECTION_MIGRATIONS['channel-state'].filter(step => step.fromSchemaVersion >= 8)) {
      migrated = await edge.migrate(migrated, { currentRevision: 22 });
    }
    expect(migrated).toEqual(before);
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), migrated)).toBe(true);
    expect(await adoption.migrate(before, { currentRevision: 22 })).toBe(before);
    const { lastOccurrenceId: _lastOccurrenceId, revision: _revision, ...payload } = before.payload;
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), { ...before, payload })).toBe(true);
    expect(before).toEqual(retainedV8.checkpoint);
  });
});

const predecessor = { serverIdentityId: 'srv_v7fixture', materializationRef: {
  pluginId: 'happier.channel.example', machineId: 'machine-predecessor', materializationId: 'old-materialization',
} };
function retainedPendingConnection() {
  return { ...retained.connection, payload: { ...retained.connection.payload, pendingOldTransportStop: {
    predecessorCheckpointedPollInvocation: { connectionRevision: 7, authorityEpoch: 7, transportOrigin: predecessor },
    transportOrigin: predecessor, providerContributionSelection: { contributionId: 'provider' },
    stopRequest: { v: 1, connectionId: retained.connection.id, providerConnectionKey: 'retained-mailbox',
      providerConfigVersion: 1, providerConfig: { mailbox: 'Old inbox' }, credentialRef: null, authorityEpoch: 8, reason: 'transfer' },
    predecessorTransportKind: 'checkpointedPull', endpointRetarget: 'notRequired', overlapSafety: 'safe', acceptedPossibleLoss: false,
  } } };
}

describe('Channels retained V8 configuration revision migration', () => {
  it('seeds the logical configuration revision from the host physical revision without changing custody or cursors', async () => {
    expect(retainedV8.collection.schemaVersion).toBe(8);
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retainedV8.collection.schema), retainedV8.connection)).toBe(true);
    const edge = CHANNEL_COLLECTION_MIGRATIONS['channel-state'].find(step => step.fromSchemaVersion === 8);
    expect(edge).toMatchObject({ toSchemaVersion: 9 });
    if (edge === undefined) throw new Error('Missing V8→V9 migration');
    const migrated = await edge.migrate(retainedV8.connection, { currentRevision: 14 });
    expect(migrated).toEqual({ ...retainedV8.connection, payload: { ...retainedV8.connection.payload, configurationRevision: 14 } });
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), migrated)).toBe(true);
    expect(await edge.migrate(retainedV8.checkpoint, { currentRevision: 22 })).toEqual(retainedV8.checkpoint);
  });
});

describe('Channels delete-finalization selector migration', () => {
  it('projects retained finalizing rows into due work without changing authority, content or revisions', async () => {
    const edge = CHANNEL_COLLECTION_MIGRATIONS['channel-state'].find(step => step.fromSchemaVersion === 14);
    expect(edge).toMatchObject({ toSchemaVersion: 15 });
    if (edge === undefined) throw new Error('Missing delete-finalization selector migration');
    let connection = retainedV8.connection;
    for (const step of CHANNEL_COLLECTION_MIGRATIONS['channel-state'].filter(step => step.fromSchemaVersion >= 8 && step.toSchemaVersion <= 14)) {
      connection = await step.migrate(connection, { currentRevision: 22 });
    }
    const binding = {
      id: 'binding-delete-selector', v: 1, 'record-kind': 'binding',
      'connection-id': connection.id, 'binding-id': 'binding-delete-selector', 'created-at': 1, 'updated-at': 23,
      payload: {
        endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
        target: { kind: 'session', sessionId: 'session-1', policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
          approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
        allowedPrincipalIds: ['person-1'], allowBotSenders: false, inputMode: 'allAllowedMessages', inboundDebounceMs: 0,
        linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1, enabled: true, deletionState: 'none',
      },
    };
    const target = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    for (const healthy of [connection, binding]) {
      expect(await edge.migrate(healthy, { currentRevision: 22 })).toEqual(healthy);
      const finalizing = { ...healthy, payload: { ...healthy.payload, enabled: false, deletionState: 'finalizingDelete' } };
      const projected = await edge.migrate(finalizing, { currentRevision: 22 });
      expect(projected).toEqual({ ...finalizing, 'due-at': finalizing['updated-at'] });
      expect(isValidPluginJsonSchemaValue(target, projected)).toBe(true);
      expect(isValidPluginJsonSchemaValue(target, finalizing)).toBe(false);
      expect(await edge.migrate(projected, { currentRevision: 22 })).toEqual(projected);
      // A selector cannot keep authorizing work after the lifecycle leaves it.
      expect(isValidPluginJsonSchemaValue(target, { ...projected, payload: healthy.payload })).toBe(false);
    }
    expect(await edge.migrate(retainedV8.checkpoint, { currentRevision: 22 })).toEqual(retainedV8.checkpoint);
  });
});

describe('Channels retained V16 configured-Fix migration', () => {
  it('maps only the reviewed SHA and leaves new-shaped, unrelated and replayed rows unchanged', async () => {
    const edge = CHANNEL_COLLECTION_MIGRATIONS['channel-state'].find(step => step.fromSchemaVersion === 16);
    expect(edge).toMatchObject({ id: 'channel-state-v16-to-v17', toSchemaVersion: 17 });
    if (!edge) throw new Error('Missing configured-Fix migration');
    const request = { kind: 'deliverConfiguredFix', sessionId: 'session-1', bindingId: 'binding-1', expectedRevision: 7,
      pullRequest: { repository: 'acme/widgets', number: 12 }, head: { ref: 'feature', sha: 'reviewed-sha' },
      delivery: { idempotencyKey: 'original-delivery', text: 'Retained fix' } };
    const row = { id: 'c'.repeat(43), v: 1, 'record-kind': 'ingress-obligation', 'connection-id': 'connection-1',
      'binding-id': 'binding-1', 'session-id': 'session-1', terminal: false, attention: false,
      'created-at': 10, 'updated-at': 20, payload: { kind: 'configuredFix', request } };
    const { head, ...rest } = request;
    const expected = { ...row, payload: { ...row.payload, request: { ...rest, expectedHeadSha: head.sha } } };
    const migrated = await edge.migrate(row, { currentRevision: 22 });
    expect(migrated).toEqual(expected);
    expect(await edge.migrate(migrated, { currentRevision: 23 })).toBe(migrated);
    const newer = { ...expected, payload: { ...expected.payload, request: { ...expected.payload.request,
      delivery: { ...request.delivery, attachments: [{ attachmentLocalId: 'entry', value: {
        key: 'entry-12', value: { entryId: '12' }, presentation: { label: 'Pull request 12' } } }] } } } };
    expect(await edge.migrate(newer, { currentRevision: 22 })).toBe(newer);
    for (const unaffected of [retainedV8.connection, retainedV8.checkpoint, retained.eventObligation]) {
      expect(await edge.migrate(unaffected, { currentRevision: 22 })).toBe(unaffected);
    }
    expect(row.payload.request).toHaveProperty('head.sha', 'reviewed-sha');
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), migrated)).toBe(true);
  });
});

describe('Channels exact Session selector migration', () => {
  it('backfills direct, scoped and frozen Session identities without using a current binding for custody', async () => {
    const edge = CHANNEL_COLLECTION_MIGRATIONS['channel-state'].find(step => step.fromSchemaVersion === 10);
    expect(edge).toMatchObject({ toSchemaVersion: 11 });
    if (edge === undefined) throw new Error('Missing exact Session selector migration');
    const { id, connectionId, v, createdAt, updatedAt, ...payload } = ConversationBindingV1Schema.parse({
      v: 1, id: 'binding-direct', connectionId: 'connection-1', createdAt: 0, updatedAt: 0,
      endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
      target: { kind: 'session', sessionId: 'direct-session', policy: {
        deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
        approvals: { kind: 'off' }, newSession: { kind: 'off' },
      } },
      allowedPrincipalIds: ['person-1'], allowBotSenders: false, inputMode: 'allAllowedMessages',
      inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1,
      enabled: true, deletionState: 'none',
    });
    const direct = { id, v, 'record-kind': 'binding', 'connection-id': connectionId, 'binding-id': id,
      'created-at': createdAt, 'updated-at': updatedAt, payload };
    const scoped = { ...direct, payload: { ...payload, target: {
      kind: 'automation', automationId: 'automation-1', policy: { resultDelivery: 'none' },
      scopedTrigger: { sessionId: 'scoped-session', triggerId: 'trigger-1', triggerRevision: 0,
        triggerKind: 'ciFailed', principalPolicy: 'repositoryWriters', pullRequest: { repository: 'acme/widgets', number: 12 } },
    } } };
    const oldObligation = migrateChannelStateV7ToV8(retained.eventObligation);
    const frozen = { ...oldObligation, 'binding-id': id, payload: { ...retained.eventObligation.payload,
      target: { kind: 'session', sessionId: 'original-session',
        idempotencyKey: `channels:input:v1:${retained.eventObligation.id}`,
        requestedPermissionCeiling: 'read-only', remoteApprovalMaxScope: 'off' },
    } };
    const sourceSchema = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    for (const [source, sessionId, prSelector] of [
      [direct, 'direct-session', {}],
      [scoped, 'scoped-session', { 'pr-binding': true }],
      [frozen, 'original-session', {}],
    ] as const) {
      expect(isValidPluginJsonSchemaValue(sourceSchema, source)).toBe(true);
      expect(await edge.migrate(source, { currentRevision: 1 })).toEqual({ ...source, 'session-id': sessionId, ...prSelector });
    }
    const accepted = { ...frozen, payload: { ...frozen.payload,
      sessionInput: { sessionId: 'resolved-session', localId: 'accepted-input', projectedReplySeq: null },
    } };
    expect(await edge.migrate(accepted, { currentRevision: 1 })).toEqual({ ...accepted, 'session-id': 'resolved-session' });
    expect(await edge.migrate(retainedV8.checkpoint, { currentRevision: 1 })).toEqual(retainedV8.checkpoint);
    // Existing event custody has no resolved Session. Never infer it from a later binding.
    expect(await edge.migrate(retained.eventObligation, { currentRevision: 1 })).toEqual(retained.eventObligation);
  });
});

describe('Channels retained V7 routing migration', () => {
  it('preserves the pinned retained connection while contracting its origin to placement', async () => {
    expect(retained.collection.schemaVersion).toBe(7);
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retained.collection.schema), retained.connection)).toBe(true);
    const edge = CHANNEL_COLLECTION_MIGRATIONS['channel-state'].find(step => step.fromSchemaVersion === 7);
    expect(edge).toMatchObject({ toSchemaVersion: 8 });
    const migrated = await edge!.migrate(retained.connection, { currentRevision: 14 });
    expect(migrated).toEqual({ ...retained.connection, payload: { ...retained.connection.payload,
      transportOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-v7' },
    } });
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retainedV8.collection.schema), migrated)).toBe(true);
  });
  it('preserves real predecessor stop and checkpoint invocation facts', () => {
    const source = retainedPendingConnection();
    const migrated = migrateChannelStateV7ToV8(source);
    const old = source.payload.pendingOldTransportStop;
    expect(migrated).toEqual({ ...source, payload: { ...source.payload,
      transportOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-v7' },
      pendingOldTransportStop: { ...old, transportOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-predecessor' },
        predecessorCheckpointedPollInvocation: { ...old.predecessorCheckpointedPollInvocation,
          transportOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-predecessor' } } },
    } });
  });
  it('contracts frozen Event retry placement while preserving its immutable input and the checkpoint cursor', () => {
    const source = retained.eventObligation;
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retained.collection.schema), source)).toBe(true);
    const migrated = migrateChannelStateV7ToV8(source);
    expect(migrated).toEqual({ ...source, payload: { ...source.payload, target: { ...source.payload.target,
      executionOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-v7' },
    } } });
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retainedV8.collection.schema), migrated)).toBe(true);
    expect(migrateChannelStateV7ToV8(retained.checkpoint)).toEqual(retained.checkpoint);
  });
  it('rejects a mismatched full predecessor custody even when its placement agrees', () => {
    const source = retainedPendingConnection();
    source.payload.pendingOldTransportStop.predecessorCheckpointedPollInvocation.transportOrigin = {
      ...predecessor, materializationRef: { ...predecessor.materializationRef, materializationId: 'different-custody' },
    };
    expect(() => migrateChannelStateV7ToV8(source)).toThrow();
  });
  it('rejects an origin naming a different provider before erasing that identity', () => {
    const source = { ...retained.connection, payload: { ...retained.connection.payload,
      transportOrigin: { ...predecessor, materializationRef: { ...predecessor.materializationRef, pluginId: 'another.plugin' } },
    } };
    expect(() => migrateChannelStateV7ToV8(source)).toThrow();
  });
  it.each([false, true])('contracts endpoint custody without losing repair intent (legacy accepted marker: %s)', (accepted) => {
    const vector = retained.retainedEndpointVectors;
    const { kind: _transportKind, ...endpoint } = vector.transport;
    const source = { ...retained.connection, payload: { ...retained.connection.payload,
      authorityEpoch: accepted ? vector.acceptedCurrentAuthorityEpoch : 8,
      replayContinuity: 'none',
      transport: vector.transport,
      pendingOldTransportStop: { ...vector.pendingOldTransportStop, acceptedPossibleLoss: accepted },
    } };
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retained.collection.schema), source)).toBe(true);
    const migrated = migrateChannelStateV7ToV8(source);
    expect(migrated).toEqual({ ...source, payload: { ...source.payload,
      transportOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-v7' },
      pendingOldTransportStop: { kind: 'endpointRetarget', ...endpoint,
        targetMaterialization: source.payload.transportOrigin.materializationRef,
        transferAuthorityEpoch: source.payload.authorityEpoch,
      },
    } });
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(retainedV8.collection.schema), migrated)).toBe(true);
  });
});
