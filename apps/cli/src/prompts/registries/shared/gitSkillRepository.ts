import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function runGit(args: readonly string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
    },
  }).trim();
}

function normalizeRepositoryUrl(repositoryUrl: string): string {
  if (/^[a-z]+:\/\//i.test(repositoryUrl)) return repositoryUrl;
  return existsSync(repositoryUrl) ? pathToFileURL(resolve(repositoryUrl)).href : repositoryUrl;
}

function isResolvedPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  if (!relativePath || relativePath === '.') return true;
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`);
}

export function clonePromptRegistryRepositoryToTempDir(repositoryUrl: string): string {
  const tempRoot = mkdtempSync(join(tmpdir(), 'happier-prompt-registry-clone-'));
  try {
    runGit(['clone', '--depth', '1', normalizeRepositoryUrl(repositoryUrl), tempRoot]);
    return tempRoot;
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export function collectPromptRegistrySkillDirectories(rootDirectory: string): string[] {
  const output = runGit(['-C', rootDirectory, 'ls-files']);
  const files = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('/SKILL.md') || line === 'SKILL.md');

  const directories = new Set<string>();
  for (const file of files) {
    const skillDirectory = resolve(rootDirectory, file, '..');
    if (existsSync(join(skillDirectory, 'SKILL.md'))) {
      directories.add(skillDirectory);
    }
  }
  return [...directories].sort((left, right) => left.localeCompare(right));
}

export function resolvePromptRegistrySourceRoot(cloneDirectory: string, subdirectory: string | null): string {
  if (!subdirectory) return cloneDirectory;
  const resolvedCloneDirectory = realpathSync(resolve(cloneDirectory));
  const candidatePath = resolve(resolvedCloneDirectory, subdirectory);
  if (!isResolvedPathInsideRoot(resolvedCloneDirectory, candidatePath)) {
    throw new Error('registry subdirectory must stay within the cloned repository');
  }
  const resolvedCandidatePath = existsSync(candidatePath) ? realpathSync(candidatePath) : candidatePath;
  if (!isResolvedPathInsideRoot(resolvedCloneDirectory, resolvedCandidatePath)) {
    throw new Error('registry subdirectory must stay within the cloned repository');
  }
  return resolvedCandidatePath;
}
