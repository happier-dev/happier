import { chmodSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from './configuration';
import { runAddedHostedSession, runInHostedSessionScope } from './agent/runtime/lifecycle/hostedSessionScope';
import { resolveEffectiveClientEncryptionRequirement } from './settings/accountSettings/resolveEffectiveClientEncryptionRequirement';

// Observe the real filesystem boundary while retaining all actual IO behavior.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, chmodSync: vi.fn(actual.chmodSync), existsSync: vi.fn(actual.existsSync), mkdirSync: vi.fn(actual.mkdirSync) };
});

afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfiguration();
});

describe('hosted Session Configuration policy', () => {
  it('isolates concurrent Session policies while retaining the host Home and installation identity', async () => {
    vi.stubEnv('HAPPIER_SESSION_KEEPALIVE_IDLE_MS', '17000');
    vi.stubEnv('HAPPIER_ENCRYPTION_REQUIREMENT', 'follow_account');
    reloadConfiguration();
    const hostHome = configuration.happyHomeDir;
    const hostIdentity = configuration.installationIdentityFile;
    const sessionHome = join(mkdtempSync(join(tmpdir(), 'session-policy-')), 'unused-home');
    for (const operation of [chmodSync, existsSync, mkdirSync]) vi.mocked(operation).mockClear();
    const observe = async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return {
        idle: configuration.sessionKeepAliveIdleMs,
        thinking: configuration.sessionKeepAliveThinkingMs,
        recovery: configuration.transcriptRecoveryDelayMs,
        replay: configuration.replaySeedMaxChars,
        upload: configuration.filesUploadMaxFileBytes,
        encryption: resolveEffectiveClientEncryptionRequirement(null),
        home: configuration.happyHomeDir,
        installation: configuration.installationIdentityFile,
      };
    };
    const [a, b] = await Promise.all([
      runAddedHostedSession({
        environment: {
          NODE_ENV: 'test',
          HAPPIER_HOME_DIR: sessionHome,
          HAPPIER_SESSION_KEEPALIVE_IDLE_MS: '23000',
          HAPPIER_SESSION_KEEPALIVE_THINKING_MS: '750',
          HAPPIER_TRANSCRIPT_RECOVERY_DELAY_MS: '40',
          HAPPIER_REPLAY_MAX_SEED_CHARS: '140000',
          HAPPIER_FILES_UPLOAD_MAX_FILE_BYTES: '123456',
          HAPPIER_ENCRYPTION_REQUIREMENT: 'require_e2ee',
        },
        workingDirectory: '/session/a',
        end: () => {},
      }, observe),
      runInHostedSessionScope({ environment: {
        NODE_ENV: 'test',
        HAPPIER_SESSION_KEEPALIVE_IDLE_MS: '31000',
        HAPPIER_SESSION_KEEPALIVE_THINKING_MS: '1250',
        HAPPIER_TRANSCRIPT_RECOVERY_DELAY_MS: '80',
        HAPPIER_REPLAY_MAX_SEED_CHARS: '180000',
        HAPPIER_FILES_UPLOAD_MAX_FILE_BYTES: '654321',
        HAPPIER_ENCRYPTION_REQUIREMENT: 'follow_account',
      } }, observe),
    ]);
    expect(a).toEqual({ idle: 23000, thinking: 750, recovery: 40, replay: 140000, upload: 123456,
      encryption: 'require_e2ee', home: hostHome, installation: hostIdentity });
    expect(b).toEqual({ idle: 31000, thinking: 1250, recovery: 80, replay: 180000, upload: 654321,
      encryption: 'follow_account', home: hostHome, installation: hostIdentity });
    expect(configuration.sessionKeepAliveIdleMs).toBe(17000);
    expect(resolveEffectiveClientEncryptionRequirement(null)).toBe('follow_account');
    for (const operation of [chmodSync, existsSync, mkdirSync]) expect(operation).not.toHaveBeenCalled();
    expect(existsSync(sessionHome)).toBe(false);
  });

  it('captures policy once at admission and keeps nested work on the admitted policy', () => {
    let reads = 0;
    let idle = '23000';
    const environment = Object.defineProperty({ NODE_ENV: 'test' as const }, 'HAPPIER_SESSION_KEEPALIVE_IDLE_MS', {
      get: () => { reads += 1; return idle; },
    });
    runInHostedSessionScope({ environment }, () => {
      idle = '31000';
      for (let read = 0; read < 100; read += 1) expect(configuration.sessionKeepAliveIdleMs).toBe(23000);
      runInHostedSessionScope({ environment: { NODE_ENV: 'test', HAPPIER_SESSION_KEEPALIVE_IDLE_MS: '41000' } }, () => {
        expect(configuration.sessionKeepAliveIdleMs).toBe(23000);
      });
    });
    expect(reads).toBe(1);
  });

  it('preserves explicit reload and field overrides without changing sibling policies', async () => {
    vi.stubEnv('HAPPIER_SESSION_KEEPALIVE_IDLE_MS', '17000');
    reloadConfiguration();
    let resumeSibling!: () => void;
    const reloaded = new Promise<void>(resolve => { resumeSibling = resolve; });
    const sibling = runInHostedSessionScope({ environment: { NODE_ENV: 'test', HAPPIER_SESSION_KEEPALIVE_IDLE_MS: '31000' } }, async () => {
      await reloaded;
      return configuration.sessionKeepAliveIdleMs;
    });
    runInHostedSessionScope({ environment: { NODE_ENV: 'test', HAPPIER_SESSION_KEEPALIVE_IDLE_MS: '23000' } }, () => {
      const mutable = configuration as { sessionKeepAliveIdleMs: number };
      mutable.sessionKeepAliveIdleMs = 24000;
      expect(configuration.sessionKeepAliveIdleMs).toBe(24000);
      reloadConfiguration();
      expect(configuration.sessionKeepAliveIdleMs).toBe(23000);
    });
    resumeSibling();
    expect(await sibling).toBe(31000);
    expect(configuration.sessionKeepAliveIdleMs).toBe(17000);
    const mutable = configuration as { sessionKeepAliveIdleMs: number };
    mutable.sessionKeepAliveIdleMs = 18000;
    expect(configuration.sessionKeepAliveIdleMs).toBe(18000);
    reloadConfiguration();
    expect(configuration.sessionKeepAliveIdleMs).toBe(17000);
  });
});
