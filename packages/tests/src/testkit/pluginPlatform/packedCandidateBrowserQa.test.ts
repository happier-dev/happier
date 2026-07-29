import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { computePluginUiArtifactFileSetSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';

import type { PackedAuthorCandidate } from '../../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import {
  attestCandidateInspectorRuntime,
  attestPackedInspectorArtifacts,
  preparePackedCandidateBrowserQa,
  preparePackedNovelConnectedAccountBrowserQa,
  requirePackedCandidateManifestPath,
  resolvePackedCandidateBrowserQaBeforeAllTimeoutMs,
  resolvePackedCandidateBrowserQaMaterializationRoot,
} from './packedCandidateBrowserQa';

const MATERIALIZED_CLI_ENTRYPOINT = resolve(
  '/materialized/node_modules/@happier-dev/cli/bin/happier.mjs',
);

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function candidateManifest(params: Readonly<{
  sdkIntegrity: string;
  cliIntegrity: string;
}>): PackedAuthorCandidate {
  return {
    schemaVersion: 1,
    runId: 'candidate-browser-qa',
    sourceBasis: {
      algorithm: 'sha256',
      digest: 'a'.repeat(64),
    },
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
    cli: {
      packageName: '@happier-dev/cli',
      version: '0.9.4',
      integrity: params.cliIntegrity,
      tarballPath: '/candidate/cli.tgz',
      entrypoint: 'package/bin/happier.mjs',
    },
  };
}

describe('packed candidate browser QA preparation', () => {
  it('admits only the canonical packed novel handoff and selects its browser-isolated roots', async () => {
    const candidate = candidateManifest({
      sdkIntegrity: sri(Buffer.from('sdk')),
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

  it('attests both tarball SRIs and package identities before materializing the exact CLI', async () => {
    const sdkBytes = Buffer.from('sdk candidate bytes');
    const cliBytes = Buffer.from('cli candidate bytes');
    const candidate = candidateManifest({
      sdkIntegrity: sri(sdkBytes),
      cliIntegrity: sri(cliBytes),
    });
    const materializePackedCli = vi.fn(async () => MATERIALIZED_CLI_ENTRYPOINT);
    const assertPackedPackageIdentity = vi.fn();
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

    const prepared = await preparePackedCandidateBrowserQa({
      candidateManifestPath: '/candidate/candidate.json',
      materializationRoot: '/materialized',
      deps: {
        parseCandidateManifest: (raw: string) => JSON.parse(raw) as PackedAuthorCandidate,
        assertCandidateManifestArtifacts,
        readFile: vi.fn(async (path: string) => {
          if (path === '/candidate/candidate.json') return Buffer.from(JSON.stringify(candidate));
          if (path === '/candidate/sdk.tgz') return sdkBytes;
          if (path === '/candidate/cli.tgz') return cliBytes;
          throw new Error(`unexpected path: ${path}`);
        }),
        readPackedPackageManifest: vi.fn(async (path: string) => (
          path === candidate.sdk.tarballPath
            ? { name: candidate.sdk.packageName, version: candidate.sdk.version }
            : {
                name: candidate.cli.packageName,
                version: candidate.cli.version,
                bin: { happier: './bin/happier.mjs' },
              }
        )),
        assertPackedPackageIdentity,
        assertPackedCliEntrypoint,
        materializePackedCli,
        attestPackedInspectorArtifacts,
      },
    });

    expect(assertPackedPackageIdentity).toHaveBeenCalledTimes(2);
    expect(assertCandidateManifestArtifacts).toHaveBeenCalledWith(candidate, {
      manifestPath: '/candidate/candidate.json',
    });
    expect(assertPackedCliEntrypoint).toHaveBeenCalledWith(
      expect.objectContaining({ name: '@happier-dev/cli' }),
      candidate.cli,
    );
    expect(materializePackedCli).toHaveBeenCalledWith({
      cliArtifact: candidate.cli,
      installRoot: '/materialized',
    });
    expect(prepared.cliLaunchSpec).toEqual({
      command: process.execPath,
      args: [MATERIALIZED_CLI_ENTRYPOINT],
      cwd: '/materialized',
    });
    expect(prepared.attestation).toEqual({
      runId: 'candidate-browser-qa',
      sdkPackageName: '@happier-dev/plugin-sdk',
      sdkVersion: '0.3.1',
      sdkIntegrity: candidate.sdk.integrity,
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
  });

  it('rejects tampered candidate bytes before package inspection or CLI materialization', async () => {
    const sdkBytes = Buffer.from('sdk candidate bytes');
    const cliBytes = Buffer.from('tampered cli candidate bytes');
    const candidate = candidateManifest({
      sdkIntegrity: sri(sdkBytes),
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
          if (path === '/candidate/cli.tgz') return cliBytes;
          throw new Error(`unexpected path: ${path}`);
        }),
        readPackedPackageManifest,
        assertPackedPackageIdentity: vi.fn(),
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
      ['react-native-web/inspector-app-native/entry.mjs', Buffer.from('web')],
      ['react-native/inspector-app-native/ios/ios.bundle.js', Buffer.from('ios')],
      ['react-native/inspector-app-native/android/android.bundle.js', Buffer.from('android')],
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
            'react-native-web/inspector-app-native/entry.mjs',
            files.get('react-native-web/inspector-app-native/entry.mjs')!,
          ),
          entry: 'react-native-web/inspector-app-native/entry.mjs',
          files: [{
            relativePath: 'react-native-web/inspector-app-native/entry.mjs',
            digest: digest(files.get('react-native-web/inspector-app-native/entry.mjs')!),
            byteSize: 3,
          }],
          builtWith: { bundler: 'vite', version: '7.3.1' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        ...(['ios', 'android'] as const).map((platform) => {
          const relativePath = `react-native/inspector-app-native/${platform}/${platform}.bundle.js`;
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
        'react-native-web/inspector-app-native/entry.mjs',
        Buffer.from('web'),
      ),
      iosArtifactDigest: graphDigest(
        'react-native/inspector-app-native/ios/ios.bundle.js',
        Buffer.from('ios'),
      ),
      androidArtifactDigest: graphDigest(
        'react-native/inspector-app-native/android/android.bundle.js',
        Buffer.from('android'),
      ),
      repackContainerName: 'happier_inspector_inspector_app_native',
      repackModulePath: './renderSurface',
      repackExportName: 'renderSurface',
      platforms: {
        web: {
          artifactDigest: graphDigest(
            'react-native-web/inspector-app-native/entry.mjs',
            Buffer.from('web'),
          ),
          builtWith: { bundler: 'vite', version: '7.3.1' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        ios: {
          artifactDigest: graphDigest(
            'react-native/inspector-app-native/ios/ios.bundle.js',
            Buffer.from('ios'),
          ),
          builtWith: { bundler: 'repack', version: '5.2.5' },
          hostUiApiVersion: '1.0.0',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        android: {
          artifactDigest: graphDigest(
            'react-native/inspector-app-native/android/android.bundle.js',
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
          ? 'react-native-web/inspector-app-native/entry.mjs'
          : `react-native/inspector-app-native/${platform}/${platform}.bundle.js`;
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
          ? 'react-native-web/inspector-app-native/entry.mjs'
          : `react-native/inspector-app-native/${platform}/${platform}.bundle.js`;
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
                  placement: 'app.rightSidebarTab',
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
                  placement: 'app.rightSidebarTab',
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
