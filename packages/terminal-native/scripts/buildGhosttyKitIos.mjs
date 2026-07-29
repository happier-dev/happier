import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

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
const existingArtifactExpectedSha256 = installPathOverride
  ? explicitExpectedSha256
  : (explicitExpectedSha256 ?? rendererPolicy.iosGhostty.artifact.expandedSha256);

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

  writeJsonLine({
    status: 'blocked',
    renderer: rendererPolicy.iosGhostty.renderer,
    reason: 'missing-libghostty-spm-ghosttykit-xcframework',
    fallbackRenderer: 'xterm-webview',
    fallbackRequired: true,
    artifactPath: rendererPolicy.iosGhostty.artifact.path,
    sourceEnv: 'HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_XCFRAMEWORK',
    requiredGates: [
      'pin libghostty-spm version or revision',
      'set HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_XCFRAMEWORK to an expanded pinned GhosttyKit.xcframework',
      'produce ios-arm64 and ios-arm64-simulator slices',
      'verify checksum, wrapper source/patch provenance, license, size, ABI smoke, and App Store/export review',
    ],
    verifier: existing,
    referenceImplementations: rendererPolicy.iosGhostty.referenceImplementations,
  });
  process.exitCode = 1;
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
    const vendorDir = dirname(artifactPath);
    const tempArtifactPath = join(vendorDir, `.GhosttyKit.xcframework.${process.pid}.tmp`);
    await mkdir(vendorDir, { recursive: true });
    await rm(tempArtifactPath, { force: true, recursive: true });
    try {
      await materializeGhosttyKitArtifact(explicitXcframeworkPath, tempArtifactPath);
      const installed = await validateGhosttyKitArtifact({
        artifactPath: tempArtifactPath,
      });
      if (installed.status !== 'ok') {
        writeJsonLine({
          status: 'blocked',
          renderer: rendererPolicy.iosGhostty.renderer,
          reason: 'copied-ghosttykit-artifact-failed-verification',
          fallbackRenderer: 'xterm-webview',
          fallbackRequired: true,
          sourceArtifactPath: explicitXcframeworkPath,
          artifactPath: installedArtifactPath,
          verifier: installed,
        });
        process.exitCode = 1;
      } else {
        await rm(artifactPath, { force: true, recursive: true });
        await rename(tempArtifactPath, artifactPath);
        writeJsonLine({
          status: 'ok',
          renderer: rendererPolicy.iosGhostty.renderer,
          source: source.sourceKind === 'xcframework-zip'
            ? 'explicit-local-xcframework-zip'
            : 'explicit-local-xcframework',
          sourceArtifactPath: explicitXcframeworkPath,
          artifactPath: installedArtifactPath,
          installedArtifactPath,
          slices: installed.slices,
          checksum: source.checksum,
          installedChecksum: installed.checksum,
        });
      }
    } finally {
      await rm(tempArtifactPath, { force: true, recursive: true });
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
