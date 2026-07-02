import { describe, expect, it } from 'vitest';

import {
  getSessionNotificationAgentDisplayName,
  getSessionNotificationTitle,
} from './sessionNotificationContext';

describe('sessionNotificationContext', () => {
  it('normalizes session titles from metadata snapshots', () => {
    expect(getSessionNotificationTitle(() => ({
      summary: {
        text: '  Review   branch  ',
      },
    }))).toBe('Review branch');

    expect(getSessionNotificationTitle(() => ({ name: '  Named session  ' }))).toBe('Named session');
    expect(getSessionNotificationTitle(() => ({ title: '  Titled session  ' }))).toBe('Titled session');
    expect(getSessionNotificationTitle(() => ({ summary: { text: '   ' } }))).toBeNull();
    expect(getSessionNotificationTitle()).toBeNull();
  });

  it('returns null when metadata snapshots throw', () => {
    expect(getSessionNotificationTitle(() => {
      throw new Error('metadata unavailable');
    })).toBeNull();
  });

  it('resolves agent display names from metadata before catalog fallbacks', () => {
    expect(getSessionNotificationAgentDisplayName(() => ({
      agentDisplayName: '  Claude  ',
      flavor: 'codex',
    }))).toBe('Claude');

    expect(getSessionNotificationAgentDisplayName(() => ({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'claude',
        provider: {},
      },
    }))).toBe('Claude Code CLI');
  });
});
