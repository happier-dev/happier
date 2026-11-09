import { describe, expect, it } from 'vitest';

import {
  isAuthoritativeHumanSessionFollowMessageV1,
  SessionFollowUpdateEnvelopeV1Schema,
} from './sessionFollowUpdateEnvelopeV1.js';

const update = {
  v: 1,
  kind: 'session_follow_update',
  edge: { sourceSessionId: 'source', destinationSessionId: 'destination' },
  reason: 'source_changed',
  deliveryIntent: 'context_only',
  observed: { transcriptSeq: 3, readyEventSeq: 0, agentStateVersion: 1, turn: null },
  awareness: {
    v: 1, sessionId: 'source', title: 'Source title', lifecycle: 'ready', runtime: 'idle',
    freshness: 'live', operational: { primary: 'ready', reasons: ['ready'] },
    encryption: 'ready', availability: 'complete',
  },
  recentMessages: [{ messageId: 'message', seq: 3, text: 'Please review', provenance: null }],
  truncated: false,
};

describe('Session Follow update envelope', () => {
  it('keeps question offers complete, destination-bound and unavailable when source content is locked', () => {
    const questionOffers = [{ requestId: 'question', currentHandler: { kind: 'session', sessionId: 'destination' },
      questions: [{ id: 'q', type: 'text', prompt: 'What should I do?', required: true }] }];
    expect(SessionFollowUpdateEnvelopeV1Schema.safeParse({ ...update, questionOffers }).success).toBe(true);
    for (const value of [
      { ...update, questionOffers: [{ ...questionOffers[0], currentHandler: { kind: 'session', sessionId: 'other' } }] },
      { ...update, questionOffers: [{ ...questionOffers[0], currentHandler: { kind: 'person' } }] },
      { ...update, questionOffers: [{ ...questionOffers[0], authority: 'owner' }] },
      { ...update, questionOffers, reason: 'source_unavailable', recentMessages: [],
        awareness: { ...update.awareness, title: undefined, encryption: 'locked', availability: 'locked' } },
    ]) expect(SessionFollowUpdateEnvelopeV1Schema.safeParse(value).success).toBe(false);
  });

  it('allows wake only from authoritative decrypted human provenance', () => {
    const qualifies = (provenance: typeof update.recentMessages[number]['provenance']) =>
      isAuthoritativeHumanSessionFollowMessageV1({ provenance });
    expect(qualifies({ v: 1, kind: 'happierApp', actor: { kind: 'owner' } })).toBe(true);
    expect(qualifies({ v: 1, kind: 'cli' })).toBe(true);
    expect(qualifies({ v: 1, kind: 'pluginSession', pluginId: 'plugin', contributionLocalId: 'input', surface: 'ui', externalActor: { kind: 'human' }, contentProvenance: 'original' })).toBe(true);
    expect(qualifies(null)).toBe(false);
    expect(qualifies({ v: 1, kind: 'voice' })).toBe(false);
    expect(qualifies({ v: 1, kind: 'host', producer: 'happierApp' })).toBe(false);
    expect(qualifies({ v: 1, kind: 'happierSession', sourceSessionId: 'upstream', via: 'action' })).toBe(false);
    expect(qualifies({ v: 1, kind: 'automation', automationId: 'a', runId: 'r' })).toBe(false);
    expect(qualifies({ v: 1, kind: 'pluginSession', pluginId: 'plugin', contributionLocalId: 'input', surface: 'ui', externalActor: { kind: 'human' }, contentProvenance: 'forwarded' })).toBe(false);
    expect(qualifies({ v: 1, kind: 'pluginSession', pluginId: 'plugin', contributionLocalId: 'input', surface: 'ui', externalActor: { kind: 'bot' }, contentProvenance: 'original' })).toBe(false);
  });
  it('accepts the closed context contract and rejects foreign identities or future transcript content', () => {
    expect(SessionFollowUpdateEnvelopeV1Schema.safeParse(update).success).toBe(true);
    for (const invalid of [
      { ...update, authority: 'owner' },
      { ...update, edge: { sourceSessionId: 'source', destinationSessionId: 'source' } },
      { ...update, awareness: { ...update.awareness, sessionId: 'other' } },
      { ...update, recentMessages: [{ ...update.recentMessages[0], seq: 4 }] },
      { ...update, recentMessages: [{ ...update.recentMessages[0], messageId: '   ' }] },
      { ...update, recentMessages: [{ ...update.recentMessages[0], authorLabel: null }] },
    ]) expect(SessionFollowUpdateEnvelopeV1Schema.safeParse(invalid).success).toBe(false);
    expect(SessionFollowUpdateEnvelopeV1Schema.safeParse({
      ...update, reason: 'human_changed_source', deliveryIntent: 'wake',
    }).success).toBe(true);
    expect(SessionFollowUpdateEnvelopeV1Schema.safeParse({
      ...update, reason: 'human_changed_source', deliveryIntent: 'context_only',
    }).success).toBe(false);
    expect(SessionFollowUpdateEnvelopeV1Schema.safeParse({
      ...update, reason: 'source_changed', deliveryIntent: 'wake',
    }).success).toBe(false);
  });

  it('rejects plaintext from unavailable sources, including awareness content', () => {
    const unavailable = {
      ...update, reason: 'source_unavailable', recentMessages: [],
      awareness: { ...update.awareness, title: undefined, encryption: 'locked', availability: 'locked' },
    };
    expect(SessionFollowUpdateEnvelopeV1Schema.safeParse(unavailable).success).toBe(true);
    expect(SessionFollowUpdateEnvelopeV1Schema.safeParse({ ...unavailable, recentMessages: update.recentMessages }).success).toBe(false);
    expect(SessionFollowUpdateEnvelopeV1Schema.safeParse({
      ...unavailable, awareness: { ...unavailable.awareness, currentWork: { title: 'Private work' } },
    }).success).toBe(false);
  });

  it('cannot disclose content by labeling an unreadable source as changed', () => {
    for (const encryption of [
      'preparing', 'repair_needed', 'locked', 'access_pending',
      'setup_required', 'content_unavailable', 'unknown',
    ]) {
      const unreadable = {
        ...update,
        awareness: { ...update.awareness, title: undefined, encryption, availability: 'locked' },
        recentMessages: [],
      };
      // Content-free current facts remain usable while hydration is unavailable.
      expect(SessionFollowUpdateEnvelopeV1Schema.safeParse(unreadable).success).toBe(true);
      for (const content of [
        { ...unreadable, recentMessages: update.recentMessages },
        { ...unreadable, awareness: { ...unreadable.awareness, title: 'Private source' } },
        { ...unreadable, awareness: { ...unreadable.awareness, currentWork: { title: 'Private work' } } },
        { ...unreadable, awareness: { ...unreadable.awareness, workspace: { path: '/private' } } },
        { ...unreadable, awareness: { ...unreadable.awareness, lineage: { relation: 'fork', sourceSessionId: 'private-parent' } } },
      ]) {
        expect(SessionFollowUpdateEnvelopeV1Schema.safeParse(content).success, encryption).toBe(false);
      }
    }
    for (const encryption of ['plain', 'ready']) {
      expect(SessionFollowUpdateEnvelopeV1Schema.safeParse({
        ...update, awareness: { ...update.awareness, encryption, availability: 'partial' },
      }).success).toBe(true);
    }
  });
});
