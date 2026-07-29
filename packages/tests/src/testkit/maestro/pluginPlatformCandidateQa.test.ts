import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PluginInstallationReviewFacts } from '../pluginPlatform/pluginInstallReviewRequiredEnvelope.mjs';

import {
  G5_GENERATED_INPUTS_AUTHORIZATION,
  preparePackedNovelConnectedAccountDeviceQa,
  preparePluginPlatformCandidateQa,
  resolveReusablePackedCliEntrypoint,
  runPluginPlatformCandidateQaPhases,
} from './pluginPlatformCandidateQa';

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function mobileInstallationReview(
  version: string,
  locator: string,
): PluginInstallationReviewFacts {
  return {
    pluginId: 'acme.mobile-candidate',
    displayName: 'Mobile candidate',
    version,
    packageIdentity: { name: '@acme/mobile-candidate', version },
    publisherIdentity: { status: 'unavailable' },
    source: { kind: 'archive', locator },
    updateChannel: { kind: 'archive', locator },
    integrity: {
      packageDigest: `sha256:${'a'.repeat(64)}`,
      manifestDigest: `sha256:${'b'.repeat(64)}`,
      uiArtifactDigest: `sha256:${'c'.repeat(64)}`,
    },
    signature: { status: 'notProvided' },
    provenance: { status: 'notProvided' },
    curation: { status: 'notApplicable' },
    executableRealms: ['reactNative'],
    contributions: [{ family: 'ui.renderers', count: 1 }],
    uiArtifacts: { status: 'verified', contributionIds: ['main-native'] },
    requiredHostAccess: [],
    optionalHostAccess: [],
    compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
    updatePolicy: 'manual',
  };
}

describe('Plugin Platform candidate mobile QA', () => {
  it('admits only the canonical packed novel handoff and selects its device-isolated roots', async () => {
    const candidate = {
      schemaVersion: 1 as const,
      runId: 'candidate-device-qa',
      sdk: {
        packageName: '@happier-dev/plugin-sdk' as const,
        version: '0.3.1',
        integrity: 'sha512-sdk',
        tarballPath: '/candidate/sdk.tgz',
      },
      cli: {
        packageName: '@happier-dev/cli' as const,
        version: '0.9.4',
        integrity: 'sha512-cli',
        tarballPath: '/candidate/cli.tgz',
        entrypoint: 'package/bin/happier.mjs',
      },
    };
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

    const prepared = await preparePackedNovelConnectedAccountDeviceQa({
      candidate,
      handoffManifestPath: '/handoff/packed-novel-connected-account-qa.json',
      deps: {
        loadHandoff,
        assertCandidate,
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
    expect(prepared.isolation).toBe(handoff.consumers.device);
    expect(prepared.oauth).toBe(handoff.oauth);
  });

  it('fails closed unless the literal G5 candidate authorization is present', async () => {
    await expect(preparePluginPlatformCandidateQa({
      authorization: '',
      candidateManifestPath: '/missing/candidate.json',
      workDir: '/tmp/mobile-plugin-qa',
    })).rejects.toThrow(/G5_GENERATED_INPUTS_GREEN/);

    await expect(preparePluginPlatformCandidateQa({
      authorization: 'almost-green',
      candidateManifestPath: '/missing/candidate.json',
      workDir: '/tmp/mobile-plugin-qa',
    })).rejects.toThrow(/G5_GENERATED_INPUTS_GREEN/);
  });

  it('re-verifies exact candidate SRIs and packed identities before materializing the candidate CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-mobile-candidate-'));
    const sdkBytes = Buffer.from('sdk-candidate');
    const cliBytes = Buffer.from('cli-candidate');
    const sdkTarballPath = join(root, 'sdk.tgz');
    const cliTarballPath = join(root, 'cli.tgz');
    const candidateManifestPath = join(root, 'candidate.json');
    const installerBytes = {
      shell: Buffer.from('s'),
      powershell: Buffer.from('p'),
      publicKey: Buffer.from('k'),
    };
    await writeFile(sdkTarballPath, sdkBytes);
    await writeFile(cliTarballPath, cliBytes);
    await writeFile(join(root, 'install-dev.sh'), installerBytes.shell);
    await writeFile(join(root, 'install-dev.ps1'), installerBytes.powershell);
    await writeFile(join(root, 'happier-release.pub'), installerBytes.publicKey);
    await writeFile(candidateManifestPath, JSON.stringify({
      schemaVersion: 1,
      runId: 'g5-mobile-candidate',
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
          sha256: createHash('sha256').update(installerBytes.shell).digest('hex'),
          filePath: join(root, 'install-dev.sh'),
        },
        powershell: {
          kind: 'powershell',
          fileName: 'install-dev.ps1',
          sizeBytes: 1,
          sha256: createHash('sha256').update(installerBytes.powershell).digest('hex'),
          filePath: join(root, 'install-dev.ps1'),
        },
        publicKey: {
          kind: 'minisign-public-key',
          fileName: 'happier-release.pub',
          sizeBytes: 1,
          sha256: createHash('sha256').update(installerBytes.publicKey).digest('hex'),
          filePath: join(root, 'happier-release.pub'),
        },
      },
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.1.0',
        integrity: sri(sdkBytes),
        tarballPath: sdkTarballPath,
      },
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.3.0',
        integrity: sri(cliBytes),
        tarballPath: cliTarballPath,
        entrypoint: 'package/bin/happier.mjs',
      },
    }));

    const materializePackedCli = vi.fn(async () => join(root, 'installed-cli/bin/happier.mjs'));
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
          builtWith: { bundler: 'vite' as const, version: '7.0.0' },
          hostUiApiVersion: '1',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        ios: {
          artifactDigest: 'sha256:ios',
          builtWith: { bundler: 'repack' as const, version: '5.2.5' },
          hostUiApiVersion: '1',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        android: {
          artifactDigest: 'sha256:android',
          builtWith: { bundler: 'repack' as const, version: '5.2.5' },
          hostUiApiVersion: '1',
          compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
      },
    }));
    const prepared = await preparePluginPlatformCandidateQa({
      authorization: G5_GENERATED_INPUTS_AUTHORIZATION,
      candidateManifestPath,
      workDir: join(root, 'work'),
      deps: {
        readPackedPackageManifest: vi.fn(async (path: string) => path === sdkTarballPath
          ? { name: '@happier-dev/plugin-sdk', version: '0.1.0' }
          : {
              name: '@happier-dev/cli',
              version: '0.3.0',
              bin: { happier: 'bin/happier.mjs' },
        }),
        materializePackedCli,
        attestPackedInspectorArtifacts,
      },
    });

    expect(prepared.candidate.runId).toBe('g5-mobile-candidate');
    expect(prepared.cliEntrypoint).toContain('installed-cli/bin/happier.mjs');
    expect(prepared.inspectorArtifacts.ios.artifactDigest).toBe('sha256:ios');
    expect(prepared.inspectorArtifacts.android.artifactDigest).toBe('sha256:android');
    expect(materializePackedCli).toHaveBeenCalledWith(expect.objectContaining({
      cliArtifact: expect.objectContaining({ integrity: sri(cliBytes) }),
    }));

    await writeFile(cliTarballPath, 'tampered');
    await expect(preparePluginPlatformCandidateQa({
      authorization: G5_GENERATED_INPUTS_AUTHORIZATION,
      candidateManifestPath,
      workDir: join(root, 'tampered-work'),
      deps: {
        readPackedPackageManifest: vi.fn(),
        materializePackedCli,
        attestPackedInspectorArtifacts,
      },
    })).rejects.toThrow(/CLI tarball integrity mismatch/);
  });

  it('verifies a private reusable packed CLI install before returning its real entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plugin-mobile-reused-cli-'));
    const packageRoot = join(root, 'node_modules', '@happier-dev', 'cli');
    await mkdir(join(packageRoot, 'bin'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.10',
      bin: { happier: './bin/happier.mjs' },
    }));
    await writeFile(join(packageRoot, 'bin', 'happier.mjs'), '#!/usr/bin/env node\n');

    const resolvedEntrypoint = await resolveReusablePackedCliEntrypoint({
      installRoot: root,
      cliArtifact: {
        packageName: '@happier-dev/cli',
        version: '0.2.10',
        integrity: 'sha512-placeholder',
        tarballPath: '/tmp/cli.tgz',
        entrypoint: 'package/bin/happier.mjs',
      },
    });
    expect(resolvedEntrypoint.endsWith(
      '/node_modules/@happier-dev/cli/bin/happier.mjs',
    )).toBe(true);
    expect((await stat(resolvedEntrypoint)).isFile()).toBe(true);

    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli',
      version: '0.2.9',
      bin: { happier: './bin/happier.mjs' },
    }));
    await expect(resolveReusablePackedCliEntrypoint({
      installRoot: root,
      cliArtifact: {
        packageName: '@happier-dev/cli',
        version: '0.2.10',
        integrity: 'sha512-placeholder',
        tarballPath: '/tmp/cli.tgz',
        entrypoint: 'package/bin/happier.mjs',
      },
    })).rejects.toThrow(/identity mismatch/);
  });

  it('orders UI lifecycle, update, offline recovery, rollback, cache replacement, and uninstall phases', async () => {
    const events: string[] = [];
    const reviews = [
      {
        pendingChangeId: 'pending-v1',
        review: mobileInstallationReview('1.0.0', '/candidate/plugin-v1.tgz'),
      },
      {
        pendingChangeId: 'pending-v2',
        review: mobileInstallationReview('2.0.0', '/candidate/plugin-v2.tgz'),
      },
    ];
    const runFlow = vi.fn(async (flow: string) => {
      events.push(`flow:${flow}`);
      return { exitCode: 0 };
    });
    const runCli = vi.fn(async (args: readonly string[]) => {
      events.push(`cli:${args.join(' ')}`);
      if (args[1] === 'install') {
        const requested = reviews.shift();
        if (!requested) throw new Error('unexpected install');
        return JSON.stringify({
          ok: false,
          kind: 'plugins_install',
          error: {
            code: 'review_required',
            details: requested,
          },
        });
      }
      return JSON.stringify({ ok: true });
    });
    const decideInstallReview = vi.fn(async (input: {
      pendingChangeId: string;
      review: Readonly<Record<string, unknown>>;
    }) => {
      events.push(`review:${input.pendingChangeId}:${String(input.review.version)}`);
    });
    const stopDaemon = vi.fn(async () => {
      events.push('daemon:stop');
    });
    const startDaemon = vi.fn(async () => {
      events.push('daemon:start');
    });

    const exitCode = await runPluginPlatformCandidateQaPhases({
      pluginId: 'acme.mobile-candidate',
      installArchivePath: '/candidate/plugin-v1.tgz',
      updateArchivePath: '/candidate/plugin-v2.tgz',
      runFlow,
      runCli,
      decideInstallReview,
      stopDaemon,
      startDaemon,
    });

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      'cli:plugins install /candidate/plugin-v1.tgz --kind archive --json',
      'review:pending-v1:1.0.0',
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/online-install-and-inspector.yaml',
      'cli:plugins install /candidate/plugin-v2.tgz --kind archive --json',
      'review:pending-v2:2.0.0',
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/updated-cache-replacement.yaml',
      'daemon:stop',
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/offline-read-only.yaml',
      'daemon:start',
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/reconnected.yaml',
      'cli:plugins rollback acme.mobile-candidate --json',
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/rolled-back.yaml',
      'cli:plugins uninstall acme.mobile-candidate --json',
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/uninstalled.yaml',
    ]);
    expect(decideInstallReview).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a non-interactive install omits the exact review continuation', async () => {
    const decideInstallReview = vi.fn();

    await expect(runPluginPlatformCandidateQaPhases({
      pluginId: 'acme.mobile-candidate',
      installArchivePath: '/candidate/plugin-v1.tgz',
      updateArchivePath: '/candidate/plugin-v2.tgz',
      runFlow: vi.fn(),
      runCli: vi.fn(async () => JSON.stringify({ ok: true })),
      decideInstallReview,
      stopDaemon: vi.fn(),
      startDaemon: vi.fn(),
    })).rejects.toThrow(/review_required/);

    expect(decideInstallReview).not.toHaveBeenCalled();
  });
});
