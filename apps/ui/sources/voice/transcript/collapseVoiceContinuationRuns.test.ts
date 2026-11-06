import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';

import { buildVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';
import { collapseVoiceContinuationRuns } from './collapseVoiceContinuationRuns';

const conversation = { serverId: 'server-1', sessionId: 'voice-1' };

function note(id: string, device: string): Message {
  return {
    kind: 'agent-text',
    id,
    localId: null,
    createdAt: 1,
    text: `Continued on ${device}`,
    meta: buildVoiceTranscriptNoteMeta({
      continuation: {
        v: 1,
        deviceId: device,
        deviceDisplayName: device,
        conversation,
      },
    }),
  } as unknown as Message;
}

function said(id: string): Message {
  return {
    kind: 'agent-text',
    id,
    localId: null,
    createdAt: 1,
    text: 'Two of five relay tests pass.',
  } as unknown as Message;
}

function byId(messages: readonly Message[]): Record<string, Message> {
  return Object.fromEntries(messages.map((message) => [message.id, message]));
}

describe('collapseVoiceContinuationRuns', () => {
  it('keeps only the newest note of each run of consecutive continuation notes', () => {
    const messages = [
      said('a'),
      note('n1', 'Chrome'),
      note('n2', 'Chrome'),
      note('n3', 'iPhone'),
      said('b'),
      note('n4', 'Chrome'),
    ];
    const ids = messages.map((message) => message.id);

    expect(collapseVoiceContinuationRuns(ids, byId(messages))).toEqual([
      'a',
      'n3',
      'b',
      'n4',
    ]);
  });

  it('returns the same id list when nothing collapses, so downstream caches keep their identity', () => {
    const messages = [note('n1', 'Chrome'), said('a'), note('n2', 'Chrome')];
    const ids = messages.map((message) => message.id);

    expect(collapseVoiceContinuationRuns(ids, byId(messages))).toBe(ids);
  });

  it('preserves independent Voice tool-result notes and breaks continuation runs at them', () => {
    const failed = { ...said('failed'), text: 'The tool failed.', meta: buildVoiceTranscriptNoteMeta() };
    const succeeded = { ...said('succeeded'), text: 'The tool succeeded.', meta: buildVoiceTranscriptNoteMeta() };
    const messages = [note('n1', 'Chrome'), failed, succeeded, note('n2', 'iPhone'), note('n3', 'Chrome')];

    expect(collapseVoiceContinuationRuns(messages.map(({ id }) => id), byId(messages))).toEqual([
      'n1', 'failed', 'succeeded', 'n3',
    ]);
    const independent = [failed, succeeded];
    const ids = independent.map(({ id }) => id);
    expect(collapseVoiceContinuationRuns(ids, byId(independent))).toBe(ids);
  });
});
