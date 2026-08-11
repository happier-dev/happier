import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { applyClaudeSharedGroupGenerationApplication } from './applyClaudeSharedGroupGenerationApplication';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';

describe('applyClaudeSharedGroupGenerationApplication', () => {
  it('materializes and proves setup-token credentials through the canonical shared-group application owner', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-shared-generation-token-'));
    const credentialRevision = 'csr_7123456789ABCDEFGHJKMNPQRT' as const;
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'setup',
      kind: 'token',
      token: {
        token: 'sk-ant-oat01-shared-placeholder',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    await expect(applyClaudeSharedGroupGenerationApplication({
      activeServerDir,
      serviceId: 'claude-subscription',
      groupId: 'team',
      profileId: 'setup',
      generation: 7,
      credentialRevision,
      record,
      validateCurrentBeforeMutation: async () => ({ current: true }),
    })).resolves.toMatchObject({
      status: 'verified',
      source: 'claude_shared_group_home_provenance',
      sharedAuthSurfaceId: 'team',
      credentialRevision,
    });

    const claudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      fallbackProfileId: 'setup',
      selection: {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId: 'team',
        activeProfileId: 'setup',
        fallbackProfileId: 'setup',
        generation: 7,
        credentialRevision,
        record,
        policy: null,
      },
    });
    expect(JSON.parse(await readFile(join(claudeConfigDir!, '.credentials.json'), 'utf8'))).toEqual({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-shared-placeholder',
        scopes: ['user:inference'],
      },
    });
  });

  it('materializes and proves the exact committed generation on the shared Claude group surface', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-shared-generation-'));
    const credentialRevision = 'csr_7123456789ABCDEFGHJKMNPQRS' as const;
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: Date.now() + 60_000,
      oauth: {
        accessToken: 'shared-generation-access-token',
        refreshToken: 'shared-generation-refresh-token',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: 'work@example.test',
      },
    });

    await expect(applyClaudeSharedGroupGenerationApplication({
      activeServerDir,
      serviceId: 'claude-subscription',
      groupId: 'team',
      profileId: 'work',
      generation: 7,
      credentialRevision,
      record,
      validateCurrentBeforeMutation: async () => ({ current: true }),
    })).resolves.toMatchObject({
      status: 'verified',
      source: 'claude_shared_group_home_provenance',
      sharedAuthSurfaceId: 'team',
      credentialRevision,
      credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });

    const claudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      fallbackProfileId: 'work',
      selection: {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId: 'team',
        activeProfileId: 'work',
        fallbackProfileId: 'work',
        generation: 7,
        credentialRevision,
        record,
        policy: null,
      },
    });
    expect(claudeConfigDir).not.toBeNull();
    const provenance = JSON.parse(await readFile(
      join(claudeConfigDir!, '.happier-claude-connected-service-home.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(provenance).toMatchObject({
      serviceId: 'claude-subscription',
      credentialProfileId: 'work',
      credentialRevision,
      generation: 7,
      selection: {
        kind: 'group',
        groupId: 'team',
        activeProfileId: 'work',
      },
    });
  });

  it('does not let a superseded generation rewrite the current shared Claude home', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-shared-generation-superseded-'));
    const buildRecord = (profileId: string, accessToken: string, now: number) => buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'claude-subscription',
      profileId,
      kind: 'oauth',
      expiresAt: Date.now() + 60_000,
      oauth: {
        accessToken,
        refreshToken: `${accessToken}-refresh`,
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: `${profileId}-account`,
        providerEmail: `${profileId}@example.test`,
      },
    });
    const currentRecord = buildRecord('current', 'current-access-token', 2_000);
    const staleRecord = buildRecord('stale', 'stale-access-token', 1_000);
    const currentRevision = 'csr_8123456789ABCDEFGHJKMNPQRS' as const;
    const staleRevision = 'csr_6123456789ABCDEFGHJKMNPQRS' as const;

    await expect(applyClaudeSharedGroupGenerationApplication({
      activeServerDir,
      serviceId: 'claude-subscription',
      groupId: 'team',
      profileId: 'current',
      generation: 8,
      credentialRevision: currentRevision,
      record: currentRecord,
      validateCurrentBeforeMutation: async () => ({ current: true }),
    })).resolves.toMatchObject({ status: 'verified' });

    await expect(applyClaudeSharedGroupGenerationApplication({
      activeServerDir,
      serviceId: 'claude-subscription',
      groupId: 'team',
      profileId: 'stale',
      generation: 7,
      credentialRevision: staleRevision,
      record: staleRecord,
      validateCurrentBeforeMutation: async () => ({
        current: false,
        authoritativeTarget: {
          profileId: 'current',
          generation: 8,
          credentialRevision: currentRevision,
        },
      }),
    } as never)).resolves.toEqual({
      status: 'superseded_after_apply',
      activeProfileId: 'current',
      generation: 8,
      credentialRevision: currentRevision,
    });

    const claudeConfigDir = resolveClaudeConnectedServiceStableConfigDir({
      activeServerDir,
      serviceId: 'claude-subscription',
      fallbackProfileId: 'current',
      selection: {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId: 'team',
        activeProfileId: 'current',
        fallbackProfileId: 'current',
        generation: 8,
        credentialRevision: currentRevision,
        record: currentRecord,
        policy: null,
      },
    });
    expect(claudeConfigDir).not.toBeNull();
    expect(JSON.parse(await readFile(join(claudeConfigDir!, '.credentials.json'), 'utf8')))
      .toMatchObject({ claudeAiOauth: { accessToken: 'current-access-token' } });
    expect(JSON.parse(await readFile(
      join(claudeConfigDir!, '.happier-claude-connected-service-home.json'),
      'utf8',
    ))).toMatchObject({ credentialProfileId: 'current', generation: 8, credentialRevision: currentRevision });
  });
});
