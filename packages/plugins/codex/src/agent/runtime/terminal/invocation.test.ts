import { describe, expect, it } from 'vitest';

import {
  buildCodexTerminalArgs,
  buildCodexTerminalChildEnv,
  normalizeCodexTerminalSessionId,
  resolveCodexTerminalRolloutDiscoveryConfig,
  resolveCodexTerminalSessionsRootDir,
} from './invocation.js';

const resolvePermissionPolicy = (permissionMode: string) => ({
  approvalPolicy: permissionMode === 'read-only' ? 'never' : 'on-request',
  sandbox: permissionMode === 'read-only' ? 'read-only' : 'workspace-write',
});

describe('Codex terminal invocation policy', () => {
  it('omits approval and sandbox flags for default mode', () => {
    expect(buildCodexTerminalArgs({
      cwd: '/repo',
      permissionMode: 'default',
      resolvePermissionPolicy,
    })).toEqual(['--cd', '/repo']);
  });

  it('adds resume id, permission flags, and native Codex args for non-default mode', () => {
    expect(buildCodexTerminalArgs({
      cwd: '/repo',
      resumeId: 'resume-1',
      permissionMode: 'read-only',
      codexArgs: ['exec'],
      resolvePermissionPolicy,
    })).toEqual([
      'resume',
      'resume-1',
      '--cd',
      '/repo',
      '--ask-for-approval',
      'never',
      '--sandbox',
      'read-only',
      'exec',
    ]);
  });

  it('removes Codex-internal thread env while preserving CODEX_HOME', () => {
    expect(buildCodexTerminalChildEnv({
      env: {
        CODEX_HOME: '/codex-home',
        CODEX_THREAD_ID: 'thread',
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'origin',
        CODEX_SHELL: 'shell',
        KEEP: 'yes',
      },
    })).toEqual({
      CODEX_HOME: '/codex-home',
      KEEP: 'yes',
    });
  });

  it('resolves sessions root from explicit override, Codex home, or user home', () => {
    expect(resolveCodexTerminalSessionsRootDir({
      env: { HAPPIER_CODEX_SESSIONS_DIR: '/override' },
      homeDir: '/home/me',
    })).toBe('/override');
    expect(resolveCodexTerminalSessionsRootDir({
      env: { CODEX_HOME: '/codex-home' },
      homeDir: '/home/me',
    })).toBe('/codex-home/sessions');
    expect(resolveCodexTerminalSessionsRootDir({
      env: {},
      homeDir: '/home/me',
    })).toBe('/home/me/.codex/sessions');
  });

  it('normalizes rollout discovery config and session ids', () => {
    expect(resolveCodexTerminalRolloutDiscoveryConfig({ initialTimeoutMs: 10 })).toEqual({
      initialTimeoutMs: 10,
      initialPollIntervalMs: 500,
      extendedPollIntervalMs: 2_000,
    });
    expect(normalizeCodexTerminalSessionId(' resume ')).toBe('resume');
    expect(normalizeCodexTerminalSessionId('   ')).toBeNull();
  });
});

