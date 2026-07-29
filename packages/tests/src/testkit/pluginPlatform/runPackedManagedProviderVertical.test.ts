import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PackedManagedProviderScenarioDependencies,
} from '../../../scripts/plugin-platform/run-packed-managed-provider.mjs';
import {
  main,
  runPackedManagedProviderEntrypoint,
  type PackedManagedProviderArtifactOwners,
} from '../../plugin-platform/runPackedManagedProviderVertical';

const roots: string[] = [];

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
    canonicalSessionIdBeforeWebhook: null,
    canonicalSessionId: 'session-canonical-a',
    purposes: [
      'happier.agent.opencode/opencode:openai-codex-model-request',
      'happier.provider.cliproxyapi/cliproxyapi:openai-upstream',
    ],
    capabilityScopeDigests: [
      'a'.repeat(64),
      'b'.repeat(64),
    ],
    timeline: {
      freshSpawnStartedAtMs: 1,
      canonicalSessionRegisteredAtMs: 2,
      capabilitiesActivatedAtMs: 2,
      canonicalWebhookAcknowledgedAtMs: 3,
      spawnAcknowledgedAtMs: 4,
      agentRequestAuthLookupAtMs: 5,
      agentRequestAuthLookupCompletedAtMs: 6,
      managedRequestAuthLookupAtMs: 7,
      managedRequestAuthLookupCompletedAtMs: 8,
      providerAttemptAtMs: 9,
    },
    observedPorts: {
      server: 41001,
      serverProxy: 41002,
      daemon: 41003,
      brokerProxy: 41004,
      upstreamProxy: 41005,
      wrapper: 41006,
    },
    stockPortRequestCount: 0,
    stockPortOsConnectionAttemptCount: 0,
    stockListenerIdentityBefore: `sha256:${'e'.repeat(64)}`,
    stockListenerIdentityAfter: `sha256:${'e'.repeat(64)}`,
    preActivationCredentialReleased: false,
    preActivationUpstreamAttempted: false,
    preActivationAgentCapabilityPresent: false,
    managedLeaseCredentialRevision: 'revision-current',
    managedLeaseAccessTokenFingerprint: `sha256:${'c'.repeat(64)}`,
    upstreamAuthorizationFingerprint: `sha256:${'c'.repeat(64)}`,
    managedRequestAuthOrigin: 'https://chatgpt.com',
    managedConnectionSecurityFingerprint:
      `connection-security:v1:${'d'.repeat(43)}`,
    upstreamConnectTarget: 'chatgpt.com:443',
    promptSentinelObserved: true,
    upstreamRequestPath: '/backend-api/codex/responses',
    currentCredentialRevision: 'revision-current',
    currentAccessTokenFingerprint: `sha256:${'c'.repeat(64)}`,
  } as const;
}

function scenarioDependencies(
  overrides: Partial<PackedManagedProviderScenarioDependencies> = {},
): PackedManagedProviderScenarioDependencies {
  return {
    runPackagedWrapperConformance: vi.fn(async () => ({
      tokenFreeReadiness: true,
      preActivationLookupRefused: true,
      preActivationCredentialReleased: false,
      preActivationUpstreamAttempted: false,
    })),
    runFreshManagedSequence: vi.fn(async () => managedSequenceEvidence()),
    runActivationFailureCleanupProbe: vi.fn(async () => ({
      activationFailedBeforeAck: true,
      firstInputDispatched: false,
      providerAttempted: false,
      wrapperStopped: true,
      capabilityRetired: true,
      materializationRemoved: true,
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
  const cliBytes = Buffer.from('exact cli archive');
  const sdkPath = join(root, 'sdk.tgz');
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
  const checksumsPath = join(root, `checksums-happier-v${version}.txt`);
  const checksumsBytes = Buffer.from(
    nativeArchives
      .map((artifact) => `${artifact.sha256}  ${basename(artifact.archivePath)}`)
      .join('\n')
      .concat('\n'),
  );
  const installerDefinitions = [
    ['shell', 'shell', 'install-dev.sh', Buffer.from('shell installer')],
    ['powershell', 'powershell', 'install-dev.ps1', Buffer.from('powershell installer')],
    ['publicKey', 'minisign-public-key', 'happier-release.pub', Buffer.from('public key')],
  ] as const;
  const manifestPath = join(root, 'candidate.json');
  await Promise.all([
    writeFile(sdkPath, sdkBytes),
    writeFile(cliPath, cliBytes),
    ...nativeArchives.map((artifact) => writeFile(artifact.archivePath, artifact.bytes)),
    writeFile(checksumsPath, checksumsBytes),
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
    sourceBasis: {
      algorithm: 'sha256',
      digest: 'a'.repeat(64),
    },
    installers,
    sdk: {
      packageName: '@happier-dev/plugin-sdk',
      version: '0.0.0',
      integrity: sha512Sri(sdkBytes),
      tarballPath: sdkPath,
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
      signature: null,
    },
  }));
  return {
    root,
    manifestPath,
    standalonePath,
  };
}

function artifactOwners(events: string[]): PackedManagedProviderArtifactOwners {
  return {
    assertCandidateArchivesSafe: vi.fn(async ({ sdkTarballPath, cliTarballPath }) => {
      events.push(`candidate-census:${basename(sdkTarballPath)}:${basename(cliTarballPath)}`);
      return { sdk: { entryCount: 2 }, cli: { entryCount: 2 } };
    }),
    readPackedPackageManifest: vi.fn(async (archivePath) => {
      events.push(`package-manifest:${basename(archivePath)}`);
      return basename(archivePath).startsWith('sdk')
        ? { name: '@happier-dev/plugin-sdk', version: '0.0.0' }
        : {
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('packed managed Provider executable entrypoint', () => {
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
          tokenFreeReadiness: true,
          preActivationLookupRefused: true,
          preActivationCredentialReleased: false,
          preActivationUpstreamAttempted: false,
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
          wrapper: 41006,
        },
      },
      cleanup: { disposition: 'removed' },
    });
    const isolatedPorts = result.harnessEvidence.isolation.ports;
    expect(isolatedPorts).not.toBeNull();
    if (!isolatedPorts) throw new Error('expected isolated ports');
    expect(new Set(Object.values(isolatedPorts)).size).toBe(3);
    expect(events).toEqual([
      'candidate-census:sdk-attested.tgz:cli-attested.tgz',
      'package-manifest:sdk-attested.tgz',
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
