// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
function listGitFilesForStaging(repoRoot) {
  const list = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });

  return list
    .toString('utf8')
    .split('\u0000')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * @param {string} normalized
 * @returns {boolean}
 */
function shouldExclude(normalized) {
  return (
    normalized === '.daggerignore' ||
    normalized.startsWith('.env') ||
    normalized.includes('/.env') ||
    normalized.startsWith('.git/') ||
    normalized.includes('/.git/') ||
    normalized.startsWith('dist/') ||
    normalized.startsWith('output/') ||
    normalized.startsWith('test-results/') ||
    normalized.startsWith('node_modules/') ||
    normalized.includes('/node_modules/')
  );
}

/**
 * Creates a staged repo directory to:
 * - avoid leaking local-only files (e.g. `.env*`, `node_modules`) into the Dagger engine
 * - reduce sync overhead vs passing the full working tree to Dagger
 *
 * Uses the *working tree* contents (tracked + untracked, excluding ignored files) so local iteration is accurate.
 *
 * Stages regular files via hardlinks when possible to avoid duplicating gigabytes of data.
 *
 * @param {{ repoRoot: string; files?: string[] }} opts
 * @returns {{ stagedRepoDir: string; cleanup: () => void }}
 */
export function stageRepoForDagger({ repoRoot, files }) {
  const stagedRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-dagger-repo-'));
  const fileList = Array.isArray(files) ? files : listGitFilesForStaging(repoRoot);

  for (const relativePath of fileList) {
    const normalized = relativePath.replaceAll('\\', '/');
    if (shouldExclude(normalized)) continue;

    const src = path.join(repoRoot, relativePath);
    if (!fs.existsSync(src)) continue;

    const dest = path.join(stagedRepoDir, relativePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) {
      const link = fs.readlinkSync(src);
      fs.symlinkSync(link, dest);
      continue;
    }

    if (st.isFile()) {
      try {
        fs.linkSync(src, dest);
      } catch {
        fs.copyFileSync(src, dest);
        fs.chmodSync(dest, st.mode);
      }
      continue;
    }
  }

  return {
    stagedRepoDir,
    cleanup: () => {
      try {
        fs.rmSync(stagedRepoDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup only
      }
    },
  };
}
