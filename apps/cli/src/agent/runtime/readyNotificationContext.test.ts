import { describe, expect, it } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { getLatestAssistantMessagePreview, getSessionNotificationTitle } from './readyNotificationContext';

describe('readyNotificationContext', () => {
  it('returns the latest assistant message preview from the message buffer', () => {
    const messageBuffer = new MessageBuffer();
    messageBuffer.addMessage('User prompt', 'user');
    messageBuffer.addMessage('Earlier assistant reply', 'assistant');
    messageBuffer.addMessage('Status update', 'status');
    messageBuffer.addMessage('Latest assistant reply', 'assistant');

    expect(getLatestAssistantMessagePreview(messageBuffer)).toBe('Latest assistant reply');
  });

  it('normalizes session titles from metadata snapshots', () => {
    expect(getSessionNotificationTitle(() => ({
      summary: {
        text: '  Review branch  ',
      },
    }))).toBe('Review branch');

    expect(getSessionNotificationTitle(() => ({ summary: { text: '   ' } }))).toBeNull();
    expect(getSessionNotificationTitle()).toBeNull();
  });
});
