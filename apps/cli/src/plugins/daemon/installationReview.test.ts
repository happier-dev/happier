import { describe, expect, it } from 'vitest';

import { validatePluginManifest } from '@/plugins/manifest/validate';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { PluginInstallationReviewSchema } from '@happier-dev/protocol/marketplace/internal';

import {
  projectPluginInstallationReview,
  type PluginInstallationReviewSourceFacts,
} from './installationReview';

function createManifest(options: Readonly<{
  includeHappierEngine?: boolean;
  happierEngine?: string;
  includeRawVoiceCredentialGrants?: boolean;
  includeRequestInterceptors?: boolean;
}> = {}) {
  const result = validatePluginManifest({
    schemaVersion: 2,
    id: 'acme.install-review',
    version: '1.0.0',
    displayName: 'Install review',
    ...(options.includeHappierEngine === false ? {} : { engines: { happier: options.happierEngine ?? '>=0.0.0' } }),
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './dist/daemon.mjs' },
    hostAccess: { required: [], optional: [] },
    contributes: {
      ...(options.includeRawVoiceCredentialGrants ? {
        voiceProviders: [{
        id: 'raw-voice',
        title: 'Raw Voice',
        kind: 'conversation',
        roles: ['realtime_conversation'],
        platforms: ['web', 'ios'],
        capabilities: {
          turn: { cancelResponse: false, bargeIn: false },
        },
        credentials: {
          slot: {
            id: 'voice_auth',
            purpose: 'voice.client-auth',
            title: 'Voice credential',
          },
          requirement: { kind: 'always' },
          sources: [{
            kind: 'savedSecret',
            secretKinds: ['apiKey'],
            rawGrants: [{
              realm: 'web',
              phase: 'connection',
              request: {
                kind: 'httpHeaders',
                origin: 'https://voice.example.test',
                headerNames: ['authorization'],
              },
            }],
          }, {
            kind: 'connectedAccount',
            service: { pluginId: 'acme.voice-account', localId: 'oauth' },
            rawGrants: [{
              realm: 'ios',
              phase: 'prepare',
              request: {
                kind: 'httpHeaders',
                origin: 'https://voice.example.test',
                headerNames: ['x-account-token'],
              },
            }],
          }],
        },
        client: {
          artifactId: 'raw-voice-client',
          exportName: 'activate',
        },
        }],
      } : {}),
      ...(options.includeRequestInterceptors ? {
        requestInterceptors: [{
          id: 'protect-api',
          origins: ['https://api.example.test', 'https://accounts.example.test'],
          methods: ['GET', 'POST'],
          priority: 25,
        }],
      } : {}),
    },
  }, { sourceProvenance: 'registryCustodied' });
  if (!result.ok) throw new Error(`Fixture manifest rejected: ${JSON.stringify(result.diagnostics)}`);
  return result.manifest;
}

describe('projectPluginInstallationReview', () => {
  it('does not synthesize a review host floor when the canonical manifest omits its optional engine', () => {
    const review = projectPluginInstallationReview({
      manifest: createManifest({ includeHappierEngine: false }),
      source: {
        kind: 'path',
        locator: '/tmp/install-review',
        development: false,
        packageName: null,
        publisher: { status: 'unavailable' },
        signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' },
        curation: { status: 'notApplicable' },
        updatePolicy: 'allowed',
      },
      uiArtifacts: { verification: 'verified', contributionIds: [] },
    });

    expect(review.compatibility).toEqual({ runtimeApiVersion: 1 });
  });

  it('retains a bounded selected compatible engine range verbatim', () => {
    const review = projectPluginInstallationReview({
      manifest: createManifest({ happierEngine: '^0.2.0' }),
      source: {
        kind: 'path',
        locator: '/tmp/install-review',
        development: false,
        packageName: null,
        publisher: { status: 'unavailable' },
        signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' },
        curation: { status: 'notApplicable' },
        updatePolicy: 'allowed',
      },
      uiArtifacts: { verification: 'verified', contributionIds: [] },
    });

    expect(review.compatibility).toEqual({ happier: '^0.2.0', runtimeApiVersion: 1 });
  });

  it('preserves the complete long valid selected engine range in the review', () => {
    const happierEngine = `>=0.0.0${' '.repeat(37_980)}<10000.0.0`;
    const review = projectPluginInstallationReview({
      manifest: createManifest({ happierEngine }),
      source: {
        kind: 'path',
        locator: '/tmp/install-review',
        development: false,
        packageName: null,
        publisher: { status: 'unavailable' },
        signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' },
        curation: { status: 'notApplicable' },
        updatePolicy: 'allowed',
      },
      uiArtifacts: { verification: 'verified', contributionIds: [] },
    });

    expect(review.compatibility).toEqual({
      happier: happierEngine,
      runtimeApiVersion: 1,
    });
    expect(PluginInstallationReviewSchema.safeParse(review).success).toBe(true);
  });

  it('projects every evaluator-owned reason and newer version without silently truncating review evidence', () => {
    const source: PluginInstallationReviewSourceFacts = {
      kind: 'npm',
      locator: '@acme/install-review@1.0.0',
      integrity: 'sha512-example',
      integrityBasis: 'expected',
      packageName: '@acme/install-review',
      registryOrigin: 'https://registry.example.test',
      publisher: { status: 'unavailable' },
      signature: { status: 'notProvided' },
      provenance: { status: 'notProvided' },
      curation: { status: 'notApplicable' },
      blockedNewerVersions: Array.from({ length: 33 }, (_, index) => ({
        version: `1.0.${33 - index}`,
        diagnostics: Array.from({ length: 5 }, (_, reason) => ({
          code: 'plugin_manifest_semantic_invalid',
          message: `Evaluator reason ${index + 1}.${reason + 1}`,
        })),
      })),
      updatePolicy: 'allowed',
    };

    const review = projectPluginInstallationReview({
      manifest: createManifest(),
      source,
      uiArtifacts: { verification: 'verified', contributionIds: [] },
    });

    expect(review.compatibility.blockedNewerVersions).toEqual(source.blockedNewerVersions);
    expect(PluginInstallationReviewSchema.safeParse(review).success).toBe(true);
  });

  it('projects every declared raw Voice credential grant as non-secret review facts', () => {
    const review = projectPluginInstallationReview({
      manifest: createManifest({ includeRawVoiceCredentialGrants: true }),
      source: {
        kind: 'path',
        locator: '/tmp/install-review',
        development: false,
        packageName: null,
        publisher: { status: 'unavailable' },
        signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' },
        curation: { status: 'notApplicable' },
        updatePolicy: 'allowed',
      },
      uiArtifacts: { verification: 'verified', contributionIds: ['raw-voice-client'] },
    });

    expect(review.rawCredentialAccess).toEqual([
      {
        accessMode: 'raw',
        contribution: { pluginId: 'acme.install-review', localId: 'raw-voice' },
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
      },
      {
        accessMode: 'raw',
        contribution: { pluginId: 'acme.install-review', localId: 'raw-voice' },
        credentialSlot: {
          id: 'voice_auth',
          title: 'Voice credential',
          purpose: 'voice.client-auth',
        },
        sourceClass: {
          kind: 'connectedAccount',
          service: { pluginId: 'acme.voice-account', localId: 'oauth' },
        },
        realm: 'ios',
        phase: 'prepare',
        request: {
          kind: 'httpHeaders',
          origin: 'https://voice.example.test',
          headerNames: ['x-account-token'],
        },
      },
    ]);
  });

  it('projects a hostedWeb UI renderer as its own executable realm through the review wire schema', () => {
    const parsed = readCanonicalPluginManifest(createPluginManifestV2Fixture({
      id: 'acme.hosted-review',
      version: '1.0.0',
      contributes: {
        ui: {
          renderers: [{
            id: 'panel',
            kind: 'hostedWeb',
            source: { kind: 'artifact', artifact: 'panel-web' },
          }],
        },
      },
    }));
    if (!parsed) throw new Error('Expected canonical hosted-web renderer manifest');

    const review = projectPluginInstallationReview({
      manifest: parsed,
      source: {
        kind: 'path',
        locator: '/tmp/hosted-review',
        development: false,
        packageName: null,
        publisher: { status: 'unavailable' },
        signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' },
        curation: { status: 'notApplicable' },
        updatePolicy: 'allowed',
      },
      uiArtifacts: { verification: 'verified', contributionIds: ['panel-web'] },
    });

    expect(review.executableRealms).toEqual(['daemon', 'hostedWeb']);
    expect(PluginInstallationReviewSchema.safeParse(review).success).toBe(true);
  });

  it('projects each request interceptor declaration as an exact review fact', () => {
    const review = projectPluginInstallationReview({
      manifest: createManifest({ includeRequestInterceptors: true }),
      source: {
        kind: 'path',
        locator: '/tmp/install-review',
        development: false,
        packageName: null,
        publisher: { status: 'unavailable' },
        signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' },
        curation: { status: 'notApplicable' },
        updatePolicy: 'allowed',
      },
      uiArtifacts: { verification: 'verified', contributionIds: [] },
    });

    expect(review).toMatchObject({
      requestInterceptors: [{
        id: 'protect-api',
        origins: ['https://accounts.example.test', 'https://api.example.test'],
        methods: ['GET', 'POST'],
        priority: 25,
      }],
    });
  });
});
