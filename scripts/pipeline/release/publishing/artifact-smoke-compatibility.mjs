import { parseArtifactFilename } from '../lib/manifests.mjs';

function normalizeRunnerPlatform(platform) {
  const value = String(platform ?? '').trim().toLowerCase();
  if (value === 'win32') return 'windows';
  return value;
}

function normalizeRunnerArch(arch) {
  const value = String(arch ?? '').trim().toLowerCase();
  if (value === 'x86_64' || value === 'amd64') return 'x64';
  if (value === 'aarch64') return 'arm64';
  return value;
}

export function resolveReleaseArtifactSmokeEligibility(params) {
  const archiveName = String(params?.archiveName ?? '').trim();
  const runnerTarget = {
    os: normalizeRunnerPlatform(params?.runner?.platform ?? process.platform),
    arch: normalizeRunnerArch(params?.runner?.arch ?? process.arch),
  };
  const target = parseArtifactFilename(archiveName);
  if (!target) {
    return {
      eligible: false,
      reason: 'non-native-archive',
      target: null,
      runnerTarget,
    };
  }
  const eligible = target.os === runnerTarget.os && target.arch === runnerTarget.arch;
  return {
    eligible,
    reason: eligible ? 'compatible-target' : 'target-mismatch',
    target,
    runnerTarget,
  };
}

export function shouldSmokeTestReleaseArtifact(params) {
  return resolveReleaseArtifactSmokeEligibility(params).eligible;
}
