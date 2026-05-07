import { describe, expect, it } from 'vitest';
import { getSessionNotificationTitle } from './readyNotificationContext';

describe('readyNotificationContext', () => {
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
