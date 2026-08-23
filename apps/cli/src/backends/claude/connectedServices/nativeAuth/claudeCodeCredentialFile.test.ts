import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';

import {
  buildClaudeCodeCredentialPayload,
  computeClaudeCodeCredentialAccountProofFingerprint,
  computeClaudeCodeCredentialFingerprint,
  parseClaudeCodeCredentialFile,
  readClaudeCodeNativeCredential,
  resolveClaudeCodeCredentialsFilePath,
  writeClaudeCodeCredentialsFile,
} from './claudeCodeCredentialFile';
import {
  CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
  CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES,
} from './claudeCodeCredentialScopes';

const REALISTIC_ISSUED_AT_MS = Date.parse('2026-06-05T12:00:00.000Z');
const REALISTIC_EXPIRES_AT_MS = REALISTIC_ISSUED_AT_MS + 60 * 60 * 1000;

describe('claudeCodeCredentialFile', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the native Claude Code credential payload from an OAuth record', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(buildClaudeCodeCredentialPayload(record)).toEqual({
      status: 'ok',
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          expiresAt: REALISTIC_EXPIRES_AT_MS,
          scopes: [...CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES],
        },
      },
    });
  });

  it('omits expiresAt rather than coercing a null record expiry to an immediately-expired 0', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const built = buildClaudeCodeCredentialPayload(record);
    expect(built.status).toBe('ok');
    if (built.status !== 'ok') throw new Error('expected ok payload');
    expect(built.payload.claudeAiOauth.expiresAt).toBeUndefined();
    expect(built.payload.claudeAiOauth.accessToken).toBe('access-placeholder');
  });

  it('includes optional Claude subscription metadata when raw native OAuth data is available', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
        raw: {
          claudeAiOauth: {
            subscriptionType: 'max',
            rateLimitTier: 'max_20x',
          },
        },
      },
    });

    expect(buildClaudeCodeCredentialPayload(record)).toEqual({
      status: 'ok',
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          expiresAt: REALISTIC_EXPIRES_AT_MS,
          scopes: [...CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES],
          subscriptionType: 'max',
          rateLimitTier: 'max_20x',
        },
      },
    });
  });

  it('computes account proof fingerprints without volatile credential expiry', () => {
    const firstPayload = {
      claudeAiOauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        expiresAt: REALISTIC_EXPIRES_AT_MS,
        scopes: ['user:profile', 'user:inference'],
      },
    };
    const refreshedExpiryPayload = {
      claudeAiOauth: {
        ...firstPayload.claudeAiOauth,
        expiresAt: REALISTIC_EXPIRES_AT_MS + 1_000,
      },
    };

    expect(computeClaudeCodeCredentialFingerprint(firstPayload)).not.toBe(
      computeClaudeCodeCredentialFingerprint(refreshedExpiryPayload),
    );
    expect(computeClaudeCodeCredentialAccountProofFingerprint(firstPayload)).toBe(
      computeClaudeCodeCredentialAccountProofFingerprint(refreshedExpiryPayload),
    );
  });

  it('writes .credentials.json atomically under the selected CLAUDE_CONFIG_DIR', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: REALISTIC_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });

    expect(credentialPath).toBe(join(claudeConfigDir, '.credentials.json'));
    const parsed = JSON.parse(await readFile(credentialPath, 'utf8'));
    expect(parsed.claudeAiOauth.accessToken).toBe('access-placeholder');
    expect(parsed.claudeAiOauth).not.toHaveProperty('refreshToken');
    expect(parsed.claudeAiOauth.expiresAt).toBe(REALISTIC_EXPIRES_AT_MS);
    expect(parsed.claudeAiOauth.expiresAt).toBeGreaterThan(1_000_000_000_000);

    if (process.platform !== 'win32') {
      const mode = (await stat(credentialPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('does not overwrite a newer native credential with an older different refresh token', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-freshness-test-'));
    const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'newer-access',
          refreshToken: 'newer-refresh',
          expiresAt: REALISTIC_EXPIRES_AT_MS + 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      incomingUpdatedAtMs: REALISTIC_ISSUED_AT_MS + 20_000,
    });

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'older-access',
          refreshToken: 'older-refresh',
          expiresAt: REALISTIC_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      incomingUpdatedAtMs: REALISTIC_ISSUED_AT_MS,
    });

    const parsed = JSON.parse(await readFile(credentialPath, 'utf8'));
    expect(parsed.claudeAiOauth.accessToken).toBe('newer-access');
    expect(parsed.claudeAiOauth).not.toHaveProperty('refreshToken');
  });

  it('preserves a newer target credential when writing through a staged home', async () => {
    const targetClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-target-test-'));
    const stagedClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-staged-test-'));
    const targetCredentialPath = resolveClaudeCodeCredentialsFilePath(targetClaudeConfigDir);
    const stagedCredentialPath = resolveClaudeCodeCredentialsFilePath(stagedClaudeConfigDir);

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: targetClaudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'target-newer-access',
          refreshToken: 'target-newer-refresh',
          expiresAt: REALISTIC_EXPIRES_AT_MS + 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      incomingUpdatedAtMs: REALISTIC_ISSUED_AT_MS + 20_000,
    });

    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: stagedClaudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'staged-older-access',
          refreshToken: 'staged-older-refresh',
          expiresAt: REALISTIC_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      incomingUpdatedAtMs: REALISTIC_ISSUED_AT_MS,
      compareCredentialPath: targetCredentialPath,
    });

    const parsed = JSON.parse(await readFile(stagedCredentialPath, 'utf8'));
    expect(parsed.claudeAiOauth.accessToken).toBe('target-newer-access');
    expect(parsed.claudeAiOauth).not.toHaveProperty('refreshToken');
  });

  it('emits safe machine-greppable diagnostics for write and freshness-skip decisions', async () => {
    const info = vi.mocked(logger.debug);
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-diagnostic-test-'));
    const writeWithDiagnostics = writeClaudeCodeCredentialsFile as (
      params: Parameters<typeof writeClaudeCodeCredentialsFile>[0] & Readonly<{
        diagnosticContext: Readonly<{
          profileId: string;
          homeKind: 'group';
        }>;
      }>,
    ) => ReturnType<typeof writeClaudeCodeCredentialsFile>;
    await writeWithDiagnostics({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'first-access-secret',
          refreshToken: 'first-refresh-secret',
          expiresAt: REALISTIC_EXPIRES_AT_MS + 60_000,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      incomingUpdatedAtMs: REALISTIC_ISSUED_AT_MS + 20_000,
      diagnosticContext: {
        profileId: 'work',
        homeKind: 'group',
      },
    });
    await writeWithDiagnostics({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'older-access-secret',
          refreshToken: 'older-refresh-secret',
          expiresAt: REALISTIC_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      incomingUpdatedAtMs: REALISTIC_ISSUED_AT_MS,
      diagnosticContext: {
        profileId: 'work',
        homeKind: 'group',
      },
    });

    expect(info).toHaveBeenCalledWith(
      '[DAEMON RUN] Claude Code credential file decision',
      expect.objectContaining({
        event: 'claude_code_credential_file_decision',
        profileId: 'work',
        homeKind: 'group',
        decision: 'write',
        comparatorBasis: expect.objectContaining({
          existing: null,
          incoming: expect.objectContaining({
            expiresAtMs: REALISTIC_EXPIRES_AT_MS + 60_000,
            updatedAtMs: REALISTIC_ISSUED_AT_MS + 20_000,
          }),
        }),
      }),
    );
    expect(info).toHaveBeenCalledWith(
      '[DAEMON RUN] Claude Code credential file decision',
      expect.objectContaining({
        event: 'claude_code_credential_file_decision',
        profileId: 'work',
        homeKind: 'group',
        decision: 'skip_existing_newer',
        comparatorBasis: expect.objectContaining({
          existing: expect.objectContaining({
            expiresAtMs: REALISTIC_EXPIRES_AT_MS + 60_000,
          }),
          incoming: expect.objectContaining({
            expiresAtMs: REALISTIC_EXPIRES_AT_MS,
          }),
        }),
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('secret');
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('emits safe source and fingerprint diagnostics when reading credentials', async () => {
    const info = vi.mocked(logger.debug);
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-read-diagnostic-test-'));
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'read-access-secret',
          refreshToken: 'read-refresh-secret',
          expiresAt: REALISTIC_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
      incomingUpdatedAtMs: REALISTIC_ISSUED_AT_MS,
      diagnosticContext: {
        profileId: 'work',
        homeKind: 'profile',
      },
    });
    info.mockClear();

    await expect(readClaudeCodeNativeCredential({
      claudeConfigDir,
      diagnosticContext: {
        profileId: 'work',
        homeKind: 'profile',
      },
    })).resolves.toEqual(expect.objectContaining({ source: 'file' }));

    expect(info).toHaveBeenCalledWith(
      '[DAEMON RUN] Claude Code credential read',
      expect.objectContaining({
        event: 'claude_code_credential_read',
        profileId: 'work',
        homeKind: 'profile',
        source: 'file',
        credential: expect.objectContaining({
          accessTokenFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{8}$/),
          hasRefreshToken: false,
          refreshTokenFingerprint: null,
          expiresAtMs: REALISTIC_EXPIRES_AT_MS,
        }),
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('secret');
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('parses credential health without exposing credential values', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const credentialPath = resolveClaudeCodeCredentialsFilePath(claudeConfigDir);
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-secret-placeholder',
          refreshToken: 'refresh-secret-placeholder',
          expiresAt: REALISTIC_EXPIRES_AT_MS,
          scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
        },
      },
    });
    await chmod(credentialPath, 0o600);

    const safe = parseClaudeCodeCredentialFile(JSON.parse(await readFile(credentialPath, 'utf8')));

    expect(safe).toEqual({
      status: 'ok',
      hasAccessToken: true,
      hasRefreshToken: false,
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    });
    expect(JSON.stringify(safe)).not.toContain('secret-placeholder');
  });
});
