import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import type { Credentials } from '@/persistence';
import type { Metadata } from '@/api/types';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

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

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: async () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
}));

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
]);

describe('ApiClient loopback url resolution', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockIsAxiosError.mockReset();

    envScope.patch({
      HAPPIER_HOME_DIR: '/tmp/happier-cli-test-loopback',
      HAPPIER_SERVER_URL: 'http://localhost:3005',
      HAPPIER_WEBAPP_URL: 'http://localhost:8080',
      HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_PUBLIC_SERVER_URL: undefined,
    });
    reloadConfiguration();
  });

  afterEach(() => {
    envScope.restore();
    reloadConfiguration();
  });

  it('uses 127.0.0.1 instead of localhost for http requests', async () => {
    mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });
    const output = captureConsoleLogAndMuteStdout();

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
    output.restore();

    expect(mockPost).toHaveBeenCalled();
    const calledUrl = mockPost.mock.calls[0]?.[0];
    expect(String(calledUrl)).toContain('http://127.0.0.1:3005');
    expect(String(calledUrl)).toContain('/v1/sessions');
  });

  it('uses apiServerUrl for http requests when HAPPIER_PUBLIC_SERVER_URL is set', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://localhost:3005';
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'https://my-stack.example.test';
    reloadConfiguration();

    mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });

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

    expect(mockPost).toHaveBeenCalled();
    const calledUrl = mockPost.mock.calls[0]?.[0];
    expect(String(calledUrl)).toContain('http://127.0.0.1:3005');
    expect(String(calledUrl)).toContain('/v1/sessions');
    expect(String(calledUrl)).not.toContain('my-stack.example.test');
  });
});
