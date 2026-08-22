import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Page } from '@playwright/test';

import { computePluginUiArtifactFileSetSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';

import type { PackedAuthorCandidate } from '../../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import {
  attestLoadedBrowserModules,
  attestCandidateInspectorRuntime,
  attestPackedPublicAuthoringHostedWebRuntime,
  attestPackedInspectorArtifacts,
  buildPackedCandidateBrowserQaRunOutcome,
  observeLoadedBrowserModuleResponses,
  preparePackedCandidateBrowserQa,
  preparePackedUcxWebQa,
  preparePackedNovelConnectedAccountBrowserQa,
  requirePackedCandidateManifestPath,
  resolvePackedCandidateBrowserQaBeforeAllTimeoutMs,
  resolvePackedCandidateBrowserQaMaterializationRoot,
  type PackedCandidateBrowserQaAttestation,
} from './packedCandidateBrowserQa';

const MATERIALIZED_CLI_ENTRYPOINT = resolve(
  '/materialized/node_modules/@happier-dev/cli/bin/happier.mjs',
);

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function candidateManifest(params: Readonly<{
  sdkIntegrity: string;
  pluginUiIntegrity: string;
  cliIntegrity: string;
}>): PackedAuthorCandidate {
  return {
    schemaVersion: 1,
    runId: 'candidate-browser-qa',
    installers: {
      releaseChannel: 'dev',
      shell: {
        kind: 'shell',
        fileName: 'install-dev.sh',
        sizeBytes: 1,
        sha256: '1'.repeat(64),
        filePath: '/candidate/installers/install-dev.sh',
      },
      powershell: {
        kind: 'powershell',
        fileName: 'install-dev.ps1',
        sizeBytes: 1,
        sha256: '2'.repeat(64),
        filePath: '/candidate/installers/install-dev.ps1',
      },
      publicKey: {
        kind: 'minisign-public-key',
        fileName: 'happier-release.pub',
        sizeBytes: 1,
        sha256: '3'.repeat(64),
        filePath: '/candidate/installers/happier-release.pub',
      },
    },
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.3.1',
      integrity: params.sdkIntegrity,
      tarballPath: '/candidate/sdk.tgz',
    },
    pluginUi: {
      packageName: '@happier-dev/plugin-ui',
      version: '0.3.1',
      pluginSdkVersion: '0.3.1',
      integrity: params.pluginUiIntegrity,
      tarballPath: '/candidate/plugin-ui.tgz',
    },
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.9.4',
      integrity: params.cliIntegrity,
      tarballPath: '/candidate/cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
    standaloneCli: {
      product: 'happier',
      version: '0.9.4',
      os: 'linux',
      arch: 'x64',
      sha256: '4'.repeat(64),
      archivePath: '/candidate/native/happier-v0.9.4-linux-x64.tar.gz',
      archives: [{
        product: 'happier',
        version: '0.9.4',
        os: 'linux',
        arch: 'x64',
        sha256: '4'.repeat(64),
        archivePath: '/candidate/native/happier-v0.9.4-linux-x64.tar.gz',
      }],
      checksums: {
        kind: 'sha256-checksums',
        fileName: 'checksums-happier-v0.9.4.txt',
        sizeBytes: 1,
        sha256: '5'.repeat(64),
        filePath: '/candidate/native/checksums-happier-v0.9.4.txt',
      },
      signature: {
        kind: 'minisign-signature',
        fileName: 'checksums-happier-v0.9.4.txt.minisig',
        sizeBytes: 1,
        sha256: '6'.repeat(64),
        filePath: '/candidate/native/checksums-happier-v0.9.4.txt.minisig',
      },
      notarization: [],
    },
  };
}

function expectedLoadedBrowserModuleDigest(entries: readonly Readonly<{
  path: string;
  bytes: string;
}>[]): string {
  const digest = createHash('sha256');
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes, 'utf8');
    digest.update(`${entry.path}\0${bytes.byteLength}\0`);
    digest.update(bytes);
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}

function expectedLoadedBrowserModuleProbes(entries: readonly Readonly<{
  url: string;
  path: string;
  bytes: string;
}>[]): readonly Readonly<{
  url: string;
  path: string;
  sha256: string;
}>[] {
  return entries.map((entry) => Object.freeze({
    url: entry.url,
    path: entry.path,
    sha256: `sha256:${createHash('sha256').update(entry.bytes).digest('hex')}`,
  }));
}

function createObservedBrowserModulePage(scriptUrls: readonly string[]) {
  const mainFrame = {};
  const responseListeners = new Set<(response: unknown) => void>();
  const frameNavigatedListeners = new Set<(frame: unknown) => void>();
  const page = {
    locator: (selector: string) => {
      expect(selector).toBe('script[src]');
      return {
        evaluateAll: async (pageFunction: (scripts: Array<{ src: string }>) => unknown) => (
          pageFunction(scriptUrls.map((src) => ({ src })))
        ),
      };
    },
    mainFrame: () => mainFrame,
    on: (event: string, listener: (value: unknown) => void) => {
      if (event === 'response') responseListeners.add(listener);
      if (event === 'framenavigated') frameNavigatedListeners.add(listener);
      return page;
    },
    off: (event: string, listener: (value: unknown) => void) => {
      if (event === 'response') responseListeners.delete(listener);
      if (event === 'framenavigated') frameNavigatedListeners.delete(listener);
      return page;
    },
    request: {
      get: vi.fn(),
    },
  };
  return {
    page: page as unknown as Pick<Page, 'locator' | 'mainFrame' | 'on' | 'off'>,
    navigateMainFrame: () => {
      for (const listener of frameNavigatedListeners) listener(mainFrame);
    },
    emitScriptResponse: (url: string, bytes: Uint8Array) => {
      const response = {
        frame: () => mainFrame,
        request: () => ({ resourceType: () => 'script' }),
        url: () => url,
        ok: () => true,
        body: async () => Buffer.from(bytes),
      };
      for (const listener of responseListeners) listener(response);
    },
    emitUnavailableScriptResponse: (url: string) => {
      const response = {
        frame: () => mainFrame,
        request: () => ({ resourceType: () => 'script' }),
        url: () => url,
        ok: () => true,
        body: async () => {
          throw new Error('response body unavailable');
        },
      };
      for (const listener of responseListeners) listener(response);
    },
  };
}

describe('packed candidate browser run attestation', () => {
  it('fails closed when the same loaded script URL changes bytes across row documents', async () => {
    const scriptUrl = 'http://127.0.0.1:8081/index.bundle?platform=web&dev=true';
    const browser = createObservedBrowserModulePage([scriptUrl]);
    const observedResponses = observeLoadedBrowserModuleResponses(browser.page);
    try {
      browser.navigateMainFrame();
      browser.emitScriptResponse(scriptUrl, Buffer.from('v1'));

      browser.navigateMainFrame();
      browser.emitScriptResponse(scriptUrl, Buffer.from('v2'));
      await expect(observedResponses.observedResponses()).rejects.toThrow(
        `Packed candidate browser observed conflicting script responses for the loaded QA row: ${scriptUrl}`,
      );
    } finally {
      observedResponses.dispose();
    }
  });

  it('keeps a byte-identical script response across row documents', async () => {
    const scriptUrl = 'http://127.0.0.1:8081/index.bundle?platform=web&dev=true';
    const browser = createObservedBrowserModulePage([scriptUrl]);
    const observedResponses = observeLoadedBrowserModuleResponses(browser.page);
    try {
      browser.navigateMainFrame();
      browser.emitScriptResponse(scriptUrl, Buffer.from('stable'));
      browser.navigateMainFrame();
      browser.emitScriptResponse(scriptUrl, Buffer.from('stable'));
      expect(await observedResponses.observedResponses()).toEqual(
        new Map([[scriptUrl, Uint8Array.from(Buffer.from('stable'))]]),
      );
    } finally {
      observedResponses.dispose();
    }
  });

  it('fails closed when a loaded row script response body is unavailable', async () => {
    const scriptUrl = 'http://127.0.0.1:8081/index.bundle?platform=web&dev=true';
    const browser = createObservedBrowserModulePage([scriptUrl]);
    const observedResponses = observeLoadedBrowserModuleResponses(browser.page);
    try {
      browser.navigateMainFrame();
      browser.emitUnavailableScriptResponse(scriptUrl);
      await expect(observedResponses.observedResponses()).rejects.toThrow(
        `Packed candidate browser could not capture script response bytes for the loaded QA row: ${scriptUrl}`,
      );
    } finally {
      observedResponses.dispose();
    }
  });

  it('binds the browser-delivered V1 script bytes instead of refetching later V2 bytes from the same URL', async () => {
    const loadedScriptBytes = new Map<string, Buffer>([
      ['http://127.0.0.1:8081/index.bundle?platform=web&dev=true', Buffer.from('entry')],
      ['http://127.0.0.1:8081/_expo/static/js/web/vendor.js', Buffer.from('vendor')],
    ]);
    const normalTriageLoadedScriptBytes = new Map<string, Buffer>([
      ['http://127.0.0.1:8081/index.bundle?platform=web&dev=true', Buffer.from('triage-entry')],
      ['http://127.0.0.1:8081/_expo/static/js/web/vendor.js', Buffer.from('triage-vendor')],
    ]);
    const laterRefetchBytes = new Map<string, Buffer>([
      ['http://127.0.0.1:8081/index.bundle?platform=web&dev=true', Buffer.from('entry-v2')],
      ['http://127.0.0.1:8081/_expo/static/js/web/vendor.js', Buffer.from('vendor-v2')],
    ]);
    const laterRefetch = vi.fn(async (url: string) => ({
      ok: () => laterRefetchBytes.has(url),
      status: () => laterRefetchBytes.has(url) ? 200 : 404,
      body: async () => laterRefetchBytes.get(url) ?? Buffer.alloc(0),
    }));
    // This mock stands in for the real browser boundary while executing the
    // page-side selector callback against the scripts the page has loaded.
    const page = {
      locator: (selector: string) => {
        expect(selector).toBe('script[src]');
        return {
          evaluateAll: async (pageFunction: (scripts: Array<{ src: string }>) => unknown) => (
            pageFunction([
              { src: 'http://127.0.0.1:8081/_expo/static/js/web/vendor.js' },
              { src: 'http://127.0.0.1:8081/index.bundle?platform=web&dev=true' },
            ])
          ),
        };
      },
      request: {
        get: laterRefetch,
      },
    } as unknown as Pick<Page, 'locator' | 'request'>;
    const loadedModules = await attestLoadedBrowserModules(
      page,
      loadedScriptBytes,
    );
    const normalTriageLocalAgentJourneyLoadedModules = await attestLoadedBrowserModules(
      page,
      normalTriageLoadedScriptBytes,
    );
    expect(laterRefetch).not.toHaveBeenCalled();
    const attestation: PackedCandidateBrowserQaAttestation = {
      artifactBasis: 'candidate_manifest',
      artifactRunId: 'candidate-run-1',
      runId: 'candidate-run-1',
      sdkPackageName: '@happier-dev/plugin-sdk',
      sdkVersion: '1.2.3',
      sdkIntegrity: 'sha512-sdk',
      pluginUiPackageName: '@happier-dev/plugin-ui',
      pluginUiVersion: '1.2.3',
      pluginUiSdkVersion: '1.2.3',
      pluginUiIntegrity: 'sha512-ui',
      cliPackageName: '@happier-dev/cli',
      cliVersion: '1.2.3',
      cliIntegrity: 'sha512-cli',
      cliEntrypoint: '/candidate/happier.mjs',
      inspectorContributionId: 'inspector-app-native',
      inspectorWebArtifactDigest: 'sha256:inspector-web',
      inspectorIosArtifactDigest: 'sha256:inspector-ios',
      inspectorAndroidArtifactDigest: 'sha256:inspector-android',
      inspectorRepackContainerName: 'happier_inspector_inspector_app_native',
      inspectorRepackModulePath: './renderSurface',
      inspectorRepackExportName: 'renderSurface',
      inspectorPlatforms: {
        web: {
          artifactDigest: 'sha256:inspector-web',
          builtWith: { bundler: 'vite', version: '7.3.1' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        ios: {
          artifactDigest: 'sha256:inspector-ios',
          builtWith: { bundler: 'repack', version: '5.2.5' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        android: {
          artifactDigest: 'sha256:inspector-android',
          builtWith: { bundler: 'repack', version: '5.2.5' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
      },
    };

    expect(loadedModules).toEqual({
      digest: expectedLoadedBrowserModuleDigest([
        { path: '/_expo/static/js/web/vendor.js', bytes: 'vendor' },
        { path: '/index.bundle', bytes: 'entry' },
      ]),
      scriptPaths: [
        '/_expo/static/js/web/vendor.js',
        '/index.bundle',
      ],
      primaryBundleUrl: 'http://127.0.0.1:8081/index.bundle?platform=web&dev=true',
      moduleProbes: expectedLoadedBrowserModuleProbes([
        {
          url: 'http://127.0.0.1:8081/_expo/static/js/web/vendor.js',
          path: '/_expo/static/js/web/vendor.js',
          bytes: 'vendor',
        },
        {
          url: 'http://127.0.0.1:8081/index.bundle?platform=web&dev=true',
          path: '/index.bundle',
          bytes: 'entry',
        },
      ]),
    });
    expect(buildPackedCandidateBrowserQaRunOutcome({
      attestation,
      loadedModules,
      normalTriageLocalAgentJourneyLoadedModules,
      ucxContributor: {
        v1: {
          archiveSha256: 'sha256:ucx-v1',
          appliedGeneration: 'generation-v1',
        },
        v2: {
          archiveSha256: 'sha256:ucx-v2',
          appliedGeneration: 'generation-v2',
        },
      },
      completion: {
        normalTriageLocalAgentJourneyCompleted: true,
        contributorDisabledAndRetired: true,
        contributorTrustRevokedAndReinstalled: true,
        contributorUninstalledAndRetired: true,
      },
    })).toMatchObject({
      loadedHostPlatform: 'web',
      loadedHostRuntime: 'metro',
      loadedModuleSha256: expectedLoadedBrowserModuleDigest([
        { path: '/_expo/static/js/web/vendor.js', bytes: 'vendor' },
        { path: '/index.bundle', bytes: 'entry' },
      ]),
      loadedModulePathsJson: JSON.stringify([
        '/_expo/static/js/web/vendor.js',
        '/index.bundle',
      ]),
      loadedWebBundleUrl: 'http://127.0.0.1:8081/index.bundle?platform=web&dev=true',
      loadedWebBundleRevision: expectedLoadedBrowserModuleDigest([
        { path: '/_expo/static/js/web/vendor.js', bytes: 'vendor' },
        { path: '/index.bundle', bytes: 'entry' },
      ]),
      loadedWebModuleProbeJson: JSON.stringify(expectedLoadedBrowserModuleProbes([
        {
          url: 'http://127.0.0.1:8081/_expo/static/js/web/vendor.js',
          path: '/_expo/static/js/web/vendor.js',
          bytes: 'vendor',
        },
        {
          url: 'http://127.0.0.1:8081/index.bundle?platform=web&dev=true',
          path: '/index.bundle',
          bytes: 'entry',
        },
      ])),
      packageArtifactBasis: 'candidate_manifest',
      packageArtifactRunId: 'candidate-run-1',
      candidateRunId: 'candidate-run-1',
      candidateSdkIntegrity: 'sha512-sdk',
      candidatePluginUiIntegrity: 'sha512-ui',
      candidateCliIntegrity: 'sha512-cli',
      ucxContributorV1ArchiveSha256: 'sha256:ucx-v1',
      ucxContributorV1AppliedGeneration: 'generation-v1',
      ucxContributorV2ArchiveSha256: 'sha256:ucx-v2',
      ucxContributorV2AppliedGeneration: 'generation-v2',
      normalTriageLocalAgentJourneyCompleted: true,
      normalTriageLocalAgentJourneyLoadedModuleSha256: expectedLoadedBrowserModuleDigest([
        { path: '/_expo/static/js/web/vendor.js', bytes: 'triage-vendor' },
        { path: '/index.bundle', bytes: 'triage-entry' },
      ]),
      normalTriageLocalAgentJourneyLoadedModulePathsJson: JSON.stringify([
        '/_expo/static/js/web/vendor.js',
        '/index.bundle',
      ]),
      normalTriageLocalAgentJourneyLoadedWebBundleUrl:
        'http://127.0.0.1:8081/index.bundle?platform=web&dev=true',
      normalTriageLocalAgentJourneyLoadedWebBundleRevision:
        expectedLoadedBrowserModuleDigest([
          { path: '/_expo/static/js/web/vendor.js', bytes: 'triage-vendor' },
          { path: '/index.bundle', bytes: 'triage-entry' },
        ]),
      normalTriageLocalAgentJourneyLoadedWebModuleProbeJson: JSON.stringify(
        expectedLoadedBrowserModuleProbes([
          {
            url: 'http://127.0.0.1:8081/_expo/static/js/web/vendor.js',
            path: '/_expo/static/js/web/vendor.js',
            bytes: 'triage-vendor',
          },
          {
            url: 'http://127.0.0.1:8081/index.bundle?platform=web&dev=true',
            path: '/index.bundle',
            bytes: 'triage-entry',
          },
        ]),
      ),
      contributorDisabledAndRetired: true,
      contributorTrustRevokedAndReinstalled: true,
      contributorUninstalledAndRetired: true,
    });
    expect(() => buildPackedCandidateBrowserQaRunOutcome({
      attestation,
      loadedModules,
      normalTriageLocalAgentJourneyLoadedModules,
      ucxContributor: {
        v1: {
          archiveSha256: 'sha256:reused',
          appliedGeneration: 'generation-v1',
        },
        v2: {
          archiveSha256: 'sha256:reused',
          appliedGeneration: 'generation-v2',
        },
      },
      completion: {
        normalTriageLocalAgentJourneyCompleted: true,
        contributorDisabledAndRetired: true,
        contributorTrustRevokedAndReinstalled: true,
        contributorUninstalledAndRetired: true,
      },
    })).toThrow('UCX contributor v1 and v2 archive identities must differ');
    expect(() => buildPackedCandidateBrowserQaRunOutcome({
      attestation,
      loadedModules,
      normalTriageLocalAgentJourneyLoadedModules,
      ucxContributor: {
        v1: {
          archiveSha256: 'sha256:ucx-v1',
          appliedGeneration: 'generation-v1',
        },
        v2: {
          archiveSha256: 'sha256:ucx-v2',
          appliedGeneration: 'generation-v2',
        },
      },
      completion: {
        normalTriageLocalAgentJourneyCompleted: false,
        contributorDisabledAndRetired: true,
        contributorTrustRevokedAndReinstalled: true,
        contributorUninstalledAndRetired: true,
      },
    })).toThrow('packed_candidate_browser_qa_terminal_completion_incomplete');
    expect(() => buildPackedCandidateBrowserQaRunOutcome({
      attestation,
      loadedModules,
      normalTriageLocalAgentJourneyLoadedModules: null,
      ucxContributor: {
        v1: {
          archiveSha256: 'sha256:ucx-v1',
          appliedGeneration: 'generation-v1',
        },
        v2: {
          archiveSha256: 'sha256:ucx-v2',
          appliedGeneration: 'generation-v2',
        },
      },
      completion: {
        normalTriageLocalAgentJourneyCompleted: true,
        contributorDisabledAndRetired: true,
        contributorTrustRevokedAndReinstalled: true,
        contributorUninstalledAndRetired: true,
      },
    })).toThrow('packed_candidate_browser_qa_normal_triage_loaded_identity_missing');
  });

  it('fails closed when the loaded document has no observed script response bytes', async () => {
    const scriptUrl = 'http://127.0.0.1:8081/index.bundle?platform=web&dev=true';
    const browser = createObservedBrowserModulePage([scriptUrl]);

    await expect(attestLoadedBrowserModules(browser.page, new Map())).rejects.toThrow(
      `Packed candidate browser did not observe response bytes for loaded script: ${scriptUrl}`,
    );
  });
});

describe('packed candidate browser QA preparation', () => {
  it('attests the public authoring hosted-web projection against the exact handoff graph', () => {
    const publicAuthoring = {
      pluginId: 'examples.public-sdk-review-assistant',
      version: '0.1.0',
    archivePath:
      '/handoff/public-authoring/examples.public-sdk-review-assistant.happier-plugin.tgz',
    archive: {
      integrity: `sha512-${'a'.repeat(64)}`,
      sha256: 'b'.repeat(64),
      sizeBytes: 128,
      archivePath:
        '/handoff/public-authoring/examples.public-sdk-review-assistant.happier-plugin.tgz',
    },
    hostedWeb: {
        contributionId: 'review-web',
        entry: 'hosted-web/review-web/entry.mjs',
        digest: `sha256:${'a'.repeat(64)}`,
        files: [{
          relativePath: 'hosted-web/review-web/entry.mjs',
          digest: `sha256:${'b'.repeat(64)}`,
          byteSize: 24,
        }],
      },
    };
    const projectionResponse = {
      projection: {
        generation: 9,
        familiesById: {
          pluginUi: {
            entriesById: {
              'hostedWeb:examples.public-sdk-review-assistant:review-web': {
                runtime: { state: 'available' },
                runtimeMode: { kind: 'installedStaticAssets' },
                artifactGraph: {
                  contributionId: 'review-web',
                  tier: 'hostedWeb',
                  platform: 'web',
                  digest: publicAuthoring.hostedWeb.digest,
                },
              },
            },
          },
        },
      },
    };

    expect(attestPackedPublicAuthoringHostedWebRuntime({
      publicAuthoring,
      projectionResponse,
    })).toEqual({
      projectionGeneration: 9,
      hostedWebDigest: publicAuthoring.hostedWeb.digest,
      runtimeState: 'available',
    });
    expect(() => attestPackedPublicAuthoringHostedWebRuntime({
      publicAuthoring,
      projectionResponse: {
        ...projectionResponse,
        projection: {
          ...projectionResponse.projection,
          familiesById: {
            pluginUi: {
              entriesById: {
                'hostedWeb:examples.public-sdk-review-assistant:review-web': {
                  ...projectionResponse.projection.familiesById.pluginUi.entriesById[
                    'hostedWeb:examples.public-sdk-review-assistant:review-web'
                  ],
                  artifactGraph: {
                    contributionId: 'review-web',
                    tier: 'hostedWeb',
                    platform: 'web',
                    digest: `sha256:${'c'.repeat(64)}`,
                  },
                },
              },
            },
          },
        },
      },
    })).toThrow('packed_public_authoring_hosted_web_projection_digest_mismatch');
  });

  it('admits only the canonical packed novel handoff and selects its browser-isolated roots', async () => {
    const candidate = candidateManifest({
      sdkIntegrity: sri(Buffer.from('sdk')),
      pluginUiIntegrity: sri(Buffer.from('plugin-ui')),
      cliIntegrity: sri(Buffer.from('cli')),
    });
    const handoff = {
      plugin: {
        archivePath: '/handoff/plugin/acme.vertical-a.happier-plugin.tgz',
        service: {
          pluginId: 'acme.vertical-a',
          localId: 'novel-cloud',
        },
        authenticationModeIds: ['manual', 'oauth', 'device'],
      },
      publicAuthoring: {
        pluginId: 'examples.public-sdk-review-assistant',
        version: '0.1.0',
        archivePath:
          '/handoff/public-authoring/examples.public-sdk-review-assistant.happier-plugin.tgz',
        archive: {
          integrity: `sha512-${'a'.repeat(64)}`,
          sha256: 'b'.repeat(64),
          sizeBytes: 128,
          archivePath:
            '/handoff/public-authoring/examples.public-sdk-review-assistant.happier-plugin.tgz',
        },
        hostedWeb: {
          contributionId: 'review-web',
          entry: 'hosted-web/review-web/entry.mjs',
          digest: `sha256:${'a'.repeat(64)}`,
          files: [{
            relativePath: 'hosted-web/review-web/entry.mjs',
            digest: `sha256:${'b'.repeat(64)}`,
            byteSize: 24,
          }],
        },
      },
      consumers: {
        browser: {
          root: '/handoff/consumers/browser',
          happyHomeDir: '/handoff/consumers/browser/happier-home',
          databasePath: '/handoff/consumers/browser/server-data/server.sqlite',
        },
        device: {
          root: '/handoff/consumers/device',
          happyHomeDir: '/handoff/consumers/device/happier-home',
          databasePath: '/handoff/consumers/device/server-data/server.sqlite',
        },
      },
      oauth: {
        authorizationOriginConfigurationFieldId: 'authorization-origin',
        callbackUrl: 'http://localhost:1455/auth/callback',
        authorizePath: '/authorize',
        transport: 'ephemeral-https-loopback',
      },
    };
    const loadHandoff = vi.fn(async () => handoff);
    const assertCandidate = vi.fn();
    const authorization = {
      origin: 'https://127.0.0.1:43125',
      caCertificatePath: '/handoff/tls/ca.pem',
      callbackUrl: 'http://localhost:1455/auth/callback',
      getRequestSummary: vi.fn(() => ({
        authorizationRedirects: 0,
        rejectedRequests: 0,
      })),
      close: vi.fn(async () => {}),
    };
    const startAuthorizationServer = vi.fn(async () => authorization);

    const prepared = await preparePackedNovelConnectedAccountBrowserQa({
      candidate,
      handoffManifestPath: '/handoff/packed-novel-connected-account-qa.json',
      deps: {
        loadHandoff,
        assertCandidate,
        startAuthorizationServer,
      },
    });

    expect(loadHandoff).toHaveBeenCalledWith({
      manifestPath: '/handoff/packed-novel-connected-account-qa.json',
    });
    expect(assertCandidate).toHaveBeenCalledWith({
      handoff,
      candidate,
    });
    expect(prepared.pluginArchivePath).toBe(
      '/handoff/plugin/acme.vertical-a.happier-plugin.tgz',
    );
    expect(prepared.service).toEqual({
      pluginId: 'acme.vertical-a',
      localId: 'novel-cloud',
    });
    expect(prepared.authenticationModeIds).toEqual([
      'manual',
      'oauth',
      'device',
    ]);
    expect(prepared.isolation).toBe(handoff.consumers.browser);
    expect(prepared.oauth).toBe(handoff.oauth);
    expect(prepared.publicAuthoring).toBe(handoff.publicAuthoring);
    expect(startAuthorizationServer).toHaveBeenCalledOnce();
    expect(prepared.authorization).toBe(authorization);
    expect(prepared.authorizationOriginConfiguration).toEqual({
      'authorization-origin': authorization.origin,
    });
    await prepared.authorization.close();
    expect(authorization.close).toHaveBeenCalledOnce();

    const mismatchedAuthorizationClose = vi.fn(async () => {});
    await expect(preparePackedNovelConnectedAccountBrowserQa({
      candidate,
      handoffManifestPath:
        '/handoff/packed-novel-connected-account-qa.json',
      deps: {
        loadHandoff,
        assertCandidate,
        startAuthorizationServer: vi.fn(async () => ({
          ...authorization,
          callbackUrl: 'http://localhost:1456/auth/callback',
          close: mismatchedAuthorizationClose,
        })),
      },
    })).rejects.toThrow(
      'packed_novel_browser_authorization_callback_mismatch',
    );
    expect(mismatchedAuthorizationClose).toHaveBeenCalledOnce();
  });

  it('budgets candidate materialization before the Playwright beforeAll hook starts', () => {
    expect(resolvePackedCandidateBrowserQaBeforeAllTimeoutMs({
      candidateManifestPath: '/candidate/candidate.json',
      uiBeforeAllTimeoutMs: 120_000,
    })).toBe(900_000);
    expect(resolvePackedCandidateBrowserQaBeforeAllTimeoutMs({
      candidateManifestPath: null,
      uiBeforeAllTimeoutMs: 120_000,
    })).toBe(120_000);
  });

  it('requires an explicit candidate manifest path instead of falling back to checkout source', () => {
    expect(() => requirePackedCandidateManifestPath({})).toThrow(
      'packed_candidate_browser_qa_manifest_required',
    );
    expect(requirePackedCandidateManifestPath({
      HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST: '/candidate/candidate.json',
    })).toBe('/candidate/candidate.json');
  });

  it('uses an explicit reusable packed CLI materialization root without changing the default', () => {
    expect(resolvePackedCandidateBrowserQaMaterializationRoot({
      env: {},
      defaultRoot: '/run/packed-candidate-cli',
    })).toBe('/run/packed-candidate-cli');
    expect(resolvePackedCandidateBrowserQaMaterializationRoot({
      env: {
        HAPPIER_E2E_PACKED_CANDIDATE_CLI_MATERIALIZATION_ROOT:
          '/cache/current-packed-candidate-cli',
      },
      defaultRoot: '/run/packed-candidate-cli',
    })).toBe('/cache/current-packed-candidate-cli');
  });

  it('attests the exact SDK/plugin-ui pair and CLI before materializing the exact CLI', async () => {
    const sdkBytes = Buffer.from('sdk candidate bytes');
    const pluginUiBytes = Buffer.from('plugin-ui candidate bytes');
    const cliBytes = Buffer.from('cli candidate bytes');
    const candidate = candidateManifest({
      sdkIntegrity: sri(sdkBytes),
      pluginUiIntegrity: sri(pluginUiBytes),
      cliIntegrity: sri(cliBytes),
    });
    const materializePackedCli = vi.fn(async () => MATERIALIZED_CLI_ENTRYPOINT);
    const assertPackedPackageIdentity = vi.fn();
    const assertPackedPluginUiSdkDependency = vi.fn();
    const assertPackedCliEntrypoint = vi.fn();
    const assertCandidateManifestArtifacts = vi.fn(async () => {});
    const attestPackedInspectorArtifacts = vi.fn(async () => ({
      contributionId: 'inspector-app-native' as const,
      webArtifactDigest: 'sha256:web',
      iosArtifactDigest: 'sha256:ios',
      androidArtifactDigest: 'sha256:android',
      repackContainerName: 'happier_inspector_inspector_app_native' as const,
      repackModulePath: './renderSurface' as const,
      repackExportName: 'renderSurface' as const,
      platforms: {
        web: {
          artifactDigest: 'sha256:web',
          builtWith: { bundler: 'vite' as const, version: '7.3.1' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        ios: {
          artifactDigest: 'sha256:ios',
          builtWith: { bundler: 'repack' as const, version: '5.2.5' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        android: {
          artifactDigest: 'sha256:android',
          builtWith: { bundler: 'repack' as const, version: '5.2.5' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
      },
    }));
    const verifiedCandidateRoot = '/materialized/verified-candidate-test';
    let removeAttempts = 0;
    const removeVerifiedCandidateRoot = vi.fn(async () => {
      removeAttempts += 1;
      if (removeAttempts === 1) throw new Error('transient browser cleanup failure');
    });

    const prepared = await preparePackedCandidateBrowserQa({
      candidateManifestPath: '/candidate/candidate.json',
      materializationRoot: '/materialized',
      deps: {
        parseCandidateManifest: (raw: string) => JSON.parse(raw) as PackedAuthorCandidate,
        assertCandidateManifestArtifacts,
        readFile: vi.fn(async (path: string) => {
          if (path === '/candidate/candidate.json') return Buffer.from(JSON.stringify(candidate));
          if (path === '/candidate/sdk.tgz') return sdkBytes;
          if (path === '/candidate/plugin-ui.tgz') return pluginUiBytes;
          if (path === '/candidate/cli.tgz') return cliBytes;
          throw new Error(`unexpected path: ${path}`);
        }),
        mkdir: vi.fn(async () => undefined),
        mkdtemp: vi.fn(async () => verifiedCandidateRoot),
        writeFile: vi.fn(async () => undefined),
        rm: removeVerifiedCandidateRoot,
        readPackedPackageManifest: vi.fn(async (path: string) => (
          path === join(verifiedCandidateRoot, 'sdk.tgz')
            ? { name: candidate.sdk.packageName, version: candidate.sdk.version }
            : path === join(verifiedCandidateRoot, 'plugin-ui.tgz')
              ? {
                  name: candidate.pluginUi.packageName,
                  version: candidate.pluginUi.version,
                  dependencies: {
                    '@happier-dev/plugin-sdk': candidate.sdk.version,
                  },
                }
            : {
                name: candidate.cli.packageName,
                version: candidate.cli.version,
                bin: { happier: './bin/happier.mjs' },
              }
        )),
        assertPackedPackageIdentity,
        assertPackedPluginUiSdkDependency,
        assertPackedCliEntrypoint,
        materializePackedCli,
        attestPackedInspectorArtifacts,
      },
    });

    expect(assertPackedPackageIdentity).toHaveBeenCalledTimes(3);
    expect(assertPackedPluginUiSdkDependency).toHaveBeenCalledWith(
      expect.objectContaining({ name: '@happier-dev/plugin-ui' }),
      expect.objectContaining({ packageName: '@happier-dev/plugin-sdk' }),
    );
    expect(assertCandidateManifestArtifacts).toHaveBeenCalledWith(candidate, {
      manifestPath: '/candidate/candidate.json',
    });
    expect(assertPackedCliEntrypoint).toHaveBeenCalledWith(
      expect.objectContaining({ name: '@happier-dev/cli' }),
      expect.objectContaining({
        tarballPath: join(verifiedCandidateRoot, 'cli.tgz'),
      }),
    );
    expect(materializePackedCli).toHaveBeenCalledWith({
      cliArtifact: expect.objectContaining({
        tarballPath: join(verifiedCandidateRoot, 'cli.tgz'),
      }),
      installRoot: '/materialized',
    });
    expect(prepared.cliLaunchSpec).toEqual({
      command: process.execPath,
      args: [MATERIALIZED_CLI_ENTRYPOINT],
      cwd: '/materialized',
    });
    expect(prepared.attestation).toEqual({
      artifactBasis: 'candidate_manifest',
      artifactRunId: 'candidate-browser-qa',
      runId: 'candidate-browser-qa',
      sdkPackageName: '@happier-dev/plugin-sdk',
      sdkVersion: '0.3.1',
      sdkIntegrity: candidate.sdk.integrity,
      pluginUiPackageName: '@happier-dev/plugin-ui',
      pluginUiVersion: '0.3.1',
      pluginUiSdkVersion: '0.3.1',
      pluginUiIntegrity: candidate.pluginUi.integrity,
      cliPackageName: '@happier-dev/cli',
      cliVersion: '0.9.4',
      cliIntegrity: candidate.cli.integrity,
      cliEntrypoint: MATERIALIZED_CLI_ENTRYPOINT,
      inspectorContributionId: 'inspector-app-native',
      inspectorWebArtifactDigest: 'sha256:web',
      inspectorIosArtifactDigest: 'sha256:ios',
      inspectorAndroidArtifactDigest: 'sha256:android',
      inspectorRepackContainerName: 'happier_inspector_inspector_app_native',
      inspectorRepackModulePath: './renderSurface',
      inspectorRepackExportName: 'renderSurface',
      inspectorPlatforms: {
        web: {
          artifactDigest: 'sha256:web',
          builtWith: { bundler: 'vite', version: '7.3.1' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        ios: {
          artifactDigest: 'sha256:ios',
          builtWith: { bundler: 'repack', version: '5.2.5' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        android: {
          artifactDigest: 'sha256:android',
          builtWith: { bundler: 'repack', version: '5.2.5' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
      },
    });
    expect(attestPackedInspectorArtifacts).toHaveBeenCalledWith({
      cliEntrypoint: MATERIALIZED_CLI_ENTRYPOINT,
    });
    const firstCleanup = prepared.cleanup();
    const firstCleanupRejection = expect(firstCleanup).rejects.toThrow(
      /transient browser cleanup failure/,
    );
    const concurrentCleanup = prepared.cleanup();
    expect(firstCleanup).toBe(concurrentCleanup);
    await firstCleanupRejection;
    const successfulCleanup = prepared.cleanup();
    await successfulCleanup;
    expect(prepared.cleanup()).toBe(successfulCleanup);
    expect(removeVerifiedCandidateRoot).toHaveBeenNthCalledWith(
      2,
      verifiedCandidateRoot,
      { recursive: true, force: true },
    );
  });

  it('prepares a row-local SDK, Plugin UI, and CLI trio without a candidate manifest', async () => {
    const sdkBytes = Buffer.from('row-local sdk bytes');
    const pluginUiBytes = Buffer.from('row-local plugin-ui bytes');
    const cliBytes = Buffer.from('row-local cli bytes');
    const directCandidate = {
      runId: 'row-local-admission-only',
      sdk: {
        packageName: '@happier-dev/plugin-sdk' as const,
        version: '0.3.1',
        integrity: sri(sdkBytes),
        tarballPath: '/row-local/sdk.tgz',
      },
      pluginUi: {
        packageName: '@happier-dev/plugin-ui' as const,
        version: '0.3.1',
        pluginSdkVersion: '0.3.1',
        integrity: sri(pluginUiBytes),
        tarballPath: '/row-local/plugin-ui.tgz',
      },
      cli: {
        packageName: '@happier-dev/cli' as const,
        version: '0.9.4',
        integrity: sri(cliBytes),
        tarballPath: '/row-local/cli.tgz',
        entrypoint: 'package/bin/happier.mjs',
      },
    };
    const loadNaturalArtifacts = vi.fn(async () => directCandidate);
    const privateRoot = '/row-local-materialized/verified-candidate';
    const prepared = await preparePackedUcxWebQa({
      artifactBasis: 'row_local_natural',
      sdkTarballPath: '/row-local/sdk.tgz',
      pluginUiTarballPath: '/row-local/plugin-ui.tgz',
      cliTarballPath: '/row-local/cli.tgz',
      materializationRoot: '/row-local-materialized',
      deps: {
        loadNaturalArtifacts,
        readFile: vi.fn(async (path: string) => {
          if (path === '/row-local/sdk.tgz') return sdkBytes;
          if (path === '/row-local/plugin-ui.tgz') return pluginUiBytes;
          if (path === '/row-local/cli.tgz') return cliBytes;
          throw new Error(`unexpected row-local path: ${path}`);
        }),
        mkdir: vi.fn(async () => undefined),
        mkdtemp: vi.fn(async () => privateRoot),
        rm: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => undefined),
        readPackedPackageManifest: vi.fn(async (path: string) => (
          path === join(privateRoot, 'sdk.tgz')
            ? { name: directCandidate.sdk.packageName, version: directCandidate.sdk.version }
            : path === join(privateRoot, 'plugin-ui.tgz')
              ? {
                  name: directCandidate.pluginUi.packageName,
                  version: directCandidate.pluginUi.version,
                  dependencies: {
                    '@happier-dev/plugin-sdk': directCandidate.sdk.version,
                  },
                }
              : {
                  name: directCandidate.cli.packageName,
                  version: directCandidate.cli.version,
                  bin: { happier: './bin/happier.mjs' },
                }
        )),
        assertPackedPackageIdentity: vi.fn(),
        assertPackedPluginUiSdkDependency: vi.fn(),
        assertPackedCliEntrypoint: vi.fn(),
        materializePackedCli: vi.fn(async () => MATERIALIZED_CLI_ENTRYPOINT),
      },
    });

    expect(loadNaturalArtifacts).toHaveBeenCalledWith({
      sdkTarballPath: '/row-local/sdk.tgz',
      pluginUiTarballPath: '/row-local/plugin-ui.tgz',
      cliTarballPath: '/row-local/cli.tgz',
    });
    expect(prepared.attestation).toMatchObject({
      artifactBasis: 'row_local_natural',
      artifactRunId: null,
      sdkIntegrity: directCandidate.sdk.integrity,
      pluginUiIntegrity: directCandidate.pluginUi.integrity,
      cliIntegrity: directCandidate.cli.integrity,
    });
    expect(prepared.candidate.sdk.tarballPath).toBe(join(privateRoot, 'sdk.tgz'));
    expect(prepared.candidate.pluginUi.tarballPath).toBe(join(privateRoot, 'plugin-ui.tgz'));
    expect(prepared.candidate.cli.tarballPath).toBe(join(privateRoot, 'cli.tgz'));
    await prepared.cleanup();
  });

  it('uses consumer-private verified copies after the candidate paths mutate', async () => {
    const sdkBytes = Buffer.from('verified sdk bytes');
    const pluginUiBytes = Buffer.from('verified plugin-ui bytes');
    const cliBytes = Buffer.from('verified cli bytes');
    const candidate = candidateManifest({
      sdkIntegrity: sri(sdkBytes),
      pluginUiIntegrity: sri(pluginUiBytes),
      cliIntegrity: sri(cliBytes),
    });
    let mutableSdkBytes = sdkBytes;
    let mutablePluginUiBytes = pluginUiBytes;
    let mutableCliBytes = cliBytes;
    const privateFiles = new Map<string, Uint8Array>();
    const privateRoot = '/materialized/verified-candidate-private';
    const readPackedPackageManifest = vi.fn(async (path: string) => {
      if (
        path === candidate.sdk.tarballPath
        || path === candidate.pluginUi.tarballPath
        || path === candidate.cli.tarballPath
      ) {
        throw new Error('mutable candidate path reopened after verification');
      }
      const bytes = privateFiles.get(path);
      if (!bytes) throw new Error(`missing private candidate copy: ${path}`);
      return path.endsWith('sdk.tgz')
        ? { name: candidate.sdk.packageName, version: candidate.sdk.version }
        : path.endsWith('plugin-ui.tgz')
          ? {
              name: candidate.pluginUi.packageName,
              version: candidate.pluginUi.version,
              dependencies: {
                '@happier-dev/plugin-sdk': candidate.sdk.version,
              },
            }
        : {
            name: candidate.cli.packageName,
            version: candidate.cli.version,
            bin: { happier: './bin/happier.mjs' },
          };
    });
    const materializePackedCli = vi.fn(async (input: Readonly<{
      cliArtifact: PackedAuthorCandidate['cli'];
      installRoot: string;
    }>) => {
      expect(input.cliArtifact.tarballPath).toBe(join(privateRoot, 'cli.tgz'));
      expect(privateFiles.get(input.cliArtifact.tarballPath)).toEqual(cliBytes);
      return MATERIALIZED_CLI_ENTRYPOINT;
    });

    const prepared = await preparePackedCandidateBrowserQa({
      candidateManifestPath: '/candidate/candidate.json',
      materializationRoot: '/materialized',
      deps: {
        parseCandidateManifest: (raw: string) => JSON.parse(raw) as PackedAuthorCandidate,
        assertCandidateManifestArtifacts: vi.fn(async () => {}),
        readFile: vi.fn(async (path: string) => {
          if (path === '/candidate/candidate.json') return Buffer.from(JSON.stringify(candidate));
          if (path === candidate.sdk.tarballPath) return mutableSdkBytes;
          if (path === candidate.pluginUi.tarballPath) return mutablePluginUiBytes;
          if (path === candidate.cli.tarballPath) return mutableCliBytes;
          throw new Error(`unexpected path: ${path}`);
        }),
        mkdir: vi.fn(async () => undefined),
        mkdtemp: vi.fn(async () => privateRoot),
        writeFile: vi.fn(async (path: string, bytes: Uint8Array, options: { flag: string }) => {
          expect(options.flag).toBe('wx');
          privateFiles.set(path, Buffer.from(bytes));
          mutableSdkBytes = Buffer.from('mutated sdk bytes');
          mutablePluginUiBytes = Buffer.from('mutated plugin-ui bytes');
          mutableCliBytes = Buffer.from('mutated cli bytes');
        }),
        readPackedPackageManifest,
        assertPackedPackageIdentity: vi.fn(),
        assertPackedPluginUiSdkDependency: vi.fn(),
        assertPackedCliEntrypoint: vi.fn(),
        materializePackedCli,
        attestPackedInspectorArtifacts: vi.fn(async () => ({
          contributionId: 'inspector-app-native' as const,
          webArtifactDigest: 'sha256:web',
          iosArtifactDigest: 'sha256:ios',
          androidArtifactDigest: 'sha256:android',
          repackContainerName: 'happier_inspector_inspector_app_native' as const,
          repackModulePath: './renderSurface' as const,
          repackExportName: 'renderSurface' as const,
          platforms: {
            web: {
              artifactDigest: 'sha256:web',
              builtWith: { bundler: 'vite' as const, version: '7.3.1' },
              hostUiApiVersion: '1.0.0',
              compat: { react: '19.2.0', reactNative: '0.83.4' },
            },
            ios: {
              artifactDigest: 'sha256:ios',
              builtWith: { bundler: 'repack' as const, version: '5.2.5' },
              hostUiApiVersion: '1.0.0',
              compat: { react: '19.2.0', reactNative: '0.83.4' },
            },
            android: {
              artifactDigest: 'sha256:android',
              builtWith: { bundler: 'repack' as const, version: '5.2.5' },
              hostUiApiVersion: '1.0.0',
              compat: { react: '19.2.0', reactNative: '0.83.4' },
            },
          },
        })),
      },
    });

    expect(readPackedPackageManifest).toHaveBeenCalledWith(
      join(privateRoot, 'sdk.tgz'),
      '/materialized/verify-sdk',
    );
    expect(readPackedPackageManifest).toHaveBeenCalledWith(
      join(privateRoot, 'plugin-ui.tgz'),
      '/materialized/verify-plugin-ui',
    );
    expect(readPackedPackageManifest).toHaveBeenCalledWith(
      join(privateRoot, 'cli.tgz'),
      '/materialized/verify-cli',
    );
    expect(prepared.candidate.sdk.tarballPath).toBe(join(privateRoot, 'sdk.tgz'));
    expect(prepared.candidate.pluginUi.tarballPath).toBe(join(privateRoot, 'plugin-ui.tgz'));
    expect(prepared.candidate.cli.tarballPath).toBe(join(privateRoot, 'cli.tgz'));
  });

  it('removes the real browser capture when setup fails after copying verified bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'candidate-browser-capture-failure-'));
    try {
      const sdkBytes = Buffer.from('browser-failure-sdk');
      const pluginUiBytes = Buffer.from('browser-failure-plugin-ui');
      const cliBytes = Buffer.from('browser-failure-cli');
      const sdkPath = join(root, 'sdk.tgz');
      const pluginUiPath = join(root, 'plugin-ui.tgz');
      const cliPath = join(root, 'cli.tgz');
      const manifestPath = join(root, 'candidate.json');
      const materializationRoot = join(root, 'materialized');
      const candidate = candidateManifest({
        sdkIntegrity: sri(sdkBytes),
        pluginUiIntegrity: sri(pluginUiBytes),
        cliIntegrity: sri(cliBytes),
      });
      const filesystemCandidate: PackedAuthorCandidate = {
        ...candidate,
        sdk: { ...candidate.sdk, tarballPath: sdkPath },
        pluginUi: { ...candidate.pluginUi, tarballPath: pluginUiPath },
        cli: { ...candidate.cli, tarballPath: cliPath },
      };
      await Promise.all([
        writeFile(sdkPath, sdkBytes),
        writeFile(pluginUiPath, pluginUiBytes),
        writeFile(cliPath, cliBytes),
        writeFile(manifestPath, JSON.stringify(filesystemCandidate)),
      ]);

      let transientCleanupAttempts = 0;
      await expect(preparePackedCandidateBrowserQa({
        candidateManifestPath: manifestPath,
        materializationRoot,
        deps: {
          readFile,
          parseCandidateManifest: (raw: string) => JSON.parse(raw) as PackedAuthorCandidate,
          assertCandidateManifestArtifacts: vi.fn(async () => undefined),
          readPackedPackageManifest: vi.fn(async () => {
            throw new Error('browser package inspection failed');
          }),
          assertPackedPackageIdentity: vi.fn(),
          assertPackedPluginUiSdkDependency: vi.fn(),
          assertPackedCliEntrypoint: vi.fn(),
          materializePackedCli: vi.fn(),
          attestPackedInspectorArtifacts: vi.fn(),
          rm: async (path, options) => {
            transientCleanupAttempts += 1;
            if (transientCleanupAttempts === 1) {
              throw new Error('transient browser preparation cleanup failure');
            }
            await rm(path, options);
          },
        },
      })).rejects.toThrow(/browser package inspection failed/);
      expect(transientCleanupAttempts).toBe(2);
      expect(
        (await readdir(materializationRoot))
          .filter((name) => name.startsWith('verified-candidate-')),
      ).toEqual([]);

      const permanentlyFailedRoot = join(root, 'permanently-failed-materialized');
      let permanentCleanupAttempts = 0;
      await expect(preparePackedCandidateBrowserQa({
        candidateManifestPath: manifestPath,
        materializationRoot: permanentlyFailedRoot,
        deps: {
          readFile,
          parseCandidateManifest: (raw: string) => JSON.parse(raw) as PackedAuthorCandidate,
          assertCandidateManifestArtifacts: vi.fn(async () => undefined),
          readPackedPackageManifest: vi.fn(async () => {
            throw new Error('permanent browser package inspection failure');
          }),
          assertPackedPackageIdentity: vi.fn(),
          assertPackedPluginUiSdkDependency: vi.fn(),
          assertPackedCliEntrypoint: vi.fn(),
          materializePackedCli: vi.fn(),
          attestPackedInspectorArtifacts: vi.fn(),
          rm: async () => {
            permanentCleanupAttempts += 1;
            throw new Error(`permanent browser cleanup failure ${permanentCleanupAttempts}`);
          },
        },
      })).rejects.toSatisfy((error: unknown) => (
        error instanceof AggregateError
        && error.errors.map((entry) => entry.message).join('|')
          === [
            'permanent browser package inspection failure',
            'permanent browser cleanup failure 1',
            'permanent browser cleanup failure 2',
          ].join('|')
      ));
      expect(permanentCleanupAttempts).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects tampered candidate bytes before package inspection or CLI materialization', async () => {
    const sdkBytes = Buffer.from('sdk candidate bytes');
    const pluginUiBytes = Buffer.from('plugin-ui candidate bytes');
    const cliBytes = Buffer.from('tampered cli candidate bytes');
    const candidate = candidateManifest({
      sdkIntegrity: sri(sdkBytes),
      pluginUiIntegrity: sri(pluginUiBytes),
      cliIntegrity: sri(Buffer.from('original cli candidate bytes')),
    });
    const readPackedPackageManifest = vi.fn();
    const materializePackedCli = vi.fn();

    await expect(preparePackedCandidateBrowserQa({
      candidateManifestPath: '/candidate/candidate.json',
      materializationRoot: '/materialized',
      deps: {
        parseCandidateManifest: (raw: string) => JSON.parse(raw) as PackedAuthorCandidate,
        assertCandidateManifestArtifacts: vi.fn(async () => {}),
        readFile: vi.fn(async (path: string) => {
          if (path === '/candidate/candidate.json') return Buffer.from(JSON.stringify(candidate));
          if (path === '/candidate/sdk.tgz') return sdkBytes;
          if (path === '/candidate/plugin-ui.tgz') return pluginUiBytes;
          if (path === '/candidate/cli.tgz') return cliBytes;
          throw new Error(`unexpected path: ${path}`);
        }),
        readPackedPackageManifest,
        assertPackedPackageIdentity: vi.fn(),
        assertPackedPluginUiSdkDependency: vi.fn(),
        assertPackedCliEntrypoint: vi.fn(),
        materializePackedCli,
        attestPackedInspectorArtifacts: vi.fn(),
      },
    })).rejects.toThrow('packed_candidate_cli_integrity_mismatch');

    expect(readPackedPackageManifest).not.toHaveBeenCalled();
    expect(materializePackedCli).not.toHaveBeenCalled();
  });

  it('attests every generated Inspector artifact file and exact native Re.Pack identity', async () => {
    const files = new Map<string, Buffer>([
      ['react-native-web/inspector-app-native/entry.mjs.bundle', Buffer.from('web')],
      ['react-native/inspector-app-native/ios/ios.bundle', Buffer.from('ios')],
      ['react-native/inspector-app-native/android/android.bundle', Buffer.from('android')],
    ]);
    const digest = (bytes: Uint8Array) =>
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const graphDigest = (relativePath: string, bytes: Uint8Array) =>
      computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes }]);
    const rawGraph = JSON.stringify({
      version: 1,
      entries: [
        {
          contributionId: 'inspector-app-native',
          tier: 'reactNative',
          platform: 'web',
          digest: graphDigest(
            'react-native-web/inspector-app-native/entry.mjs.bundle',
            files.get('react-native-web/inspector-app-native/entry.mjs.bundle')!,
          ),
          entry: 'react-native-web/inspector-app-native/entry.mjs.bundle',
          files: [{
            relativePath: 'react-native-web/inspector-app-native/entry.mjs.bundle',
            digest: digest(files.get('react-native-web/inspector-app-native/entry.mjs.bundle')!),
            byteSize: 3,
          }],
          builtWith: { bundler: 'vite', version: '7.3.1' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        ...(['ios', 'android'] as const).map((platform) => {
          const relativePath = `react-native/inspector-app-native/${platform}/${platform}.bundle`;
          const bytes = files.get(relativePath)!;
          return {
            contributionId: 'inspector-app-native',
            tier: 'reactNative',
            platform,
            digest: graphDigest(relativePath, bytes),
            entry: relativePath,
            files: [{ relativePath, digest: digest(bytes), byteSize: bytes.byteLength }],
            builtWith: { bundler: 'repack', version: '5.2.5' },
            repack: {
              containerName: 'happier_inspector_inspector_app_native',
              modulePath: './renderSurface',
              exportName: 'renderSurface',
            },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.2.0', reactNative: '0.83.4' },
          };
        }),
      ],
    });
    const inspectorArtifactRoot = join(
      resolve(dirname(MATERIALIZED_CLI_ENTRYPOINT), '..'),
      'node_modules',
      '@happier-dev',
      'plugins-inspector',
      'dist',
      'happier-plugin-ui',
    );
    const readInspectorArtifactFile = vi.fn(async (path: string) => {
      if (path === `${inspectorArtifactRoot}/ui-artifacts.json`) {
        return Buffer.from(rawGraph);
      }
      const relativePath = [...files.keys()].find(
        (candidate) => path === `${inspectorArtifactRoot}/${candidate}`,
      );
      if (!relativePath) throw new Error(`unexpected path: ${path}`);
      return files.get(relativePath)!;
    });

    await expect(attestPackedInspectorArtifacts({
      cliEntrypoint: MATERIALIZED_CLI_ENTRYPOINT,
    }, {
      readFile: readInspectorArtifactFile,
    })).resolves.toEqual({
      contributionId: 'inspector-app-native',
      webArtifactDigest: graphDigest(
        'react-native-web/inspector-app-native/entry.mjs.bundle',
        Buffer.from('web'),
      ),
      iosArtifactDigest: graphDigest(
        'react-native/inspector-app-native/ios/ios.bundle',
        Buffer.from('ios'),
      ),
      androidArtifactDigest: graphDigest(
        'react-native/inspector-app-native/android/android.bundle',
        Buffer.from('android'),
      ),
      repackContainerName: 'happier_inspector_inspector_app_native',
      repackModulePath: './renderSurface',
      repackExportName: 'renderSurface',
      platforms: {
        web: {
          artifactDigest: graphDigest(
            'react-native-web/inspector-app-native/entry.mjs.bundle',
            Buffer.from('web'),
          ),
          builtWith: { bundler: 'vite', version: '7.3.1' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        ios: {
          artifactDigest: graphDigest(
            'react-native/inspector-app-native/ios/ios.bundle',
            Buffer.from('ios'),
          ),
          builtWith: { bundler: 'repack', version: '5.2.5' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        android: {
          artifactDigest: graphDigest(
            'react-native/inspector-app-native/android/android.bundle',
            Buffer.from('android'),
          ),
          builtWith: { bundler: 'repack', version: '5.2.5' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
      },
    });
    expect(readInspectorArtifactFile).toHaveBeenCalledWith(
      `${inspectorArtifactRoot}/ui-artifacts.json`,
    );
  });

  it('fails closed when an Inspector graph digest does not match its candidate artifact bytes', async () => {
    const rawGraph = JSON.stringify({
      version: 1,
      entries: (['web', 'ios', 'android'] as const).map((platform) => {
        const relativePath = platform === 'web'
          ? 'react-native-web/inspector-app-native/entry.mjs.bundle'
          : `react-native/inspector-app-native/${platform}/${platform}.bundle`;
        return {
          contributionId: 'inspector-app-native',
          tier: 'reactNative',
          platform,
          digest: `sha256:${'a'.repeat(64)}`,
          entry: relativePath,
          files: [{
            relativePath,
            digest: `sha256:${'a'.repeat(64)}`,
            byteSize: 3,
          }],
          builtWith: {
            bundler: platform === 'web' ? 'vite' : 'repack',
            version: platform === 'web' ? '7.3.1' : '5.2.5',
          },
          ...(platform === 'web' ? {} : {
            repack: {
              containerName: 'happier_inspector_inspector_app_native',
              modulePath: './renderSurface',
              exportName: 'renderSurface',
            },
          }),
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        };
      }),
    });

    await expect(attestPackedInspectorArtifacts({
      cliEntrypoint: MATERIALIZED_CLI_ENTRYPOINT,
    }, {
      readFile: vi.fn(async (path: string) => (
        path.endsWith('/ui-artifacts.json') ? Buffer.from(rawGraph) : Buffer.from('web')
      )),
    })).rejects.toThrow('packed_candidate_inspector_file_digest_mismatch');
  });

  it('rejects a graph digest that does not bind the otherwise valid complete file set', async () => {
    const bytes = Buffer.from('web');
    const fileDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const rawGraph = JSON.stringify({
      version: 1,
      entries: (['web', 'ios', 'android'] as const).map((platform) => {
        const relativePath = platform === 'web'
          ? 'react-native-web/inspector-app-native/entry.mjs.bundle'
          : `react-native/inspector-app-native/${platform}/${platform}.bundle`;
        return {
          contributionId: 'inspector-app-native',
          tier: 'reactNative',
          platform,
          digest: `sha256:${'a'.repeat(64)}`,
          entry: relativePath,
          files: [{ relativePath, digest: fileDigest, byteSize: bytes.byteLength }],
          builtWith: {
            bundler: platform === 'web' ? 'vite' : 'repack',
            version: platform === 'web' ? '7.3.1' : '5.2.5',
          },
          ...(platform === 'web' ? {} : {
            repack: {
              containerName: 'happier_inspector_inspector_app_native',
              modulePath: './renderSurface',
              exportName: 'renderSurface',
            },
          }),
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        };
      }),
    });

    await expect(attestPackedInspectorArtifacts({
      cliEntrypoint: MATERIALIZED_CLI_ENTRYPOINT,
    }, {
      readFile: vi.fn(async (path: string) => (
        path.endsWith('/ui-artifacts.json') ? Buffer.from(rawGraph) : bytes
      )),
    })).rejects.toThrow('packed_candidate_inspector_graph_digest_mismatch:web');
  });

  it('binds the daemon runtime projection to the exact CLI and packed Inspector web graph', () => {
    const inspectorWebArtifactDigest = `sha256:${'b'.repeat(64)}`;
    expect(attestCandidateInspectorRuntime({
      expectedCliVersion: '0.9.4',
      expectedInspectorWebArtifactDigest: inspectorWebArtifactDigest,
      daemonState: { startedWithCliVersion: '0.9.4' },
      projectionResponse: {
        projection: {
          generation: 41,
          familiesById: {
            pluginUi: {
              entriesById: {
                'reactNativeBundle:happier.inspector:inspector-renderer': {
                  pluginId: 'happier.inspector',
                  contributionId: 'inspector-renderer',
                  artifactGraph: {
                    contributionId: 'inspector-app-native',
                    platform: 'web',
                    digest: inspectorWebArtifactDigest,
                  },
                  runtime: {
                    state: 'loadable',
                    decision: { state: 'load', reason: 'compatible' },
                    cacheIdentity: {
                      artifactDigest: inspectorWebArtifactDigest,
                      projectionGeneration: 41,
                    },
                    loadPolicy: { source: 'installedArtifact' },
                  },
                },
                'surfacePlacement:happier.inspector:inspector-app': {
                  pluginId: 'happier.inspector',
                  contributionId: 'inspector-app',
                  container: 'rightSidebarTab',
                  target: { kind: 'app' },
                  renderer: {
                    kind: 'reactNative',
                    contributionId: 'inspector-renderer',
                  },
                  availability: { state: 'available', reason: 'available' },
                },
              },
            },
          },
        },
      },
    })).toEqual({
      cliVersion: '0.9.4',
      projectionGeneration: 41,
      inspectorWebArtifactDigest,
      inspectorRuntimeState: 'loadable',
      inspectorRuntimeDecision: 'load',
      inspectorSurfaceAvailable: true,
    });
  });

  it('rejects a stale daemon projection whose Inspector digest is not the packed candidate digest', () => {
    expect(() => attestCandidateInspectorRuntime({
      expectedCliVersion: '0.9.4',
      expectedInspectorWebArtifactDigest: `sha256:${'b'.repeat(64)}`,
      daemonState: { startedWithCliVersion: '0.9.4' },
      projectionResponse: {
        projection: {
          generation: 1,
          familiesById: {
            pluginUi: {
              entriesById: {
                'reactNativeBundle:happier.inspector:inspector-renderer': {
                  artifactGraph: {
                    contributionId: 'inspector-app-native',
                    platform: 'web',
                    digest: `sha256:${'c'.repeat(64)}`,
                  },
                  runtime: {
                    state: 'loadable',
                    decision: { state: 'load' },
                    cacheIdentity: {
                      artifactDigest: `sha256:${'c'.repeat(64)}`,
                      projectionGeneration: 1,
                    },
                    loadPolicy: { source: 'installedArtifact' },
                  },
                },
                'surfacePlacement:happier.inspector:inspector-app': {
                  container: 'rightSidebarTab',
                  target: { kind: 'app' },
                  renderer: { kind: 'reactNative', contributionId: 'inspector-renderer' },
                  availability: { state: 'available' },
                },
              },
            },
          },
        },
      },
    })).toThrow('packed_candidate_inspector_runtime_digest_mismatch');
  });
});
