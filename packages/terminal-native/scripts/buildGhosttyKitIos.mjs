import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { downloadPinnedGhosttyKitArchive } from './ghosttyKitIosDownload.mjs';
import { validateGhosttyKitArtifact } from './probeIos.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rendererPolicy = JSON.parse(await readFile(join(packageRoot, 'native-renderers.json'), 'utf-8'));
const configuredArtifactPath = rendererPolicy.iosGhostty.artifact.path;
const installPathOverride = process.env.HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_INSTALL_PATH?.trim();
const artifactPath = installPathOverride
  ? (installPathOverride.startsWith('/') ? installPathOverride : join(packageRoot, installPathOverride))
  : join(packageRoot, configuredArtifactPath);
const installedArtifactPath = installPathOverride || configuredArtifactPath;
const explicitXcframeworkPath = process.env.HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_XCFRAMEWORK;
const explicitExpectedSha256 = process.env.HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256;
const artifactPolicy = rendererPolicy.iosGhostty.artifact;
const existingArtifactExpectedSha256 = installPathOverride
  ? explicitExpectedSha256
  : (explicitExpectedSha256 ?? artifactPolicy.expandedSha256);

if (!explicitXcframeworkPath) {
  const existing = await validateGhosttyKitArtifact({
    artifactPath,
    expectedSha256: existingArtifactExpectedSha256,
  });
  if (existing.status === 'ok') {
    if (!existingArtifactExpectedSha256) {
      writeJsonLine(missingChecksumPayload({
        artifactPath: installedArtifactPath,
        source: 'existing-vendored-artifact',
        checksum: existing.checksum,
      }));
      process.exitCode = 1;
      process.exit();
    }
    writeJsonLine({
      status: 'ok',
      renderer: rendererPolicy.iosGhostty.renderer,
      artifactPath: installedArtifactPath,
      installedArtifactPath,
      source: 'existing-vendored-artifact',
      slices: existing.slices,
      checksum: existing.checksum,
    });
    process.exit(0);
  }

  const downloadRoot = await mkdtemp(join(tmpdir(), 'happier-ghosttykit-download-'));
  const downloadedArtifactPath = join(downloadRoot, 'GhosttyKit.xcframework.zip');
  try {
    const downloaded = await downloadPinnedGhosttyKitArchive({
      sourceUrl: artifactPolicy.upstreamDownloadUrl,
      destinationPath: downloadedArtifactPath,
      expectedSha256: artifactPolicy.upstreamZipSha256,
    });
    const source = await validateGhosttyKitArtifact({
      artifactPath: downloadedArtifactPath,
      expectedSha256: artifactPolicy.upstreamZipSha256,
    });
    if (source.status !== 'ok') {
      writeJsonLine({
        status: 'blocked',
        renderer: rendererPolicy.iosGhostty.renderer,
        reason: 'invalid-pinned-libghostty-spm-ghosttykit-xcframework',
        fallbackRenderer: 'xterm-webview',
        fallbackRequired: true,
        sourceUrl: artifactPolicy.upstreamDownloadUrl,
        artifactPath: installedArtifactPath,
        verifier: source,
      });
      process.exitCode = 1;
    } else {
      const installed = await installGhosttyKitArtifact({
        sourceArtifactPath: downloadedArtifactPath,
        source,
        sourceLabel: 'pinned-libghostty-spm-release-xcframework-zip',
        installedExpectedSha256: artifactPolicy.expandedSha256,
        downloadedChecksum: downloaded.checksum,
      });
      writeJsonLine(installed);
      if (installed.status !== 'ok') {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    writeJsonLine({
      status: 'blocked',
      renderer: rendererPolicy.iosGhostty.renderer,
      reason: 'pinned-libghostty-spm-download-failed',
      fallbackRenderer: 'xterm-webview',
      fallbackRequired: true,
      sourceUrl: artifactPolicy.upstreamDownloadUrl,
      artifactPath: installedArtifactPath,
      verifier: existing,
      detail: error instanceof Error ? error.message : 'Pinned GhosttyKit download failed.',
    });
    process.exitCode = 1;
  } finally {
    await rm(downloadRoot, { force: true, recursive: true });
  }
} else {
  if (!explicitExpectedSha256) {
    writeJsonLine(missingChecksumPayload({
      sourceArtifactPath: explicitXcframeworkPath,
      artifactPath: installedArtifactPath,
    }));
    process.exitCode = 1;
    process.exit();
  }

  const source = await validateGhosttyKitArtifact({
    artifactPath: explicitXcframeworkPath,
    expectedSha256: explicitExpectedSha256,
  });
  if (source.status !== 'ok') {
    writeJsonLine({
      status: 'blocked',
      renderer: rendererPolicy.iosGhostty.renderer,
      reason: 'invalid-libghostty-spm-ghosttykit-xcframework',
      fallbackRenderer: 'xterm-webview',
      fallbackRequired: true,
      sourceArtifactPath: explicitXcframeworkPath,
      artifactPath: installedArtifactPath,
      verifier: source,
    });
    process.exitCode = 1;
  } else {
    const installed = await installGhosttyKitArtifact({
      sourceArtifactPath: explicitXcframeworkPath,
      source,
      sourceLabel: source.sourceKind === 'xcframework-zip'
        ? 'explicit-local-xcframework-zip'
        : 'explicit-local-xcframework',
      installedExpectedSha256: source.sourceKind === 'expanded-xcframework'
        ? explicitExpectedSha256
        : explicitExpectedSha256 === artifactPolicy.upstreamZipSha256
          ? artifactPolicy.expandedSha256
          : undefined,
    });
    writeJsonLine(installed);
    if (installed.status !== 'ok') {
      process.exitCode = 1;
    }
  }
}

function writeJsonLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function missingChecksumPayload(fields = {}) {
  return {
    status: 'blocked',
    renderer: rendererPolicy.iosGhostty.renderer,
    reason: 'missing-checksum-pinned-artifact',
    fallbackRenderer: 'xterm-webview',
    fallbackRequired: true,
    checksumEnv: 'HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256',
    requiredGates: [
      'set HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256 to the approved sha256 for the pinned GhosttyKit.xcframework',
      'verify checksum, wrapper source/patch provenance, license, size, ABI smoke, and App Store/export review before installing',
    ],
    ...fields,
  };
}

async function installGhosttyKitArtifact({
  sourceArtifactPath,
  source,
  sourceLabel,
  installedExpectedSha256,
  downloadedChecksum,
}) {
  const vendorDir = dirname(artifactPath);
  const tempArtifactPath = join(vendorDir, `.GhosttyKit.xcframework.${process.pid}.tmp`);
  await mkdir(vendorDir, { recursive: true });
  await rm(tempArtifactPath, { force: true, recursive: true });
  try {
    await materializeGhosttyKitArtifact(sourceArtifactPath, tempArtifactPath);
    const copied = await validateGhosttyKitArtifact({
      artifactPath: tempArtifactPath,
      expectedSha256: installedExpectedSha256,
    });
    if (copied.status !== 'ok') {
      return {
        status: 'blocked',
        renderer: rendererPolicy.iosGhostty.renderer,
        reason: 'copied-ghosttykit-artifact-failed-verification',
        fallbackRenderer: 'xterm-webview',
        fallbackRequired: true,
        sourceArtifactPath,
        artifactPath: installedArtifactPath,
        verifier: copied,
      };
    }

    await rm(artifactPath, { force: true, recursive: true });
    await rename(tempArtifactPath, artifactPath);
    const persisted = await validateGhosttyKitArtifact({
      artifactPath,
      expectedSha256: installedExpectedSha256,
    });
    if (persisted.status !== 'ok') {
      return {
        status: 'blocked',
        renderer: rendererPolicy.iosGhostty.renderer,
        reason: 'installed-ghosttykit-artifact-failed-verification',
        fallbackRenderer: 'xterm-webview',
        fallbackRequired: true,
        sourceArtifactPath,
        artifactPath: installedArtifactPath,
        verifier: persisted,
      };
    }

    return {
      status: 'ok',
      renderer: rendererPolicy.iosGhostty.renderer,
      source: sourceLabel,
      sourceArtifactPath,
      artifactPath: installedArtifactPath,
      installedArtifactPath,
      slices: persisted.slices,
      checksum: source.checksum,
      installedChecksum: persisted.checksum,
      ...(downloadedChecksum ? { downloadedChecksum } : {}),
    };
  } finally {
    await rm(tempArtifactPath, { force: true, recursive: true });
  }
}

async function materializeGhosttyKitArtifact(sourcePath, destinationPath) {
  if (!sourcePath.endsWith('.zip')) {
    await cp(sourcePath, destinationPath, { recursive: true });
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'happier-ghosttykit-install-'));
  try {
    await execFileAsync('unzip', ['-q', sourcePath, '-d', root], {
      maxBuffer: 1024 * 1024,
    });
    await cp(join(root, 'GhosttyKit.xcframework'), destinationPath, { recursive: true });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
