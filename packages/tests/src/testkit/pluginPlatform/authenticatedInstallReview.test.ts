import { describe, expect, it, vi } from 'vitest';
import {
  decideAuthenticatedPluginInstallReview,
  readPluginInstallReviewRequiredEnvelope,
} from './authenticatedInstallReview';
const completeReview = {
  pluginId: 'acme.plugin',
  displayName: 'Acme Plugin',
  version: '1.0.0',
  packageIdentity: { name: '@acme/plugin', version: '1.0.0' },
  publisherIdentity: { status: 'unverified', id: 'acme', displayName: 'Acme' },
  source: {
    kind: 'npm',
    locator: 'https://registry.example.test/acme-plugin.tgz',
    integrity: 'sha512-candidate',
  },
  updateChannel: {
    kind: 'npm',
    packageName: '@acme/plugin',
    registryOrigin: 'https://registry.example.test',
    marketplaceSource: {
      id: 'marketplace:curated',
      kind: 'curated',
      sourceUrl: 'https://marketplace.example.test/catalog.json',
    },
  },
  signature: { status: 'verified', keyId: 'registry-key-1' },
  provenance: { status: 'retrievedUnverified', predicateTypes: ['https://slsa.dev/provenance/v1'] },
  curation: {
    status: 'approved',
    sourceId: 'marketplace:curated',
    reviewedAt: '2026-07-24T00:00:00.000Z',
  },
  executableRealms: ['daemon'],
  contributions: [{ family: 'actions', count: 1 }],
  requestInterceptors: [],
  uiArtifacts: { status: 'none', contributionIds: [] },
  requiredHostAccess: [{
    id: 'required-network',
    capability: 'network',
    reason: 'Connect to the Acme service',
    authorizationClass: 'cooperativeDisclosure',
    normalizedScope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.acme.test' }] },
  }],
  optionalHostAccess: [],
  rawCredentialAccess: [{
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
  }],
  compatibility: { happier: '^0.3.0', runtimeApiVersion: 1 },
  updatePolicy: 'allowed',
} as const;

function reviewRequiredEnvelope(review: unknown) {
  return {
    ok: false as const,
    kind: 'plugins_install' as const,
    error: {
      code: 'review_required',
      message: 'Review required',
      pendingChangeId: 'pending-1',
      review,
    },
  };
}

describe('decideAuthenticatedPluginInstallReview', () => {
  it('reads the CLI review_required facts without treating them as install authority', () => {
    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(completeReview))).toEqual({
      pendingChangeId: 'pending-1',
      review: completeReview,
    });
  });

  it('retains strict request-interceptor review facts', () => {
    const requestInterceptor = {
      id: 'protect-api',
      origins: ['https://accounts.example.test', 'https://api.example.test'],
      methods: ['GET', 'POST'],
      priority: 25,
    } as const;
    const review = {
      ...completeReview,
      requestInterceptors: [requestInterceptor],
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });

    const invalidRequestInterceptors = [
      [{ ...requestInterceptor, unexpected: true }],
      [{ ...requestInterceptor, id: 'Protect-API' }],
      [{ ...requestInterceptor, origins: ['ftp://api.example.test'] }],
      [{ ...requestInterceptor, methods: ['TRACE'] }],
      [{ ...requestInterceptor, priority: 25.5 }],
    ];
    for (const requestInterceptors of invalidRequestInterceptors) {
      expect(() => readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope({
        ...completeReview,
        requestInterceptors,
      }))).toThrow(/malformed review_required facts \(review\.requestInterceptors: invalid\)/);
    }
  });

  it('rejects raw credential selection or secret material that is not a review fact', () => {
    expect(() => readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope({
      ...completeReview,
      rawCredentialAccess: [{
        ...completeReview.rawCredentialAccess[0],
        accountId: 'selected-account-1',
      }],
    }))).toThrow(/malformed review_required facts \(review\.rawCredentialAccess: invalid\)/);
    expect(() => readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope({
      ...completeReview,
      rawCredentialAccess: [{
        ...completeReview.rawCredentialAccess[0],
        request: {
          ...completeReview.rawCredentialAccess[0].request,
          secretValue: 'not-a-review-fact',
        },
      }],
    }))).toThrow(/malformed review_required facts \(review\.rawCredentialAccess: invalid\)/);
  });

  it('retains bounded newer-version compatibility facts without treating them as an install decision', () => {
    const review = {
      ...completeReview,
      compatibility: {
        ...completeReview.compatibility,
        blockedNewerVersions: [{
          version: '1.1.0',
          diagnostics: [{
            code: 'plugin_manifest_semantic_invalid',
            message: 'Plugin manifest requires happier >=9999.0.0',
          }],
        }],
      },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
    expect(() => readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope({
      ...review,
      compatibility: {
        ...review.compatibility,
        blockedNewerVersions: Array.from({ length: 33 }, () => review.compatibility.blockedNewerVersions[0]),
      },
    }))).toThrow(/malformed review_required facts \(review\.compatibility: invalid\)/);
  });

  it('accepts the bounded daemon-entry compatibility diagnostic emitted before download', () => {
    const review = {
      ...completeReview,
      compatibility: {
        ...completeReview.compatibility,
        blockedNewerVersions: [{
          version: '1.1.0',
          diagnostics: [{
            code: 'plugin_manifest_semantic_invalid',
            message: 'Plugin daemon entry uses an unsupported extension',
          }],
        }],
      },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
  });

  it('accepts the bounded generated UI artifact compatibility diagnostic emitted before download', () => {
    const review = {
      ...completeReview,
      compatibility: {
        ...completeReview.compatibility,
        blockedNewerVersions: [{
          version: '1.1.0',
          diagnostics: [{
            code: 'plugin_compatibility_projection_invalid',
            message: 'Generated UI artifact compatibility check failed: generated_ui_host_api_mismatch.',
          }],
        }],
      },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
  });

  it('accepts the bounded incompatible-engine compatibility diagnostic emitted before download', () => {
    const review = {
      ...completeReview,
      compatibility: {
        ...completeReview.compatibility,
        blockedNewerVersions: [{
          version: '1.1.0',
          diagnostics: [{
            code: 'plugin_manifest_semantic_invalid',
            message: 'Plugin manifest requires a compatible Happier CLI version',
          }],
        }],
      },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
  });

  it('accepts the bounded selected-engine compatibility declaration', () => {
    const review = {
      ...completeReview,
      compatibility: {
        ...completeReview.compatibility,
        happier: 'Declared compatible Happier CLI range',
      },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
  });

  it('accepts an optional absent engine without inventing a host floor', () => {
    const review = {
      ...completeReview,
      compatibility: { runtimeApiVersion: 1 },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(review))).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
  });

  it('keeps archive/npm acquisition integrity while rejecting retired review digests and path integrity', () => {
    const pathReview = {
      ...completeReview,
      packageIdentity: { name: null, version: '1.0.0' },
      publisherIdentity: { status: 'unavailable' },
      source: { kind: 'path', locator: '/tmp/acme-plugin' },
      updateChannel: { kind: 'path', locator: '/tmp/acme-plugin', development: true },
      signature: { status: 'notProvided' },
      curation: { status: 'notApplicable' },
      updatePolicy: 'allowed',
    } as const;
    const archiveReview = {
      ...pathReview,
      source: {
        kind: 'archive',
        locator: 'file:///tmp/acme-plugin.tar.gz',
        integrity: 'sha512-archive-candidate',
      },
      updateChannel: { kind: 'archive', locator: 'file:///tmp/acme-plugin.tar.gz' },
    } as const;

    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(pathReview))).toEqual({
      pendingChangeId: 'pending-1',
      review: pathReview,
    });
    expect(readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope(archiveReview))).toEqual({
      pendingChangeId: 'pending-1',
      review: archiveReview,
    });
    expect(() => readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope({
      ...completeReview,
      integrity: { retired: true },
    }))).toThrow(/malformed review_required facts \(review: unexpected_field\)/);
    expect(() => readPluginInstallReviewRequiredEnvelope(reviewRequiredEnvelope({
      ...pathReview,
      source: { ...pathReview.source, integrity: 'sha512-fabricated-local' },
    }))).toThrow(/malformed review_required facts \(review\.source: invalid\)/);
  });

  it('rejects an incomplete review before it can reach the decision helper', () => {
    const { signature: _missing, ...incompleteReview } = completeReview;
    expect(() => readPluginInstallReviewRequiredEnvelope({
      ok: false,
      kind: 'plugins_install',
      error: {
        code: 'review_required',
        message: 'Review required',
        pendingChangeId: 'pending-1',
        review: incompleteReview,
      },
    })).toThrow(/malformed review_required facts \(review\.signature: invalid\)/);
  });

  it('accepts the production review schema npm registry profile identity', () => {
    const review = {
      ...completeReview,
      updateChannel: {
        ...completeReview.updateChannel,
        registryProfileId: 'registry-private',
      },
    } as const;
    expect(readPluginInstallReviewRequiredEnvelope({
      ok: false,
      kind: 'plugins_install',
      error: {
        code: 'review_required',
        message: 'Review required',
        pendingChangeId: 'pending-1',
        review,
      },
    })).toEqual({
      pendingChangeId: 'pending-1',
      review,
    });
  });

  it('decides the pending install as the present user through approval.request.decide, then reads the settled change', async () => {
    const calls: string[][] = [];
    const runCli = vi.fn(async ({ args }: { args: readonly string[] }) => {
      calls.push([...args]);
      if (args[0] === 'actions') {
        return { code: 0, stdout: JSON.stringify({ ok: true, data: { status: 'approved' } }) };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          kind: 'plugins_change_status',
          data: calls.filter((call) => call[0] === 'plugins').length < 2
            ? { kind: 'applying', pendingChangeId: 'pending-1' }
            : { kind: 'terminal', pendingChangeId: 'pending-1', result: { kind: 'committed', pluginId: 'acme.plugin' } },
        }),
      };
    });
    const outcome = await decideAuthenticatedPluginInstallReview({
      cliHomeDir: '/tmp/home',
      serverUrl: 'http://127.0.0.1:1',
      pendingChangeId: 'pending-1',
      optionalSelections: [{ accessId: 'optional-secrets', selected: false }],
      confirmPresentUser: async () => true,
      cliEntrypoint: '/cli.mjs',
      deps: { runCli },
    });
    expect(outcome).toMatchObject({ kind: 'committed', pluginId: 'acme.plugin' });
    expect(calls[0]).toEqual(expect.arrayContaining(['approval.request.decide', '--input-json']));
    expect(JSON.parse(calls[0]![calls[0]!.indexOf('--input-json') + 1]!)).toEqual({
      artifactId: 'pending-1',
      decision: 'approve',
    });
  });

  it('cancels without polling when the present user declines', async () => {
    const runCli = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ ok: true }) }));
    const outcome = await decideAuthenticatedPluginInstallReview({
      cliHomeDir: '/tmp/home',
      serverUrl: 'http://127.0.0.1:1',
      pendingChangeId: 'pending-1',
      confirmPresentUser: async () => false,
      cliEntrypoint: '/cli.mjs',
      deps: { runCli },
    });
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(runCli).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a refused decision and on an unexpressible optional selection', async () => {
    await expect(decideAuthenticatedPluginInstallReview({
      cliHomeDir: '/tmp/home',
      serverUrl: 'http://127.0.0.1:1',
      pendingChangeId: 'pending-1',
      confirmPresentUser: async () => true,
      cliEntrypoint: '/cli.mjs',
      deps: { runCli: async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'not_found' } }) }) },
    })).rejects.toThrow('not_found');
    const runCli = vi.fn();
    await expect(decideAuthenticatedPluginInstallReview({
      cliHomeDir: '/tmp/home',
      serverUrl: 'http://127.0.0.1:1',
      pendingChangeId: 'pending-1',
      optionalSelections: [{ accessId: 'optional-secrets', selected: true }],
      confirmPresentUser: async () => true,
      cliEntrypoint: '/cli.mjs',
      deps: { runCli },
    })).rejects.toThrow('optional host access');
    expect(runCli).not.toHaveBeenCalled();
  });
});
