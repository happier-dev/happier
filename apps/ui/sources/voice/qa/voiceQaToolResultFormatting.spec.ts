import { afterEach, describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import type { LocalVoiceAgentToolResultEntry } from '@/voice/local/runVoiceAgentTurnWithTools';

import { formatVoiceQaToolResultsSummary } from './voiceQaToolResultFormatting';

function setSummarySharing(enabled: boolean): void {
  storage.setState((current) => ({
    ...current,
    settings: {
      ...settingsDefaults,
      voice: {
        ...settingsDefaults.voice,
        privacy: {
          ...settingsDefaults.voice.privacy,
          shareSessionSummary: enabled,
        },
      },
    },
  }) as never);
}

describe('formatVoiceQaToolResultsSummary privacy', () => {
  afterEach(() => {
    storage.setState((current) => ({ ...current, settings: settingsDefaults }) as never);
  });

  it('routes the human summary through the canonical helper and surfaces it when summaries are shared', () => {
    setSummarySharing(true);
    const toolResults: LocalVoiceAgentToolResultEntry[] = [
      {
        t: 'listSessions',
        args: {},
        result: {
          ok: true,
          sessions: [{ id: 'sess_a', title: 'Payments bugfix' }],
          nextCursor: null,
        },
      },
    ];

    const summary = formatVoiceQaToolResultsSummary(toolResults);
    expect(summary).toContain('listSessions(ok)');
    expect(summary).toContain('Payments bugfix');
  });

  it('suppresses session summary titles when shareSessionSummary is disabled', () => {
    setSummarySharing(false);
    const toolResults: LocalVoiceAgentToolResultEntry[] = [
      {
        t: 'listSessions',
        args: {},
        result: {
          ok: true,
          sessions: [{ id: 'sess_a', title: 'Confidential billing rewrite' }],
          nextCursor: null,
        },
      },
    ];

    const summary = formatVoiceQaToolResultsSummary(toolResults);
    expect(summary).toContain('listSessions(ok)');
    expect(summary).not.toContain('Confidential billing rewrite');
  });
});
