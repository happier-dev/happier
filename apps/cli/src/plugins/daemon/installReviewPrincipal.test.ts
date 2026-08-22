import { describe, expect, it } from 'vitest';

import type { PluginInstallationReview } from './changeContract';
import {
  derivePluginInstallReviewPrincipal,
  derivePluginInstallReviewPrincipalDigest,
} from './installReviewPrincipal';

function review() {
  return {
    pluginId: 'happier.voice.openai',
    displayName: 'OpenAI Voice',
    version: '1.0.0',
    packageIdentity: { name: '@happier/plugin-voice-openai', version: '1.0.0' },
    publisherIdentity: { status: 'unverified', id: 'happier', displayName: 'Happier' },
    source: { kind: 'npm', locator: '@happier/plugin-voice-openai@1.0.0', integrity: 'sha512-old' },
    updateChannel: {
      kind: 'npm',
      packageName: '@happier/plugin-voice-openai',
      registryOrigin: 'https://registry.npmjs.org',
    },
    signature: { status: 'verified', keyId: 'publisher-key-1' },
    provenance: { status: 'notProvided' },
    curation: { status: 'notApplicable' },
    executableRealms: ['daemon'],
    contributions: [],
    requestInterceptors: [],
    uiArtifacts: { status: 'none', contributionIds: [] },
    requiredHostAccess: [],
    optionalHostAccess: [],
    rawCredentialAccess: [],
    compatibility: { happier: '*', runtimeApiVersion: 1 },
    updatePolicy: 'automatic',
  } satisfies PluginInstallationReview;
}

describe('plugin install-review principal digest', () => {
  it('is stable across package versions and mutable runtime bytes', () => {
    const initial = review();
    const updated = {
      ...initial,
      version: '2.0.0',
      packageIdentity: { ...initial.packageIdentity, version: '2.0.0' },
      source: { ...initial.source, locator: '@happier/plugin-voice-openai@2.0.0', integrity: 'sha512-new' },
    } satisfies PluginInstallationReview;

    expect(derivePluginInstallReviewPrincipal(updated).digest)
      .toBe(derivePluginInstallReviewPrincipal(initial).digest);
  });

  it('changes with package, distribution, publisher, or package-signature authority', () => {
    const initial = review();
    const digest = derivePluginInstallReviewPrincipal(initial).digest;

    expect(derivePluginInstallReviewPrincipal({
      ...initial,
      packageIdentity: { ...initial.packageIdentity, name: '@acme/voice' },
    }).digest).not.toBe(digest);
    expect(derivePluginInstallReviewPrincipal({
      ...initial,
      updateChannel: { ...initial.updateChannel, registryOrigin: 'https://registry.acme.test' },
    }).digest).not.toBe(digest);
    expect(derivePluginInstallReviewPrincipal({
      ...initial,
      publisherIdentity: {
        status: 'unverified',
        id: 'acme',
        displayName: 'Acme',
      },
    }).digest).not.toBe(digest);
    expect(derivePluginInstallReviewPrincipal({
      ...initial,
      signature: { status: 'verified', keyId: 'publisher-key-2' },
    }).digest).not.toBe(digest);
  });

  it('returns a safe presentation from the exact facts used by the digest', () => {
    const npm = derivePluginInstallReviewPrincipal(review());
    expect(npm.presentation).toEqual({
      v: 1,
      packageIdentity: {
        pluginId: 'happier.voice.openai',
        packageName: '@happier/plugin-voice-openai',
      },
      distributionIdentity: {
        kind: 'npm',
        packageName: '@happier/plugin-voice-openai',
        registryOrigin: 'https://registry.npmjs.org',
      },
      publisherIdentity: {
        status: 'unverified',
        id: 'happier',
        displayName: 'Happier',
      },
      packageSignature: {
        status: 'verified',
        keyId: 'publisher-key-1',
      },
    });
    expect(derivePluginInstallReviewPrincipalDigest(npm.presentation)).toBe(npm.digest);

    const path = derivePluginInstallReviewPrincipal({
      ...review(),
      source: {
        kind: 'path',
        locator: '/Users/alice/private/plugins/voice',
      },
      updateChannel: {
        kind: 'path',
        locator: '/Users/alice/private/plugins/voice',
        development: true,
      },
      signature: { status: 'notProvided' },
    });
    expect(path.presentation.distributionIdentity).toEqual({
      kind: 'path',
      development: true,
    });
    expect(path.presentation.publisherIdentity).toEqual({
      status: 'unverified',
      id: 'happier',
      displayName: 'Happier',
    });
    expect(path.presentation.packageSignature).toEqual({ status: 'unavailable' });

    const archive = derivePluginInstallReviewPrincipal({
      ...review(),
      source: {
        kind: 'archive',
        locator: 'https://user:password@example.test/private/plugin.tgz?token=secret',
        integrity: 'secret-integrity',
      },
      updateChannel: {
        kind: 'archive',
        locator: 'https://user:password@example.test/private/plugin.tgz?token=secret',
      },
      signature: { status: 'notProvided' },
    });
    expect(archive.presentation.distributionIdentity).toEqual({ kind: 'archive' });
    expect(JSON.stringify([path.presentation, archive.presentation])).not.toContain('alice');
    expect(JSON.stringify([path.presentation, archive.presentation])).not.toContain('password');
    expect(JSON.stringify([path.presentation, archive.presentation])).not.toContain('integrity');
  });
});
