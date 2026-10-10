import { describe, expect, it } from 'vitest';

import { createPluginInstallationReviewFixture } from '../testing/pluginInstallationReviewFixture.js';

import {
  PluginChangePendingReviewResultSchema,
  PluginInstallationReviewSchema,
} from './pluginInstallationReviewV1.js';

describe('PluginInstallationReviewSchema', () => {
  it('preserves large review facts and normalized JSON without competing projection cutoffs', () => {
    const normalizedScope: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`key-${index}`, 'value'.repeat(1_000)]),
    );
    normalizedScope['key'.repeat(100)] = Array.from({ length: 300 }, () => 'value');
    normalizedScope.nested = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: true } } } } } } } } } };
    const request = { id: 'network', capability: 'network', reason: 'Reason', authorizationClass: 'hostResourceSelection' as const, normalizedScope };
    const review = createPluginInstallationReviewFixture({
      displayName: 'Name'.repeat(10_000),
      provenance: { status: 'retrievedUnverified', predicateTypes: Array.from({ length: 70 }, (_, index) => `predicate-${index}`) },
      contributions: Array.from({ length: 70 }, (_, index) => ({ family: `family-${index}`, count: 1 })),
      uiArtifacts: { status: 'verified', contributionIds: Array.from({ length: 70 }, (_, index) => `artifact-${index}`) },
      requiredHostAccess: Array.from({ length: 140 }, (_, index) => ({ ...request, id: `required-${index}`, normalizedScope: index === 0 ? normalizedScope : {} })),
      optionalHostAccess: Array.from({ length: 140 }, (_, index) => ({ ...request, id: `optional-${index}`, normalizedScope: {} })),
    });
    expect(PluginInstallationReviewSchema.parse(review)).toEqual(review);
  });

  it.each([Infinity, () => true])('rejects non-JSON normalized scope values', (invalid) => {
    const review = createPluginInstallationReviewFixture({ requiredHostAccess: [{
      id: 'network', capability: 'network', reason: 'Reason', authorizationClass: 'hostResourceSelection', normalizedScope: { invalid },
    }] });
    expect(PluginInstallationReviewSchema.safeParse(review).success).toBe(false);
  });

  it('carries one closed, duplicate-free authority delta for update decisions', () => {
    const review = createPluginInstallationReviewFixture();
    const result = {
      kind: 'reviewRequired',
      reviewKind: 'installation',
      pendingChangeId: `pending-${'a'.repeat(300)}`,
      reason: 'authorityExpansion',
      currentVersion: '1.0.0',
      authorityExpansion: ['requiredHostAccess', 'requestInterceptor'],
      review,
    };

    expect(PluginChangePendingReviewResultSchema.safeParse(result).success).toBe(true);
    expect(PluginChangePendingReviewResultSchema.safeParse({
      ...result,
      authorityExpansion: ['requiredHostAccess', 'requiredHostAccess'],
    }).success).toBe(false);
    expect(PluginChangePendingReviewResultSchema.safeParse({
      ...result,
      authorityExpansion: ['packageBytesChanged'],
    }).success).toBe(false);
  });

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
        kind: 'archive',
        locator: 'https://example.test/plugin.tgz',
        integrity: 'sha512-observed-archive-integrity',
        integrityBasis: 'observed',
      },
    }).success).toBe(true);
    expect(PluginInstallationReviewSchema.safeParse({
      ...pathReview,
      source: {
        kind: 'npm',
        locator: '@acme/example@1.0.0',
        integrity: 'sha512-external-source-integrity',
        integrityBasis: 'expected',
      },
    }).success).toBe(true);
    expect(PluginInstallationReviewSchema.safeParse({
      ...pathReview,
      source: {
        kind: 'npm',
        locator: '@acme/example@1.0.0',
        integrity: 'sha512-observed-npm-integrity',
        integrityBasis: 'observed',
      },
    }).success).toBe(false);
  });

  it('preserves every newer-version compatibility reason beyond the former count limits', () => {
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
        blockedNewerVersions: Array.from({ length: 33 }, (_, index) => ({
          version: `1.2.${index}`,
          diagnostics: Array.from({ length: 5 }, () => blockedVersion.diagnostics[0]),
        })),
      },
    }).success).toBe(true);
    expect(PluginInstallationReviewSchema.safeParse({
      ...pathReview,
      compatibility: { runtimeApiVersion: 1 },
    }).success).toBe(true);
  });

  it('admits hostedWeb as a distinct executable realm beside daemon and React Native', () => {
    const review = createPluginInstallationReviewFixture({
      executableRealms: ['daemon', 'reactNative', 'hostedWeb'],
    });

    expect(PluginInstallationReviewSchema.safeParse(review).success).toBe(true);
    expect(PluginInstallationReviewSchema.safeParse({
      ...review,
      executableRealms: ['hostedWeb'],
    }).success).toBe(true);
    expect(PluginInstallationReviewSchema.safeParse({
      ...review,
      executableRealms: ['hostedWeb', 'hostedWeb'],
    }).success).toBe(false);
    expect(PluginInstallationReviewSchema.safeParse({
      ...review,
      executableRealms: ['daemon', 'reactNative', 'hostedWeb', 'daemon'],
    }).success).toBe(false);
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
