import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeClaudeCodeCredentialsFile } from './credentials.js';
import { verifyClaudeCodeNativeAuth } from './verify.js';

const REQUIRED_SCOPES = ['user:inference', 'user:profile', 'user:sessions:claude_code'];
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const PROVENANCE_FILE_NAME = '.happier-claude-connected-service-home.json';

async function writeCredentials(expiresAt: number | undefined): Promise<string> {
  const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-verify-'));
  await writeClaudeCodeCredentialsFile({
    claudeConfigDir,
    payload: {
      claudeAiOauth: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
        scopes: REQUIRED_SCOPES,
      },
    },
  });
  return claudeConfigDir;
}

function createExecFixture(): ExecRuntimeServiceV1 {
  return {
    systemTools: {
      resolve: vi.fn(),
    },
    run: vi.fn(),
  } as unknown as ExecRuntimeServiceV1;
}

describe('verifyClaudeCodeNativeAuth', () => {
  beforeEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('./keychain.js');
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
  });

  it('verifies a well-formed, unexpired credential', async () => {
    const claudeConfigDir = await writeCredentials(10_000);
    const result = await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: 1_000 });
    expect(result.status).toBe('ok');
  });

  it('rejects a well-formed but expired credential as a usability failure', async () => {
    const claudeConfigDir = await writeCredentials(1_000);
    const result = await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: 2_000 });
    expect(result.status).toBe('expired');
  });

  it('treats an expiry exactly at now as expired', async () => {
    const claudeConfigDir = await writeCredentials(2_000);
    const result = await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: 2_000 });
    expect(result.status).toBe('expired');
  });

  it('does NOT treat an unknown (omitted) expiry as expired', async () => {
    const claudeConfigDir = await writeCredentials(undefined);
    const result = await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: 2_000 });
    expect(result.status).toBe('ok');
  });

  it('reports a missing credentials file', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-verify-missing-'));
    const result = await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: 1_000 });
    expect(result.status).toBe('missing_credentials_file');
  });

  it('fails closed when connected-service provenance points at a different credential fingerprint', async () => {
    const claudeConfigDir = await writeCredentials(10_000);
    await writeFile(join(claudeConfigDir, PROVENANCE_FILE_NAME), JSON.stringify({
      v: 1,
      serviceId: 'claude-subscription',
      credentialProfileId: 'other-profile',
      credentialCreatedAt: 1,
      credentialFingerprint: `sha256:${'b'.repeat(64)}`,
    }));

    const result = await verifyClaudeCodeNativeAuth({ claudeConfigDir, now: 1_000 });

    expect(result.status).toBe('credential_fingerprint_mismatch');
  });

  it('fails closed on darwin when the matching keychain entry is missing the refresh token even if the file is healthy', async () => {
    const claudeConfigDir = await writeCredentials(10_000);
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    vi.doMock('./keychain.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./keychain.js')>();
      return {
        ...actual,
        readClaudeCodeMacOsKeychainCredential: vi.fn(async () => ({
          claudeAiOauth: {
            accessToken: 'access-token',
            expiresAt: 10_000,
            scopes: REQUIRED_SCOPES,
          },
        })),
      };
    });

    const { verifyClaudeCodeNativeAuth: verifyUnderDarwin } = await import('./verify.js');
    const result = await verifyUnderDarwin({ claudeConfigDir, now: 1_000, exec: createExecFixture() });

    expect(result.status).toBe('missing_refresh_token');
  });

  it('fails closed on darwin when the keychain credential differs from the credential file', async () => {
    const claudeConfigDir = await writeCredentials(10_000);
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    vi.doMock('./keychain.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./keychain.js')>();
      return {
        ...actual,
        readClaudeCodeMacOsKeychainCredential: vi.fn(async () => ({
          claudeAiOauth: {
            accessToken: 'different-access-token',
            refreshToken: 'refresh-token',
            expiresAt: 10_000,
            scopes: REQUIRED_SCOPES,
          },
        })),
      };
    });

    const { verifyClaudeCodeNativeAuth: verifyUnderDarwin } = await import('./verify.js');
    const result = await verifyUnderDarwin({ claudeConfigDir, now: 1_000, exec: createExecFixture() });

    expect(result.status).toBe('credential_fingerprint_mismatch');
  });
});
