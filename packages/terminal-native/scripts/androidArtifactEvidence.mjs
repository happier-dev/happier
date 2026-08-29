import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { computeSha256ForPath } from './checksum.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export async function createAndroidArtifactEvidence({
  candidatePath,
  baselinePath,
  requiredAbis = ['arm64-v8a', 'x86_64'],
  expectTermuxIncluded,
} = {}) {
  if (!candidatePath) {
    return {
      status: 'blocked',
      reason: 'missing-candidate-apk',
      requiredEnv: 'HAPPIER_TERMINAL_NATIVE_ANDROID_CANDIDATE_APK',
    };
  }

  const policy = JSON.parse(await readFile(join(packageRoot, 'native-renderers.json'), 'utf8'));
  const licensePolicy = policy.androidTermux.license;
  const candidate = await inspectApk(candidatePath, licensePolicy);
  const baseline = baselinePath ? await inspectApk(baselinePath, licensePolicy) : null;
  const missingAbis = requiredAbis.filter((abi) => !candidate.packagedAbis.includes(abi));
  const inclusionMismatch = expectTermuxIncluded === true
    ? !candidate.termuxImplementationPresent
    : expectTermuxIncluded === false
      ? candidate.termuxImplementationPresent
      : false;
  const licenseClosureMissing = candidate.termuxImplementationPresent && !candidate.termuxLicenseClosurePresent;
  const reason = missingAbis.length > 0
    ? 'required-abi-missing'
    : inclusionMismatch
      ? (expectTermuxIncluded ? 'termux-implementation-missing' : 'termux-unexpected-in-artifact')
      : licenseClosureMissing
        ? 'termux-license-closure-missing'
        : 'artifact-evidence-complete';

  return {
    status: reason === 'artifact-evidence-complete' ? 'ok' : 'blocked',
    reason,
    candidate,
    baseline,
    sizeDeltaBytes: baseline ? candidate.bytes - baseline.bytes : null,
    requiredAbis,
    missingAbis,
    expectTermuxIncluded: expectTermuxIncluded ?? null,
    evidenceScope: 'static-apk-package-only',
    abiSmokeStillRequired: true,
  };
}

async function inspectApk(path, licensePolicy) {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`Android artifact is not a file: ${path}`);
  }

  const { stdout } = await execFileAsync('unzip', ['-Z1', path], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const entries = stdout.split(/\r?\n/u).filter(Boolean);
  const packagedAbis = [...new Set(
    entries
      .map((entry) => /^lib\/([^/]+)\//u.exec(entry)?.[1])
      .filter(Boolean),
  )].sort();
  const dexEntries = entries.filter((entry) => /^classes\d*\.dex$/u.test(entry));
  const termuxMarkers = [
    Buffer.from('Ldev/happier/terminal/termux/TermuxBackedRemoteSession;'),
    Buffer.from('Lcom/termux/terminal/TerminalEmulator;'),
    Buffer.from('Lcom/termux/view/TerminalRenderer;'),
  ];
  const foundTermuxMarkers = new Set();
  for (const dexEntry of dexEntries) {
    const dexBytes = await readZipEntry(path, dexEntry, 256 * 1024 * 1024);
    for (const marker of termuxMarkers) {
      if (dexBytes.includes(marker)) foundTermuxMarkers.add(marker.toString('utf8'));
    }
  }
  const termuxImplementationPresent = foundTermuxMarkers.size === termuxMarkers.length;
  const licenseEntry = 'assets/LICENSE-APACHE-2.0.txt';
  const noticeEntry = 'assets/NOTICE.txt';
  const licenseBytes = entries.includes(licenseEntry) ? await readZipEntry(path, licenseEntry) : null;
  const noticeBytes = entries.includes(noticeEntry) ? await readZipEntry(path, noticeEntry) : null;
  const termuxLicenseSha256 = licenseBytes ? sha256(licenseBytes) : null;
  const termuxNoticeSha256 = noticeBytes ? sha256(noticeBytes) : null;
  const termuxLicenseClosurePresent = termuxLicenseSha256 === licensePolicy.redistributionLicenseSha256
    && termuxNoticeSha256 === licensePolicy.redistributionNoticeSha256;

  return {
    path,
    bytes: info.size,
    sha256: await computeSha256ForPath(path),
    packagedAbis,
    termuxImplementationPresent,
    foundTermuxMarkers: [...foundTermuxMarkers].sort(),
    termuxLicenseClosurePresent,
    termuxLicenseSha256,
    termuxNoticeSha256,
  };
}

async function readZipEntry(path, entry, maxBuffer = 16 * 1024 * 1024) {
  const { stdout } = await execFileAsync('unzip', ['-p', path, entry], {
    encoding: 'buffer',
    maxBuffer,
  });
  return stdout;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseOptionalBoolean(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('HAPPIER_TERMINAL_NATIVE_ANDROID_EXPECT_TERMUX_INCLUDED must be a boolean value');
}

function parseRequiredAbis(value) {
  return [...new Set(
    (value || 'arm64-v8a,x86_64')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
}

async function main() {
  try {
    const report = await createAndroidArtifactEvidence({
      candidatePath: process.env.HAPPIER_TERMINAL_NATIVE_ANDROID_CANDIDATE_APK,
      baselinePath: process.env.HAPPIER_TERMINAL_NATIVE_ANDROID_BASELINE_APK,
      requiredAbis: parseRequiredAbis(process.env.HAPPIER_TERMINAL_NATIVE_ANDROID_REQUIRED_ABIS),
      expectTermuxIncluded: parseOptionalBoolean(process.env.HAPPIER_TERMINAL_NATIVE_ANDROID_EXPECT_TERMUX_INCLUDED),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== 'ok') process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: 'blocked',
      reason: 'artifact-inspection-failed',
      detail: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
