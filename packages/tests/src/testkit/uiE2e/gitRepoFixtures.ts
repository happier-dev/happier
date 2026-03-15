import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function execGit(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

export async function initGitRepo(params: { repoDir: string }) {
  await mkdir(resolve(join(params.repoDir, 'src')), { recursive: true });

  execGit(params.repoDir, ['init']);
  execGit(params.repoDir, ['config', 'user.email', 'ui-e2e@happier.dev']);
  execGit(params.repoDir, ['config', 'user.name', 'UI E2E']);
}

export async function createGitRepoWithChanges(params: { repoDir: string; fileCount: number }) {
  await initGitRepo({ repoDir: params.repoDir });

  // Baseline commit with many files.
  for (let i = 0; i < params.fileCount; i += 1) {
    const name = String(i).padStart(2, '0');
    await writeFile(
      resolve(join(params.repoDir, 'src', `file-${name}.txt`)),
      `hello ${name}\nline 2\n`,
      'utf8',
    );
  }
  await writeFile(resolve(join(params.repoDir, 'README.md')), '# ui-e2e\n', 'utf8');

  // A large file so file-details tabs can validate scrolling in both diff + file modes.
  const bigBaseline: string[] = [];
  for (let i = 0; i < 240; i += 1) bigBaseline.push(`baseline ${i}`);
  await writeFile(resolve(join(params.repoDir, 'src', 'big.txt')), `${bigBaseline.join('\n')}\n`, 'utf8');

  execGit(params.repoDir, ['add', '.']);
  execGit(params.repoDir, ['commit', '-m', 'chore: initial']);

  // Modify a subset so SCM has diffs to render.
  for (let i = 0; i < params.fileCount; i += 1) {
    const name = String(i).padStart(2, '0');
    await writeFile(
      resolve(join(params.repoDir, 'src', `file-${name}.txt`)),
      `hello ${name}\nline 2\nchanged ${name}\n`,
      'utf8',
    );
  }

  const bigChanged: string[] = [];
  for (let i = 0; i < 360; i += 1) bigChanged.push(`changed ${i}`);
  await writeFile(resolve(join(params.repoDir, 'src', 'big.txt')), `${bigChanged.join('\n')}\n`, 'utf8');

  // Include an image to validate binary/image paths do not crash Review.
  const tinyPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2p7bEAAAAASUVORK5CYII=';
  await writeFile(resolve(join(params.repoDir, 'src', 'tiny.png')), Buffer.from(tinyPngBase64, 'base64'));
}

function buildTwoHunksBaseline(): string {
  return [
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
    'twenty',
  ].join('\n');
}

function buildTwoHunksModified(): string {
  return [
    'one',
    'two',
    'ADDED_HUNK1_A',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'ADDED_HUNK2_A',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
    'twenty',
  ].join('\n');
}

export async function createGitRepoForPartialStagingFixture(params: { repoDir: string }) {
  await initGitRepo({ repoDir: params.repoDir });

  await writeFile(resolve(join(params.repoDir, 'src', 'two-hunks.txt')), `${buildTwoHunksBaseline()}\n`, 'utf8');
  await writeFile(resolve(join(params.repoDir, 'src', 'whole-file.txt')), 'baseline whole file\n', 'utf8');

  execGit(params.repoDir, ['add', '.']);
  execGit(params.repoDir, ['commit', '-m', 'chore: initial']);

  await writeFile(resolve(join(params.repoDir, 'src', 'two-hunks.txt')), `${buildTwoHunksModified()}\n`, 'utf8');
  await writeFile(
    resolve(join(params.repoDir, 'src', 'whole-file.txt')),
    'rewritten whole file\nwith multiple lines\n',
    'utf8',
  );
  await writeFile(resolve(join(params.repoDir, 'src', 'untracked.txt')), 'untracked file\n', 'utf8');
}
