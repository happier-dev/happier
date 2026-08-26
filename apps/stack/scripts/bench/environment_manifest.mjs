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

export function classifyRepositoryPlacement(cwd) {
  const normalized = String(cwd ?? '').replaceAll('\\', '/').toLowerCase();
  const knownCloudSegments = [
    '/library/mobile documents/',
    '/dropbox/',
    '/onedrive/',
    '/google drive/',
    '/google drive file stream/',
  ];
  if (knownCloudSegments.some((segment) => normalized.includes(segment))) return 'known-cloud-provider';
  if (/^\/users\/[^/]+\/(desktop|documents)(\/|$)/.test(normalized)) return 'possibly-managed-home-folder';
  return 'local-path';
}

export function detectSecurityProcessFamilies(processListText) {
  const text = String(processListText ?? '').toLowerCase();
  const signatures = {
    'crowdstrike': ['falconctl', 'falcond'],
    'microsoft-defender': ['wdavdaemon', 'microsoft defender'],
    'sentinel-one': ['sentinelone', 'sentinel-agent', 'sentineld'],
    'sophos': ['sophos'],
  };
  return Object.entries(signatures)
    .filter(([, needles]) => needles.some((needle) => text.includes(needle)))
    .map(([family]) => family)
    .sort();
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

async function defaultHostObservations({ cwd, env }) {
  const repositoryPlacement = classifyRepositoryPlacement(cwd);
  if (platform() !== 'darwin') {
    return {
      repositoryPlacement,
      spotlight: { available: false, indexingEnabled: null },
      timeMachine: { available: false, excluded: null },
      securityProcessFamilies: [],
    };
  }
  const captureResult = (command, args) => runCaptureResult(command, args, {
    cwd,
    env,
    timeoutMs: 5_000,
  }).catch(() => ({ exitCode: 1, out: '', err: '' }));
  const [spotlightResult, timeMachineResult, processResult] = await Promise.all([
    captureResult('mdutil', ['-s', cwd]),
    captureResult('tmutil', ['isexcluded', cwd]),
    captureResult('ps', ['-axo', 'comm=']),
  ]);
  const spotlightText = `${spotlightResult.out ?? ''}\n${spotlightResult.err ?? ''}`;
  const timeMachineText = `${timeMachineResult.out ?? ''}\n${timeMachineResult.err ?? ''}`;
  return {
    repositoryPlacement,
    spotlight: {
      available: spotlightResult.exitCode === 0,
      indexingEnabled: spotlightResult.exitCode === 0
        ? /indexing enabled/i.test(spotlightText)
        : null,
    },
    timeMachine: {
      available: timeMachineResult.exitCode === 0,
      excluded: timeMachineResult.exitCode === 0
        ? /\[excluded\]/i.test(timeMachineText)
        : null,
    },
    securityProcessFamilies: processResult.exitCode === 0
      ? detectSecurityProcessFamilies(processResult.out)
      : [],
  };
}

function defaultBoundary() {
  return {
    nowIso: () => new Date().toISOString(),
    platform: defaultPlatform,
    toolVersion: defaultToolVersion,
    git: defaultGit,
    filesystem: defaultFilesystem,
    hostObservations: defaultHostObservations,
  };
}

export async function collectEnvironmentManifest({ cwd, env = process.env, boundary = defaultBoundary() } = {}) {
  const toolNames = Object.keys(TOOL_PROBES);
  const [toolVersions, filesystem, git, host] = await Promise.all([
    Promise.all(toolNames.map((tool) => boundary.toolVersion(tool, { cwd, env }))),
    boundary.filesystem({ cwd, env }),
    boundary.git({ cwd, env }),
    boundary.hostObservations({ cwd, env }),
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
    host,
    git,
    tools,
    environment: { present },
  };
}
