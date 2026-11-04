import { describe, expect, it } from 'vitest';
import { createSpokenActionConfirmation } from './spokenActionConfirmation';

const actionId = 'notifications.webhooks.remove' as const;
const operation = (channelId: string, actionRequestId = 'remove-webhook') => ({
  actionId, actionRequestId,
  normalizedInput: { channelId },
  summary: `Remove notification webhook ${channelId}.`,
});

describe('live carrier spoken Action read-back binding', () => {
  it('admits the exact operation only after its captured speech drain, once', () => {
    const carrier = createSpokenActionConfirmation();
    const request = operation('channel-one');
    carrier.prepare(request);
    const speech = carrier.readPending();
    expect(carrier.completeReadBack(speech)).toBe(true);
    expect(carrier.completeReadBack(speech)).toBe(false);
    expect(carrier.readPending()).toBeNull();
  });

  it('replaces a changed operation and never lets an older speech drain confirm its replacement', () => {
    const carrier = createSpokenActionConfirmation();
    const first = operation('channel-one');
    carrier.prepare(first);
    const oldSpeech = carrier.readPending();
    const second = operation('channel-two', 'remove-other-webhook');
    carrier.prepare(second);
    expect(carrier.completeReadBack(oldSpeech)).toBe(false);
    expect(carrier.readPending()?.operation).toEqual(second);
    expect(carrier.completeReadBack(carrier.readPending())).toBe(true);
  });

  it('discards pending playback at call end', () => {
    const carrier = createSpokenActionConfirmation();
    const request = operation('channel-one');
    carrier.prepare(request);
    const speech = carrier.readPending();
    carrier.clear();
    expect(carrier.completeReadBack(speech)).toBe(false);
    expect(carrier.readPending()).toBeNull();
  });

});
