import { describe, expect, it } from 'vitest';
import { recommendConversationConnectionRecovery } from '../recoveryRecommendation.js';

import {
  buildChannelsConversationIndex,
  channelsStatusNeedsYou,
  connectionStatus,
  readChannelsPageLocation,
  parseBinding,
  parseConnection,
  type ChannelsConnection,
} from './conversationRows.js';

describe('readChannelsPageLocation', () => {
  it('reads the link journey, optionally on one named bot (a session tab\'s "+" picks the bot first)', () => {
    expect(readChannelsPageLocation('link')).toEqual({ step: 'link' });
    expect(readChannelsPageLocation('link/connection-1')).toEqual({ step: 'link', connectionId: 'connection-1' });
    expect(readChannelsPageLocation('binding-1/edit')).toEqual({ bindingId: 'binding-1', step: 'edit' });
    expect(readChannelsPageLocation('binding-1')).toEqual({ bindingId: 'binding-1' });
  });
});

const t = (_key: string, fallback: string): string => fallback;

it('preserves router and child relations from the binding Resource without treating routers as sessions or automations', () => {
  const row = { bindingId: 'router-1', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'direct' },
    target: { kind: 'threadRouter', summary: 'threadRouter' }, inputMode: 'allAllowedMessages', deliveryMode: 'none', approval: { kind: 'notApplicable' }, enabled: true, deletionState: 'none' };
  expect(parseBinding(row)).toEqual(row);
  const child = { ...row, bindingId: 'child-1', parentBindingId: 'router-1', target: { kind: 'session', summary: 'session-1' }, deliveryMode: 'repliesOnly', approval: { kind: 'off' } };
  expect(parseBinding(child)).toEqual(child);
  const exactChild = { ...child, target: { ...child.target, sessionId: 'session-1-exact-unshortened-id' } };
  expect(parseBinding(exactChild)).toEqual(exactChild);
  expect(parseBinding({ ...exactChild, target: { ...exactChild.target, sessionId: '' } })).toBeUndefined();
  expect(parseBinding({ ...row, deliveryMode: 'finalResult' })).toBeUndefined();
});

function connection(attention: Partial<ChannelsConnection['attention']> = {}): ChannelsConnection {
  return {
    connectionId: 'connection-1',
    revision: 1,
    authorityEpoch: 1,
    providerPluginId: 'happier.telegram',
    selectedMachineId: 'machine-1',
    selectedTransport: 'socket',
    enabled: true,
    deletionState: 'none',
    attention: {
      historyGap: null,
      providerReadiness: null,
      ingressConflict: null,
      pollFailure: null,
      bestEffortBeforeDurableAdmission: false,
      oldTransportStopUnconfirmed: false,
      endpointRetargetOwed: false,
      acceptedPossibleLoss: false,
      outwardDelivery: { retryDue: false, notDelivered: false, partial: false, outcomeUnknown: false, archiveRecovery: false },
      ...attention,
    },
  };
}

const DELIVERY = connection().attention.outwardDelivery;

it('accepts a retained conflict snapshot without reviving its attention latch', () => {
  const retained = connection({ ingressConflict: { kind: 'occurrenceEvidenceMismatch' }, pollFailure: {
    phase: 'blocked', attemptCount: 1, retryNotBeforeMs: null, evidence: { kind: 'provider', reason: 'network' },
  } });
  const parsed = parseConnection(retained);
  expect(parsed?.attention.ingressConflict).toBeNull();
  expect(parsed?.attention.pollFailure).toEqual(retained.attention.pollFailure);
});

it('preserves the canonical recovery Action through the shared UI row parsers and rejects malformed recommendations', () => {
  const recommendedRecovery = { action: { pluginId: 'happier.channels', localId: 'connection/retest-v1' },
    input: { connectionId: 'connection-1', expectedRevision: 1, authorityEpoch: 1 }, reason: 'providerPermissionMissing' };
  expect(parseConnection({ ...connection(), recommendedRecovery })?.recommendedRecovery).toEqual(recommendedRecovery);
  expect(parseConnection({ ...connection(), recommendedRecovery: { ...recommendedRecovery, action: { ...recommendedRecovery.action, rawCredential: 'forbidden' } } })).toBeUndefined();
  const binding = { bindingId: 'binding-1', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'direct' },
    target: { kind: 'session', summary: 'session-1' }, inputMode: 'allAllowedMessages', deliveryMode: 'repliesOnly',
    approval: { kind: 'off' }, enabled: false, deletionState: 'none', recommendedRecovery: {
      action: { pluginId: 'happier.channels', localId: 'binding/set-enabled-v1' },
      input: { bindingId: 'binding-1', expectedRevision: 1, enabled: true }, reason: 'bindingDisabled',
    } };
  expect(parseBinding(binding)?.recommendedRecovery).toEqual(binding.recommendedRecovery);
  expect(parseBinding({ ...binding, recommendedRecovery: { action: 123 } })).toBeUndefined();
});

describe('connectionStatus', () => {
  it('keeps a history gap visible as a quiet notice without asking the owner to resume', () => {
    const historyGap = {
      reportedAt: 1_700_000_000_000, reason: 'providerHistoryUnavailable',
    } as const;
    const status = connectionStatus(connection({ historyGap }), t);
    expect(status.tone).toBe('neutral');
    expect(channelsStatusNeedsYou(status.tone)).toBe(false);
    expect(status).not.toEqual(connectionStatus(connection(), t));
    // FIN step 9 retires stop/retarget machinery, not retained rows or history notices.
    expect(connectionStatus(connection({ historyGap, oldTransportStopUnconfirmed: true, endpointRetargetOwed: true }), t))
      .toEqual(status);
  });

  it.each<Partial<ChannelsConnection['attention']>>([
    { providerReadiness: { code: 'providerCredentialInvalid' } },
    { outwardDelivery: { ...DELIVERY, outcomeUnknown: true } },
    { outwardDelivery: { ...DELIVERY, partial: true } },
    { pollFailure: { phase: 'blocked', attemptCount: 1, retryNotBeforeMs: null,
      evidence: { kind: 'provider', reason: 'providerConflict' } } },
  ])('preserves the real blocker when a history notice coexists with %o', (attention) => {
    expect(connectionStatus(connection({ ...attention, historyGap: {
      reportedAt: 1_700_000_000_000, reason: 'applicationAdmissionLost',
    } }), t)).toEqual(connectionStatus(connection(attention), t));
  });

  it('preserves deletion progress when a history notice remains recorded', () => {
    const row = connection({ historyGap: {
      reportedAt: 1_700_000_000_000, reason: 'providerHistoryUnavailable',
    } });
    expect(connectionStatus({ ...row, deletionState: 'finalizingDelete' }, t))
      .toEqual(connectionStatus({ ...connection(), deletionState: 'finalizingDelete' }, t));
  });

  it.each<Partial<ChannelsConnection['attention']>>([
    { pollFailure: { phase: 'blocked', attemptCount: 1, retryNotBeforeMs: null,
      evidence: { kind: 'provider', reason: 'providerConflict' } } },
    { outwardDelivery: { ...DELIVERY, outcomeUnknown: true } },
  ])('keeps the actual recovery Action ahead of history dismissal for %o', (attention) => {
    const row = { ...connection(attention), selectedTransport: 'checkpointedPull' as const };
    const recovery = recommendConversationConnectionRecovery(row);
    expect(recovery).not.toBeNull();
    expect(recommendConversationConnectionRecovery({ ...row, attention: { ...row.attention, historyGap: {
      reportedAt: 1_700_000_000_000, reason: 'providerHistoryUnavailable',
    } } })).toEqual(recovery);
  });

  it('says nothing for a healthy bot, asks for you in the attention tone, and keeps rose for failure', () => {
    expect(connectionStatus(connection(), t).tone).toBe('secondary');
    expect(connectionStatus(connection({ providerReadiness: { code: 'providerCredentialInvalid' } }), t).tone).toBe('attention');
    expect(connectionStatus(connection({ oldTransportStopUnconfirmed: true, endpointRetargetOwed: true }), t))
      .toEqual(connectionStatus(connection(), t));
    expect(connectionStatus(connection({ outwardDelivery: { ...DELIVERY, notDelivered: true } }), t).tone).toBe('attention');
    expect(connectionStatus(connection({ outwardDelivery: { ...DELIVERY, outcomeUnknown: true } }), t).tone).toBe('danger');
    // A retry the system owns is a caution, not a request of the reader.
    expect(connectionStatus(connection({ outwardDelivery: { ...DELIVERY, retryDue: true } }), t).tone).toBe('warning');
  });

  it('treats needs-you, caution and failure as needing a look, and a quiet state as not', () => {
    expect(channelsStatusNeedsYou('attention')).toBe(true);
    expect(channelsStatusNeedsYou('warning')).toBe(true);
    expect(channelsStatusNeedsYou('danger')).toBe(true);
    expect(channelsStatusNeedsYou('secondary')).toBe(false);
    expect(channelsStatusNeedsYou('neutral')).toBe(false);
  });
});

it('lists a router once in the conversation index and leaves its threads to the router page', () => {
  const router = parseBinding({ bindingId: 'router-1', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'direct', label: 'wilson@batiplus.ch' },
    target: { kind: 'threadRouter', summary: 'threadRouter' }, inputMode: 'allAllowedMessages', deliveryMode: 'none', approval: { kind: 'notApplicable' }, enabled: true, deletionState: 'none' });
  const thread = parseBinding({ bindingId: 'thread-1', parentBindingId: 'router-1', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'shared', label: 'Devis' },
    target: { kind: 'session', summary: 'session-1' }, inputMode: 'allAllowedMessages', deliveryMode: 'repliesOnly', approval: { kind: 'off' }, enabled: true, deletionState: 'none' });
  const orphan = parseBinding({ bindingId: 'thread-2', parentBindingId: 'router-gone', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'shared', label: 'Orphan' },
    target: { kind: 'session', summary: 'session-2' }, inputMode: 'allAllowedMessages', deliveryMode: 'repliesOnly', approval: { kind: 'off' }, enabled: true, deletionState: 'none' });
  if (router === undefined || thread === undefined || orphan === undefined) throw new Error('fixture rows must parse');
  const groups = buildChannelsConversationIndex({ bindings: [router, thread, orphan], connections: [], providerName: (id) => id, t });
  expect(groups.flatMap((group) => group.rows.map((row) => row.binding.bindingId)).sort()).toEqual(['router-1', 'thread-2']);
});

it('joins activity only by the exact retained Session id and retains the selected read reference', () => {
  const binding = parseBinding({ bindingId: 'binding-1', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'shared' },
    target: { kind: 'session', summary: 'a-shortened-prefix', sessionId: 'an-exact-session-id' }, inputMode: 'allAllowedMessages',
    deliveryMode: 'repliesOnly', approval: { kind: 'off' }, enabled: true, deletionState: 'none' });
  if (!binding) throw new Error('Expected a binding');
  const read = { status: 'ready' as const, state: { hasUnreadMessages: true,
    workStatus: { state: 'thinking', bucket: 'working' as const, tone: 'neutral' as const, attentionType: null, word: 'Working' },
    latestActivity: { kind: 'ready' as const, text: 'Approved reply', createdAt: 3000 } } };
  const build = (sessionStates: ReadonlyMap<string, typeof read>) => buildChannelsConversationIndex({
    bindings: [binding], connections: [], providerName: id => id, t, sessionStates,
  })[0]?.rows[0];
  expect(build(new Map([['a-shortened-prefix', read]]))?.session).toBeUndefined();
  expect(build(new Map([['an-exact-session-id', read]]))?.session).toBe(read);
});

it('says a bot needs you once per group, in the same words whatever its cause', () => {
  const row = parseBinding({ bindingId: 'binding-1', revision: 1, connectionId: 'connection-1', endpoint: { audience: 'shared', label: 'Ops' },
    target: { kind: 'session', summary: 'session-1' }, inputMode: 'allAllowedMessages', deliveryMode: 'repliesOnly', approval: { kind: 'off' }, enabled: true, deletionState: 'none' });
  if (row === undefined) throw new Error('fixture row must parse');
  const labelFor = (attention: Partial<ChannelsConnection['attention']>) => buildChannelsConversationIndex({
    bindings: [row], connections: [connection(attention)], providerName: (id) => id, t,
  })[0]?.botAttention?.label;
  const polling = labelFor({ pollFailure: { phase: 'blocked', attemptCount: 1, retryNotBeforeMs: null, evidence: { kind: 'provider', reason: 'providerConflict' } } });
  const credential = labelFor({ providerReadiness: { code: 'providerCredentialInvalid' } });
  expect(polling).toBe('Bot needs you');
  expect(credential).toBe(polling);
  expect(labelFor({})).toBeUndefined();
});
