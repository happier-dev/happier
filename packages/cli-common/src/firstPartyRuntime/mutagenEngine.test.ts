import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  MUTAGEN_ENGINE_FORK_BRANCH,
  MUTAGEN_ENGINE_FORK_REMOTE,
  MUTAGEN_ENGINE_FORK_RELEASE_COMMIT,
  MUTAGEN_ENGINE_FORK_SOURCE_BASE_COMMIT,
  MUTAGEN_ENGINE_TRANSPORT_SPIKE_COMMIT,
  MUTAGEN_ENGINE_VERSION,
  MUTAGEN_ENGINE_GO_DISTRIBUTION_SHA256,
  MUTAGEN_ENGINE_CONTENT_HASH_ALGORITHM,
  MUTAGEN_ENGINE_PROTOCOL_EPOCH,
  MUTAGEN_ENGINE_SUPPORTED_TARGETS,
  MUTAGEN_ENGINE_UPSTREAM_COMMIT,
  MUTAGEN_ENGINE_UPSTREAM_TAG,
  MUTAGEN_ENGINE_GO_VERSION,
  assertMutagenEngineArtifactManifest,
  assertMutagenEngineArtifactPayload,
  resolveMutagenEngineArtifactPaths,
  resolveMutagenEngineArtifactTarget,
  resolveMutagenEngineDataLayout,
  resolveMutagenEngineReleaseTag,
} from './mutagenEngineArtifact.js';

const MUTAGEN_ENGINE_SOURCE_POLICY = JSON.parse(
  readFileSync(new URL('../../mutagen-engine.json', import.meta.url), 'utf8'),
) as Readonly<{
  schemaVersion: number;
  component: string;
  engineVersion: string;
  fork: Readonly<{
    remote: string;
    branch: string;
    sourceBaseCommit: string;
    releaseCommit: string;
    transportSpikeCommit: string;
  }>;
  upstream: Readonly<{ tag: string; commit: string }>;
  toolchain: Readonly<{
    go: string;
    distributionSha256: Readonly<Record<string, string>>;
  }>;
  protocol: Readonly<{ epoch: string }>;
  engine: Readonly<{ contentHashAlgorithm: string }>;
  targets: readonly string[];
  artifact: Readonly<{ releaseRepository: string; sourceRepository: string }>;
  license: Readonly<{
    ssplEnabled: boolean;
    managerBuildTags: readonly string[];
    agentBuildTags: readonly string[];
  }>;
}>;
const FIXTURE_RELEASE_COMMIT = '3a4774da2a75a0d2a5343e4980d9a03aa44ca81c';
const APPROVED_FORK_RELEASE_COMMIT = 'f02d01e88f2eeec5e4326a4739243b863f8cebbe';
const MUTAGEN_UMBRELLA_LICENSE = `Unless otherwise specified, all code in this repository is made available under
the terms of the MIT License, the text of which can be found below.

All code that resides under the sspl directory is made available under the terms
of the Server Side Public License, the text of which can be found in sspl/LICENSE.

MIT License
`;
const SSPL_V1_LICENSE = 'Server Side Public License\nVersion 1, October 16, 2018\n';

const VALID_MANIFEST = {
  schemaVersion: 1,
  component: 'mutagen-engine',
  engineVersion: '0.18.1',
  forkCommit: FIXTURE_RELEASE_COMMIT,
  sourceRepository: 'https://github.com/happier-dev/mutagen',
  sourceTag: 'mutagen-v0.18.1',
  sourceArchive: 'happier-mutagen-source-mutagen-v0.18.1.tar.gz',
  upstreamTag: MUTAGEN_ENGINE_UPSTREAM_TAG,
  upstreamCommit: MUTAGEN_ENGINE_UPSTREAM_COMMIT,
  toolchain: {
    go: MUTAGEN_ENGINE_GO_VERSION,
    goChecksum: MUTAGEN_ENGINE_GO_DISTRIBUTION_SHA256['linux-amd64'],
  },
  protocolEpoch: MUTAGEN_ENGINE_PROTOCOL_EPOCH,
  targetTriple: 'linux-amd64',
  managerPath: 'bin/happier-mutagen',
  agentPath: 'bin/happier-mutagen-agent',
  licensePolicy: 'mixed-mit-sspl',
  ssplEnabled: true,
  // Exact tags the fork release builds with: manager -tags mutagensidecar,
  // agent -tags mutagenagent, and both include the upstream SSPL implementation.
  buildTags: ['mutagensidecar', 'mutagensspl', 'mutagenagent'],
  managerBuildTags: ['mutagensidecar', 'mutagensspl'],
  agentBuildTags: ['mutagenagent', 'mutagensspl'],
  cgoEnabled: false,
  watcher: 'polling',
  managerSha256: createHash('sha256').update('manager').digest('hex'),
  agentSha256: createHash('sha256').update('agent').digest('hex'),
  releaseTag: 'mutagen-v0.18.1',
};

describe('Mutagen engine artifact contract', () => {
  it('keeps source-build policy and runtime acquisition constants in strict parity', () => {
    expect({
      schemaVersion: 1,
      component: 'mutagen-engine',
      engineVersion: MUTAGEN_ENGINE_VERSION,
      fork: {
        remote: MUTAGEN_ENGINE_FORK_REMOTE,
        branch: MUTAGEN_ENGINE_FORK_BRANCH,
        sourceBaseCommit: MUTAGEN_ENGINE_FORK_SOURCE_BASE_COMMIT,
        releaseCommit: MUTAGEN_ENGINE_FORK_RELEASE_COMMIT,
        transportSpikeCommit: MUTAGEN_ENGINE_TRANSPORT_SPIKE_COMMIT,
      },
      upstream: {
        tag: MUTAGEN_ENGINE_UPSTREAM_TAG,
        commit: MUTAGEN_ENGINE_UPSTREAM_COMMIT,
      },
      toolchain: {
        go: MUTAGEN_ENGINE_GO_VERSION,
        distributionSha256: MUTAGEN_ENGINE_GO_DISTRIBUTION_SHA256,
      },
      protocol: { epoch: MUTAGEN_ENGINE_PROTOCOL_EPOCH },
      engine: { contentHashAlgorithm: MUTAGEN_ENGINE_CONTENT_HASH_ALGORITHM },
      targets: MUTAGEN_ENGINE_SUPPORTED_TARGETS,
      artifact: {
        releaseRepository: 'happier-dev/mutagen',
        sourceRepository: MUTAGEN_ENGINE_FORK_REMOTE.replace(/\.git$/u, ''),
      },
      license: {
        ssplEnabled: true,
        managerBuildTags: ['mutagensidecar', 'mutagensspl'],
        agentBuildTags: ['mutagenagent', 'mutagensspl'],
      },
    }).toEqual({
      schemaVersion: MUTAGEN_ENGINE_SOURCE_POLICY.schemaVersion,
      component: MUTAGEN_ENGINE_SOURCE_POLICY.component,
      engineVersion: MUTAGEN_ENGINE_SOURCE_POLICY.engineVersion,
      fork: {
        remote: MUTAGEN_ENGINE_SOURCE_POLICY.fork.remote,
        branch: MUTAGEN_ENGINE_SOURCE_POLICY.fork.branch,
        sourceBaseCommit: MUTAGEN_ENGINE_SOURCE_POLICY.fork.sourceBaseCommit,
        releaseCommit: MUTAGEN_ENGINE_SOURCE_POLICY.fork.releaseCommit,
        transportSpikeCommit: MUTAGEN_ENGINE_SOURCE_POLICY.fork.transportSpikeCommit,
      },
      upstream: MUTAGEN_ENGINE_SOURCE_POLICY.upstream,
      toolchain: {
        go: MUTAGEN_ENGINE_SOURCE_POLICY.toolchain.go,
        distributionSha256: MUTAGEN_ENGINE_SOURCE_POLICY.toolchain.distributionSha256,
      },
      protocol: { epoch: MUTAGEN_ENGINE_SOURCE_POLICY.protocol.epoch },
      engine: { contentHashAlgorithm: MUTAGEN_ENGINE_SOURCE_POLICY.engine.contentHashAlgorithm },
      targets: MUTAGEN_ENGINE_SOURCE_POLICY.targets,
      artifact: {
        releaseRepository: MUTAGEN_ENGINE_SOURCE_POLICY.artifact.releaseRepository,
        sourceRepository: MUTAGEN_ENGINE_SOURCE_POLICY.artifact.sourceRepository,
      },
      license: {
        ssplEnabled: MUTAGEN_ENGINE_SOURCE_POLICY.license.ssplEnabled,
        managerBuildTags: MUTAGEN_ENGINE_SOURCE_POLICY.license.managerBuildTags,
        agentBuildTags: MUTAGEN_ENGINE_SOURCE_POLICY.license.agentBuildTags,
      },
    });
  });

  it('pins the approved fork, upstream, toolchain, protocol, and target matrix', () => {
    expect(MUTAGEN_ENGINE_FORK_SOURCE_BASE_COMMIT).toMatch(/^[0-9a-f]{40}$/u);
    expect(MUTAGEN_ENGINE_FORK_RELEASE_COMMIT).toBe(APPROVED_FORK_RELEASE_COMMIT);
    expect(MUTAGEN_ENGINE_VERSION).toBe('0.18.1-happier.9');
    expect(MUTAGEN_ENGINE_UPSTREAM_COMMIT).toBe('a225ae50aee3d7ebb59139203cb84e8a6a3ff4bf');
    expect(MUTAGEN_ENGINE_UPSTREAM_TAG).toBe('v0.18.1');
    expect(MUTAGEN_ENGINE_GO_VERSION).toBe('1.22.12');
    expect(MUTAGEN_ENGINE_PROTOCOL_EPOCH).toBe('external-stream-v1');
    expect(MUTAGEN_ENGINE_SOURCE_POLICY.engine.contentHashAlgorithm).toBe(MUTAGEN_ENGINE_CONTENT_HASH_ALGORITHM);
    expect(MUTAGEN_ENGINE_SUPPORTED_TARGETS).toEqual([
      'darwin-arm64',
      'darwin-amd64',
      'linux-amd64',
      'linux-arm64',
      'windows-amd64',
    ]);
  });

  it('resolves only immutable engine release tags', () => {
    expect(resolveMutagenEngineReleaseTag('0.18.1')).toBe('mutagen-v0.18.1');
    expect(resolveMutagenEngineReleaseTag('0.18.1-happier.2')).toBe('mutagen-v0.18.1-happier.2');
    expect(() => resolveMutagenEngineReleaseTag('')).toThrow(/engine version/i);
    expect(() => resolveMutagenEngineReleaseTag('latest')).toThrow(/engine version/i);
    expect(() => resolveMutagenEngineReleaseTag('mutagen-v0.18.1')).toThrow(/engine version/i);
  });

  it('maps host platform values to the fixed release target matrix', () => {
    expect(resolveMutagenEngineArtifactTarget({ platform: 'darwin', arch: 'arm64' })).toBe('darwin-arm64');
    expect(resolveMutagenEngineArtifactTarget({ platform: 'linux', arch: 'x64' })).toBe('linux-amd64');
    expect(resolveMutagenEngineArtifactTarget({ platform: 'win32', arch: 'x64' })).toBe('windows-amd64');
    expect(() => resolveMutagenEngineArtifactTarget({ platform: 'linux', arch: 'arm' })).toThrow(/unsupported platform/i);
    expect(() => resolveMutagenEngineArtifactTarget({ platform: 'win32', arch: 'arm64' })).toThrow(/unsupported platform/i);
  });

  it('accepts only the approved mixed MIT and SSPL manager/agent manifest', () => {
    expect(assertMutagenEngineArtifactManifest(VALID_MANIFEST, {
      trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT,
    })).toMatchObject({
      schemaVersion: 1,
      component: 'mutagen-engine',
      targetTriple: 'linux-amd64',
      managerPath: 'bin/happier-mutagen',
      agentPath: 'bin/happier-mutagen-agent',
      licensePolicy: 'mixed-mit-sspl',
      ssplEnabled: true,
      sourceRepository: 'https://github.com/happier-dev/mutagen',
      sourceTag: 'mutagen-v0.18.1',
      sourceArchive: 'happier-mutagen-source-mutagen-v0.18.1.tar.gz',
      buildTags: ['mutagensidecar', 'mutagensspl', 'mutagenagent'],
      managerBuildTags: ['mutagensidecar', 'mutagensspl'],
      agentBuildTags: ['mutagenagent', 'mutagensspl'],
    });
  });

  it('never treats the source-base commit as the releasable artifact identity', () => {
    expect(FIXTURE_RELEASE_COMMIT).not.toBe(MUTAGEN_ENGINE_FORK_SOURCE_BASE_COMMIT);
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      forkCommit: MUTAGEN_ENGINE_FORK_SOURCE_BASE_COMMIT,
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/exact release commit/i);
    expect(() => assertMutagenEngineArtifactManifest(VALID_MANIFEST)).toThrow(/exact release commit/i);
  });

  it('rejects stale provenance, path-bearing protocol metadata, and unapproved license modes or tags', () => {
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      forkCommit: '5582f67145136047dda45d17c97bdfc8a0a97bf0',
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/fork commit/i);
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      protocol: 'external://id?path=/tmp/root&rootGrantId=grant',
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/protocol/i);
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      licensePolicy: 'mit-only',
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/SSPL|license/i);
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      ssplEnabled: false,
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/SSPL|license/i);
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      sourceRepository: 'https://example.invalid/mutagen',
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/source repository/i);
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      sourceTag: 'mutagen-v0.18.1-other',
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/source tag/i);
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      sourceArchive: 'source.tar.gz',
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/source archive/i);
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      managerBuildTags: ['mutagensidecar'],
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/manager build tag/i);
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      agentBuildTags: ['mutagenagent'],
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/agent build tag/i);
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      buildTags: ['mutagensidecar', 'mutagensspl'],
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/build tag/i);
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      buildTags: [...VALID_MANIFEST.buildTags, 'experimental'],
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/build tag/i);
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      watcher: 'fanotify-when-supported',
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/watcher/i);
    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      rootGrantId: 'grant-01',
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/unknown|field/i);

    expect(assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      targetTriple: 'darwin-arm64',
      toolchain: {
        ...VALID_MANIFEST.toolchain,
        goChecksum: MUTAGEN_ENGINE_GO_DISTRIBUTION_SHA256['darwin-arm64'],
      },
      buildTags: ['mutagensidecar', 'mutagensspl', 'mutagenagent'],
      agentBuildTags: ['mutagenagent', 'mutagensspl'],
      cgoEnabled: true,
      watcher: 'fsevents',
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toMatchObject({
      targetTriple: 'darwin-arm64',
      agentBuildTags: ['mutagenagent', 'mutagensspl'],
    });
  });

  it('requires manager and agent binaries plus the license/checksum closure without monopolizing the event loop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-mutagen-artifact-'));
    try {
      const paths = resolveMutagenEngineArtifactPaths(root, 'linux-amd64');
      mkdirSync(join(root, 'bin'), { recursive: true });
      mkdirSync(join(root, 'licenses'), { recursive: true });
      // Span several stream chunks; corruption at the tail must not be missed.
      const managerBytes = Buffer.from('manager'.repeat(32768));
      writeFileSync(paths.managerPath, managerBytes);
      writeFileSync(paths.agentPath, 'agent');
      writeFileSync(paths.mutagenLicensePath, MUTAGEN_UMBRELLA_LICENSE);
      writeFileSync(paths.ssplLicensePath, SSPL_V1_LICENSE);
      writeFileSync(paths.thirdPartyNoticesPath, 'notices\n');
      const payloadManifest = {
        ...VALID_MANIFEST,
        managerSha256: createHash('sha256').update(managerBytes).digest('hex'),
      };
      const manifestText = JSON.stringify(payloadManifest);
      writeFileSync(paths.manifestPath, manifestText);
      const validChecksums = [
        `${payloadManifest.managerSha256}  bin/happier-mutagen`,
        `${VALID_MANIFEST.agentSha256}  bin/happier-mutagen-agent`,
        `${createHash('sha256').update(MUTAGEN_UMBRELLA_LICENSE).digest('hex')}  licenses/MUTAGEN-LICENSE`,
        `${createHash('sha256').update(SSPL_V1_LICENSE).digest('hex')}  licenses/SSPL-LICENSE`,
        `${createHash('sha256').update('notices\n').digest('hex')}  licenses/THIRD-PARTY-NOTICES`,
        `${createHash('sha256').update(manifestText).digest('hex')}  .happier-mutagen-engine.json`,
      ].join('\n').concat('\n');
      writeFileSync(paths.checksumsPath, validChecksums);
      chmodSync(paths.managerPath, 0o755);
      chmodSync(paths.agentPath, 0o755);

      let eventLoopAdvanced = false;
      const heartbeat = new Promise<void>((resolve) => setImmediate(() => {
        eventLoopAdvanced = true;
        resolve();
      }));
      expect(await assertMutagenEngineArtifactPayload({
        payloadRoot: root,
        targetTriple: 'linux-amd64',
        trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT,
      })).toMatchObject({ targetTriple: 'linux-amd64' });
      expect(eventLoopAdvanced).toBe(true);
      await heartbeat;

      writeFileSync(paths.managerPath, Buffer.concat([managerBytes.subarray(0, -1), Buffer.from('!')]));
      await expect(assertMutagenEngineArtifactPayload({
        payloadRoot: root,
        targetTriple: 'linux-amd64',
        trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT,
      })).rejects.toMatchObject({ code: 'mutagen_engine_artifact_incomplete' });
      writeFileSync(paths.managerPath, managerBytes);

      rmSync(paths.ssplLicensePath);
      await expect(assertMutagenEngineArtifactPayload({
        payloadRoot: root,
        targetTriple: 'linux-amd64',
        trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT,
      })).rejects.toThrow(/SSPL license.*missing/i);

      writeFileSync(paths.ssplLicensePath, '\n');
      await expect(assertMutagenEngineArtifactPayload({
        payloadRoot: root,
        targetTriple: 'linux-amd64',
        trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT,
      })).rejects.toThrow(/SSPL license/i);

      writeFileSync(paths.ssplLicensePath, SSPL_V1_LICENSE);
      writeFileSync(paths.checksumsPath, validChecksums.replace(payloadManifest.managerSha256, '0'.repeat(64)));
      await expect(assertMutagenEngineArtifactPayload({
        payloadRoot: root,
        targetTriple: 'linux-amd64',
        trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT,
      })).rejects.toThrow(/checksums/i);

      writeFileSync(paths.checksumsPath, validChecksums);
      writeFileSync(paths.ssplLicensePath, 'not an SSPL license\n');
      await expect(assertMutagenEngineArtifactPayload({
        payloadRoot: root,
        targetTriple: 'linux-amd64',
        trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT,
      })).rejects.toThrow(/SSPL license/i);

      writeFileSync(paths.ssplLicensePath, SSPL_V1_LICENSE);

      rmSync(paths.agentPath);
      await expect(assertMutagenEngineArtifactPayload({
        payloadRoot: root,
        targetTriple: 'linux-amd64',
        trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT,
      })).rejects.toThrow(/agent/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires the exact target-specific executable paths in manifests, payloads, and checksums', async () => {
    expect(resolveMutagenEngineArtifactPaths('C:\\engine', 'windows-amd64')).toMatchObject({
      managerPath: join('C:\\engine', 'bin', 'happier-mutagen.exe'),
      agentPath: join('C:\\engine', 'bin', 'happier-mutagen-agent.exe'),
    });
    expect(resolveMutagenEngineArtifactPaths('/engine', 'linux-amd64')).toMatchObject({
      managerPath: join('/engine', 'bin', 'happier-mutagen'),
      agentPath: join('/engine', 'bin', 'happier-mutagen-agent'),
    });

    expect(() => assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      targetTriple: 'windows-amd64',
      toolchain: {
        ...VALID_MANIFEST.toolchain,
        goChecksum: MUTAGEN_ENGINE_GO_DISTRIBUTION_SHA256['windows-amd64'],
      },
      watcher: 'native',
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toThrow(/canonical bin paths/i);

    expect(assertMutagenEngineArtifactManifest({
      ...VALID_MANIFEST,
      targetTriple: 'windows-amd64',
      toolchain: {
        ...VALID_MANIFEST.toolchain,
        goChecksum: MUTAGEN_ENGINE_GO_DISTRIBUTION_SHA256['windows-amd64'],
      },
      managerPath: 'bin/happier-mutagen.exe',
      agentPath: 'bin/happier-mutagen-agent.exe',
      watcher: 'native',
    }, { trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT })).toMatchObject({
      managerPath: 'bin/happier-mutagen.exe',
      agentPath: 'bin/happier-mutagen-agent.exe',
    });

    const root = mkdtempSync(join(tmpdir(), 'happier-mutagen-windows-artifact-'));
    try {
      const paths = resolveMutagenEngineArtifactPaths(root, 'windows-amd64');
      mkdirSync(join(root, 'bin'), { recursive: true });
      mkdirSync(join(root, 'licenses'), { recursive: true });
      writeFileSync(paths.managerPath, 'manager');
      writeFileSync(paths.agentPath, 'agent');
      writeFileSync(paths.mutagenLicensePath, MUTAGEN_UMBRELLA_LICENSE);
      writeFileSync(paths.ssplLicensePath, SSPL_V1_LICENSE);
      writeFileSync(paths.thirdPartyNoticesPath, 'notices\n');
      const manifest = {
        ...VALID_MANIFEST,
        targetTriple: 'windows-amd64',
        toolchain: {
          ...VALID_MANIFEST.toolchain,
          goChecksum: MUTAGEN_ENGINE_GO_DISTRIBUTION_SHA256['windows-amd64'],
        },
        managerPath: 'bin/happier-mutagen.exe',
        agentPath: 'bin/happier-mutagen-agent.exe',
        watcher: 'native',
      };
      const manifestText = JSON.stringify(manifest);
      writeFileSync(paths.manifestPath, manifestText);
      const checksumClosure = (managerPath: string, agentPath: string) => [
        `${VALID_MANIFEST.managerSha256}  ${managerPath}`,
        `${VALID_MANIFEST.agentSha256}  ${agentPath}`,
        `${createHash('sha256').update(MUTAGEN_UMBRELLA_LICENSE).digest('hex')}  licenses/MUTAGEN-LICENSE`,
        `${createHash('sha256').update(SSPL_V1_LICENSE).digest('hex')}  licenses/SSPL-LICENSE`,
        `${createHash('sha256').update('notices\n').digest('hex')}  licenses/THIRD-PARTY-NOTICES`,
        `${createHash('sha256').update(manifestText).digest('hex')}  .happier-mutagen-engine.json`,
      ].join('\n').concat('\n');

      writeFileSync(paths.checksumsPath, checksumClosure('bin/happier-mutagen', 'bin/happier-mutagen-agent'));
      await expect(assertMutagenEngineArtifactPayload({
        payloadRoot: root,
        targetTriple: 'windows-amd64',
        trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT,
      })).rejects.toThrow(/checksums/i);

      writeFileSync(paths.checksumsPath, checksumClosure(manifest.managerPath, manifest.agentPath));
      expect(await assertMutagenEngineArtifactPayload({
        payloadRoot: root,
        targetTriple: 'windows-amd64',
        trustedForkReleaseCommit: FIXTURE_RELEASE_COMMIT,
      })).toMatchObject({
        managerPath: manifest.managerPath,
        agentPath: manifest.agentPath,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps managed data, broker, and staging paths isolated from stack dev-target data', () => {
    const layout = resolveMutagenEngineDataLayout({
      daemonDataRoot: '/home/tester/.happier/daemon',
      stackDevTargetMutagenDataDir: '/home/tester/.happier-stack/stacks/dev/mutagen/data',
    });
    expect(layout.dataDir).toBe('/home/tester/.happier/daemon/workspace-sync/mutagen/data');
    expect(layout.brokerDir).toBe('/home/tester/.happier/daemon/workspace-sync/mutagen/broker');
    expect(layout).toEqual({
      rootDir: '/home/tester/.happier/daemon/workspace-sync/mutagen',
      dataDir: '/home/tester/.happier/daemon/workspace-sync/mutagen/data',
      brokerDir: '/home/tester/.happier/daemon/workspace-sync/mutagen/broker',
    });
    expect(() => resolveMutagenEngineDataLayout({
      daemonDataRoot: '/tmp/daemon',
      stackDevTargetMutagenDataDir: '/tmp/daemon/workspace-sync/mutagen/data',
    })).toThrow(/dev-target|isolat|data directory/i);
  });
});
