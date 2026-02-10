import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGeminiBackend } from './backend';

type AcpBackendLike = {
  options: {
    authMethodId?: string;
    env?: Record<string, string | undefined>;
  };
};

function withTempHome<T>(fn: (homeDir: string) => T): T {
  const prevHome = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'happier-gemini-home-'));
  process.env.HOME = dir;
  try {
    return fn(dir);
  } finally {
    process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('createGeminiBackend auth method', () => {
  it('defaults to oauth-personal when no API key is present', () => {
    withTempHome(() => {
      const prevGeminiKey = process.env.GEMINI_API_KEY;
      const prevGoogleKey = process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      try {
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: {},
          model: null,
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(backend.options.authMethodId).toBe('oauth-personal');
      } finally {
        if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = prevGeminiKey;
        if (prevGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
        else process.env.GOOGLE_API_KEY = prevGoogleKey;
      }
    });
  });

  it('uses gemini-api-key when GEMINI_API_KEY is present', () => {
    withTempHome(() => {
      const prevGeminiKey = process.env.GEMINI_API_KEY;
      const prevGoogleKey = process.env.GOOGLE_API_KEY;
      process.env.GEMINI_API_KEY = 'AIzaFakeKey';
      try {
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: {},
          model: null,
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(backend.options.authMethodId).toBe('gemini-api-key');
      } finally {
        if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = prevGeminiKey;
        if (prevGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
        else process.env.GOOGLE_API_KEY = prevGoogleKey;
      }
    });
  });

  it('uses gemini-api-key when cloudToken is provided', () => {
    withTempHome(() => {
      const prevGeminiKey = process.env.GEMINI_API_KEY;
      const prevGoogleKey = process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      try {
        const result = createGeminiBackend({
          cwd: '/tmp',
          env: {},
          model: null,
          cloudToken: 'cloud-token',
        });

        const backend = result.backend as unknown as AcpBackendLike;
        expect(backend.options.authMethodId).toBe('gemini-api-key');
        expect(backend.options.env?.GEMINI_API_KEY).toBe('cloud-token');
      } finally {
        if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = prevGeminiKey;
        if (prevGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
        else process.env.GOOGLE_API_KEY = prevGoogleKey;
      }
    });
  });
});
