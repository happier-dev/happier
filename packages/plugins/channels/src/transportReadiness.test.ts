import { describe, expect, it } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { ConversationTransportFactReportInputV1Schema, ConversationTransportFactReportResultV1Schema } from '@happier-dev/channels-protocol/v1';
import { reportConversationTransportFactForInvocation } from './management.js';
import { CHANNEL_STATE_COLLECTION } from './collections.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';

describe('sender-scoped provider readiness at the Channels authority', () => {
  it.each([
    { principalId: 'external@example.com', fact: { kind: 'providerReadiness', status: 'attention', code: 'providerPermissionMissing', diagnostic: 'Required authentication markers are absent.' } },
    { principalId: 'allowed@example.com', fact: { kind: 'providerReadiness', status: 'attention', code: 'providerPermissionMissing', diagnostic: 'Required authentication markers are absent.' } },
    { principalId: 'allowed@example.com', fact: { kind: 'historyGap', reason: 'applicationAdmissionLost' } },
  ] as const)('retains schema-valid $fact.kind evidence for $principalId without disclosing the candidate', async ({ principalId, fact }) => {
    const state = new MemoryCollection();
    const materializationRef = { pluginId: 'fixture.email', machineId: 'machine', materializationId: 'materialization' };
    const connection = createCurrentConversationConnectionFixture({ connectionId: 'readiness-connection', authority: {
      providerPluginId: materializationRef.pluginId, providerContributionSelection: { contributionId: 'provider' },
      providerSetupInput: {}, credentialRef: null, providerConfig: {}, providerConnectionKey: 'mailbox',
      transportOrigin: { serverIdentityId: 'srv_account_one', materializationRef }, routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'mailbox' }, authorityEpoch: 1,
    } });
    await state.put(connection, { expectedRevision: 'absent' });
    const endpoint = { kind: 'thread', audience: 'direct', id: 'thread', parentId: 'mailbox' } as const;
    await state.put({ id: 'binding', 'record-kind': 'binding', 'binding-id': 'binding', 'connection-id': connection.id,
      v: 1, 'created-at': 1, 'updated-at': 1, payload: { endpoint,
        target: { kind: 'session', sessionId: 'session', policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
          approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
        allowedPrincipalIds: ['allowed@example.com'], allowBotSenders: false, inputMode: 'allAllowedMessages', inboundDebounceMs: 0,
        linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1, enabled: true, deletionState: 'none',
      } }, { expectedRevision: 'absent' });
    // Account storage and host-stamped invocation are genuine external boundaries;
    // the canonical schema, binding reader and readiness lifecycle remain real.
    const context = { signal: new AbortController().signal, caller: { kind: 'plugin', pluginId: materializationRef.pluginId,
      contribution: { id: 'readiness', qualifiedId: `${materializationRef.pluginId}/actions/readiness` },
      occurrenceId: 'readiness-occurrence', sourceCustody: { kind: 'development', registeredRootId: 'readiness-root' },
      executionOrigin: { serverIdentityId: 'srv_account_one', materializationRef },
      materialization: materializationRef }, services: { storage: { account: { collection(definition: { id: string }) {
        if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('Unexpected Collection');
        return state;
      } } } } } as unknown as PluginInvocationContext;
    const request = ConversationTransportFactReportInputV1Schema.parse({ connectionId: connection.id, authorityEpoch: 1,
      ...(fact.kind === 'providerReadiness' ? { senderEligibility: { endpoint, principalId } } : {}), fact });
    const result = ConversationTransportFactReportResultV1Schema.parse(await reportConversationTransportFactForInvocation(request, context));
    const retained = await state.get(connection.id);
    const eligible = principalId === 'allowed@example.com';
    expect(result.kind).toBe(eligible ? 'recorded' : 'notEligible');
    expect(retained?.revision).toBe(eligible ? 2 : 1);
    expect(retained?.value.payload).toMatchObject(fact.kind === 'historyGap'
      ? { historyGap: { reason: 'applicationAdmissionLost', reportedAt: expect.any(Number) } }
      : { providerReadiness: eligible ? { code: 'providerPermissionMissing' } : null });
    // Real Account storage validates this closed schema before committing;
    // the in-memory storage boundary must not hide a rejected history-gap write.
    expect(isValidPluginJsonSchemaValue(compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema), retained?.value)).toBe(true);
    expect(JSON.stringify(retained)).not.toContain(principalId);
  });
});
