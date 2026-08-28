import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { computeSha256ForPath } from './checksum.mjs';

const execFileAsync = promisify(execFile);

export async function createAndroidArtifactEvidence({
  candidatePath,
  baselinePath,
  requiredAbis = ['arm64-v8a', 'x86_64'],
} = {}) {
  if (!candidatePath) {
    return {
      status: 'blocked',
      reason: 'missing-candidate-apk',
      requiredEnv: 'HAPPIER_TERMINAL_NATIVE_ANDROID_CANDIDATE_APK',
    };
  }

  const candidate = await inspectApk(candidatePath);
  const baseline = baselinePath ? await inspectApk(baselinePath) : null;
  const missingAbis = requiredAbis.filter((abi) => !candidate.packagedAbis.includes(abi));

  return {
    status: missingAbis.length === 0 ? 'ok' : 'blocked',
    reason: missingAbis.length === 0 ? 'artifact-evidence-complete' : 'required-abi-missing',
    candidate,
    baseline,
    sizeDeltaBytes: baseline ? candidate.bytes - baseline.bytes : null,
    requiredAbis,
    missingAbis,
    evidenceScope: 'static-apk-package-only',
    abiSmokeStillRequired: true,
  };
}

async function inspectApk(path) {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`Android artifact is not a file: ${path}`);
  }

  const { stdout } = await execFileAsync('unzip', ['-Z1', path], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const packagedAbis = [...new Set(
    stdout
      .split(/\r?\n/u)
      .map((entry) => /^lib\/([^/]+)\//u.exec(entry)?.[1])
      .filter(Boolean),
  )].sort();

  return {
    path,
    bytes: info.size,
    sha256: await computeSha256ForPath(path),
    packagedAbis,
  };
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
