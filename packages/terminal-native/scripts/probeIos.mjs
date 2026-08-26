import { access, mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { computeSha256ForPath } from './checksum.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rendererPolicy = JSON.parse(await readFile(join(packageRoot, 'native-renderers.json'), 'utf-8'));
const artifactPathOverride = process.env.HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_ARTIFACT_PATH?.trim();
const defaultArtifactPath = join(packageRoot, rendererPolicy.iosGhostty.artifact.path);
const REQUIRED_HEADER_HINTS = Object.freeze([
  'GHOSTTY_SURFACE_IO_BACKEND_HOST_MANAGED',
  'ghostty_surface_receive_buffer_cb',
  'ghostty_surface_receive_resize_cb',
  'ghostty_surface_write_buffer',
  'ghostty_surface_process_exit',
]);
const REQUIRED_MODULEMAP_HINT = 'module libghostty';
const REQUIRED_LIBRARY_NAME = 'libghostty.a';
const REQUIRED_HEADER_NAME = 'ghostty.h';

export async function validateGhosttyKitArtifact({
  artifactPath,
  expectedSha256,
  requiredSlices = rendererPolicy.iosGhostty.artifact.requiredSlices,
} = {}) {
  if (!artifactPath) {
    return blocked('missing-artifact-path', {
      detail: 'GhosttyKit.xcframework path is required.',
    });
  }

  const prepared = await prepareArtifactForValidation(artifactPath);
  if (prepared.status !== 'ok') {
    return prepared;
  }

  try {
    return await validateExpandedGhosttyKitArtifact({
      artifactPath: prepared.artifactPath,
      checksumPath: prepared.checksumPath,
      expectedSha256,
      requiredSlices,
      sourceKind: prepared.sourceKind,
    });
  } finally {
    if (prepared.cleanupPath) {
      await rm(prepared.cleanupPath, { force: true, recursive: true });
    }
  }
}

async function validateExpandedGhosttyKitArtifact({
  artifactPath,
  checksumPath,
  expectedSha256,
  requiredSlices,
  sourceKind,
}) {
  let artifactStat;
  try {
    artifactStat = await stat(artifactPath);
  } catch {
    return blocked('renderer-artifact-not-linked', {
      detail: `GhosttyKit.xcframework was not found at ${artifactPath}.`,
    });
  }

  if (!artifactStat.isDirectory()) {
    return blocked('invalid-artifact-shape', {
      detail: 'GhosttyKit artifact must be an expanded .xcframework directory.',
    });
  }

  const infoPlistPath = join(artifactPath, 'Info.plist');
  if (!await exists(infoPlistPath)) {
    return blocked('invalid-artifact-shape', {
      detail: 'GhosttyKit.xcframework is missing Info.plist.',
    });
  }

  const slices = [];
  const missingFiles = [];
  const missingHeaderHints = new Set();
  const invalidModuleMaps = [];

  for (const identifier of requiredSlices) {
    const slicePath = join(artifactPath, identifier);
    const archivePath = join(slicePath, REQUIRED_LIBRARY_NAME);
    const headerPath = join(slicePath, 'Headers', REQUIRED_HEADER_NAME);
    const modulemapPath = join(slicePath, 'Headers', 'module.modulemap');

    for (const requiredPath of [slicePath, archivePath, headerPath, modulemapPath]) {
      if (!await exists(requiredPath)) {
        missingFiles.push(requiredPath);
      }
    }

    if (await exists(headerPath)) {
      const header = await readFile(headerPath, 'utf-8');
      for (const hint of REQUIRED_HEADER_HINTS) {
        if (!header.includes(hint)) {
          missingHeaderHints.add(hint);
        }
      }
    }

    if (await exists(modulemapPath)) {
      const modulemap = await readFile(modulemapPath, 'utf-8');
      if (modulemap.includes('framework module') || !modulemap.includes(REQUIRED_MODULEMAP_HINT)) {
        invalidModuleMaps.push(modulemapPath);
      }
    }

    slices.push({
      identifier,
      libraryPath: archivePath,
      headerPath,
      modulemapPath,
    });
  }

  if (missingFiles.length > 0) {
    return blocked('invalid-artifact-shape', { missingFiles });
  }

  if (invalidModuleMaps.length > 0) {
    return blocked('invalid-modulemap', { invalidModuleMaps });
  }

  const missingHeaderHintsList = [...missingHeaderHints].sort();
  if (missingHeaderHintsList.length > 0) {
    return blocked('missing-host-managed-io-api', {
      missingHeaderHints: missingHeaderHintsList,
    });
  }

  const checksum = await validateChecksum(checksumPath, expectedSha256);
  if (checksum.status === 'mismatch') {
    return blocked('checksum-mismatch', { checksum });
  }

  return {
    status: 'ok',
    platform: 'ios',
    renderer: rendererPolicy.iosGhostty.renderer,
    artifactPath,
    sourceKind,
    slices,
    headerHints: {
      required: REQUIRED_HEADER_HINTS,
      missing: [],
    },
    checksum,
  };
}

async function prepareArtifactForValidation(artifactPath) {
  let artifactStat;
  try {
    artifactStat = await stat(artifactPath);
  } catch {
    return blocked('renderer-artifact-not-linked', {
      detail: `GhosttyKit.xcframework was not found at ${artifactPath}.`,
    });
  }

  if (artifactStat.isDirectory()) {
    return {
      status: 'ok',
      artifactPath,
      checksumPath: artifactPath,
      sourceKind: 'expanded-xcframework',
    };
  }

  if (!artifactStat.isFile() || !artifactPath.endsWith('.zip')) {
    return blocked('invalid-artifact-shape', {
      detail: 'GhosttyKit artifact must be an expanded .xcframework directory or .xcframework.zip file.',
    });
  }

  const root = await mkdtemp(join(tmpdir(), 'happier-ghosttykit-'));
  try {
    await execFileAsync('unzip', ['-q', artifactPath, '-d', root], {
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    return blocked('invalid-artifact-zip', {
      detail: error instanceof Error ? error.message : 'Failed to unzip GhosttyKit artifact.',
    });
  }

  return {
    status: 'ok',
    artifactPath: join(root, 'GhosttyKit.xcframework'),
    checksumPath: artifactPath,
    cleanupPath: root,
    sourceKind: 'xcframework-zip',
  };
}

async function main() {
  const artifactPath = artifactPathOverride
    ? (artifactPathOverride.startsWith('/') ? artifactPathOverride : join(packageRoot, artifactPathOverride))
    : defaultArtifactPath;
  const expectedSha256 = process.env.HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256
    ?? selectPolicyChecksumForGhosttyKitArtifact({
      artifactPath,
      defaultArtifactPath,
      artifactPolicy: rendererPolicy.iosGhostty.artifact,
    });
  const gates = readIosGhosttyGates();
  if (artifactPath !== defaultArtifactPath && !expectedSha256) {
    writeJsonLine({
      status: 'blocked',
      platform: 'ios',
      renderer: rendererPolicy.iosGhostty.renderer,
      reason: 'missing-checksum-pinned-artifact',
      detail: 'Explicit GhosttyKit probe overrides require an exact SHA-256 checksum.',
      fallbackRenderer: 'xterm-webview',
      fallbackRequired: true,
      artifactPath: rendererPolicy.iosGhostty.artifact.path,
      linkedArtifactPath: artifactPath,
      checksumEnv: 'HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256',
      gates,
      requiredGates: rendererPolicy.iosGhostty.gates,
    });
    return;
  }
  const result = await validateGhosttyKitArtifact({
    artifactPath,
    expectedSha256,
  });

  if (result.status === 'ok') {
    const blocker = collectIosGhosttyBlockers(gates)[0];
    if (blocker) {
      writeJsonLine({
        status: 'blocked',
        platform: 'ios',
        renderer: rendererPolicy.iosGhostty.renderer,
        reason: blocker.reason,
        detail: blocker.detail,
        fallbackRenderer: 'xterm-webview',
        fallbackRequired: true,
        artifactPath: rendererPolicy.iosGhostty.artifact.path,
        linkedArtifactPath: artifactPath,
        gates,
        requiredGates: rendererPolicy.iosGhostty.gates,
        verifier: result,
        remediation: [
          'Keep xterm WebView selected until package proof and crash fallback proof gates pass.',
          'Use terminalRendererPreference=native only after hard package/crash gates pass if native accessibility is still fallback-required.',
        ],
      });
      return;
    }

    const accessibility = gates.nativeAccessibilityProven ? 'native' : 'fallback-required';
    writeJsonLine({
      ...result,
      reason: 'available',
      fallbackRenderer: 'xterm-webview',
      fallbackRequired: accessibility !== 'native',
      availability: {
        available: true,
        platform: 'ios',
        renderer: rendererPolicy.iosGhostty.renderer,
        moduleVersion: '0.0.0',
        accessibility,
      },
      gates,
      requiredGates: rendererPolicy.iosGhostty.gates,
    });
    return;
  }

  writeJsonLine({
    status: 'blocked',
    platform: 'ios',
    renderer: rendererPolicy.iosGhostty.renderer,
    reason: result.reason,
    detail: result.detail,
    fallbackRenderer: 'xterm-webview',
    fallbackRequired: true,
    artifactPath: rendererPolicy.iosGhostty.artifact.path,
    linkedArtifactPath: artifactPath,
    gates,
    requiredGates: rendererPolicy.iosGhostty.gates,
    remediation: [
      'Provide a pinned/checksummed libghostty-spm GhosttyKit.xcframework or trigger the direct Ghostty build escape hatch.',
      'Keep xterm WebView selected until package, crash fallback, and accessibility gates pass.',
    ],
    referenceImplementations: rendererPolicy.iosGhostty.referenceImplementations,
    missingFiles: result.missingFiles,
    missingHeaderHints: result.missingHeaderHints,
    invalidModuleMaps: result.invalidModuleMaps,
    checksum: result.checksum,
  });
}

function readIosGhosttyGates() {
  return {
    packageProofAccepted: readBooleanEnv('HAPPIER_TERMINAL_NATIVE_IOS_PACKAGE_PROOF_ACCEPTED'),
    crashFallbackProven: readBooleanEnv('HAPPIER_TERMINAL_NATIVE_IOS_CRASH_FALLBACK_PROVEN'),
    nativeAccessibilityProven: readBooleanEnv('HAPPIER_TERMINAL_NATIVE_IOS_ACCESSIBILITY_NATIVE'),
  };
}

function collectIosGhosttyBlockers(gates) {
  const blockers = [];
  if (!gates.packageProofAccepted) {
    blockers.push({
      reason: 'package-proof-unaccepted',
      detail: 'iOS Ghostty package proof has not been accepted.',
    });
  }
  if (!gates.crashFallbackProven) {
    blockers.push({
      reason: 'renderer-unavailable',
      detail: 'iOS Ghostty crash-to-WebView fallback proof has not passed.',
    });
  }
  return blockers;
}

function readBooleanEnv(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function selectPolicyChecksumForGhosttyKitArtifact({
  artifactPath,
  defaultArtifactPath,
  artifactPolicy,
}) {
  if (artifactPath !== defaultArtifactPath) {
    return undefined;
  }
  return artifactPolicy.expandedSha256;
}

async function validateChecksum(artifactPath, expectedSha256) {
  if (!expectedSha256) {
    return { status: 'not-provided' };
  }

  const actualSha256 = await computeSha256ForPath(artifactPath);
  return actualSha256 === expectedSha256
    ? { status: 'matched', sha256: actualSha256 }
    : { status: 'mismatch', expectedSha256, actualSha256 };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function blocked(reason, fields = {}) {
  return {
    status: 'blocked',
    platform: 'ios',
    renderer: rendererPolicy.iosGhostty.renderer,
    reason,
    ...fields,
  };
}

function writeJsonLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
