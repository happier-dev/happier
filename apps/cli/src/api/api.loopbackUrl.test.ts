import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import type { Credentials } from '@/persistence';
import type { Metadata } from '@/api/types';

const { mockPost, mockIsAxiosError } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockIsAxiosError: vi.fn(() => false),
}));

vi.mock('axios', () => ({
  default: {
    post: mockPost,
    isAxiosError: mockIsAxiosError,
  },
  isAxiosError: mockIsAxiosError,
}));

describe('ApiClient loopback url resolution', () => {
  const originalEnv = {
    homeDir: process.env.HAPPIER_HOME_DIR,
    activeServerId: process.env.HAPPIER_ACTIVE_SERVER_ID,
    serverUrl: process.env.HAPPIER_SERVER_URL,
    webappUrl: process.env.HAPPIER_WEBAPP_URL,
    publicServerUrl: process.env.HAPPIER_PUBLIC_SERVER_URL,
  };

  beforeEach(() => {
    mockPost.mockReset();
    mockIsAxiosError.mockReset();

    process.env.HAPPIER_HOME_DIR = '/tmp/happier-cli-test-loopback';
    process.env.HAPPIER_SERVER_URL = 'http://localhost:3005';
    process.env.HAPPIER_WEBAPP_URL = 'http://localhost:8080';
    delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    reloadConfiguration();
  });

  afterEach(() => {
    if (originalEnv.homeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalEnv.homeDir;
    if (originalEnv.activeServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    else process.env.HAPPIER_ACTIVE_SERVER_ID = originalEnv.activeServerId;
    if (originalEnv.serverUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = originalEnv.serverUrl;
    if (originalEnv.webappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = originalEnv.webappUrl;
    if (originalEnv.publicServerUrl === undefined) delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    else process.env.HAPPIER_PUBLIC_SERVER_URL = originalEnv.publicServerUrl;

    reloadConfiguration();
  });

  it('uses 127.0.0.1 instead of localhost for http requests', async () => {
    mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const credential: Credentials = {
      token: 'fake-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
    };
    const { ApiClient } = await import('./api');
    const api = await ApiClient.create(credential);

    const metadata: Metadata = {
      path: '/tmp',
      host: 'localhost',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/happier-cli-test-loopback',
      happyLibDir: '/tmp/happier-cli-test-loopback/lib',
      happyToolsDir: '/tmp/happier-cli-test-loopback/tools',
      machineId: 'test-machine',
    };
    await api.getOrCreateSession({
      tag: 'test-tag',
      metadata,
      state: null,
    });
    consoleSpy.mockRestore();

    expect(mockPost).toHaveBeenCalled();
    const calledUrl = mockPost.mock.calls[0]?.[0];
    expect(String(calledUrl)).toContain('http://127.0.0.1:3005');
    expect(String(calledUrl)).toContain('/v1/sessions');
  });
});
