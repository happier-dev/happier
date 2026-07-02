import { describe, expect, it } from 'vitest';

import type { EnvRuntimeServiceV1, ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import * as cursorAuthModule from './status.js';
import { resolveCursorAuthStatus } from './status.js';

type CursorAuthModuleWithProbe = typeof cursorAuthModule & Readonly<{
  checkCursorAuthStatus?: (params: Readonly<{
    env: Pick<EnvRuntimeServiceV1, 'get'>;
    exec: Pick<ExecRuntimeServiceV1, 'run'>;
    executablePath: string;
  }>) => Promise<ReturnType<typeof resolveCursorAuthStatus>>;
}>;

describe('resolveCursorAuthStatus', () => {
  it('uses CURSOR_API_KEY as logged-in auth material', () => {
    expect(resolveCursorAuthStatus({
      apiKey: ' cursor-key ',
      aboutJson: null,
      exitCode: null,
    })).toEqual({
      status: 'logged_in',
      source: 'api_key',
    });
  });

  it('maps about json with authenticated user information to logged_in', () => {
    expect(resolveCursorAuthStatus({
      apiKey: null,
      aboutJson: '{"user":{"email":"person@example.com"},"cliVersion":"2026.05.24-dda726e"}',
      exitCode: 0,
    })).toEqual({
      status: 'logged_in',
      source: 'about_json',
    });
  });

  it('maps malformed or failed about probes to unknown', () => {
    expect(resolveCursorAuthStatus({
      apiKey: null,
      aboutJson: '{',
      exitCode: 0,
    })).toEqual({
      status: 'unknown',
      source: 'probe_failed',
    });
  });

  it('runs cursor about through exec with materialized api-key env', async () => {
    const launches: unknown[] = [];
    const env: Pick<EnvRuntimeServiceV1, 'get'> = {
      get: (name) => (name === 'CURSOR_API_KEY' ? ' cursor-key ' : null),
    };
    const exec: Pick<ExecRuntimeServiceV1, 'run'> = {
      run: async (launch) => {
        launches.push(launch);
        return {
          exitCode: 0,
          signal: null,
          stdout: '{}',
          stderr: '',
        };
      },
    };
    const authModule: CursorAuthModuleWithProbe = cursorAuthModule;

    expect(authModule.checkCursorAuthStatus).toBeTypeOf('function');
    const status = await authModule.checkCursorAuthStatus?.({
      env,
      exec,
      executablePath: '/opt/cursor-agent',
    });

    expect(status).toEqual({ status: 'logged_in', source: 'api_key' });
    expect(launches).toEqual([
      {
        kind: 'binary',
        executablePath: '/opt/cursor-agent',
        args: ['about', '--format', 'json'],
        env: { CURSOR_API_KEY: 'cursor-key' },
      },
    ]);
  });
});
