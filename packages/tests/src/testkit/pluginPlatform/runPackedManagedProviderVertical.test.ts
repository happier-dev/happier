import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PackedChannelProviderLifecycleEvidence,
  PackedManagedProviderPreparedInput,
  PackedManagedProviderRunInput,
  PackedManagedProviderScenarioDependencies,
} from '../../../scripts/plugin-platform/run-packed-managed-provider.mjs';
import {
  assertPackedAuthorCandidateManifestArtifacts,
  parseCandidateManifest,
} from '../../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';
import {
  main,
  prepareCandidateBoundCliLaunchSpec,
  runPackedChannelProviderEntrypoint,
  runPackedManagedProviderEntrypoint,
  type PackedManagedProviderArtifactOwners,
} from '../../plugin-platform/runPackedManagedProviderVertical';
import * as packedManagedProviderContinuity from '../../plugin-platform/runPackedManagedProviderContinuity';

const roots: string[] = [];

const TEST_MINISIGN_KEY_ID = Buffer.from('0102030405060708', 'hex');
const TEST_MINISIGN_KEY_PAIR = generateKeyPairSync('ed25519');
const TEST_MINISIGN_RAW_PUBLIC_KEY = Buffer.from(
  TEST_MINISIGN_KEY_PAIR.publicKey.export({ format: 'der', type: 'spki' }),
).subarray(-32);
const TEST_MINISIGN_PUBLIC_KEY = [
  'untrusted comment: packed managed candidate fixture minisign public key',
  Buffer.concat([
    Buffer.from('Ed'),
    TEST_MINISIGN_KEY_ID,
    TEST_MINISIGN_RAW_PUBLIC_KEY,
  ]).toString('base64'),
  '',
].join('\n');
const TEST_CANDIDATE_ARTIFACT_VERIFICATION = Object.freeze({
  trustedMinisignPublicKey: TEST_MINISIGN_PUBLIC_KEY,
});

function signTestMinisign(message: Buffer): Buffer {
  const signature = sign(null, message, TEST_MINISIGN_KEY_PAIR.privateKey);
  const trustedSuffix = Buffer.from('timestamp:0', 'utf8');
  const globalSignature = sign(
    null,
    Buffer.concat([signature, trustedSuffix]),
    TEST_MINISIGN_KEY_PAIR.privateKey,
  );
  return Buffer.from([
    'untrusted comment: packed managed candidate fixture signature',
    Buffer.concat([
      Buffer.from('Ed'),
      TEST_MINISIGN_KEY_ID,
      signature,
    ]).toString('base64'),
    `trusted comment: ${trustedSuffix.toString('utf8')}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n'), 'utf8');
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'packed-managed-entrypoint-test-'));
  roots.push(root);
  return root;
}

function sha512Sri(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function managedSequenceEvidence() {
  return {
    freshSession: true,
    agentId: 'opencode',
    canonicalSessionId: 'session-canonical-a',
    publicActivationReason: 'sessionDemand',
    connectionRevision: 3,
    purposes: [
      'happier.agent.opencode/opencode:openai-codex-model-request',
      'happier.provider.cliproxyapi/cliproxyapi:openai-upstream',
    ],
    timeline: {
      freshSpawnStartedAtMs: 1,
      canonicalSessionRegisteredAtMs: 2,
      spawnAcknowledgedAtMs: 4,
      providerAttemptAtMs: 9,
    },
    observedPorts: {
      server: 41001,
      serverProxy: 41002,
      daemon: 41003,
      upstreamProxy: 41005,
    },
    stockPortRequestCount: 0,
    stockPortOsConnectionAttemptCount: 0,
    stockListenerIdentityBefore: `sha256:${'e'.repeat(64)}`,
    stockListenerIdentityAfter: `sha256:${'e'.repeat(64)}`,
    preSessionDemandCredentialReleased: false,
    preSessionDemandUpstreamAttempted: false,
    upstreamAuthorizationFingerprint: `sha256:${'c'.repeat(64)}`,
    managedRequestAuthOrigin: 'https://chatgpt.com',
    upstreamConnectTarget: 'chatgpt.com:443',
    promptSentinelObserved: true,
    upstreamRequestPath: '/backend-api/codex/responses',
    currentCredentialRevision: 'revision-current',
    currentAccessTokenFingerprint: `sha256:${'c'.repeat(64)}`,
  } as const;
}

function packedChannelProviderLifecycleEvidence(): PackedChannelProviderLifecycleEvidence {
  return {
    archive: {
      hostRuntime: 'daemonArchive',
      reviewedInstall: true,
      publicOnlyArtifact: true,
      publicDependencyClosure: true,
    },
    discovery: {
      corePluginId: 'happier.channels',
      providerPluginId: 'acme.channels.out-of-tree-socket',
      actionLocalId: 'fixture/setup',
      targetSurface: 'plugin',
      coldCatalogBeforeProviderActivation: true,
      demandedActivation: true,
      caller: { kind: 'plugin', pluginId: 'happier.channels' },
      strictInputRejectedBeforeHandler: true,
      strictResultRejectedBeforeCore: true,
    },
    resource: {
      localId: 'status-v1',
      readObserved: true,
      watchSubscribed: true,
      invalidationDropped: true,
      rereadConverged: true,
    },
    background: {
      startedAfterAdoption: true,
      normalizedNetworkClientObserved: true,
      socketConnectCountBeforeAdoption: 0,
      observationIngressCustodied: true,
      outboundDeliveryCustodied: true,
      historyGapReported: true,
      confirmedStopReported: true,
    },
    lifecycle: {
      disableAbortedGeneration: true,
      reenableSocketCount: 1,
      daemonRestartSocketCount: 1,
      failedReplacementRetainedLkg: true,
      retiredGenerationReportInert: true,
      uninstalledCleanly: true,
    },
  };
}

function scenarioDependencies(
  overrides: Partial<PackedManagedProviderScenarioDependencies> = {},
): PackedManagedProviderScenarioDependencies {
  return {
    runPackagedWrapperConformance: vi.fn(async () => ({
      publicExplicitStart: true,
      publicCatalogProbe: true,
      catalogOwnerReleased: true,
      publicCredentialLeakObserved: false,
      providerAttemptedBeforeSessionDemand: false,
    })),
    runFreshManagedSequence: vi.fn(async () => managedSequenceEvidence()),
    runActivationFailureCleanupProbe: vi.fn(async () => ({
      activationFailedBeforeAck: true,
      firstInputDispatched: false,
      providerAttempted: false,
      publicSessionCleanupComplete: true,
      sessionProviderExited: true,
    })),
    cleanup: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function writeInputFixture(params: Readonly<{
  version?: string;
}> = {}) {
  const root = await fixtureRoot();
  const version = params.version ?? '0.2.10';
  const sdkBytes = Buffer.from('exact sdk archive');
  const pluginUiBytes = Buffer.from('exact plugin ui archive');
  const channelsProtocolBytes = Buffer.from('exact channels protocol archive');
  const cliBytes = Buffer.from('exact cli archive');
  const sdkPath = join(root, 'sdk.tgz');
  const pluginUiPath = join(root, 'plugin-ui.tgz');
  const channelsProtocolPath = join(root, 'channels-protocol.tgz');
  const cliPath = join(root, 'cli.tgz');
  const nativeTargets = [
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['windows', 'x64'],
  ] as const;
  const nativeArchives = nativeTargets.map(([os, arch]) => {
    const bytes = Buffer.from(`exact standalone cli archive ${os}-${arch}`);
    const archivePath = join(root, `happier-v${version}-${os}-${arch}.tar.gz`);
    return {
      product: 'happier' as const,
      version,
      os,
      arch,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      archivePath,
      bytes,
    };
  });
  const selectedOs = process.platform === 'win32' ? 'windows' : process.platform;
  const selectedArchive = nativeArchives.find(
    (artifact) => artifact.os === selectedOs && artifact.arch === process.arch,
  );
  if (!selectedArchive) throw new Error('test host target is outside the release matrix');
  const standalonePath = selectedArchive.archivePath;
  const standaloneSha256 = selectedArchive.sha256;
  const notarization = [
    ['darwin-x64', Buffer.from('darwin x64 notarization evidence')],
    ['darwin-arm64', Buffer.from('darwin arm64 notarization evidence')],
  ] as const;
  const checksumsPath = join(root, `checksums-happier-v${version}.txt`);
  const checksumsBytes = Buffer.from(
    [
      ...nativeArchives.map((artifact) => (
        `${artifact.sha256}  ${basename(artifact.archivePath)}`
      )),
      ...notarization.map(([target, bytes]) => (
        `${createHash('sha256').update(bytes).digest('hex')}  ${target}.cli.json`
      )),
    ]
      .join('\n')
      .concat('\n'),
  );
  const signaturePath = `${checksumsPath}.minisig`;
  const signatureBytes = signTestMinisign(checksumsBytes);
  const installerDefinitions = [
    ['shell', 'shell', 'install-dev.sh', Buffer.from('shell installer')],
    ['powershell', 'powershell', 'install-dev.ps1', Buffer.from('powershell installer')],
    ['publicKey', 'minisign-public-key', 'happier-release.pub', Buffer.from('public key')],
  ] as const;
  const manifestPath = join(root, 'candidate.json');
  await Promise.all([
    writeFile(sdkPath, sdkBytes),
    writeFile(pluginUiPath, pluginUiBytes),
    writeFile(channelsProtocolPath, channelsProtocolBytes),
    writeFile(cliPath, cliBytes),
    ...nativeArchives.map((artifact) => writeFile(artifact.archivePath, artifact.bytes)),
    writeFile(checksumsPath, checksumsBytes),
    writeFile(signaturePath, signatureBytes),
    ...notarization.map(([target, bytes]) => (
      writeFile(join(root, `${target}.cli.json`), bytes)
    )),
    ...installerDefinitions.map(([, , fileName, bytes]) => (
      writeFile(join(root, fileName), bytes)
    )),
  ]);
  const computedStandaloneSha256 = standaloneSha256;
  const installers = {
    releaseChannel: 'dev' as const,
    ...Object.fromEntries(installerDefinitions.map(([field, kind, fileName, bytes]) => [
      field,
      {
        kind,
        fileName,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        filePath: join(root, fileName),
      },
    ])),
  };
  await writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    runId: 'r445-exact-candidate',
    installers,
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      integrity: sha512Sri(sdkBytes),
      tarballPath: sdkPath,
    },
    pluginUi: {
      packageName: '@happier-dev/plugin-ui',
      version: '0.0.0',
      pluginSdkVersion: '0.0.0',
      integrity: sha512Sri(pluginUiBytes),
      tarballPath: pluginUiPath,
    },
    channelsProtocol: {
      packageName: '@happier-dev/channels-protocol',
      version: '0.0.0',
      integrity: sha512Sri(channelsProtocolBytes),
      tarballPath: channelsProtocolPath,
    },
    cli: {
      packageName: '@happier-dev/cli',
      version,
      integrity: sha512Sri(cliBytes),
      tarballPath: cliPath,
      entrypoint: 'package/bin/happier.mjs',
    },
    standaloneCli: {
      product: 'happier',
      version,
      os: process.platform === 'win32' ? 'windows' : process.platform,
      arch: process.arch,
      sha256: computedStandaloneSha256,
      archivePath: standalonePath,
      archives: nativeArchives.map(({ bytes: _bytes, ...artifact }) => artifact),
      checksums: {
        kind: 'sha256-checksums',
        fileName: basename(checksumsPath),
        sizeBytes: checksumsBytes.length,
        sha256: createHash('sha256').update(checksumsBytes).digest('hex'),
        filePath: checksumsPath,
      },
      signature: {
        kind: 'minisign-signature',
        fileName: basename(signaturePath),
        sizeBytes: signatureBytes.length,
        sha256: createHash('sha256').update(signatureBytes).digest('hex'),
        filePath: signaturePath,
      },
      notarization: notarization.map(([target, bytes]) => ({
        target,
        evidence: {
          kind: 'apple-notarization-evidence',
          fileName: `${target}.cli.json`,
          sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          filePath: join(root, `${target}.cli.json`),
        },
      })),
    },
  }));
  return {
    root,
    manifestPath,
    standalonePath,
    channelsProtocolPath,
  };
}

function artifactOwners(events: string[]): PackedManagedProviderArtifactOwners {
  return {
    assertCandidateArchivesSafe: vi.fn(async ({
      sdkTarballPath,
      pluginUiTarballPath,
      channelsProtocolTarballPath,
      cliTarballPath,
    }) => {
      events.push([
        'candidate-census',
        basename(sdkTarballPath),
        basename(pluginUiTarballPath),
        ...(channelsProtocolTarballPath
          ? [basename(channelsProtocolTarballPath)]
          : []),
        basename(cliTarballPath),
      ].join(':'));
      return {
        sdk: { entryCount: 2 },
        pluginUi: { entryCount: 2 },
        ...(channelsProtocolTarballPath
          ? { channelsProtocol: { entryCount: 2 } }
          : {}),
        cli: { entryCount: 2 },
      };
    }),
    readPackedPackageManifest: vi.fn(async (archivePath) => {
      events.push(`package-manifest:${basename(archivePath)}`);
      if (basename(archivePath).startsWith('sdk')) {
        return { name: '@happier-dev/plugin-sdk', version: '0.0.0' };
      }
      if (basename(archivePath).startsWith('plugin-ui')) {
        return {
          name: '@happier-dev/plugin-ui',
          version: '0.0.0',
          dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
        };
      }
      if (basename(archivePath).startsWith('channels-protocol')) {
        return { name: '@happier-dev/channels-protocol', version: '0.0.0' };
      }
      return {
        name: '@happier-dev/cli',
        version: '0.2.10',
        bin: { happier: './bin/happier.mjs' },
      };
    }),
    inspectTarArchiveEntries: vi.fn(async ({ archivePath }) => {
      events.push(`standalone-census:${basename(archivePath)}`);
      const os = process.platform === 'win32' ? 'windows' : process.platform;
      const root = `happier-v0.2.10-${os}-${process.arch}`;
      const executable = process.platform === 'win32' ? 'happier.exe' : 'happier';
      const wrapper = process.platform === 'win32'
        ? 'happier-cliproxyapi-managed.exe'
        : 'happier-cliproxyapi-managed';
      return [
        { path: root, kind: 'directory', mode: null, uid: null, gid: null },
        { path: `${root}/${executable}`, kind: 'file', mode: null, uid: null, gid: null },
        { path: `${root}/tools/unpacked/${wrapper}`, kind: 'file', mode: null, uid: null, gid: null },
        {
          path: `${root}/tools/unpacked/CLIProxyAPI-LICENSE`,
          kind: 'file',
          mode: null,
          uid: null,
          gid: null,
        },
        {
          path: `${root}/tools/unpacked/CLIProxyAPI-THIRD-PARTY-NOTICES`,
          kind: 'file',
          mode: null,
          uid: null,
          gid: null,
        },
      ] as const;
    }),
    extractArchivePayloadToDirectory: vi.fn(async ({ extractDir }) => {
      events.push('standalone-extract');
      const os = process.platform === 'win32' ? 'windows' : process.platform;
      const root = join(
        extractDir,
        `happier-v0.2.10-${os}-${process.arch}`,
      );
      const unpacked = join(root, 'tools', 'unpacked');
      await mkdir(unpacked, { recursive: true });
      await Promise.all([
        writeFile(
          join(root, process.platform === 'win32' ? 'happier.exe' : 'happier'),
          'cli',
        ),
        writeFile(
          join(
            unpacked,
            process.platform === 'win32'
              ? 'happier-cliproxyapi-managed.exe'
              : 'happier-cliproxyapi-managed',
          ),
          'wrapper',
        ),
        writeFile(join(unpacked, 'CLIProxyAPI-LICENSE'), 'license'),
        writeFile(
          join(unpacked, 'CLIProxyAPI-THIRD-PARTY-NOTICES'),
          'notices',
        ),
      ]);
    }),
  };
}

type PackedChannelProviderContinuityProbe = (
  input: PackedManagedProviderRunInput,
  deps: Readonly<{
    composed: Readonly<{
      probePackedChannelProviderLifecycle(
        input: PackedManagedProviderPreparedInput,
      ): Promise<PackedChannelProviderLifecycleEvidence>;
    }>;
    artifactOwners?: PackedManagedProviderArtifactOwners;
    candidateArtifactVerification?: Readonly<{
      trustedMinisignPublicKey: string;
    }>;
    reserveAvailablePort?: () => Promise<number>;
    platform?: NodeJS.Platform;
    arch?: string;
  }>,
) => Promise<Readonly<{ status: 'passed' }>>;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('packed managed Provider executable entrypoint', () => {
  it('keeps the production candidate trust anchor fail-closed for the ephemeral fixture key', async () => {
    const fixture = await writeInputFixture();
    const candidate = parseCandidateManifest(
      await readFile(fixture.manifestPath, 'utf8'),
      fixture.manifestPath,
    );

    await expect(assertPackedAuthorCandidateManifestArtifacts(candidate, {
      manifestPath: fixture.manifestPath,
    })).rejects.toThrow('Candidate standalone CLI checksum signature is invalid');
    await expect(assertPackedAuthorCandidateManifestArtifacts(candidate, {
      manifestPath: fixture.manifestPath,
      trustedMinisignPublicKey: TEST_MINISIGN_PUBLIC_KEY,
    })).resolves.toBeUndefined();
  });

  it('reuses exact candidate verification and freezes one standalone CLI launch spec', async () => {
    const fixture = await writeInputFixture();
    const workRoot = join(fixture.root, 'candidate-bound-codex');
    const events: string[] = [];
    const prepared = await prepareCandidateBoundCliLaunchSpec({
      candidateManifestPath: fixture.manifestPath,
      workRoot,
      artifactOwners: artifactOwners(events),
      candidateArtifactVerification: TEST_CANDIDATE_ARTIFACT_VERIFICATION,
      reserveAvailablePort: vi.fn()
        .mockResolvedValueOnce(8317)
        .mockResolvedValueOnce(45101)
        .mockResolvedValueOnce(45102),
    });

    expect(prepared.evidence).toMatchObject({
      candidateFrozen: true,
      standaloneCliFrozen: true,
      candidateArchiveCensus: {
        sdk: { entryCount: 2 },
        pluginUi: { entryCount: 2 },
        channelsProtocol: { entryCount: 2 },
        cli: { entryCount: 2 },
      },
    });
    expect(prepared.cliLaunchSpec.command)
      .toContain(`${join('standalone', 'happier-v0.2.10-')}`);
    expect(Object.isFrozen(prepared.cliLaunchSpec)).toBe(true);
    expect(Object.isFrozen(prepared.cliLaunchSpec.args)).toBe(true);
    expect(Object.isFrozen(prepared.cliLaunchSpec.env)).toBe(true);
    expect(events).toEqual([
      'candidate-census:sdk-attested.tgz:plugin-ui-attested.tgz:channels-protocol-attested.tgz:cli-attested.tgz',
      'package-manifest:sdk-attested.tgz',
      'package-manifest:plugin-ui-attested.tgz',
      'package-manifest:channels-protocol-attested.tgz',
      'package-manifest:cli-attested.tgz',
      `standalone-census:${basename(fixture.standalonePath)}`,
      'standalone-extract',
    ]);

    await prepared.dispose();
    expect(existsSync(workRoot)).toBe(false);
  });

  it('routes the frozen Channels candidate through the canonical lifecycle validator exactly once', async () => {
    const fixture = await writeInputFixture();
    const workRoot = join(fixture.root, 'channel-lifecycle');
    const lifecycle = vi.fn(async ({ prepared }) => {
      expect(prepared.candidate.channelsProtocol).toMatchObject({
        packageName: '@happier-dev/channels-protocol',
        version: '0.0.0',
      });
      expect(prepared.candidate.channelsProtocol?.tarballPath)
        .toContain(join('archives', 'channels-protocol-attested.tgz'));
      expect(Object.isFrozen(prepared.cliLaunchSpec)).toBe(true);
      return packedChannelProviderLifecycleEvidence();
    });

    const result = await runPackedChannelProviderEntrypoint({
      candidateManifestPath: fixture.manifestPath,
      workRoot,
      enableOpenCodeLive: false,
    }, {
      runPackedChannelProviderLifecycle: lifecycle,
      artifactOwners: artifactOwners([]),
      candidateArtifactVerification: TEST_CANDIDATE_ARTIFACT_VERIFICATION,
      reserveAvailablePort: vi.fn()
        .mockResolvedValueOnce(45131)
        .mockResolvedValueOnce(45132),
    });

    expect(result.kind).toBe('packed_channel_provider_vertical');
    expect(result.status).toBe('passed');
    expect(result.candidate.channelsProtocol).toMatchObject({
      packageName: '@happier-dev/channels-protocol',
    });
    expect(lifecycle).toHaveBeenCalledTimes(1);
    expect(existsSync(workRoot)).toBe(false);
  });

  it('routes the frozen Channels candidate through the continuity composed callback', async () => {
    const runPackedChannelProviderContinuityProbe = (
      packedManagedProviderContinuity as {
        runPackedChannelProviderContinuityProbe?: PackedChannelProviderContinuityProbe;
      }
    ).runPackedChannelProviderContinuityProbe;
    expect(runPackedChannelProviderContinuityProbe).toBeTypeOf('function');
    if (!runPackedChannelProviderContinuityProbe) return;

    const fixture = await writeInputFixture();
    const workRoot = join(fixture.root, 'channel-continuity-lifecycle');
    const lifecycle = vi.fn(async ({ prepared }: PackedManagedProviderPreparedInput) => {
      expect(prepared.candidate.channelsProtocol).toMatchObject({
        packageName: '@happier-dev/channels-protocol',
        version: '0.0.0',
      });
      expect(prepared.candidate.channelsProtocol?.tarballPath)
        .toContain(join('archives', 'channels-protocol-attested.tgz'));
      expect(Object.isFrozen(prepared.cliLaunchSpec)).toBe(true);
      return packedChannelProviderLifecycleEvidence();
    });

    const result = await runPackedChannelProviderContinuityProbe({
      candidateManifestPath: fixture.manifestPath,
      workRoot,
      enableOpenCodeLive: false,
    }, {
      composed: {
        probePackedChannelProviderLifecycle: lifecycle,
      },
      artifactOwners: artifactOwners([]),
      candidateArtifactVerification: TEST_CANDIDATE_ARTIFACT_VERIFICATION,
      reserveAvailablePort: vi.fn()
        .mockResolvedValueOnce(45133)
        .mockResolvedValueOnce(45134),
    });

    expect(result.status).toBe('passed');
    expect(lifecycle).toHaveBeenCalledTimes(1);
    expect(existsSync(workRoot)).toBe(false);
  });

  it('freezes, verifies, safely extracts, and binds the host-native artifact before the managed runner', async () => {
    const fixture = await writeInputFixture();
    const workRoot = join(fixture.root, 'private-run');
    const events: string[] = [];
    const scenario = scenarioDependencies({
      runPackagedWrapperConformance: vi.fn(async ({ prepared }) => {
        events.push('wrapper-conformance');
        expect(prepared.standaloneCliArtifact.archivePath)
          .toContain(`${join('private-run', 'archives')}`);
        expect(prepared.standaloneCliArtifact.executablePath)
          .toContain(`${join('standalone', 'happier-v0.2.10-')}`);
        expect(prepared.wrapperExecutable)
          .toMatch(/tools[\\/]unpacked[\\/]happier-cliproxyapi-managed(?:\.exe)?$/u);
        expect(prepared.cliLaunchSpec.command)
          .toBe(prepared.standaloneCliArtifact.executablePath);
        expect(prepared.cliLaunchSpec.args).toEqual([]);
        return {
          publicExplicitStart: true,
          publicCatalogProbe: true,
          catalogOwnerReleased: true,
          publicCredentialLeakObserved: false,
          providerAttemptedBeforeSessionDemand: false,
        };
      }),
    });

    const result = await runPackedManagedProviderEntrypoint({
      candidateManifestPath: fixture.manifestPath,
      workRoot,
      enableOpenCodeLive: false,
    }, {
      scenario,
      artifactOwners: artifactOwners(events),
      candidateArtifactVerification: TEST_CANDIDATE_ARTIFACT_VERIFICATION,
      reserveAvailablePort: vi.fn()
        .mockResolvedValueOnce(8317)
        .mockResolvedValueOnce(45101)
        .mockResolvedValueOnce(45102)
        .mockResolvedValueOnce(45103),
    });

    expect(result.status).toBe('passed');
    expect(result.harnessEvidence).toMatchObject({
      candidateFrozen: true,
      standaloneCliFrozen: true,
      hostTarget: {
        os: process.platform === 'win32' ? 'windows' : process.platform,
        arch: process.arch,
      },
      isolation: {
        stockCliProxyApiPort: 8317,
        stockCliProxyApiTouched: false,
        ports: {
          server: 41001,
          daemon: 41003,
          upstreamProxy: 41005,
        },
      },
      cleanup: { disposition: 'removed' },
    });
    const isolatedPorts = result.harnessEvidence.isolation.ports;
    expect(isolatedPorts).not.toBeNull();
    if (!isolatedPorts) throw new Error('expected isolated ports');
    expect(new Set(Object.values(isolatedPorts)).size).toBe(3);
    expect(events).toEqual([
      'candidate-census:sdk-attested.tgz:plugin-ui-attested.tgz:channels-protocol-attested.tgz:cli-attested.tgz',
      'package-manifest:sdk-attested.tgz',
      'package-manifest:plugin-ui-attested.tgz',
      'package-manifest:channels-protocol-attested.tgz',
      'package-manifest:cli-attested.tgz',
      `standalone-census:${basename(fixture.standalonePath)}`,
      'standalone-extract',
      'wrapper-conformance',
    ]);
    expect(existsSync(workRoot)).toBe(false);
  });

  it('fails closed when the candidate-bound standalone artifact changes before census, extraction, or scenario effects', async () => {
    const fixture = await writeInputFixture();
    await writeFile(fixture.standalonePath, 'tampered standalone archive');
    const workRoot = join(fixture.root, 'digest-refusal');
    const events: string[] = [];
    const owners = artifactOwners(events);
    const scenario = scenarioDependencies();

    await expect(runPackedManagedProviderEntrypoint({
      candidateManifestPath: fixture.manifestPath,
      workRoot,
      enableOpenCodeLive: false,
    }, {
      scenario,
      artifactOwners: owners,
      candidateArtifactVerification: TEST_CANDIDATE_ARTIFACT_VERIFICATION,
      reserveAvailablePort: vi.fn(),
    })).rejects.toMatchObject({
      code: 'packed_managed_provider_execution_failed',
      evidence: {
        cleanup: { disposition: 'removed' },
      },
    });

    expect(owners.inspectTarArchiveEntries).not.toHaveBeenCalled();
    expect(scenario.runPackagedWrapperConformance).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(existsSync(workRoot)).toBe(false);
  });

  it('cleans scenario resources and the private root on failure and cancellation', async () => {
    const fixture = await writeInputFixture();
    const failureRoot = join(fixture.root, 'scenario-failure');
    const cleanup = vi.fn(async () => undefined);
    const failureDiagnostics = {
      schemaVersion: 1 as const,
      code:
        'packed_managed_provider_candidate_daemon_exited_before_state',
      phase: 'waitForDaemonState',
      process: {
        exitCode: 1,
        signalCode: null,
      },
      daemonState: {
        everWritten: false,
        everRemoved: false,
        lastCandidateCount: 0,
      },
      logs: {
        stdout: {
          byteCount: 0,
          tail: null,
        },
        stderr: {
          byteCount: 24,
          tail: 'candidate daemon failed',
        },
      },
    };
    const scenario = scenarioDependencies({
      runFreshManagedSequence: vi.fn(async () => {
        throw Object.assign(
          new Error(failureDiagnostics.code),
          {
            packedManagedProviderFailureDiagnostics:
              failureDiagnostics,
          },
        );
      }),
      cleanup,
    });

    await expect(runPackedManagedProviderEntrypoint({
      candidateManifestPath: fixture.manifestPath,
      workRoot: failureRoot,
      enableOpenCodeLive: false,
    }, {
      scenario,
      artifactOwners: artifactOwners([]),
      candidateArtifactVerification: TEST_CANDIDATE_ARTIFACT_VERIFICATION,
      reserveAvailablePort: vi.fn()
        .mockResolvedValueOnce(45111)
        .mockResolvedValueOnce(45112)
        .mockResolvedValueOnce(45113),
    })).rejects.toMatchObject({
      code:
        'packed_managed_provider_candidate_daemon_exited_before_state',
      evidence: {
        failureDiagnostics,
        cleanup: { disposition: 'removed' },
      },
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(existsSync(failureRoot)).toBe(false);

    const cancelledRoot = join(fixture.root, 'cancelled');
    const controller = new AbortController();
    controller.abort();
    await expect(runPackedManagedProviderEntrypoint({
      candidateManifestPath: fixture.manifestPath,
      workRoot: cancelledRoot,
      enableOpenCodeLive: false,
      signal: controller.signal,
    }, {
      scenario: scenarioDependencies(),
      artifactOwners: artifactOwners([]),
      candidateArtifactVerification: TEST_CANDIDATE_ARTIFACT_VERIFICATION,
      reserveAvailablePort: vi.fn(),
    })).rejects.toMatchObject({
      code: 'packed_managed_provider_cancelled',
      evidence: { cleanup: { disposition: 'removed' } },
    });
    expect(existsSync(cancelledRoot)).toBe(false);
  });

  it('does not mutate source artifacts while freezing them', async () => {
    const fixture = await writeInputFixture();
    const before = await Promise.all([
      readFile(fixture.manifestPath),
      readFile(fixture.standalonePath),
    ]);
    await runPackedManagedProviderEntrypoint({
      candidateManifestPath: fixture.manifestPath,
      workRoot: join(fixture.root, 'read-only-inputs'),
      enableOpenCodeLive: false,
    }, {
      scenario: scenarioDependencies(),
      artifactOwners: artifactOwners([]),
      candidateArtifactVerification: TEST_CANDIDATE_ARTIFACT_VERIFICATION,
      reserveAvailablePort: vi.fn()
        .mockResolvedValueOnce(45121)
        .mockResolvedValueOnce(45122)
        .mockResolvedValueOnce(45123),
    });
    const after = await Promise.all([
      readFile(fixture.manifestPath),
      readFile(fixture.standalonePath),
    ]);
    expect(after).toEqual(before);
  });

  it('serializes daemon-control readiness failures as a stable secret-free code', async () => {
    const fixture = await writeInputFixture();
    const workRoot = join(fixture.root, 'daemon-control-timeout');
    const owners: PackedManagedProviderArtifactOwners = {
      ...artifactOwners([]),
      assertCandidateArchivesSafe: vi.fn(async () => {
        throw new Error(
          'Timed out waiting for condition (packed managed candidate daemon control readiness); '
          + 'last error: command --token must-not-be-serialized',
        );
      }),
    };
    const stderr: string[] = [];
    const exitCodes: number[] = [];

    await main([
      '--candidate',
      fixture.manifestPath,
      '--work-root',
      workRoot,
    ], {
      artifactOwners: owners,
      candidateArtifactVerification: TEST_CANDIDATE_ARTIFACT_VERIFICATION,
      writeStdout: vi.fn(),
      writeStderr: (line) => stderr.push(line),
      setExitCode: (code) => exitCodes.push(code),
    });

    expect(exitCodes).toEqual([1]);
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0]!)).toMatchObject({
      schemaVersion: 1,
      kind: 'packed_managed_provider_vertical_error',
      status: 'failed',
      code: 'packed_managed_provider_candidate_daemon_control_not_ready',
      evidence: {
        cleanup: { disposition: 'removed' },
      },
    });
    expect(stderr[0]).not.toContain('must-not-be-serialized');
    expect(existsSync(workRoot)).toBe(false);
  });

});
