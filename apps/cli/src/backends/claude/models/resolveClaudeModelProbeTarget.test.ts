import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import type { ConnectedServiceAuthGroupApi, ConnectedServiceCredentialApi } from '@/api/connectedServices/connectedServiceCredentialApi';
import type { Credentials } from '@/persistence';
import { resolveClaudeModelProbeTarget } from './resolveClaudeModelProbeTarget';

const credentials: Credentials = {
  token: 'account-token',
  encryption: { type: 'legacy', secret: new Uint8Array(32) },
};

function anthropicRecord(token: string): ConnectedServiceCredentialRecordV1 {
  return {
    v: 1,
    serviceId: 'anthropic',
    profileId: 'selected-account',
    kind: 'token',
    token: { token, providerAccountId: null, providerEmail: null, raw: null },
    oauth: null,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: null,
  };
}

describe('resolveClaudeModelProbeTarget', () => {
  it('uses bearer auth before an API key from the same effective environment', async () => {
    const target = await resolveClaudeModelProbeTarget({ timeoutMs: 5_000,
      processEnv: {
        ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'gateway-token',
        ANTHROPIC_API_KEY: 'ambient-api-key',
      },
    });

    expect(target).toMatchObject({
      baseUrl: 'https://gateway.example/anthropic',
      credential: { kind: 'bearer', value: 'gateway-token' },
    });
  });

  it('uses the Claude Code apiKeyHelper for a gateway when no auth env is set', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-probe-'));
    try {
      await writeFile(join(claudeConfigDir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo helper-key' }));

      const target = await resolveClaudeModelProbeTarget({ timeoutMs: 5_000,
        processEnv: {
          PATH: process.env.PATH,
          CLAUDE_CONFIG_DIR: claudeConfigDir,
          ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
        },
      });

      expect(target).toMatchObject({
        baseUrl: 'https://gateway.example/anthropic',
        credential: { kind: 'api_key_helper', value: 'helper-key' },
      });
    } finally {
      await rm(claudeConfigDir, { recursive: true, force: true });
    }
  });

  it('prefers auth env vars over the Claude Code apiKeyHelper', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-probe-'));
    try {
      await writeFile(join(claudeConfigDir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo helper-key' }));

      const target = await resolveClaudeModelProbeTarget({ timeoutMs: 5_000,
        processEnv: {
          PATH: process.env.PATH,
          CLAUDE_CONFIG_DIR: claudeConfigDir,
          ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'gateway-token',
        },
      });

      expect(target?.credential).toEqual({ kind: 'bearer', value: 'gateway-token' });
    } finally {
      await rm(claudeConfigDir, { recursive: true, force: true });
    }
  });

  it.each([
    { env: { ANTHROPIC_API_KEY: 'api-key', CLAUDE_CODE_OAUTH_TOKEN: 'setup-token' }, expected: { kind: 'api_key', value: 'api-key' } },
    { env: { CLAUDE_CODE_OAUTH_TOKEN: 'setup-token' }, expected: { kind: 'api_key_helper', value: 'helper-key' } },
  ])('matches native credential precedence with a configured helper: $env', async ({ env, expected }) => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-precedence-'));
    try {
      await writeFile(join(claudeConfigDir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo helper-key' }));
      const target = await resolveClaudeModelProbeTarget({ timeoutMs: 5_000,
        processEnv: { ...process.env, ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '',
          CLAUDE_CONFIG_DIR: claudeConfigDir, ...env },
      });
      expect(target?.credential).toEqual(expected);
    } finally {
      await rm(claudeConfigDir, { recursive: true, force: true });
    }
  });

  it.each(['{ not json', 'null', '[]', '"invalid root"', '{"apiKeyHelper":7}'])('continues native credential precedence when user settings cannot declare a helper: %s', async (settings) => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-invalid-settings-'));
    try {
      await writeFile(join(claudeConfigDir, 'settings.json'), settings);
      await expect(resolveClaudeModelProbeTarget({ timeoutMs: 5_000, processEnv: {
        PATH: process.env.PATH, CLAUDE_CONFIG_DIR: claudeConfigDir, CLAUDE_CODE_OAUTH_TOKEN: 'setup-token',
      } })).resolves.toMatchObject({ credential: { kind: 'bearer', value: 'setup-token' } });
    } finally {
      await rm(claudeConfigDir, { recursive: true, force: true });
    }
  });

  it('does not substitute a setup token when the configured helper fails', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-helper-failure-'));
    try {
      await writeFile(join(claudeConfigDir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'exit 3' }));
      await expect(resolveClaudeModelProbeTarget({ timeoutMs: 5_000, processEnv: {
        PATH: process.env.PATH, CLAUDE_CONFIG_DIR: claudeConfigDir, CLAUDE_CODE_OAUTH_TOKEN: 'other-account',
      } })).resolves.toBeNull();
    } finally {
      await rm(claudeConfigDir, { recursive: true, force: true });
    }
  });

  it('does not execute user settings when the session excludes that settings source', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-helper-sources-'));
    try {
      await writeFile(join(claudeConfigDir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo helper-key' }));
      const target = await resolveClaudeModelProbeTarget({ timeoutMs: 5_000,
        accountSettings: { claudeRemoteSettingSourcesV2: [] },
        processEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir, CLAUDE_CODE_OAUTH_TOKEN: 'setup-token' },
      });
      expect(target?.credential).toEqual({ kind: 'bearer', value: 'setup-token' });
      await expect(resolveClaudeModelProbeTarget({ timeoutMs: 5_000,
        accountSettings: { claudeRemoteSettingSourcesV2: [] },
        processEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir, ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' },
      })).resolves.toBeNull();
    } finally {
      await rm(claudeConfigDir, { recursive: true, force: true });
    }
  });

  it('fails closed on an invalid explicit endpoint', async () => {
    await expect(resolveClaudeModelProbeTarget({ timeoutMs: 5_000,
      processEnv: {
        ANTHROPIC_BASE_URL: 'not a url',
        ANTHROPIC_AUTH_TOKEN: 'must-not-be-rehomed',
      },
    })).resolves.toBeNull();
  });

  it('uses the selected connected Anthropic account instead of ambient auth', async () => {
    const record = anthropicRecord('selected-api-key');
    const api: ConnectedServiceCredentialApi & ConnectedServiceAuthGroupApi = {
      getAccountEncryptionMode: async () => 'plain',
      getConnectedServiceCredentialSealed: async () => null,
      getConnectedServiceCredentialPlain: async () => ({
        content: { t: 'plain', v: record },
        revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      }),
      listConnectedServiceAuthGroups: async () => [],
      getConnectedServiceAuthGroup: async () => null,
    };

    const target = await resolveClaudeModelProbeTarget({ timeoutMs: 5_000,
      credentials,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: {
            source: 'connected',
            selection: 'profile',
            profileId: 'selected-account',
          },
        },
      },
      processEnv: { ANTHROPIC_API_KEY: 'wrong-ambient-key' },
      createCredentialApi: () => api,
    });

    expect(target?.credential).toEqual({ kind: 'api_key', value: 'selected-api-key' });
  });

  it('projects a selected built-in gateway profile without mutating ambient auth', async () => {
    const target = await resolveClaudeModelProbeTarget({ timeoutMs: 5_000,
      credentials,
      profileId: 'deepseek',
      accountSettings: {},
      processEnv: {
        DEEPSEEK_AUTH_TOKEN: 'deepseek-token',
        ANTHROPIC_API_KEY: 'unrelated-key',
      },
    });

    expect(target).toMatchObject({
      baseUrl: 'https://api.deepseek.com/anthropic',
      credential: { kind: 'bearer', value: 'deepseek-token' },
    });
  });
});
