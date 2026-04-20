import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const readAiAutoDebugRemoteLoggingEnabledMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('@/config', () => ({
  config: {
    serverUrl: 'https://example.test',
  },
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

vi.mock('@/utils/system/aiAutoDebuggingEnv', () => ({
  readAiAutoDebugRemoteLoggingEnabled: readAiAutoDebugRemoteLoggingEnabledMock,
}));

describe('remoteLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    runtimeFetchMock.mockReset();
    readAiAutoDebugRemoteLoggingEnabledMock.mockReset();
    readAiAutoDebugRemoteLoggingEnabledMock.mockReturnValue(true);
  });

  it('redacts voice update payloads before sending them off-device', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});

    const { monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds } = await import('./remoteLogger');

    monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds();
    runtimeFetchMock.mockClear();

    console.log('🎤 Voice: Reporting contextual update:', 'TOP_SECRET_CONTEXT');

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    const calls = runtimeFetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const requestInit = calls[0]?.[1];
    expect(requestInit).toBeDefined();
    if (!requestInit) {
      throw new Error('Expected runtimeFetch to receive request init');
    }

    const body = JSON.parse(String(requestInit.body));

    expect(body.message).toContain('🎤 Voice: Reporting contextual update:');
    expect(body.message).not.toContain('TOP_SECRET_CONTEXT');
    expect(body.messageRawObject).toBeUndefined();
  });

  it('stores redacted voice payloads in the in-memory buffer', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});

    const {
      clearLogBuffer,
      getLogBuffer,
      monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds,
    } = await import('./remoteLogger');

    monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds();
    clearLogBuffer();
    runtimeFetchMock.mockClear();

    console.log('🎤 Voice: Reporting contextual update:', 'TOP_SECRET_CONTEXT');

    const [entry] = getLogBuffer();
    expect(entry?.message).toEqual([
      '🎤 Voice: Reporting contextual update:',
      '[voice_payload_redacted]',
    ]);
    expect(entry?.message).not.toContain('TOP_SECRET_CONTEXT');
  });
});
