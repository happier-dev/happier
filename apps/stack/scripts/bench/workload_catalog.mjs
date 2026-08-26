import { isAbsolute, resolve } from 'node:path';

const workloadCatalog = [
  {
    id: 'metadata-find-source',
    description: 'Traverse source files beneath the primary application and package roots.',
    category: 'metadata',
    sourceRequirement: 'working-tree',
    command: { executable: 'find', args: ['apps', 'packages', '-type', 'f'] },
    warmupCount: 1,
    repeatCount: 5,
  },
  {
    id: 'metadata-rg-files',
    description: 'Enumerate searchable source files with explicitly bounded ripgrep parallelism.',
    category: 'metadata',
    sourceRequirement: 'working-tree',
    command: { executable: 'rg', args: ['--threads', '1', '--files', 'apps', 'packages'] },
    warmupCount: 1,
    repeatCount: 5,
  },
  {
    id: 'vcs-diff-stat',
    description: 'Summarize tracked working-tree changes against the captured Git index.',
    category: 'vcs',
    sourceRequirement: 'git-index',
    command: { executable: 'git', args: ['diff', '--stat'] },
    warmupCount: 1,
    repeatCount: 5,
  },
  {
    id: 'vcs-grep-source',
    description: 'Search tracked application and package sources through the Git index.',
    category: 'vcs',
    sourceRequirement: 'git-index',
    command: { executable: 'git', args: ['grep', '-n', 'Happier', '--', 'apps', 'packages'] },
    warmupCount: 1,
    repeatCount: 5,
  },
  {
    id: 'vcs-status-short',
    description: 'Read concise working-tree status from the captured Git repository.',
    category: 'vcs',
    sourceRequirement: 'git-index',
    command: { executable: 'git', args: ['status', '--short'] },
    warmupCount: 1,
    repeatCount: 5,
  },
  {
    id: 'validation-cli-typecheck',
    description: 'Run the CLI package typecheck through the canonical preferred-execution wrapper.',
    category: 'targeted-validation',
    sourceRequirement: 'working-tree',
    cwdRelative: 'apps/cli',
    command: { executable: 'apps/stack/bin/hstack-exec', args: ['--local', '--script=typecheck:local'] },
    warmupCount: 1,
    repeatCount: 5,
  },
  {
    id: 'validation-cli-vitest-server-url',
    description: 'Run one stable CLI Vitest slice through the canonical preferred-execution wrapper.',
    category: 'targeted-validation',
    sourceRequirement: 'working-tree',
    cwdRelative: 'apps/cli',
    command: {
      executable: 'apps/stack/bin/hstack-exec',
      args: [
        '--local',
        '--script=vitest:local',
        '--',
        'run',
        'src/server/serverUrlClassification.test.ts',
      ],
    },
    warmupCount: 1,
    repeatCount: 5,
  },
  {
    id: 'validation-full-typecheck',
    description: 'Run the complete root typecheck pipeline through the canonical preferred-execution wrapper.',
    category: 'full-validation',
    sourceRequirement: 'working-tree',
    cwdRelative: '.',
    command: { executable: 'apps/stack/bin/hstack-exec', args: ['--local', '--script=typecheck:local'] },
    warmupCount: 1,
    repeatCount: 5,
  },
];

function copyWorkload(workload) {
  return {
    ...workload,
    command: {
      executable: workload.command.executable,
      args: [...workload.command.args],
    },
  };
}

export function listBenchmarkWorkloads() {
  return workloadCatalog.map(copyWorkload);
}

export function resolveBenchmarkWorkload(id) {
  const normalizedId = String(id ?? '').trim();
  const workload = workloadCatalog.find((candidate) => candidate.id === normalizedId);
  if (!workload) throw new Error(`Unknown benchmark workload: ${normalizedId || '(empty)'}`);
  return copyWorkload(workload);
}

export function resolveBenchmarkWorkloadInvocation(id, { rootDir }) {
  const workload = resolveBenchmarkWorkload(id);
  const normalizedRootDir = resolve(String(rootDir ?? '').trim() || '.');
  const executable = workload.command.executable;
  return {
    command: isAbsolute(executable) || !executable.includes('/')
      ? executable
      : resolve(normalizedRootDir, executable),
    args: [...workload.command.args],
    cwd: resolve(normalizedRootDir, workload.cwdRelative ?? '.'),
    workload,
  };
}
