import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createClaudeConnectedServiceRuntimeAuthAdapter } from './createClaudeConnectedServiceRuntimeAuthAdapter';
import { CLAUDE_RUNTIME_AUTH_SHARED_GROUP_SURFACE_METADATA_KEY } from './claudeRuntimeAuthSharedGroupSurfaceMetadata';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import {
  computeClaudeCodeCredentialFingerprint,
  resolveClaudeCodeCredentialsFilePath,
  writeClaudeCodeCredentialsFile,
} from './nativeAuth/claudeCodeCredentialFile';
import { writeClaudeConnectedServiceHomeProvenance } from './claudeConnectedServiceHomeProvenance';

const FUTURE_EXPIRES_AT_MS = Date.now() + 60 * 60 * 1000;
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

describe('createClaudeConnectedServiceRuntimeAuthAdapter', () => {
  beforeEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    }
  });

  afterEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
  });

  it('attaches source provider account identity to Claude runtime usage-limit classifications', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: FUTURE_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: 'team@example.com',
        raw: { claudeAiOauth: { organizationUuid: 'org-team' } },
      },
    });

    const classification = createClaudeConnectedServiceRuntimeAuthAdapter().classifyRuntimeAuthFailure({
      target: { agentId: 'claude' },
      selection: {
        serviceId: 'claude-subscription',
        activeProfileId: 'oauth',
        groupId: 'claude',
        generation: 42,
        record,
      },
      error: {
        type: 'assistant',
        isApiErrorMessage: true,
        apiErrorStatus: 429,
        error: 'rate_limit_error',
        providerLimitId: 'weekly',
      },
    });

    expect(classification).toMatchObject({
      kind: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      groupId: 'claude',
      groupGeneration: 42,
      sourceProviderAccountId: 'provider-account',
      sourceAccountLabel: 'team@example.com',
      sourceProviderOrganizationId: 'org-team',
    });
  });

  it('does not treat healthy Claude subscription native credentials as runtime account adoption proof', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: FUTURE_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: FUTURE_EXPIRES_AT_MS + 1_000,
          scopes: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE.split(' '),
        },
      },
    });

    const result = await createClaudeConnectedServiceRuntimeAuthAdapter().verifyActiveAccount?.({
      target: { agentId: 'claude' },
      selection: {
        record,
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      },
    });

    expect(result).toEqual({
      status: 'unavailable',
      retryable: true,
      reason: 'claude_code_runtime_account_adoption_unproven',
      errorClassification: {
        missingScopes: [],
      },
    });
  });

  it('fails closed when the materialized Claude native credential file is already expired', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: FUTURE_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: Date.now() - 60 * 60 * 1000,
          scopes: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE.split(' '),
        },
      },
    });

    const result = await createClaudeConnectedServiceRuntimeAuthAdapter().verifyActiveAccount?.({
      target: { agentId: 'claude' },
      selection: {
        record,
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      },
    });

    expect(result).toEqual({
      status: 'unavailable',
      retryable: true,
      reason: 'expired',
      errorClassification: {
        missingScopes: [],
      },
    });
  });

  it('fails closed when the materialized Claude native credential file is missing', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-native-auth-test-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });

    const result = await createClaudeConnectedServiceRuntimeAuthAdapter().verifyActiveAccount?.({
      target: { agentId: 'claude' },
      selection: {
        record,
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      },
    });

    expect(result).toEqual({
      status: 'unavailable',
      retryable: false,
      reason: 'missing_credentials_file',
      errorClassification: {
        missingScopes: [],
      },
    });
  });

  it('fails closed when the selected Claude subscription OAuth record cannot materialize native auth', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: 'user:profile user:inference',
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });

    const result = await createClaudeConnectedServiceRuntimeAuthAdapter().verifyActiveAccount?.({
      target: { agentId: 'claude' },
      selection: { record },
    });

    expect(result).toEqual({
      status: 'unavailable',
      retryable: false,
      reason: 'missing_required_scope',
      errorClassification: {
        missingScopes: ['user:sessions:claude_code'],
      },
    });
  });

  it('hot-applies Claude subscription group credentials by rewriting the shared runtime config dir', async () => {
    const runtimeClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-hot-group-config-'));
    const rootConfigBefore = JSON.stringify({
      oauthAccount: { accountUuid: 'must-not-be-rewritten-during-live-auth-adoption' },
      unrelatedRuntimeState: { preserved: true },
    });
    const settingsBefore = JSON.stringify({ permissions: { allow: ['Read'] } });
    await writeFile(join(runtimeClaudeConfigDir, '.claude.json'), rootConfigBefore);
    await writeFile(join(runtimeClaudeConfigDir, 'settings.json'), settingsBefore);
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: FUTURE_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'new-access-placeholder',
        refreshToken: 'new-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: 'member@example.com',
        raw: { claudeAiOauth: { organizationUuid: 'org-member' } },
      },
    });
    const selection = {
      record,
      groupId: 'team',
      activeProfileId: 'oauth',
      fallbackProfileId: 'oauth',
      generation: 7,
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: runtimeClaudeConfigDir },
      targetMaterializedRoot: runtimeClaudeConfigDir,
      [CLAUDE_RUNTIME_AUTH_SHARED_GROUP_SURFACE_METADATA_KEY]: {
        mode: 'shared_group_auth_surface',
        runtimeClaudeConfigDir,
        runtimeMaterializedRoot: runtimeClaudeConfigDir,
        sourceClaudeConfigDir: runtimeClaudeConfigDir,
      },
    };

    const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();
    expect(adapter.canHotApply({ target: { agentId: 'claude' }, selection })).toEqual({
      supported: true,
      mode: 'claude_subscription_shared_group_auth_surface_rewrite',
    });
    await expect(adapter.hotApply({ target: { agentId: 'claude' }, selection })).resolves.toMatchObject({
      applied: true,
      reason: 'claude_shared_group_auth_surface_rewritten',
      targetMaterializedRoot: runtimeClaudeConfigDir,
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: runtimeClaudeConfigDir },
      verification: {
        status: 'weakly_verified',
        providerAccountId: 'provider-account',
        activeAccountId: 'member@example.com',
        sharedAuthSurfaceId: 'team',
        proofStrength: 'weak',
        source: 'shared_group_auth_surface',
        reason: 'claude_shared_group_auth_surface_rewritten',
      },
    });
    const credentials = JSON.parse(await readFile(join(runtimeClaudeConfigDir, '.credentials.json'), 'utf8')) as {
      claudeAiOauth?: { accessToken?: string; refreshToken?: string };
    };
    expect(credentials.claudeAiOauth).toMatchObject({
      accessToken: 'new-access-placeholder',
    });
    expect(credentials.claudeAiOauth).not.toHaveProperty('refreshToken');
    const credentialPath = join(runtimeClaudeConfigDir, '.credentials.json');
    const provenancePath = join(runtimeClaudeConfigDir, '.happier-claude-connected-service-home.json');
    const firstCredentialInode = (await stat(credentialPath)).ino;
    const firstProvenanceInode = (await stat(provenancePath)).ino;
    await expect(adapter.hotApply({ target: { agentId: 'claude' }, selection })).resolves.toMatchObject({
      applied: true,
    });
    expect((await stat(credentialPath)).ino).toBe(firstCredentialInode);
    expect((await stat(provenancePath)).ino).toBe(firstProvenanceInode);
    await expect(adapter.verifyActiveAccount?.({ target: { agentId: 'claude' }, selection })).resolves.toMatchObject({
      status: 'verified',
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
      credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      proofStrength: 'exact',
    });
    expect(JSON.parse(await readFile(join(runtimeClaudeConfigDir, '.claude.json'), 'utf8'))).toMatchObject({
      unrelatedRuntimeState: { preserved: true },
      hasCompletedOnboarding: true,
      oauthAccount: {
        accountUuid: 'provider-account',
        emailAddress: 'member@example.com',
      },
    });
    const rootConfig = JSON.parse(await readFile(join(runtimeClaudeConfigDir, '.claude.json'), 'utf8'));
    await writeFile(join(runtimeClaudeConfigDir, '.claude.json'), JSON.stringify({
      ...rootConfig, oauthAccount: { ...rootConfig.oauthAccount, organizationUuid: 'org-other' },
    }));
    await expect(adapter.verifyActiveAccount?.({ target: { agentId: 'claude' }, selection })).resolves.toMatchObject({
      status: 'unavailable', reason: 'claude_code_runtime_account_adoption_unproven',
    });
    expect(await readFile(join(runtimeClaudeConfigDir, 'settings.json'), 'utf8')).toBe(settingsBefore);
    expect(JSON.parse(await readFile(
      join(runtimeClaudeConfigDir, '.happier-claude-connected-service-home.json'),
      'utf8',
    ))).toMatchObject({
      v: 1,
      serviceId: 'claude-subscription',
      credentialProfileId: 'oauth',
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
      generation: 7,
      selection: {
        kind: 'group',
        groupId: 'team',
        activeProfileId: 'oauth',
        fallbackProfileId: 'oauth',
      },
    });
  });

  it('fails closed when Claude shared-group hot apply is missing a group generation', async () => {
    const runtimeClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-hot-group-config-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: FUTURE_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'new-access-placeholder',
        refreshToken: 'new-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: 'member@example.com',
      },
    });
    const selection = {
      record,
      groupId: 'team',
      activeProfileId: 'oauth',
      fallbackProfileId: 'oauth',
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: runtimeClaudeConfigDir },
      targetMaterializedRoot: runtimeClaudeConfigDir,
      [CLAUDE_RUNTIME_AUTH_SHARED_GROUP_SURFACE_METADATA_KEY]: {
        mode: 'shared_group_auth_surface',
        runtimeClaudeConfigDir,
        runtimeMaterializedRoot: runtimeClaudeConfigDir,
        sourceClaudeConfigDir: runtimeClaudeConfigDir,
      },
    };

    const adapter = createClaudeConnectedServiceRuntimeAuthAdapter();
    expect(adapter.canHotApply({ target: { agentId: 'claude' }, selection })).toEqual({
      supported: false,
      recovery: 'restart_rematerialize',
    });
    await expect(adapter.hotApply({ target: { agentId: 'claude' }, selection })).resolves.toEqual({
      applied: false,
      reason: 'hot_apply_unsupported',
      recovery: 'restart_rematerialize',
    });
  });

  it('weakly verifies a probe-backed Claude group runtime config rewrite through the shared auth surface', async () => {
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-hot-source-'));
    const runtimeClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-hot-group-config-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth',
      kind: 'oauth',
      expiresAt: FUTURE_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: 'provider-account',
        providerEmail: 'member@example.com',
      },
    });
    await writeClaudeCodeCredentialsFile({
      claudeConfigDir: runtimeClaudeConfigDir,
      payload: {
        claudeAiOauth: {
          accessToken: 'access-placeholder',
          refreshToken: 'refresh-placeholder',
          expiresAt: FUTURE_EXPIRES_AT_MS,
          scopes: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE.split(' '),
        },
      },
    });
    await writeFile(join(runtimeClaudeConfigDir, '.claude.json'), JSON.stringify({
      oauthAccount: { accountUuid: 'provider-account', emailAddress: 'member@example.com' },
    }));
    const credentialFingerprint = computeClaudeCodeCredentialFingerprint(JSON.parse(
      await readFile(resolveClaudeCodeCredentialsFilePath(runtimeClaudeConfigDir), 'utf8'),
    ));
    await writeClaudeConnectedServiceHomeProvenance({
      claudeConfigDir: runtimeClaudeConfigDir,
      provenance: {
        v: 1,
        serviceId: 'claude-subscription',
        credentialProfileId: 'oauth',
        credentialCreatedAt: record.createdAt,
        credentialFingerprint,
        credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
        generation: 7,
        selection: {
          kind: 'group',
          groupId: 'team',
          activeProfileId: 'oauth',
          fallbackProfileId: 'oauth',
        },
      },
    });

    await expect(createClaudeConnectedServiceRuntimeAuthAdapter().verifyActiveAccount?.({
      target: { agentId: 'claude' },
      selection: {
        record,
        groupId: 'team',
        activeProfileId: 'oauth',
        fallbackProfileId: 'oauth',
        generation: 7,
        credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: runtimeClaudeConfigDir },
        targetMaterializedRoot: runtimeClaudeConfigDir,
        [CLAUDE_RUNTIME_AUTH_SHARED_GROUP_SURFACE_METADATA_KEY]: {
          mode: 'shared_group_auth_surface',
          runtimeClaudeConfigDir,
          runtimeMaterializedRoot: runtimeClaudeConfigDir,
          sourceClaudeConfigDir,
        },
      },
    })).resolves.toMatchObject({
      status: 'verified',
      providerAccountId: 'provider-account',
      activeAccountId: 'member@example.com',
      sharedAuthSurfaceId: 'team',
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
      credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      proofStrength: 'exact',
      source: 'claude_shared_group_home_provenance',
    });
  });
});
