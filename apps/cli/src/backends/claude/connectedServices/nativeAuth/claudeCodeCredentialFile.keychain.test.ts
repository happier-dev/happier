import { mkdtemp, readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

const NOW_MS = Date.parse('2026-06-06T12:00:00.000Z');
const FILE_EXPIRES_AT_MS = NOW_MS + 30 * 60_000;
const KEYCHAIN_EXPIRES_AT_MS = NOW_MS + 60 * 60_000;

function keychainPayload() {
  return {
    claudeAiOauth: {
      accessToken: 'keychain-access-placeholder',
      refreshToken: 'keychain-refresh-placeholder',
      expiresAt: KEYCHAIN_EXPIRES_AT_MS,
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    },
  };
}

function keychainMetadata(updatedAt = '20260606120100Z') {
  return [
    'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
    'version: 512',
    'class: "genp"',
    'attributes:',
    '    "acct"<blob>="tester"',
    `    "mdat"<timedate>=0x32303236303630363132303130305A00  "${updatedAt}\\000"`,
  ].join('\n');
}

describe('claudeCodeCredentialFile macOS keychain source', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    spawnSpy.mockReset();
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
  });

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

  // The macOS keychain read fallback is scoped to the GLOBAL `Claude Code-credentials` service —
  // i.e. the native `~/.claude` config dir. Derived per-config items are no longer written or read,
  // so these source-preference tests exercise a global config dir where the keychain is authoritative.
  async function globalClaudeConfigDir(
    prefix: string,
  ): Promise<Readonly<{ homeDir: string; claudeConfigDir: string }>> {
    const homeDir = await mkdtemp(join(tmpdir(), prefix));
    return { homeDir, claudeConfigDir: join(homeDir, '.claude') };
  }

  it('reads the matching macOS keychain credential before the credential file', async () => {
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    mockSecuritySpawn((args) => {
      if (args.includes('-w')) return { status: 0, stdout: JSON.stringify(keychainPayload()) };
      return { status: 0, stdout: keychainMetadata() };
    });

    const {
      readClaudeCodeNativeCredential,
      writeClaudeCodeCredentialsFile,
    } = await import('./claudeCodeCredentialFile');

    const { homeDir, claudeConfigDir } = await globalClaudeConfigDir('happier-claude-keychain-read-');
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      homeDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'file-access-placeholder',
          refreshToken: 'file-refresh-placeholder',
          expiresAt: FILE_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      preserveNewerExistingCredential: false,
    });

    await expect(readClaudeCodeNativeCredential({ claudeConfigDir, homeDir })).resolves.toEqual({
      payload: keychainPayload(),
      updatedAtMs: Date.parse('2026-06-06T12:01:00.000Z'),
      source: 'macos_keychain',
    });
  });

  it('reads a gateway sign-in that the macOS keychain item holds instead of a claude.ai login', async () => {
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    const pin = 'a'.repeat(64);
    mockSecuritySpawn((args) => {
      if (args.includes('-w')) {
        return { status: 0, stdout: JSON.stringify({
          enterpriseGateway: {
            url: 'https://gateway.example.com',
            jwt: 'gateway-access-placeholder',
            expiresAt: KEYCHAIN_EXPIRES_AT_MS,
            idpRefreshToken: 'gateway-refresh-placeholder',
            tokenEndpoint: 'https://gateway.example.com/oauth/token',
          },
          gatewayTrust: { 'gateway.example.com': pin },
        }) };
      }
      return { status: 0, stdout: keychainMetadata() };
    });

    const {
      readClaudeCodeNativeCredential,
      readClaudeCodeNativeCatalogSignIn,
    } = await import('./claudeCodeCredentialFile');
    const { homeDir, claudeConfigDir } = await globalClaudeConfigDir('happier-claude-keychain-gateway-');

    await expect(readClaudeCodeNativeCatalogSignIn({ claudeConfigDir, homeDir })).resolves.toEqual({
      kind: 'gateway',
      login: {
        url: 'https://gateway.example.com',
        accessToken: 'gateway-access-placeholder',
        expiresAt: KEYCHAIN_EXPIRES_AT_MS,
        tlsCertificateSha256: pin,
      },
    });
    await expect(readClaudeCodeNativeCredential({ claudeConfigDir, homeDir })).resolves.toBeNull();
  });

  it('ignores an invalid macOS keychain credential and falls back to the credential file', async () => {
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    mockSecuritySpawn((args) => {
      if (args.includes('-w')) {
        return { status: 0, stdout: JSON.stringify({
          claudeAiOauth: {
            accessToken: '',
            refreshToken: '',
            expiresAt: 0,
            scopes: [],
          },
        }) };
      }
      return { status: 0, stdout: keychainMetadata() };
    });

    const {
      readClaudeCodeNativeCredential,
      writeClaudeCodeCredentialsFile,
    } = await import('./claudeCodeCredentialFile');

    const { homeDir, claudeConfigDir } = await globalClaudeConfigDir('happier-claude-keychain-invalid-read-');
    const filePayload = {
      claudeAiOauth: {
        accessToken: 'file-access-placeholder',
        refreshToken: 'file-refresh-placeholder',
        expiresAt: FILE_EXPIRES_AT_MS,
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      },
    };
    const expectedFilePayload = {
      claudeAiOauth: {
        accessToken: 'file-access-placeholder',
        expiresAt: FILE_EXPIRES_AT_MS,
        scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      },
    };
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      homeDir,
      payload: filePayload,
      preserveNewerExistingCredential: false,
    });

    await expect(readClaudeCodeNativeCredential({ claudeConfigDir, homeDir })).resolves.toEqual({
      payload: expectedFilePayload,
      updatedAtMs: expect.any(Number),
      source: 'file',
    });
  });

  it('does not overwrite a newer macOS keychain credential with an older file payload', async () => {
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    mockSecuritySpawn((args) => {
      if (args.includes('-w')) return { status: 0, stdout: JSON.stringify(keychainPayload()) };
      return { status: 0, stdout: keychainMetadata() };
    });

    const {
      resolveClaudeCodeCredentialsFilePath,
      writeClaudeCodeCredentialsFile,
    } = await import('./claudeCodeCredentialFile');

    const { homeDir, claudeConfigDir } = await globalClaudeConfigDir('happier-claude-keychain-freshness-');
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'older-file-access-placeholder',
          refreshToken: 'older-file-refresh-placeholder',
          expiresAt: FILE_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      incomingUpdatedAtMs: NOW_MS,
      homeDir,
    });

    const parsed = JSON.parse(await readFile(resolveClaudeCodeCredentialsFilePath(claudeConfigDir), 'utf8'));
    expect(parsed.claudeAiOauth.accessToken).toBe('keychain-access-placeholder');
    expect(parsed.claudeAiOauth).not.toHaveProperty('refreshToken');
  });

  it('preserves a newer target keychain credential when writing through a staged home', async () => {
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    mockSecuritySpawn((args) => {
      if (args.includes('-w')) return { status: 0, stdout: JSON.stringify(keychainPayload()) };
      return { status: 0, stdout: keychainMetadata() };
    });

    const {
      resolveClaudeCodeCredentialsFilePath,
      writeClaudeCodeCredentialsFile,
    } = await import('./claudeCodeCredentialFile');

    const { homeDir, claudeConfigDir: targetClaudeConfigDir } = await globalClaudeConfigDir('happier-claude-keychain-target-');
    const stagedClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-keychain-staged-'));
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: stagedClaudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'older-staged-access-placeholder',
          refreshToken: 'older-staged-refresh-placeholder',
          expiresAt: FILE_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      incomingUpdatedAtMs: NOW_MS,
      compareCredentialPath: resolveClaudeCodeCredentialsFilePath(targetClaudeConfigDir),
      homeDir,
    });

    const parsed = JSON.parse(await readFile(resolveClaudeCodeCredentialsFilePath(stagedClaudeConfigDir), 'utf8'));
    expect(parsed.claudeAiOauth.accessToken).toBe('keychain-access-placeholder');
    expect(parsed.claudeAiOauth).not.toHaveProperty('refreshToken');
  });
});
