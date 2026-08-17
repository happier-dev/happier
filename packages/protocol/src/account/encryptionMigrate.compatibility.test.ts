import { describe, expect, it } from 'vitest';

import {
  AccountEncryptionMigratePredecessorRequestSchema,
  AccountEncryptionMigrateRequestBindingDigestV1Schema,
  AccountEncryptionMigrateRequestSchema,
  createAccountEncryptionMigrateRequestBindingDigestV1,
} from './encryptionMigrate.js';

describe('account/encryptionMigrate compatibility', () => {
  it('keeps the immutable predecessor wire admissible without treating it as a current request', () => {
    // Exact released/prospective producer shape:
    // cli-v0.2.1@b1d15a8a9c241737d1ca9b167459901e6259173a
    // cli-v0.2.2-preview.1775586717.26498@4913c1e533c872a0712ba1c25b3104fd470aacc2
    // ../remote-dev@fae505bdc6916b3c9fa7a67eac3c4c88df759e9b
    const predecessorRequest = {
      toMode: 'plain',
      expectedSettingsVersion: 0,
      settingsContent: null,
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
    } as const;

    expect(
      AccountEncryptionMigratePredecessorRequestSchema.safeParse(
        predecessorRequest,
      ).success,
    ).toBe(true);
    expect(
      AccountEncryptionMigrateRequestSchema.safeParse(predecessorRequest)
        .success,
    ).toBe(false);
    expect(() =>
      createAccountEncryptionMigrateRequestBindingDigestV1({
        // @ts-expect-error This immutable predecessor wire must be rejected by the current digest owner.
        request: predecessorRequest,
        accountId: 'account-compatibility-vector',
        sourceMode: 'e2ee',
      })
    ).toThrow();
  });

  it('keeps the required Session inventory on the current wire and rejects it at the old strict reader', () => {
    const currentRequest = {
      toMode: 'plain',
      expectedAccountVersion: 7,
      expectedSigningKeyFingerprint: 'aemk1_current-signing',
      expectedContentKeyFingerprint: 'aemk1_current-content',
      expectedSettingsVersion: 2,
      settingsContent: null,
      connectedServices: { action: 'assert_empty' },
      automations: { action: 'assert_empty' },
      machines: { action: 'assert_empty' },
      todos: { action: 'assert_empty' },
      artifacts: { action: 'assert_empty' },
      sessions: { action: 'assert_empty' },
      reviewComments: { action: 'assert_empty' },
      sessionOrganization: { action: 'assert_empty' },
      pets: { action: 'assert_empty' },
    } as const;

    expect(
      AccountEncryptionMigrateRequestSchema.safeParse(currentRequest)
        .success,
    ).toBe(true);
    expect(
      AccountEncryptionMigratePredecessorRequestSchema.safeParse(
        currentRequest,
      ).success,
    ).toBe(false);

    const binding = {
      accountId: 'account-compatibility-vector',
      sourceMode: 'e2ee' as const,
    };
    const digest = createAccountEncryptionMigrateRequestBindingDigestV1({
      request: currentRequest,
      ...binding,
    });
    expect(
      AccountEncryptionMigrateRequestBindingDigestV1Schema.safeParse(
        digest,
      ).success,
    ).toBe(true);
    expect(digest).toBe(
      'aemrb1_uAdFXiOtEnbbpssVhzWZKxAlIJo-8Is0v3UN97Oj8fw',
    );
    expect(createAccountEncryptionMigrateRequestBindingDigestV1({
      request: {
        ...currentRequest,
        externalAuthProof: {
          provider: 'github',
          pending: 'oauth_pending_retry1',
          proof: 'fresh-proof-retry1',
        },
      },
      ...binding,
    })).toBe(digest);
  });

  it('does not synthesize a new Run inventory into an existing signed Automation migration', () => {
    const request = {
      toMode: 'plain',
      expectedAccountVersion: 7,
      expectedSigningKeyFingerprint: 'aemk1_current-signing',
      expectedContentKeyFingerprint: 'aemk1_current-content',
      expectedSettingsVersion: 2,
      settingsContent: null,
      connectedServices: { action: 'assert_empty' },
      automations: {
        action: 'migrate',
        templates: [{
          automationId: 'automation-compatibility-vector',
          expectedTemplateVersion: 3,
          templateCiphertext: 'opaque-target-template',
        }],
      },
      machines: { action: 'assert_empty' },
      todos: { action: 'assert_empty' },
      artifacts: { action: 'assert_empty' },
      sessions: { action: 'assert_empty' },
      reviewComments: { action: 'assert_empty' },
      sessionOrganization: { action: 'assert_empty' },
      pets: { action: 'assert_empty' },
    } as const;

    // The request binding serializes this parsed directive. Adding `runs: []`
    // here would invalidate a supported client signature that predates Run
    // migration support.
    expect(AccountEncryptionMigrateRequestSchema.parse(request).automations)
      .toEqual(request.automations);
  });
});
