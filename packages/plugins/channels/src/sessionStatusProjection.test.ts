import { describe, expect, it, vi } from 'vitest';
import type { ConversationSessionStatusInputV1 } from '@happier-dev/channels-protocol/v1';
import { createSessionStatusProjection, type SessionStatusTarget } from './sessionStatusProjection.js';

const target: SessionStatusTarget = {
  kind: 'ready', permissionApprovalsEnabled: true,
  source: { bindingId: 'binding', connectionId: 'connection', sessionId: 'session',
    sourceRef: 'channels:binding:binding', sourceRevisionOrEpoch: '1:1', connectionAuthorityEpoch: 1, bindingAuthorityEpoch: 1 },
  endpoint: { kind: 'direct', audience: 'direct', id: 'slack:T1:channel:D1' },
  connection: { revision: 1, authorityEpoch: 1, enabled: true, deletionState: 'none', credentialRef: null,
    transportOrigin: { machineId: 'machine', serverIdentityId: 'server' }, routingIdentityKey: 'routing',
    providerAction: { providerPluginId: 'happier.channel-slack', providerContributionSelection: { contributionId: 'slack' },
      providerConnectionKey: 'slack', providerConfigVersion: 1, providerConfig: {} } },
};

describe('content-free channel Session status projection', () => {
  it('keeps a queued receipt during initial idle and clears a fast final reply even without an observed active interval', async () => {
    const publish = vi.fn(async (_target: SessionStatusTarget, _status: ConversationSessionStatusInputV1['status'], _messageId?: string) => ({ kind: 'delivered' as const, providerMessageIds: ['123.456'] }));
    const projection = createSessionStatusProjection(publish);
    await projection.accepted(target, 'queued-input');
    await projection.activity(target, 'idle', false);
    expect(publish.mock.calls.map(call => call[1])).toEqual(['received']);
    await projection.finished(target);
    expect(publish.mock.calls.map(call => call[1])).toEqual(['received', 'idle']);
  });

  it('keeps one native status for a long turn, replaces working during approval, and clears completion, failure and stop', async () => {
    const publish = vi.fn(async (_target: SessionStatusTarget, _status: ConversationSessionStatusInputV1['status'], _messageId?: string) => ({ kind: 'delivered' as const, providerMessageIds: ['123.456'] }));
    const projection = createSessionStatusProjection(publish);
    await projection.accepted(target, 'input');
    for (let i = 0; i < 1000; i++) await projection.activity(target, 'active', false);
    await projection.activity(target, 'active', true);
    await projection.activity(target, 'active', false);
    await projection.activity(target, 'idle', false); // Completed turn.
    await projection.accepted(target, 'input-two');
    await projection.activity(target, 'active', false);
    await projection.activity(target, 'idle', false); // Host failure settles idle.
    await projection.accepted(target, 'input-three');
    await projection.activity(target, 'active', false);
    await projection.activity(target, 'stopped', true); // Stop wins over stale approval.
    expect(publish.mock.calls.map(call => call.slice(1))).toEqual([
      ['received', undefined], ['working', '123.456'], ['waitingForApproval', '123.456'],
      ['working', '123.456'], ['idle', '123.456'], ['received', '123.456'],
      ['working', '123.456'], ['idle', '123.456'], ['received', '123.456'],
      ['working', '123.456'], ['idle', '123.456'],
    ]);
  });

  it('never updates another Session or destination using the previous native message id', async () => {
    const publish = vi.fn(async (_target: SessionStatusTarget, _status: ConversationSessionStatusInputV1['status'], _messageId?: string) => ({ kind: 'delivered' as const, providerMessageIds: ['123.456'] }));
    const projection = createSessionStatusProjection(publish);
    await projection.accepted(target, 'input');
    await projection.accepted({ ...target, endpoint: { ...target.endpoint, id: 'slack:T1:channel:D2' } }, 'input');
    expect(publish.mock.calls.map(call => call.slice(1))).toEqual([['received', undefined], ['received', undefined]]);
  });
});
