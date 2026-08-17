import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installDaemonSpeechStreamQaRouteRequirement,
  readDaemonSpeechStreamQaRouteRequirement,
} from './daemonSpeechStreamQaRouteRequirement';

describe('daemonSpeechStreamQaRouteRequirement', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('scopes a relay requirement to one session in a debug runtime', () => {
    vi.stubEnv('EXPO_PUBLIC_DEBUG', '1');
    const release = installDaemonSpeechStreamQaRouteRequirement({
      sessionId: 'qa-session',
      routeKind: 'server_relay',
    });

    expect(readDaemonSpeechStreamQaRouteRequirement('qa-session')).toBe('server_relay');
    expect(readDaemonSpeechStreamQaRouteRequirement('other-session')).toBeNull();

    release();
    expect(readDaemonSpeechStreamQaRouteRequirement('qa-session')).toBeNull();
  });

  it('fails closed in a production runtime', () => {
    vi.stubEnv('EXPO_PUBLIC_DEBUG', '0');
    vi.stubGlobal('__DEV__', false);
    const release = installDaemonSpeechStreamQaRouteRequirement({
      sessionId: 'qa-session',
      routeKind: 'server_relay',
    });

    expect(readDaemonSpeechStreamQaRouteRequirement('qa-session')).toBeNull();
    release();
  });
});
