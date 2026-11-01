import { describe, expect, it } from 'vitest';
import { agentEventAttentionImpact, agentEventLocalIdAttentionImpact } from '@happier-dev/protocol';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { createClaudeUnifiedCompactionProjection } from '../../../plugins/claude/src/agent/runtime/terminal/unified/compaction';
import { normalizeRawMessage } from '../../../session-core/src/raw/normalize';
import type { Message } from '../../../session-core/src/messages/messageTypes';
import { filterVisibleContextCompactionLifecycleMessageIds } from '../../../../apps/ui/sources/components/sessions/transcript/events/contextCompactionLifecycleProjection';
import { projectRuntimeTranscriptEvent, type RuntimeTranscriptProjectionSession } from '../../../../apps/cli/src/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';

describe('native idle compaction through retained transcript presentation', () => {
  it.each([
    { noticeFirst: false, adoption: false },
    { noticeFirst: true, adoption: false },
    { noticeFirst: false, adoption: true },
    { noticeFirst: true, adoption: true },
  ])('keeps one quiet measured row ($noticeFirst/$adoption)', async ({ noticeFirst, adoption }) => {
    const messages: Record<string, Message> = {};
    const messageIds: string[] = [];
    const quiet = { affectsUnread: false, affectsMeaningfulActivity: false };
    const session: RuntimeTranscriptProjectionSession = {
      sessionId: 'native-idle-session',
      enqueueAgentMessageCommitted: async (_provider, body, options) => {
        const normalized = normalizeRawMessage(options.localId, null, options.createdAt ?? 1000, {
          role: 'agent', content: body,
        });
        expect(normalized?.role).toBe('event');
        if (!normalized || normalized.role !== 'event') throw new Error('Expected a retained event');
        expect(agentEventAttentionImpact(normalized.content)).toEqual(quiet);
        expect(agentEventLocalIdAttentionImpact(options.localId)).toEqual(quiet);
        expect(JSON.stringify(body)).not.toContain('settings.json');
        expect(options.meta?.runtimeTurnId).toBeUndefined();
        messageIds.push(options.localId);
        messages[options.localId] = { id: options.localId, kind: 'agent-event', localId: options.localId,
          createdAt: options.createdAt ?? 1000, event: normalized.content };
        return { persisted: true, delivered: true };
      },
    };
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'native-idle-boundary',
      sessionId: session.sessionId, compactMetadata: { trigger: 'auto', preTokens: 240000, postTokens: 80000 } };
    const notice = { type: 'system', subtype: 'informational', level: 'notice', uuid: 'native-idle-notice',
      sessionId: session.sessionId,
      content: `${adoption ? 'Compacted using a summary written while you were away' : 'Compacted while idle, before the prompt cache expired'} · turn off with "idleCompaction": false in settings.json` };
    const summary = { type: 'user', uuid: 'native-idle-summary', sessionId: session.sessionId,
      isCompactSummary: true, message: { role: 'user', content: 'Native compact summary' } };
    const projector = createClaudeUnifiedCompactionProjection();
    let sequence = 0;
    for (const row of noticeFirst ? [notice, boundary, summary] : [boundary, summary, notice]) {
      for (const event of projector.observe(row, session.sessionId, 1000)) {
        const runtimeEvent = AgentSessionRuntimeEventSchema.parse({ ...event, kind: 'context-compaction',
          sessionId: session.sessionId, sequence: sequence++ });
        expect(await projectRuntimeTranscriptEvent({ session, provider: 'claude', event: runtimeEvent }))
          .toMatchObject({ projected: true });
      }
    }
    const visibleIds = filterVisibleContextCompactionLifecycleMessageIds(messageIds, messages);
    expect(visibleIds).toHaveLength(1);
    const visible = messages[visibleIds[0]!];
    expect(visible).toMatchObject({ kind: 'agent-event', event: { type: 'context-compaction',
      phase: 'completed', trigger: 'idle', tokenCountSource: 'providerReported', tokenCountBefore: 240000, tokenCountAfter: 80000 } });
  });
});
