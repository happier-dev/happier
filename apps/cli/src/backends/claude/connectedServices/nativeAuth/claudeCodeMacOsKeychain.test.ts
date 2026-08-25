import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { logger } from '@/ui/logger';

const { spawnSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnSpy,
  };
});

import {
  deleteClaudeCodeMacOsKeychainCredential,
  readClaudeCodeMacOsKeychainCredential,
  resolveClaudeCodeMacOsKeychainServiceName,
  sweepStaleClaudeCodeMacOsKeychainCredentials,
} from './claudeCodeMacOsKeychain';

describe('claudeCodeMacOsKeychain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnSpy.mockReset();
  });

  function keychainMetadata(updatedAt = '20260605120100Z') {
    return [
      'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
      'version: 512',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="tester"',
      `    "mdat"<timedate>=0x32303236303630353132303130305A00  "${updatedAt}\\000"`,
    ].join('\n');
  }

  function successfulSpawnResult() {
    return {
      status: 0,
      stdout: '',
      stderr: '',
    };
  }

  function mockSecurityProcess(result: Readonly<{ status: number | null; stdout?: string; stderr?: string }>) {
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => {
      if (result.stdout) child.stdout.write(result.stdout);
      if (result.stderr) child.stderr.write(result.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', result.status);
    });
    return child;
  }

  function mockSecuritySpawn(
    resolve: (args: readonly string[]) => Readonly<{ status: number | null; stdout?: string; stderr?: string }>,
  ): void {
    spawnSpy.mockImplementation((_command: string, args: readonly string[]) => mockSecurityProcess(resolve(args)));
  }

  function dumpKeychainItems(items: readonly Readonly<{ account: string; service: string }>[]): string {
    return items.map((item) => [
      'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
      'version: 512',
      'class: "genp"',
      'attributes:',
      `    "acct"<blob>="${item.account}"`,
      `    "svce"<blob>="${item.service}"`,
    ].join('\n')).join('\n\n');
  }

  it('uses the unsuffixed service for the default Claude config dir and a hashed suffix for custom dirs', () => {
    expect(
      resolveClaudeCodeMacOsKeychainServiceName({
        claudeConfigDir: '/Users/tester/.claude',
        homeDir: '/Users/tester',
      }),
    ).toBe('Claude Code-credentials');

    expect(
      resolveClaudeCodeMacOsKeychainServiceName({
        claudeConfigDir: '/tmp/custom-claude-home',
        homeDir: '/Users/tester',
      }),
    ).toBe('Claude Code-credentials-e161167c');
  });

  it('reads and parses the GLOBAL macOS keychain credential payload (native/external fallback)', async () => {
    mockSecuritySpawn((args) => {
      if (args[0] === 'find-generic-password' && args.includes('-w')) {
        return { status: 0, stdout: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'access-placeholder',
            refreshToken: 'refresh-placeholder',
            expiresAt: 123,
            scopes: ['user:profile', 'user:sessions:claude_code'],
          },
        }) };
      }
      if (args[0] === 'find-generic-password') return { status: 0, stdout: keychainMetadata() };
      return successfulSpawnResult();
    });

    await expect(
      readClaudeCodeMacOsKeychainCredential({
        claudeConfigDir: '/Users/tester/.claude',
        homeDir: '/Users/tester',
        username: 'tester',
      }),
    ).resolves.toEqual({
      claudeAiOauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        expiresAt: 123,
        scopes: ['user:profile', 'user:sessions:claude_code'],
      },
    });

    expect(spawnSpy).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-a', 'tester', '-s', 'Claude Code-credentials', '-w'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('never consults a derived (non-global) keychain service and returns null without spawning security', async () => {
    mockSecuritySpawn(() => successfulSpawnResult());

    await expect(
      readClaudeCodeMacOsKeychainCredential({
        claudeConfigDir: '/tmp/custom-claude-home',
        homeDir: '/Users/tester',
      }),
    ).resolves.toBeNull();

    // The derived-item read channel is removed: Happier no longer writes derived per-config
    // keychain items and native Claude only uses the global service. A derived read could only
    // surface stale legacy artifacts, so the reader must not spawn `security` at all.
    expect(spawnSpy.mock.calls.some((call) => (call[1] as readonly string[])[0] === 'find-generic-password')).toBe(false);
  });

  it('deletes the derived macOS keychain credential by account and service', async () => {
    mockSecuritySpawn(() => successfulSpawnResult());

    await expect(deleteClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: '/tmp/custom-claude-home',
      homeDir: '/Users/tester',
      username: 'tester',
    })).resolves.toBeUndefined();

    expect(spawnSpy).toHaveBeenCalledWith(
      'security',
      ['delete-generic-password', '-a', 'tester', '-s', 'Claude Code-credentials-e161167c'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('treats missing derived macOS keychain credentials as already deleted', async () => {
    mockSecuritySpawn(() => ({
      status: 44,
      stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
    }));

    await expect(deleteClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: '/tmp/custom-claude-home',
      homeDir: '/Users/tester',
      username: 'tester',
    })).resolves.toBeUndefined();
  });

  it('sweeps ALL Happier-managed derived services for the account (live or otherwise) and is idempotent', async () => {
    const consoleInfo = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const fileDiagnostic = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    // Under the file-only design Happier neither writes nor reads a derived (suffixed) keychain item,
    // so EVERY managed suffixed item — including one whose home is currently live — is obsolete cruft
    // and must be removed. Liveness no longer protects an item (nothing reads it), which is why the
    // sweep no longer needs a live set.
    const liveHomeService = resolveClaudeCodeMacOsKeychainServiceName({
      claudeConfigDir: '/tmp/live-claude-home',
      homeDir: '/Users/tester',
    });
    const otherManagedService = 'Claude Code-credentials-1111aaaa';
    const otherAccountService = 'Claude Code-credentials-2222bbbb';
    const entries = new Map([
      ['global', { account: 'tester', service: 'Claude Code-credentials' }],
      ['live', { account: 'tester', service: liveHomeService }],
      ['other-managed', { account: 'tester', service: otherManagedService }],
      ['other-account', { account: 'someone-else', service: otherAccountService }],
      ['other-service', { account: 'tester', service: 'Other App credentials-3333cccc' }],
    ]);
    mockSecuritySpawn((args) => {
      if (args[0] === 'dump-keychain') {
        return { status: 0, stdout: dumpKeychainItems([...entries.values()]) };
      }
      if (args[0] === 'delete-generic-password') {
        const service = String(args[args.indexOf('-s') + 1] ?? '');
        for (const [key, entry] of entries.entries()) {
          if (entry.service === service) entries.delete(key);
        }
        return successfulSpawnResult();
      }
      return successfulSpawnResult();
    });

    const first = await sweepStaleClaudeCodeMacOsKeychainCredentials({
      homeDir: '/Users/tester',
      username: 'tester',
    });
    const second = await sweepStaleClaudeCodeMacOsKeychainCredentials({
      homeDir: '/Users/tester',
      username: 'tester',
    });

    expect(first.scanned).toBe(5);
    expect(first.deleted).toEqual(expect.arrayContaining([
      { account: 'tester', service: liveHomeService },
      { account: 'tester', service: otherManagedService },
    ]));
    expect(first.deleted).toHaveLength(2);
    expect(first.skipped).toEqual(expect.arrayContaining([
      { account: 'tester', service: 'Claude Code-credentials', reason: 'global_service' },
      { account: 'someone-else', service: otherAccountService, reason: 'different_account' },
      { account: 'tester', service: 'Other App credentials-3333cccc', reason: 'not_happier_managed_service' },
    ]));
    expect(second.deleted).toEqual([]);
    // The user's global login and other-account residue (e.g. happier-test-user) are NEVER touched.
    expect(entries.get('global')).toEqual({ account: 'tester', service: 'Claude Code-credentials' });
    expect(entries.get('other-account')).toEqual({ account: 'someone-else', service: otherAccountService });
    expect(entries.get('other-service')).toEqual({ account: 'tester', service: 'Other App credentials-3333cccc' });
    expect(fileDiagnostic).toHaveBeenCalledWith(
      '[DAEMON RUN] Claude Code keychain stale credential sweep',
      expect.objectContaining({
        scanned: 5,
        deletedCount: 2,
        skippedCounts: {
          different_account: 1,
          global_service: 1,
          not_happier_managed_service: 1,
        },
      }),
    );
    expect(JSON.stringify(fileDiagnostic.mock.calls)).not.toContain(liveHomeService);
    expect(JSON.stringify(fileDiagnostic.mock.calls)).not.toContain(otherAccountService);
    expect(consoleInfo).not.toHaveBeenCalled();
  });

  it('never deletes the global service or a different-account item (protects the user login and test residue)', async () => {
    const deleteAttempts: string[] = [];
    mockSecuritySpawn((args) => {
      if (args[0] === 'dump-keychain') {
        return {
          status: 0,
          stdout: dumpKeychainItems([
            { account: 'tester', service: 'Claude Code-credentials' },
            { account: 'happier-test-user', service: 'Claude Code-credentials-deadbeef' },
          ]),
        };
      }
      if (args[0] === 'delete-generic-password') {
        deleteAttempts.push(String(args[args.indexOf('-s') + 1] ?? ''));
        return successfulSpawnResult();
      }
      return successfulSpawnResult();
    });

    const result = await sweepStaleClaudeCodeMacOsKeychainCredentials({
      homeDir: '/Users/tester',
      username: 'tester',
    });

    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      { account: 'tester', service: 'Claude Code-credentials', reason: 'global_service' },
      { account: 'happier-test-user', service: 'Claude Code-credentials-deadbeef', reason: 'different_account' },
    ]));
    expect(deleteAttempts).toEqual([]);
  });
});
