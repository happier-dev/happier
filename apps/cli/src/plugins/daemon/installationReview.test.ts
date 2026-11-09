import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { evaluatePluginDevelopmentCandidate } from '@/plugins/authoring/sourceModule';
import { resolvePluginAuthorWorkspaceUiBuilder, resolvePluginUiBuildArguments } from '@/plugins/authoring/hostSdkResolution';
import { validatePluginManifest } from '@/plugins/manifest/validate';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { PluginInstallationReviewSchema } from '@happier-dev/protocol/marketplace/internal';
import { presentMachineAuthorityV1, type MachineAdminAccessObservationV1 } from '@happier-dev/protocol';

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
  it.each(['allowed', 'denied', 'unknown', 'unavailable'] as const)('carries %s operator authority through the real review projection', (authorization) => {
    const observation: MachineAdminAccessObservationV1 = {
      version: 1, observedAt: 1, daemonUid: 1000, daemonUsername: 'happier', daemonIdentity: 'nonRoot',
      rootEquivalentGroups: [], groupMembership: { state: 'current' }, passwordlessSudoToRoot: 'denied', managedDropIn: 'absent',
      tailscaledOperator: { authorization },
    };
    const review = projectPluginInstallationReview({
      manifest: createManifest(), daemonRights: { observation, freshness: 'current' },
      source: {
        kind: 'path', locator: '/tmp/authority-review', development: false,
        packageName: null, publisher: { status: 'unavailable' }, signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' }, curation: { status: 'notApplicable' }, updatePolicy: 'allowed',
      },
      uiArtifacts: { verification: 'unavailable', contributionIds: [] },
    });
    const parsed = PluginInstallationReviewSchema.parse(review);
    expect(parsed.daemonRights?.observation).toEqual(observation);
    expect(presentMachineAuthorityV1(parsed.daemonRights ?? {})).toMatchObject({
      hostAuthority: 'ordinary', tailscaledOperator: { currentAuthorization: authorization },
    });
  });

  it('discloses unknown daemon authority when no host observation exists', () => {
    const review = projectPluginInstallationReview({
      manifest: createManifest(),
      source: {
        kind: 'path', locator: '/tmp/authority-review', development: false,
        packageName: null, publisher: { status: 'unavailable' },
        signature: { status: 'notProvided' }, provenance: { status: 'notProvided' },
        curation: { status: 'notApplicable' }, updatePolicy: 'allowed',
      },
      uiArtifacts: { verification: 'unavailable', contributionIds: [] },
    });
    expect(review).toMatchObject({ daemonRights: { observation: null, freshness: 'stale' } });
    expect(PluginInstallationReviewSchema.safeParse(review).success).toBe(true);
  });

  it('admits a Channels development candidate with the actual source compiler artifact inventory', async () => {
    const root = fileURLToPath(new URL('../../../../../packages/plugins/channels/', import.meta.url));
    const scratch = await mkdtemp(join(tmpdir(), 'happier-devplug-install-review-'));
    try {
      const candidate = await evaluatePluginDevelopmentCandidate({
        locator: root,
        sourceAuthority: { kind: 'development', registeredRootId: 'devplug', canonicalRoot: root, observedRevision: 1 },
      });
      const manifestPath = join(scratch, 'plugin.json');
      await writeFile(manifestPath, candidate.evaluated.canonicalManifestJson, 'utf8');
      const builderPath = resolvePluginAuthorWorkspaceUiBuilder(root);
      if (!builderPath) throw new Error('Expected canonical Channels source UI builder');
      // Run the real managed-child arguments at the OS boundary, with all
      // generated bytes confined to the disposable output directory.
      await promisify(execFile)(process.execPath, [...resolvePluginUiBuildArguments({
        projectRoot: root, builderPath, manifestPath,
      })], {
        cwd: root,
        env: { ...process.env, HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: scratch },
      });
      const artifacts: unknown = JSON.parse(await readFile(join(scratch, 'happier-plugin-ui/ui-artifacts.json'), 'utf8'));
      const { PluginUiArtifactsManifestV2Schema } = await import('@happier-dev/protocol/plugins/ui');
      const contributionIds = PluginUiArtifactsManifestV2Schema.parse(artifacts).entries.map(entry => entry.artifactId).sort();
      const source: PluginInstallationReviewSourceFacts = {
        kind: 'path', locator: root, development: true, packageName: null,
        publisher: { status: 'unavailable' }, signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' }, curation: { status: 'notApplicable' }, updatePolicy: 'allowed',
      };
      const declared = projectPluginInstallationReview({
        manifest: candidate.evaluated.manifest, source,
        uiArtifacts: { verification: 'unavailable', contributionIds: [] },
      }).uiArtifacts.contributionIds;
      console.info('DEVPLUG installation-review inventory', JSON.stringify({
        compiled: contributionIds, declared,
        compiledOnly: contributionIds.filter(id => !declared.includes(id)),
        declaredOnly: declared.filter(id => !contributionIds.includes(id)),
      }));
      const review = projectPluginInstallationReview({
        manifest: candidate.evaluated.manifest, source,
        uiArtifacts: { verification: 'verified', contributionIds },
      });
      expect(review.uiArtifacts).toEqual({ status: 'verified', contributionIds });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 120_000);

  it('admits the authored Account Action artifact only when verified identities exactly match its declarations', async () => {
    const { manifest: authoredManifest } = await import('../../../../../packages/plugin-sdk/fixtures/account-actions/src/index');
    const manifest = readCanonicalPluginManifest(authoredManifest);
    if (!manifest) throw new Error('Expected canonical authored Account Action manifest');
    const source: PluginInstallationReviewSourceFacts = {
      kind: 'path', locator: '/tmp/account-actions', development: false,
      packageName: null, publisher: { status: 'unavailable' },
      signature: { status: 'notProvided' }, provenance: { status: 'notProvided' },
      curation: { status: 'notApplicable' }, updatePolicy: 'allowed',
    };
    const review = projectPluginInstallationReview({
      manifest, source,
      uiArtifacts: { verification: 'verified', contributionIds: ['account-runtime'] },
    });
    expect(review.uiArtifacts).toEqual({ status: 'verified', contributionIds: ['account-runtime'] });
    expect(review.executableRealms).toEqual(['daemon', 'reactNative']);
    expect(PluginInstallationReviewSchema.safeParse(review).success).toBe(true);
    for (const contributionIds of [[], ['account-runtime', 'undeclared-runtime']]) {
      expect(() => projectPluginInstallationReview({
        manifest, source, uiArtifacts: { verification: 'verified', contributionIds },
      })).toThrow('Verified plugin UI artifact identities do not match the manifest declarations');
    }
  });

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
    expect(review.executableRealms).toEqual(['daemon']);
  });

  it('discloses a client Action executable without requiring a UI renderer', () => {
    const manifest = readCanonicalPluginManifest(createPluginManifestV2Fixture({
      contributes: { actions: [{
        id: 'preview', title: 'Preview', surfaces: ['cli'], scopes: ['global'], dangerLevel: 'safe',
        execution: { target: 'client', platforms: ['web'], client: { artifactId: 'client-runtime', exportName: 'activate' } },
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }] },
    }));
    if (!manifest) throw new Error('Expected canonical client Action manifest');
    const review = projectPluginInstallationReview({
      manifest,
      source: {
        kind: 'path', locator: '/tmp/client-actions', development: false,
        packageName: null, publisher: { status: 'unavailable' }, signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' }, curation: { status: 'notApplicable' }, updatePolicy: 'allowed',
      },
      uiArtifacts: { verification: 'verified', contributionIds: ['client-runtime'] },
    });
    expect(review.executableRealms).toEqual(['daemon', 'reactNative']);
  });

  it('discloses an authentication-only Account artifact beside the native runtime', () => {
    const manifest = readCanonicalPluginManifest(createPluginManifestV2Fixture({
      contributes: { connectedAccountDescriptors: [{
        id: 'example', title: 'Example', authentication: {
          account: { artifactId: 'portable-auth', exportName: 'activate' },
          defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [{
            id: 'token', title: 'Token', secret: true, schema: { type: 'string' },
          }] }],
        },
      }] },
    }));
    if (!manifest) throw new Error('Expected canonical portable authentication manifest');
    const review = projectPluginInstallationReview({ manifest,
      source: { kind: 'path', locator: '/tmp/portable-auth', development: false,
        packageName: null, publisher: { status: 'unavailable' }, signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' }, curation: { status: 'notApplicable' }, updatePolicy: 'allowed' },
      uiArtifacts: { verification: 'verified', contributionIds: ['portable-auth'] },
    });
    expect(review.executableRealms).toEqual(['daemon', 'reactNative']);
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

    expect(review.executableRealms).toEqual(['daemon', 'reactNative']);
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
