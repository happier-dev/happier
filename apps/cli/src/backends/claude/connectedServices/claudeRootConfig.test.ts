import { describe, expect, it } from 'vitest';

import {
  readClaudeOauthAccountIdentity,
  reconcileClaudeAccountScopedRootConfig,
} from './claudeRootConfig';

describe('readClaudeOauthAccountIdentity', () => {
  it('reads Claude accountUuid identity from the sanitized oauthAccount projection', () => {
    expect(readClaudeOauthAccountIdentity({
      accountUuid: 'account-uuid',
      emailAddress: 'member@example.com',
      organizationUuid: 'org-uuid',
    })).toEqual({
      email: 'member@example.com',
      accountId: 'account-uuid',
      providerOrganizationId: 'org-uuid',
    });
  });
});

describe('reconcileClaudeAccountScopedRootConfig', () => {
  it.each([null, 'organization-b'])('rejects preserved account caches when organization context becomes %s for the same user', (providerOrganizationId) => {
    const reconciled = reconcileClaudeAccountScopedRootConfig({
      rootConfig: { oauthAccount: { accountUuid: 'user', organizationUuid: 'organization-a' },
        modelAccessCache: ['previous-organization-model'] },
      preserveExistingAccountState: true,
      providerAccountId: 'user', providerEmail: null, providerOrganizationId,
    });
    expect(reconciled.oauthAccount).toEqual({ accountUuid: 'user',
      ...(providerOrganizationId ? { organizationUuid: providerOrganizationId } : {}) });
    expect(reconciled).not.toHaveProperty('modelAccessCache');
  });
  it('drops predecessor entitlement state while preserving workspace state on exact credential replacement', () => {
    expect(reconcileClaudeAccountScopedRootConfig({
      rootConfig: {
        oauthAccount: { emailAddress: 'old@example.test', accountUuid: 'old-account' },
        modelAccessCache: [{ value: 'claude-fable-5', description: 'Requires usage credits' }],
        additionalModelOptionsCache: [{ value: 'claude-fable-5[1m]' }],
        cachedExtraUsageDisabledReason: 'org_level_disabled',
        projects: { '/repo': { hasTrustDialogAccepted: true } },
      },
      preserveExistingAccountState: false,
      providerAccountId: 'new-account',
      providerEmail: 'new@example.test',
      providerOrganizationId: 'new-organization',
    })).toEqual({
      hasCompletedOnboarding: true,
      oauthAccount: { accountUuid: 'new-account', emailAddress: 'new@example.test', organizationUuid: 'new-organization' },
      projects: { '/repo': { hasTrustDialogAccepted: true } },
    });
  });

  it('preserves current provider-owned state for the exact same credential provenance', () => {
    const rootConfig = {
      oauthAccount: { emailAddress: 'current@example.test' },
      additionalModelOptionsCache: [{ value: 'claude-fable-5' }],
    };
    expect(reconcileClaudeAccountScopedRootConfig({
      rootConfig,
      preserveExistingAccountState: true,
      providerAccountId: 'current-account',
      providerEmail: 'current@example.test',
    })).toEqual({
      ...rootConfig,
      hasCompletedOnboarding: true,
    });
  });
});
