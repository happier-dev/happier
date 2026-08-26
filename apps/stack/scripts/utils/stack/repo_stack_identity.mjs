import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, win32 } from 'node:path';

const nativePath = { basename, isAbsolute, join, resolve };
const defaultFileOps = { existsSync, readFileSync, writeFileSync };

function sanitizeStackNameToken(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'repo';
}

function usesWindowsPathSyntax(value) {
  const path = String(value ?? '');
  return /^[a-z]:[\\/]/i.test(path) || path.includes('\\');
}

function pathApiFor(...paths) {
  return process.platform === 'win32' || paths.some(usesWindowsPathSyntax) ? win32 : nativePath;
}

function resolveGitPath(rawPath, { baseDir, pathApi }) {
  const path = String(rawPath ?? '').trim();
  return pathApi.isAbsolute(path) ? pathApi.resolve(path) : pathApi.resolve(baseDir, path);
}

function readTextFile(path, fileOps) {
  try {
    return path && fileOps.existsSync(path) ? fileOps.readFileSync(path, 'utf-8').toString().trim() : '';
  } catch {
    return '';
  }
}

function resolveGitDir(repoRoot, fileOps) {
  try {
    const pathApi = pathApiFor(repoRoot);
    const gitPath = pathApi.join(repoRoot, '.git');
    if (!fileOps.existsSync(gitPath)) return null;
    let raw;
    try {
      raw = fileOps.readFileSync(gitPath, 'utf-8').toString().trim();
    } catch {
      return gitPath;
    }
    const match = raw.match(/^gitdir:\s*(.+)\s*$/i);
    if (!match?.[1]?.trim()) return null;
    const linkedGitDir = resolveGitPath(match[1], { baseDir: repoRoot, pathApi });
    const commonDir = readTextFile(pathApi.join(linkedGitDir, 'commondir'), fileOps);
    return commonDir ? resolveGitPath(commonDir, { baseDir: linkedGitDir, pathApi }) : linkedGitDir;
  } catch {
    return null;
  }
}

function writeTextFileBestEffort(path, contents, fileOps) {
  try {
    if (path) fileOps.writeFileSync(path, String(contents), { encoding: 'utf-8' });
  } catch {
    // Repository identity remains path-stable when Git metadata is read-only.
  }
}

export function resolveStacksStorageRoot(env = process.env) {
  const configured = String(env.HAPPIER_STACK_STORAGE_DIR ?? '').trim();
  if (configured === '~') return homedir();
  if (configured.startsWith('~/')) return join(homedir(), configured.slice(2));
  return configured || join(homedir(), '.happier', 'stacks');
}

export function resolveRepoStackIdentity({
  repoRoot,
  stacksStorageRoot = resolveStacksStorageRoot(),
  createIfMissing = false,
  fileOps = defaultFileOps,
} = {}) {
  const storagePathApi = pathApiFor(stacksStorageRoot, repoRoot);
  const currentBase = sanitizeStackNameToken(pathApiFor(repoRoot).basename(String(repoRoot)));
  let base = currentBase;
  const oldHash = createHash('sha256').update(String(repoRoot)).digest('hex').slice(0, 10);
  const oldName = `repo-${currentBase}-${oldHash}`;
  const gitDir = resolveGitDir(repoRoot, fileOps);
  let id = oldHash;
  if (gitDir) {
    const basePath = pathApiFor(gitDir).join(gitDir, 'happier-stack-stackless-base');
    const existingBase = readTextFile(basePath, fileOps).toLowerCase();
    if (existingBase && sanitizeStackNameToken(existingBase) === existingBase) {
      base = existingBase;
    } else if (createIfMissing) {
      writeTextFileBestEffort(basePath, currentBase, fileOps);
    }
    const idPath = pathApiFor(gitDir).join(gitDir, 'happier-stack-stackless-id');
    const existing = readTextFile(idPath, fileOps).toLowerCase();
    if (/^[a-f0-9]{8,}$/.test(existing)) {
      id = existing.slice(0, 20);
    } else if (fileOps.existsSync(storagePathApi.join(stacksStorageRoot, oldName))) {
      if (createIfMissing) writeTextFileBestEffort(idPath, oldHash, fileOps);
    } else if (createIfMissing) {
      id = randomBytes(8).toString('hex');
      writeTextFileBestEffort(idPath, id, fileOps);
    }
  }
  const stackName = `repo-${base}-${id.slice(0, 10)}`;
  const stackBaseDir = storagePathApi.join(stacksStorageRoot, stackName);
  return {
    stackName,
    stackBaseDir,
    runtimeStatePath: storagePathApi.join(stackBaseDir, 'stack.runtime.json'),
    devTargetsConfigPath: storagePathApi.join(stackBaseDir, 'dev-targets.json'),
  };
}
