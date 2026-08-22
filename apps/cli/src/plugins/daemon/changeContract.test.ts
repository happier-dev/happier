import { describe, expect, it } from 'vitest';

import { createPluginInstallationReviewFixture } from '@/plugins/testkit/pluginInstallationReviewFixture';

import { PluginInstallationReviewSchema } from './changeContract';

describe('PluginInstallationReviewSchema', () => {
  it('keeps content integrity at the external source boundary rather than in path or review facts', () => {
    const pathReview = createPluginInstallationReviewFixture();

    expect(PluginInstallationReviewSchema.safeParse(pathReview).success).toBe(true);
    expect(PluginInstallationReviewSchema.safeParse({
      ...pathReview,
      source: { ...pathReview.source, integrity: 'sha256-local-path-content' },
    }).success).toBe(false);
    expect(PluginInstallationReviewSchema.safeParse({
      ...pathReview,
      integrity: {
        packageDigest: `sha256:${'a'.repeat(64)}`,
        manifestDigest: `sha256:${'b'.repeat(64)}`,
        uiArtifactDigest: `sha256:${'c'.repeat(64)}`,
      },
    }).success).toBe(false);
    expect(PluginInstallationReviewSchema.safeParse({
      ...pathReview,
      source: {
        kind: 'npm',
        locator: '@acme/example@1.0.0',
        integrity: 'sha512-external-source-integrity',
      },
    }).success).toBe(true);
  });

  it('admits a bounded newer-version compatibility report and rejects an unbounded one', () => {
    const pathReview = createPluginInstallationReviewFixture();
    const blockedVersion = {
      version: '1.2.5',
      diagnostics: [{
        code: 'plugin_manifest_semantic_invalid' as const,
        message: 'Plugin manifest requires happier >=9999.0.0',
      }],
    };
    const review = {
      ...pathReview,
      compatibility: {
        ...pathReview.compatibility,
        blockedNewerVersions: [blockedVersion],
      },
    };

    expect(PluginInstallationReviewSchema.safeParse(review).success).toBe(true);
    expect(PluginInstallationReviewSchema.safeParse({
      ...review,
      compatibility: {
        ...review.compatibility,
        blockedNewerVersions: Array.from({ length: 33 }, () => blockedVersion),
      },
    }).success).toBe(false);
    expect(PluginInstallationReviewSchema.safeParse({
      ...pathReview,
      compatibility: { runtimeApiVersion: 1 },
    }).success).toBe(true);
  });

  it('accepts only non-secret raw Voice credential review facts', () => {
    const pathReview = createPluginInstallationReviewFixture();
    const rawCredentialAccess = [{
      accessMode: 'raw',
      contribution: { pluginId: 'acme.voice', localId: 'conversation' },
      credentialSlot: {
        id: 'voice_auth',
        title: 'Voice credential',
        purpose: 'voice.client-auth',
      },
      sourceClass: { kind: 'savedSecret', secretKinds: ['apiKey'] },
      realm: 'web',
      phase: 'connection',
      request: {
        kind: 'httpHeaders',
        origin: 'https://voice.example.test',
        headerNames: ['authorization'],
      },
    }];

    expect(PluginInstallationReviewSchema.safeParse({
      ...pathReview,
      rawCredentialAccess,
    }).success).toBe(true);
    expect(PluginInstallationReviewSchema.safeParse({
      ...pathReview,
      rawCredentialAccess: [{ ...rawCredentialAccess[0], accountId: 'account-1' }],
    }).success).toBe(false);
    expect(PluginInstallationReviewSchema.safeParse({
      ...pathReview,
      rawCredentialAccess: [{ ...rawCredentialAccess[0], secretValue: 'not-a-review-fact' }],
    }).success).toBe(false);
    expect(PluginInstallationReviewSchema.safeParse({
      ...pathReview,
      rawCredentialAccess: [{
        ...rawCredentialAccess[0],
        request: { ...rawCredentialAccess[0]!.request, token: 'not-a-review-fact' },
      }],
    }).success).toBe(false);
  });
});
