import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PackedAuthorCandidate } from '../../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';

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
    signature: { status: 'notProvided' },
    provenance: { status: 'notProvided' },
    curation: { status: 'notApplicable' },
    executableRealms: ['reactNative'],
    contributions: [{ family: 'ui.renderers', count: 1 }],
    requestInterceptors: [],
    uiArtifacts: { status: 'verified', contributionIds: ['main-native'] },
    requiredHostAccess: [],
    optionalHostAccess: [],
    rawCredentialAccess: [],
    compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
    updatePolicy: 'manual',
  };
}

describe('Plugin Platform candidate mobile QA', () => {
  it('admits only the canonical packed novel handoff and selects its device-isolated roots', async () => {
    const candidate: PackedAuthorCandidate = {
      schemaVersion: 1 as const,
      runId: 'candidate-device-qa',
      installers: {
        releaseChannel: 'dev' as const,
        shell: { kind: 'shell' as const, fileName: 'install-dev.sh' as const, sizeBytes: 1, sha256: '1'.repeat(64), filePath: '/candidate/install-dev.sh' },
        powershell: { kind: 'powershell' as const, fileName: 'install-dev.ps1' as const, sizeBytes: 1, sha256: '2'.repeat(64), filePath: '/candidate/install-dev.ps1' },
        publicKey: { kind: 'minisign-public-key' as const, fileName: 'happier-release.pub' as const, sizeBytes: 1, sha256: '3'.repeat(64), filePath: '/candidate/happier-release.pub' },
      },
      sdk: {
        packageName: '@happier-dev/plugin-sdk' as const,
        version: '0.3.1',
        integrity: 'sha512-sdk',
        tarballPath: '/candidate/sdk.tgz',
      },
      pluginUi: {
        packageName: '@happier-dev/plugin-ui' as const,
        version: '0.3.1',
        pluginSdkVersion: '0.3.1',
        integrity: 'sha512-plugin-ui',
        tarballPath: '/candidate/plugin-ui.tgz',
      },
      cli: {
        packageName: '@happier-dev/cli' as const,
        version: '0.9.4',
        integrity: 'sha512-cli',
        tarballPath: '/candidate/cli.tgz',
        entrypoint: 'package/bin/happier.mjs',
      },
      standaloneCli: {
        product: 'happier' as const,
        version: '0.9.4',
        os: 'linux',
        arch: 'x64' as const,
        sha256: '4'.repeat(64),
        archivePath: '/candidate/happier-v0.9.4-linux-x64.tar.gz',
        archives: [{ product: 'happier' as const, version: '0.9.4', os: 'linux', arch: 'x64' as const, sha256: '4'.repeat(64), archivePath: '/candidate/happier-v0.9.4-linux-x64.tar.gz' }],
        checksums: { kind: 'sha256-checksums' as const, fileName: 'checksums-happier-v0.9.4.txt' as const, sizeBytes: 1, sha256: '5'.repeat(64), filePath: '/candidate/checksums-happier-v0.9.4.txt' },
        signature: { kind: 'minisign-signature' as const, fileName: 'checksums-happier-v0.9.4.txt.minisig' as const, sizeBytes: 1, sha256: '6'.repeat(64), filePath: '/candidate/checksums-happier-v0.9.4.txt.minisig' },
        notarization: [],
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
    expect(prepared.publicAuthoring).toBe(handoff.publicAuthoring);
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
    const pluginUiBytes = Buffer.from('plugin-ui-candidate');
    const cliBytes = Buffer.from('cli-candidate');
    const sdkTarballPath = join(root, 'sdk.tgz');
    const pluginUiTarballPath = join(root, 'plugin-ui.tgz');
    const cliTarballPath = join(root, 'cli.tgz');
    const candidateManifestPath = join(root, 'candidate.json');
    const installerBytes = {
      shell: Buffer.from('s'),
      powershell: Buffer.from('p'),
      publicKey: Buffer.from('k'),
    };
    await writeFile(sdkTarballPath, sdkBytes);
    await writeFile(pluginUiTarballPath, pluginUiBytes);
    await writeFile(cliTarballPath, cliBytes);
    await writeFile(join(root, 'install-dev.sh'), installerBytes.shell);
    await writeFile(join(root, 'install-dev.ps1'), installerBytes.powershell);
    await writeFile(join(root, 'happier-release.pub'), installerBytes.publicKey);
    const candidate: PackedAuthorCandidate = {
      schemaVersion: 1,
      runId: 'g5-mobile-candidate',
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
      pluginUi: {
        packageName: '@happier-dev/plugin-ui',
        version: '0.1.0',
        pluginSdkVersion: '0.1.0',
        integrity: sri(pluginUiBytes),
        tarballPath: pluginUiTarballPath,
      },
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.3.0',
        integrity: sri(cliBytes),
        tarballPath: cliTarballPath,
        entrypoint: 'package/bin/happier.mjs',
      },
      standaloneCli: {
        product: 'happier' as const,
        version: '0.3.0',
        os: 'linux',
        arch: 'x64' as const,
        sha256: '4'.repeat(64),
        archivePath: join(root, 'happier-v0.3.0-linux-x64.tar.gz'),
        archives: [{ product: 'happier' as const, version: '0.3.0', os: 'linux', arch: 'x64' as const, sha256: '4'.repeat(64), archivePath: join(root, 'happier-v0.3.0-linux-x64.tar.gz') }],
        checksums: { kind: 'sha256-checksums' as const, fileName: 'checksums-happier-v0.3.0.txt' as const, sizeBytes: 1, sha256: '5'.repeat(64), filePath: join(root, 'checksums-happier-v0.3.0.txt') },
        signature: { kind: 'minisign-signature' as const, fileName: 'checksums-happier-v0.3.0.txt.minisig' as const, sizeBytes: 1, sha256: '6'.repeat(64), filePath: join(root, 'checksums-happier-v0.3.0.txt.minisig') },
        notarization: [],
      },
    };
    await writeFile(candidateManifestPath, JSON.stringify(candidate));

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
    let mutatedSharedArtifacts = false;
    const readPackedPackageManifest = vi.fn(async (path: string) => {
      expect(path).not.toBe(sdkTarballPath);
      expect(path).not.toBe(pluginUiTarballPath);
      expect(path).not.toBe(cliTarballPath);
      if (!mutatedSharedArtifacts) {
        mutatedSharedArtifacts = true;
        await Promise.all([
          writeFile(sdkTarballPath, 'mutated-sdk-after-verification'),
          writeFile(pluginUiTarballPath, 'mutated-plugin-ui-after-verification'),
          writeFile(cliTarballPath, 'mutated-cli-after-verification'),
        ]);
      }
      if (path.endsWith('sdk.tgz')) {
        expect(await readFile(path)).toEqual(sdkBytes);
        return { name: '@happier-dev/plugin-sdk', version: '0.1.0' };
      }
      if (path.endsWith('plugin-ui.tgz')) {
        expect(await readFile(path)).toEqual(pluginUiBytes);
        return {
          name: '@happier-dev/plugin-ui',
          version: '0.1.0',
          dependencies: { '@happier-dev/plugin-sdk': '0.1.0' },
        };
      }
      expect(await readFile(path)).toEqual(cliBytes);
      return {
        name: '@happier-dev/cli',
        version: '0.3.0',
        bin: { happier: 'bin/happier.mjs' },
      };
    });
    let removeAttempts = 0;
    const removeCapturedRoot = vi.fn(async (
      path: Parameters<typeof rm>[0],
      options?: Parameters<typeof rm>[1],
    ) => {
      removeAttempts += 1;
      if (removeAttempts === 1) throw new Error('transient mobile cleanup failure');
      await rm(path, options);
    });
    const prepared = await preparePluginPlatformCandidateQa({
      authorization: G5_GENERATED_INPUTS_AUTHORIZATION,
      candidateManifestPath,
      workDir: join(root, 'work'),
      deps: {
        loadCandidate: async () => candidate,
        readPackedPackageManifest,
        materializePackedCli,
        attestPackedInspectorArtifacts,
        removeCapturedRoot,
      },
    });

    expect(prepared.candidate.runId).toBe('g5-mobile-candidate');
    expect(prepared.cliEntrypoint).toContain('installed-cli/bin/happier.mjs');
    expect(prepared.inspectorArtifacts.ios.artifactDigest).toBe('sha256:ios');
    expect(prepared.inspectorArtifacts.android.artifactDigest).toBe('sha256:android');
    expect(prepared.candidate.sdk.tarballPath).not.toBe(sdkTarballPath);
    expect(prepared.candidate.pluginUi.tarballPath).not.toBe(pluginUiTarballPath);
    expect(prepared.candidate.cli.tarballPath).not.toBe(cliTarballPath);
    expect(materializePackedCli).toHaveBeenCalledWith(expect.objectContaining({
      cliArtifact: expect.objectContaining({ integrity: sri(cliBytes) }),
    }));
    const captureRoot = dirname(dirname(prepared.candidate.sdk.tarballPath));
    const firstCleanup = prepared.cleanup();
    const firstCleanupRejection = expect(firstCleanup).rejects.toThrow(
      /transient mobile cleanup failure/,
    );
    const concurrentCleanup = prepared.cleanup();
    expect(firstCleanup).toBe(concurrentCleanup);
    await firstCleanupRejection;
    const successfulCleanup = prepared.cleanup();
    await successfulCleanup;
    expect(prepared.cleanup()).toBe(successfulCleanup);
    expect(removeCapturedRoot).toHaveBeenCalledTimes(2);
    await expect(access(captureRoot)).rejects.toThrow();

    await Promise.all([
      writeFile(sdkTarballPath, sdkBytes),
      writeFile(pluginUiTarballPath, pluginUiBytes),
      writeFile(cliTarballPath, cliBytes),
    ]);
    const failedWorkDir = join(root, 'failed-setup-work');
    let failedSetupCleanupAttempts = 0;
    await expect(preparePluginPlatformCandidateQa({
      authorization: G5_GENERATED_INPUTS_AUTHORIZATION,
      candidateManifestPath,
      workDir: failedWorkDir,
      deps: {
        loadCandidate: async () => candidate,
        readPackedPackageManifest: async () => {
          throw new Error('package inspection failed after capture');
        },
        materializePackedCli,
        attestPackedInspectorArtifacts,
        removeCapturedRoot: async (path, options) => {
          failedSetupCleanupAttempts += 1;
          if (failedSetupCleanupAttempts === 1) {
            throw new Error('transient mobile preparation cleanup failure');
          }
          await rm(path, options);
        },
      },
    })).rejects.toThrow(/package inspection failed after capture/);
    expect(failedSetupCleanupAttempts).toBe(2);
    expect(
      (await readdir(failedWorkDir)).filter((name) => name.startsWith('verified-candidate-')),
    ).toEqual([]);

    const permanentlyFailedWorkDir = join(root, 'permanently-failed-setup-work');
    let permanentCleanupAttempts = 0;
    await expect(preparePluginPlatformCandidateQa({
      authorization: G5_GENERATED_INPUTS_AUTHORIZATION,
      candidateManifestPath,
      workDir: permanentlyFailedWorkDir,
      deps: {
        loadCandidate: async () => candidate,
        readPackedPackageManifest: async () => {
          throw new Error('permanent mobile package inspection failure');
        },
        materializePackedCli,
        attestPackedInspectorArtifacts,
        removeCapturedRoot: async () => {
          permanentCleanupAttempts += 1;
          throw new Error(`permanent mobile cleanup failure ${permanentCleanupAttempts}`);
        },
      },
    })).rejects.toSatisfy((error: unknown) => (
      error instanceof AggregateError
      && error.errors.map((entry) => entry.message).join('|')
        === [
          'permanent mobile package inspection failure',
          'permanent mobile cleanup failure 1',
          'permanent mobile cleanup failure 2',
        ].join('|')
    ));
    expect(permanentCleanupAttempts).toBe(2);

    await Promise.all([
      writeFile(sdkTarballPath, sdkBytes),
      writeFile(pluginUiTarballPath, pluginUiBytes),
      writeFile(cliTarballPath, 'tampered'),
    ]);
    await expect(preparePluginPlatformCandidateQa({
      authorization: G5_GENERATED_INPUTS_AUTHORIZATION,
      candidateManifestPath,
      workDir: join(root, 'tampered-work'),
      deps: {
        loadCandidate: async () => candidate,
        readPackedPackageManifest: vi.fn(),
        materializePackedCli,
        attestPackedInspectorArtifacts,
      },
    })).rejects.toThrow(/CLI tarball integrity mismatch/);
    await rm(root, { recursive: true, force: true });
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

  it('schedules the shared iOS and Android normal Triage journey after the baseline with schema-v2 handoff values', async () => {
    const flows: Array<Readonly<{
      flowPath: string;
      env: NodeJS.ProcessEnv | undefined;
    }>> = [];
    const runFlow = vi.fn(async (flowPath: string, env?: NodeJS.ProcessEnv) => {
      flows.push({ flowPath, env });
      return { exitCode: 0 };
    });
    const runCli = vi.fn(async (args: readonly string[]) => {
      if (args[1] !== 'install') return JSON.stringify({ ok: true });
      return JSON.stringify({
        ok: false,
        kind: 'plugins_install',
        error: {
          code: 'review_required',
          details: {
            pendingChangeId: `pending-${args[2] ?? 'archive'}`,
            review: mobileInstallationReview('1.0.0', args[2] ?? '/candidate/archive.tgz'),
          },
        },
      });
    });
    const input: Parameters<typeof runPluginPlatformCandidateQaPhases>[0] = {
      pluginId: 'acme.mobile-candidate',
      installArchivePath: '/candidate/plugin-v1.tgz',
      updateArchivePath: '/candidate/plugin-v2.tgz',
      targeted: {
        targetArchivePath: '/candidate/target-v1.tgz',
        contributorPluginId: 'examples.packed-targeted-projection-contributor',
        contributorV1ArchivePath: '/candidate/contributor-v1.tgz',
        contributorV2ArchivePath: '/candidate/contributor-v2.tgz',
      },
      triageGithubVoice: {
        githubToken: 'schema-v2-github-token',
        githubScopeTitle: 'happier-dev/happier',
        issueATitle: 'Issue A from schema-v2 handoff',
        issueBTitle: 'Issue B from schema-v2 handoff',
        voice: {
          adapterId: 'local_conversation',
          conversationMode: 'agent',
          agentId: 'claude',
          sttProviderId: 'happier.voice.openai-compat/stt',
          microphoneFixturePath: '/fixtures/schema-v2-microphone.wav',
        },
      },
      runFlow,
      runCli,
      requestPluginChange: vi.fn(async (request: Readonly<{
        kind: 'forgetTrust';
        pluginId: string;
      }>) => ({
        kind: 'committed' as const,
        pluginId: request.pluginId,
        desiredGeneration: 'generation-after-forget',
        appliedGeneration: null,
      })),
      decideInstallReview: vi.fn(async () => undefined),
      stopDaemon: vi.fn(async () => undefined),
      startDaemon: vi.fn(async () => undefined),
    };

    const exitCode = await runPluginPlatformCandidateQaPhases(input);

    expect(exitCode).toBe(0);
    const baselineIndex = flows.findIndex(({ flowPath }) => (
      flowPath === 'suites/mobile-e2e/flows/plugin-platform-candidate/ucx-baseline-navigation.yaml'
    ));
    const normalIndex = flows.findIndex(({ flowPath }) => (
      flowPath === 'suites/mobile-e2e/flows/plugin-platform-candidate/ucx-normal-triage-voice.yaml'
    ));
    const onlineIndex = flows.findIndex(({ flowPath }) => (
      flowPath === 'suites/mobile-e2e/flows/plugin-platform-candidate/online-install-and-inspector.yaml'
    ));
    expect(normalIndex).toBeGreaterThan(baselineIndex);
    expect(normalIndex).toBeLessThan(onlineIndex);
    expect(flows[normalIndex]).toEqual({
      flowPath: 'suites/mobile-e2e/flows/plugin-platform-candidate/ucx-normal-triage-voice.yaml',
      env: {
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_GITHUB_TOKEN: 'schema-v2-github-token',
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_SCOPE_TITLE: 'happier-dev/happier',
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ISSUE_A_TITLE: 'Issue A from schema-v2 handoff',
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_ISSUE_B_TITLE: 'Issue B from schema-v2 handoff',
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_ADAPTER_ID: 'local_conversation',
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_CONVERSATION_MODE: 'agent',
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_AGENT_ID: 'claude',
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_STT_PROVIDER_ID: 'happier.voice.openai-compat/stt',
        HAPPIER_E2E_TRIAGE_GITHUB_VOICE_QA_VOICE_MICROPHONE_FIXTURE_PATH: '/fixtures/schema-v2-microphone.wav',
      },
    });
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

  it('cycles the live v2 targeted contributor through disable, enable, trust revocation, re-review, and uninstall', async () => {
    const events: string[] = [];
    const runFlow = vi.fn(async (flow: string) => {
      events.push(`flow:${flow}`);
      return { exitCode: 0 };
    });
    const runCli = vi.fn(async (args: readonly string[]) => {
      events.push(`cli:${args.join(' ')}`);
      if (args[1] !== 'install') return JSON.stringify({ ok: true });
      const archive = args[2] ?? '';
      const version = archive.includes('v2') ? '2.0.0' : '1.0.0';
      const pluginId = archive.includes('contributor')
        ? 'examples.packed-targeted-projection-contributor'
        : archive.includes('targeted')
          ? 'examples.packed-targeted-projection-target'
          : 'acme.mobile-candidate';
      return JSON.stringify({
        ok: false,
        kind: 'plugins_install',
        error: {
          code: 'review_required',
          details: {
            pendingChangeId: `pending-${archive}`,
            review: {
              ...mobileInstallationReview(version, archive),
              pluginId,
            },
          },
        },
      });
    });
    const requestPluginChange = vi.fn(async (request: Readonly<{
      kind: 'forgetTrust';
      pluginId: string;
    }>) => {
      events.push(`change:${JSON.stringify(request)}`);
      return {
        kind: 'committed' as const,
        pluginId: request.pluginId,
        desiredGeneration: 'generation-after-forget',
        appliedGeneration: null,
      };
    });

    const exitCode = await runPluginPlatformCandidateQaPhases({
      pluginId: 'acme.mobile-candidate',
      installArchivePath: '/candidate/plugin-v1.tgz',
      updateArchivePath: '/candidate/plugin-v2.tgz',
      targeted: {
        targetArchivePath: '/candidate/target-v1.tgz',
        contributorPluginId: 'examples.packed-targeted-projection-contributor',
        contributorV1ArchivePath: '/candidate/contributor-v1.tgz',
        contributorV2ArchivePath: '/candidate/contributor-v2.tgz',
      },
      triageGithubVoice: {
        githubToken: 'schema-v2-github-token',
        githubScopeTitle: 'happier-dev/happier',
        issueATitle: 'Issue A from schema-v2 handoff',
        issueBTitle: 'Issue B from schema-v2 handoff',
        voice: {
          adapterId: 'local_conversation',
          conversationMode: 'agent',
          agentId: 'claude',
          sttProviderId: 'happier.voice.openai-compat/stt',
          microphoneFixturePath: '/fixtures/schema-v2-microphone.wav',
        },
      },
      runFlow,
      runCli,
      requestPluginChange,
      decideInstallReview: vi.fn(async () => undefined),
      stopDaemon: vi.fn(async () => {
        events.push('daemon:stop');
      }),
      startDaemon: vi.fn(async () => {
        events.push('daemon:start');
      }),
    });

    expect(exitCode).toBe(0);
    const baselineIndex = events.indexOf(
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/ucx-baseline-navigation.yaml',
    );
    const targetedV1InstallIndex = events.indexOf(
      'cli:plugins install /candidate/target-v1.tgz --kind archive --json',
    );
    const contributorV1InstallIndex = events.indexOf(
      'cli:plugins install /candidate/contributor-v1.tgz --kind archive --json',
    );
    const onlineIndex = events.indexOf(
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/online-install-and-inspector.yaml',
    );
    expect(baselineIndex).toBeGreaterThan(contributorV1InstallIndex);
    expect(baselineIndex).toBeGreaterThan(targetedV1InstallIndex);
    expect(baselineIndex).toBeLessThan(onlineIndex);
    const reconnectedIndex = events.indexOf(
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/reconnected.yaml',
    );
    const disableIndex = events.indexOf(
      'cli:plugins disable examples.packed-targeted-projection-contributor --json',
    );
    const disabledRetirementIndex = events.indexOf(
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/trust-revoked.yaml',
    );
    const enableIndex = events.indexOf(
      'cli:plugins enable examples.packed-targeted-projection-contributor --json',
    );
    const enabledLiveIndex = events.indexOf(
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/reconnected.yaml',
      enableIndex,
    );
    const forgetTrustIndex = events.indexOf(
      'change:{"kind":"forgetTrust","pluginId":"examples.packed-targeted-projection-contributor"}',
    );
    const trustRevokedIndex = events.indexOf(
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/trust-revoked.yaml',
      forgetTrustIndex,
    );
    const reinstalledV2Index = events.lastIndexOf(
      'cli:plugins install /candidate/contributor-v2.tgz --kind archive --json',
    );
    const reinstalledLiveIndex = events.indexOf(
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/reconnected.yaml',
      reinstalledV2Index,
    );
    const uninstallIndex = events.indexOf(
      'cli:plugins uninstall examples.packed-targeted-projection-contributor --json',
    );
    const uninstalledRetirementIndex = events.indexOf(
      'flow:suites/mobile-e2e/flows/plugin-platform-candidate/trust-revoked.yaml',
      uninstallIndex,
    );
    expect(reconnectedIndex).toBeGreaterThan(-1);
    expect(disableIndex).toBeGreaterThan(reconnectedIndex);
    expect(disabledRetirementIndex).toBeGreaterThan(disableIndex);
    expect(enableIndex).toBeGreaterThan(disabledRetirementIndex);
    expect(enabledLiveIndex).toBeGreaterThan(enableIndex);
    expect(forgetTrustIndex).toBeGreaterThan(enabledLiveIndex);
    expect(trustRevokedIndex).toBeGreaterThan(forgetTrustIndex);
    expect(reinstalledV2Index).toBeGreaterThan(trustRevokedIndex);
    expect(reinstalledLiveIndex).toBeGreaterThan(reinstalledV2Index);
    expect(uninstallIndex).toBeGreaterThan(reinstalledLiveIndex);
    expect(uninstalledRetirementIndex).toBeGreaterThan(uninstallIndex);
    expect(
      events.filter((event) => event === 'cli:plugins install /candidate/contributor-v2.tgz --kind archive --json'),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event === 'flow:suites/mobile-e2e/flows/plugin-platform-candidate/reconnected.yaml'),
    ).toHaveLength(3);
    expect(
      events.filter((event) => event === 'flow:suites/mobile-e2e/flows/plugin-platform-candidate/trust-revoked.yaml'),
    ).toHaveLength(3);
    expect(requestPluginChange).toHaveBeenCalledWith({
      kind: 'forgetTrust',
      pluginId: 'examples.packed-targeted-projection-contributor',
    });
  });
});
