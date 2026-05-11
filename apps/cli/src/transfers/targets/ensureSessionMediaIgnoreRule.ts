import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { SessionMediaTransferConfig } from './resolveSessionMediaTransferTarget';

async function resolveGitDirBestEffort(workingDirectory: string): Promise<string | null> {
  const dotGitPath = join(workingDirectory, '.git');
  let gitDir: string | null = null;
  try {
    const dotGitStat = await stat(dotGitPath);
    if (dotGitStat.isDirectory()) {
      gitDir = dotGitPath;
    } else if (dotGitStat.isFile()) {
      const contents = await readFile(dotGitPath, 'utf8');
      const match = contents.match(/^\s*gitdir:\s*(.+)\s*$/mi);
      const raw = match?.[1]?.trim();
      if (raw) {
        gitDir = join(workingDirectory, raw);
      }
    }
  } catch {
    return null;
  }

  if (!gitDir) return null;
  try {
    const gitDirStat = await stat(gitDir);
    return gitDirStat.isDirectory() ? gitDir : null;
  } catch {
    return null;
  }
}

function toWorkspaceIgnoreRule(workspaceRelativeDir: string): string {
  const normalized = workspaceRelativeDir.replace(/^[\\/]+/, '').replace(/[\\]+/g, '/');
  return `/${normalized}/`;
}

async function ensureFileContainsRule(filePath: string, ruleLine: string): Promise<void> {
  let current = '';
  try {
    current = await readFile(filePath, 'utf8');
  } catch {
    await mkdir(dirname(filePath), { recursive: true });
  }

  const lines = current.split('\n').map((line) => line.trim());
  if (lines.includes(ruleLine)) return;

  const next = current && !current.endsWith('\n') ? `${current}\n${ruleLine}\n` : `${current}${ruleLine}\n`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, next, 'utf8');
}

export async function ensureSessionMediaIgnoreRule(params: Readonly<{
  workingDirectory: string;
  config: SessionMediaTransferConfig;
}>): Promise<void> {
  if (
    params.config.uploadLocation !== 'workspace'
    || !params.config.vcsIgnoreWritesEnabled
    || params.config.vcsIgnoreStrategy === 'none'
  ) {
    return;
  }

  const ruleLine = toWorkspaceIgnoreRule(params.config.workspaceRelativeDir);
  if (params.config.vcsIgnoreStrategy === 'git_info_exclude') {
    const gitDir = await resolveGitDirBestEffort(params.workingDirectory);
    await ensureFileContainsRule(
      gitDir ? join(gitDir, 'info', 'exclude') : join(params.workingDirectory, '.gitignore'),
      ruleLine,
    );
    return;
  }

  await ensureFileContainsRule(join(params.workingDirectory, '.gitignore'), ruleLine);
}
