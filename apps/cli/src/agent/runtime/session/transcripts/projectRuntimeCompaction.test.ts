import { describe, expect, it } from 'vitest';
import { agentEventAttentionImpact, agentEventLocalIdAttentionImpact } from '@happier-dev/protocol';
import { projectRuntimeTranscriptEvent, type RuntimeTranscriptProjectionSession } from './projectRuntimeTranscriptEvent';

describe('runtime compaction transcript projection', () => {
  it('commits distinct idle phases with one lifecycle identity and quiet encrypted identities', async () => {
    const writes: Array<{ body: unknown; options: unknown }> = [];
    const session: RuntimeTranscriptProjectionSession = { sessionId: 'session-compact',
      enqueueAgentMessageCommitted: async (_provider, body, options) => {
        writes.push({ body, options });
        return { persisted: true, delivered: true };
      } };
    const base = { kind: 'context-compaction', sessionId: session.sessionId, compactionId: 'native-compact',
      emittedAtMs: 1000, trigger: 'idle' };
    for (const [sequence, phase] of ['started', 'progress', 'completed'].entries()) {
      expect(await projectRuntimeTranscriptEvent({ session, provider: 'claude', event: {
        ...base, phase, sequence,
        ...(phase === 'completed' ? { tokenCountSource: 'providerReported', tokenCountBefore: 200000, tokenCountAfter: 12000 } : {}),
      } })).toMatchObject({ projected: true, kind: 'context-compaction' });
    }
    expect(writes).toHaveLength(3);
    const ids = new Set<string>();
    for (const write of writes) {
      expect(write.body).toMatchObject({ type: 'event', data: { type: 'context-compaction', trigger: 'idle', lifecycleId: 'native-compact' } });
      const body = write.body as { data: unknown };
      const options = write.options as { localId: string; meta?: Record<string, unknown> };
      ids.add(options.localId);
      expect(agentEventAttentionImpact(body.data)).toEqual({ affectsUnread: false, affectsMeaningfulActivity: false });
      expect(agentEventLocalIdAttentionImpact(options.localId)).toEqual(agentEventAttentionImpact(body.data));
      expect(options.meta?.runtimeTurnId).toBeUndefined();
    }
    expect(ids.size).toBe(3);
    expect(writes[2].body).toMatchObject({ data: { tokenCountSource: 'providerReported', tokenCountBefore: 200000, tokenCountAfter: 12000 } });
  });

  it.each(['providerReported', 'providerEstimated', 'derivedEstimate'] as const)('preserves existing %s counts and provenance across started and completed phases', async (tokenCountSource) => {
    const writes: unknown[] = [];
    const session: RuntimeTranscriptProjectionSession = { sessionId: 'session-counts',
      enqueueAgentMessageCommitted: async (_provider, body) => { writes.push(body); return { persisted: true, delivered: true }; } };
    const base = { kind: 'context-compaction' as const, sessionId: session.sessionId, compactionId: 'counted-compact',
      emittedAtMs: 1000, trigger: 'idle' as const, tokenCountBefore: 200000, tokenCountSource };
    await projectRuntimeTranscriptEvent({ session, provider: 'plugin-agent', event: { ...base, phase: 'started', sequence: 0 } });
    await projectRuntimeTranscriptEvent({ session, provider: 'plugin-agent', event: { ...base, phase: 'completed', sequence: 1, tokenCountAfter: 12000 } });
    expect(writes).toMatchObject([
      { data: { phase: 'started', tokenCountBefore: 200000, tokenCountSource } },
      { data: { phase: 'completed', tokenCountBefore: 200000, tokenCountAfter: 12000, tokenCountSource } },
    ]);
  });

  it('projects ordinary automatic compaction and leaves outcomeUnknown unprojectable', async () => {
    const writes: unknown[] = [];
    const session: RuntimeTranscriptProjectionSession = { sessionId: 'session-compact',
      enqueueAgentMessageCommitted: async (_provider, body) => { writes.push(body); return { persisted: true, delivered: true }; } };
    const base = { kind: 'context-compaction', sessionId: session.sessionId, compactionId: 'automatic-compact',
      emittedAtMs: 1000, trigger: 'automatic', sequence: 1 };
    expect(await projectRuntimeTranscriptEvent({ session, provider: 'claude', event: { ...base, phase: 'completed', turnId: 'real-turn' } }))
      .toMatchObject({ projected: true });
    expect(writes).toEqual([expect.objectContaining({ data: expect.objectContaining({ trigger: 'auto', turnId: 'real-turn' }) })]);
    expect(await projectRuntimeTranscriptEvent({ session, provider: 'claude', event: {
      ...base, phase: 'outcomeUnknown', diagnostic: { code: 'native_lost', severity: 'warning', message: 'Native outcome unavailable' },
    } })).toEqual({ projected: false, reason: 'unsupported_event' });
    expect(writes).toHaveLength(1);
  });

  it('retains failed and cancelled idle outcomes without inventing a foreground turn', async () => {
    const writes: unknown[] = [];
    const session: RuntimeTranscriptProjectionSession = { sessionId: 'session-compact',
      enqueueAgentMessageCommitted: async (_provider, body) => { writes.push(body); return { persisted: true, delivered: true }; } };
    for (const [sequence, phase] of ['failed', 'cancelled'].entries()) {
      expect(await projectRuntimeTranscriptEvent({ session, provider: 'claude', event: {
        kind: 'context-compaction', sessionId: session.sessionId, compactionId: 'idle-interrupted',
        trigger: 'idle', emittedAtMs: 1000, sequence, phase,
        diagnostic: { code: 'native_compaction_failed', severity: 'warning', message: 'Native compact interrupted' },
      } })).toMatchObject({ projected: true });
    }
    expect(writes).toHaveLength(2);
    for (const body of writes) expect(body).toMatchObject({ data: {
      trigger: 'idle', lifecycleId: 'idle-interrupted', errorCode: 'native_compaction_failed',
      sanitizedErrorPreview: 'Native compact interrupted',
    } });
  });

  it('keeps a valid punctuation-only plugin compaction identity quiet when encrypted', async () => {
    const localIds: string[] = [];
    const session: RuntimeTranscriptProjectionSession = { sessionId: 'session-plugin',
      enqueueAgentMessageCommitted: async (_provider, _body, options) => {
        localIds.push(options.localId); return { persisted: true, delivered: true };
      } };
    expect(await projectRuntimeTranscriptEvent({ session, provider: 'plugin-agent', event: {
      kind: 'context-compaction', sessionId: session.sessionId, compactionId: '_', trigger: 'idle',
      phase: 'completed', sequence: 0, emittedAtMs: 1000,
    } })).toMatchObject({ projected: true });
    expect(localIds).toHaveLength(1);
    expect(agentEventLocalIdAttentionImpact(localIds[0])).toEqual({ affectsUnread: false, affectsMeaningfulActivity: false });
  });
});
