import { describe, expect, it } from 'vitest';
import {
  agentEventAttentionImpact,
  agentEventLocalIdAttentionImpact,
  buildAgentEventLocalId,
  TranscriptRawAgentEventV1Schema,
  TranscriptRawRecordV1Schema,
} from './transcriptRawRecordV1.js';

describe('idle compaction attention', () => {
  it.each(['started', 'progress', 'completed', 'failed', 'cancelled'] as const)(
    'keeps plain and encrypted %s records quiet while ordinary compaction keeps attention', (phase) => {
      const idle = { type: 'context-compaction', phase, trigger: 'idle', lifecycleId: 'native-compact' };
      const localId = buildAgentEventLocalId('context-compaction', ['idle', 'native-compact', phase, 8]);
      expect(TranscriptRawAgentEventV1Schema.parse(idle)).toEqual(idle);
      expect(TranscriptRawRecordV1Schema.parse({ role: 'agent', content: { type: 'event', id: localId, data: idle } })).toBeDefined();
      expect(agentEventAttentionImpact(idle)).toEqual({ affectsUnread: false, affectsMeaningfulActivity: false });
      expect(agentEventLocalIdAttentionImpact(localId)).toEqual(agentEventAttentionImpact(idle));
      for (const trigger of ['manual', 'auto', 'threshold', 'overflow', 'unknown']) {
        expect(agentEventAttentionImpact({ ...idle, trigger })).toEqual({ affectsUnread: true, affectsMeaningfulActivity: true });
      }
    },
  );

  it('preserves measured counts and predecessor triggers without adding a stored unknown phase', () => {
    const event = { type: 'context-compaction', phase: 'completed', trigger: 'idle', tokenCountBefore: 200000, tokenCountAfter: 12000, tokenCountSource: 'providerReported' as const };
    expect(TranscriptRawAgentEventV1Schema.parse(event)).toEqual(event);
    for (const trigger of ['manual', 'auto', 'threshold', 'overflow', 'unknown']) {
      expect(TranscriptRawAgentEventV1Schema.safeParse({ ...event, trigger }).success).toBe(true);
    }
    expect(TranscriptRawAgentEventV1Schema.safeParse({ ...event, phase: 'outcomeUnknown' }).success).toBe(false);
  });

  it.each(['context-compaction:idle', 'context-compaction:idle:one:future:8',
    'context-compaction:idle:one:completed:bad', 'context-compaction:idle:one:completed:8:extra',
    'context-compaction:unknown:one:completed:8'])(
    'does not silence an unrecognized encrypted identity (%s)', (localId) => {
      expect(agentEventLocalIdAttentionImpact(localId)).not.toEqual({ affectsUnread: false, affectsMeaningfulActivity: false });
    },
  );
});
