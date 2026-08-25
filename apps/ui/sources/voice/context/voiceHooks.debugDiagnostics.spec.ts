import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

const fakeSink = vi.hoisted(() => ({
  sendContextualUpdate: vi.fn(),
  sendTextMessage: vi.fn(),
}));

const voiceConfigState = vi.hoisted(() => ({
  DISABLE_PERMISSION_REQUESTS: false,
  DISABLE_SESSION_STATUS: true,
  DISABLE_MESSAGES: false,
  DISABLE_READY_EVENTS: false,
  ENABLE_DEBUG_LOGGING: true,
}));

vi.mock('./contextFormatters', () => ({
  formatNewMessages: vi.fn(() => 'TOP_SECRET_CONTEXT'),
  formatUserActionRequest: vi.fn(() => null),
  formatPermissionRequest: vi.fn(() => null),
  formatReadyEvent: vi.fn(() => null),
  formatSessionFull: vi.fn(() => 'TOP_SECRET_CONTEXT'),
  formatSessionOffline: vi.fn(() => null),
  formatSessionOnline: vi.fn(() => null),
  summarizeMessagesForVoiceHuman: vi.fn(() => null),
  summarizeAgentRequestForVoiceHuman: vi.fn(() => null),
}));

vi.mock('@/sync/domains/messages/readStoredSessionMessages', () => ({
  readStoredSessionMessages: vi.fn(() => []),
}));

const storageMock = createStorageModuleStub({
  storage: {
    getState: () => ({
      settings: {},
    }),
  } as any,
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

vi.mock('@/sync/domains/settings/readVoicePrivacySettings', () => ({
  readVoicePrivacySettings: vi.fn(() => ({
    shareRecentMessages: true,
    sharePermissionRequests: true,
  })),
}));

vi.mock('@/voice/runtime/voiceConfig', () => ({
  VOICE_CONFIG: voiceConfigState,
}));

vi.mock('@/voice/context/getVoiceContextSinkForSession', () => ({
  getVoiceContextSinkForSession: vi.fn(() => fakeSink),
}));

vi.mock('@/voice/context/resolveEffectiveVoiceTargetState', () => ({
  resolveEffectiveVoiceTargetState: vi.fn(() => ({
    trackedSessionIds: ['s1'],
    primaryActionSessionId: 's1',
  })),
}));

vi.mock('@/voice/context/voiceContextPrefs', () => ({
  getVoiceContextFormatterPrefs: vi.fn(() => ({})),
}));

vi.mock('@/voice/runtime/voiceTargetStore', () => ({
  useVoiceTargetStore: {
    getState: () => ({
      setPrimaryActionSessionId: vi.fn(),
      setTrackedSessionIds: vi.fn(),
    }),
  },
}));

vi.mock('@/voice/runtime/voiceUpdatePolicy', () => ({
  resolveVoiceSessionUpdatePolicy: vi.fn(() => ({
    level: 'snippets',
    snippetsMaxMessages: 3,
    includeUserMessagesInSnippets: false,
  })),
}));

vi.mock('@/voice/context/resolveVoiceContextSession', () => ({
  resolveVoiceContextSessionFromState: vi.fn(() => ({
    id: 's1',
    metadata: { summary: { text: 'Summary' } },
  })),
}));

function collectConsoleOutput(calls: unknown[][]): string {
  return calls
    .flatMap((call) =>
      call.map((arg) => {
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }),
    )
    .join('\n');
}

describe('voiceHooks debug diagnostics', () => {
  afterEach(() => {
    fakeSink.sendContextualUpdate.mockReset();
    fakeSink.sendTextMessage.mockReset();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('emits safe diagnostics without logging raw voice context payloads', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { voiceHooks } = await import('./voiceHooks');
    let output = '';

    try {
      voiceHooks.onReady('s1');
      output = collectConsoleOutput([
        ...consoleLogSpy.mock.calls,
        ...consoleDebugSpy.mock.calls,
      ]);
    } finally {
      consoleLogSpy.mockRestore();
      consoleDebugSpy.mockRestore();
    }

    expect(output).toContain('voice_contextual_update');
    expect(output).not.toContain('TOP_SECRET_CONTEXT');
  });
});
