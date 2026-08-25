import { arch, cpus, platform, release, totalmem } from 'node:os';

import { runCaptureResult } from '../utils/proc/proc.mjs';

const ENV_PRESENCE_KEYS = [
  'CI',
  'GITHUB_TOKEN',
  'HAPPIER_STACK_HOME_DIR',
  'HAPPIER_STACK_REPO_DIR',
  'HAPPIER_STACK_SANDBOX_DIR',
  'MUTAGEN_DATA_DIRECTORY',
  'SSH_AUTH_SOCK',
];

const TOOL_PROBES = {
  node: () => [process.execPath, ['--version']],
  git: () => ['git', ['--version']],
  yarn: () => ['yarn', ['--version']],
  rg: () => ['rg', ['--version']],
  mutagen: () => ['mutagen', ['version']],
  lima: () => ['limactl', ['--version']],
};

function firstNonEmptyLine(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

async function capture(command, args, { cwd, env }) {
  const result = await runCaptureResult(command, args, {
    cwd,
    env,
    timeoutMs: 5_000,
  });
  if (result.exitCode !== 0) return null;
  return firstNonEmptyLine(result.out) ?? firstNonEmptyLine(result.err);
}

async function defaultToolVersion(tool, { cwd, env }) {
  const probe = TOOL_PROBES[tool];
  if (!probe) return null;
  const [command, args] = probe();
  try {
    return await capture(command, args, { cwd, env });
  } catch {
    return null;
  }
}

async function defaultGit({ cwd, env }) {
  try {
    const base = ['-c', 'core.fsmonitor=false'];
    const options = { cwd, env, timeoutMs: 10_000 };
    const [headResult, branchResult, statusResult] = await Promise.all([
      runCaptureResult('git', [...base, 'rev-parse', 'HEAD'], options),
      runCaptureResult('git', [...base, 'branch', '--show-current'], options),
      runCaptureResult('git', [...base, 'status', '--porcelain=v2', '-z'], options),
    ]);
    if (headResult.exitCode !== 0) return null;
    const dirtyEntryCount = statusResult.exitCode === 0
      ? statusResult.out.split('\0').filter(Boolean).length
      : null;
    return {
      head: firstNonEmptyLine(headResult.out),
      branch: branchResult.exitCode === 0 ? firstNonEmptyLine(branchResult.out) : null,
      dirtyEntryCount,
    };
  } catch {
    return null;
  }
}

async function defaultFilesystem({ cwd, env }) {
  const currentPlatform = platform();
  if (currentPlatform === 'win32') return { type: null };
  const args = currentPlatform === 'darwin' ? ['-f', '%T', cwd] : ['-f', '-c', '%T', cwd];
  try {
    const type = await capture('stat', args, { cwd, env });
    return { type };
  } catch {
    return { type: null };
  }
}

function defaultPlatform() {
  const cpuList = cpus();
  return {
    os: platform(),
    arch: arch(),
    release: release(),
    cpuCount: cpuList.length,
    cpuModel: cpuList[0]?.model ?? null,
    totalMemoryBytes: totalmem(),
  };
}

function defaultBoundary() {
  return {
    nowIso: () => new Date().toISOString(),
    platform: defaultPlatform,
    toolVersion: defaultToolVersion,
    git: defaultGit,
    filesystem: defaultFilesystem,
  };
}

export async function collectEnvironmentManifest({ cwd, env = process.env, boundary = defaultBoundary() } = {}) {
  const toolNames = Object.keys(TOOL_PROBES);
  const [toolVersions, filesystem, git] = await Promise.all([
    Promise.all(toolNames.map((tool) => boundary.toolVersion(tool, { cwd, env }))),
    boundary.filesystem({ cwd, env }),
    boundary.git({ cwd, env }),
  ]);
  const tools = Object.fromEntries(toolNames.map((tool, index) => [tool, toolVersions[index]]));
  const present = {};
  for (const key of ENV_PRESENCE_KEYS) {
    present[key] = typeof env?.[key] === 'string' && env[key].length > 0;
  }
  return {
    schemaVersion: 1,
    capturedAt: boundary.nowIso(),
    platform: boundary.platform(),
    filesystem,
    git,
    tools,
    environment: { present },
  };
}
