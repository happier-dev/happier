#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';

function parseArgs(argv) {
  const kv = new Map();
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') kv.set('help', true);
    else if (arg.startsWith('--src=')) kv.set('src', arg.slice('--src='.length));
    else if (arg === '--src') kv.set('src', argv[++i]);
    else if (arg.startsWith('--dst=')) kv.set('dst', arg.slice('--dst='.length));
    else if (arg === '--dst') kv.set('dst', argv[++i]);
    else throw new Error(`Unknown arg: ${arg}`);
  }
  return { src: kv.get('src'), dst: kv.get('dst'), help: kv.get('help') === true };
}

function run(cmd, args, { cwd, input, quiet = false } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: input == null ? 'utf8' : null,
    stdio: quiet ? ['pipe', 'pipe', 'pipe'] : undefined,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const out = [
      `Command failed: ${cmd} ${args.join(' ')}`,
      cwd ? `cwd: ${cwd}` : null,
      `status: ${res.status}`,
      res.stderr?.toString?.() || res.stdout?.toString?.() || '',
    ]
      .filter(Boolean)
      .join('\n');
    throw new Error(out);
  }
  return res;
}

function gitCapture({ repoDir, args }) {
  const res = spawnSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`git -C ${repoDir} ${args.join(' ')} failed:\n${res.stderr || res.stdout || ''}`);
  }
  return String(res.stdout ?? '');
}

function applyDiff({ srcDir, dstDir, args }) {
  const diff = spawnSync('git', ['-C', srcDir, 'diff', '--binary', ...args], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (diff.status !== 0) {
    throw new Error(`git diff failed:\n${diff.stderr?.toString?.() || diff.stdout?.toString?.() || ''}`);
  }
  const buf = diff.stdout ?? Buffer.from('');
  if (!buf.length) return;

  run('git', ['-C', dstDir, 'apply', '--allow-empty', '--whitespace=nowarn'], { input: buf, quiet: true });
}

function assertSafeRepoRelativePath(relPath) {
  const p = String(relPath ?? '');
  if (!p) throw new Error('Unexpected empty path from git');
  if (p.includes('\0')) throw new Error('Unexpected NUL byte in path from git');
  if (p.startsWith('/') || p.startsWith('\\')) throw new Error(`Refusing to copy absolute path: ${p}`);
  const parts = p.split(/[\\/]+/g);
  for (const part of parts) {
    if (!part) continue;
    if (part === '.' || part === '..') throw new Error(`Refusing to copy unsafe path: ${p}`);
  }
}

function copyUntrackedFiles({ srcDir, dstDir }) {
  const out = gitCapture({ repoDir: srcDir, args: ['ls-files', '--others', '--exclude-standard', '-z'] });
  if (!out) return;

  const relPaths = out.split('\0').filter(Boolean);
  for (const rel of relPaths) {
    assertSafeRepoRelativePath(rel);
    const from = join(srcDir, rel);
    const to = join(dstDir, rel);

    const stat = fs.lstatSync(from);
    fs.mkdirSync(dirname(to), { recursive: true });

    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(from);
      try {
        fs.symlinkSync(target, to);
      } catch (error) {
        throw new Error(`Failed to copy symlink ${rel}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }

    if (!stat.isFile()) {
      // git ls-files --others returns files, but be defensive.
      continue;
    }

    fs.copyFileSync(from, to);
    try {
      fs.chmodSync(to, stat.mode & 0o777);
    } catch {
      // best-effort
    }
  }
}

function ensureMainBranch({ repoDir }) {
  const head = gitCapture({ repoDir, args: ['rev-parse', '--abbrev-ref', 'HEAD'] }).trim();
  if (head === 'main') {
    return;
  }
  run('git', ['-C', repoDir, 'branch', '-f', 'main', 'HEAD'], { quiet: true });
}

function commitIfDirty({ repoDir }) {
  const status = gitCapture({ repoDir, args: ['status', '--porcelain=v1'] }).trim();
  if (!status) return false;

  run('git', ['-C', repoDir, 'add', '-A'], { quiet: true });
  run(
    'git',
    [
      '-C',
      repoDir,
      '-c',
      'user.name=happier-release-assets-e2e',
      '-c',
      'user.email=release-assets-e2e@local',
      'commit',
      '--no-gpg-sign',
      '--no-verify',
      '-m',
      'chore(release-assets-e2e): snapshot local checkout diffs',
    ],
    { quiet: true },
  );
  return true;
}

function main() {
  const { src, dst, help } = parseArgs(process.argv);
  if (help) {
    // eslint-disable-next-line no-console
    console.log('Usage: prepare-local-monorepo.mjs --src <repoDir> --dst <outDir>');
    process.exit(0);
  }
  if (!src || !dst) {
    throw new Error('Missing required args: --src and --dst');
  }
  if (!fs.existsSync(src)) {
    throw new Error(`--src does not exist: ${src}`);
  }
  if (fs.existsSync(dst)) {
    throw new Error(`--dst already exists (expected caller to clear it first): ${dst}`);
  }
  fs.mkdirSync(dirname(dst), { recursive: true });

  run('git', ['clone', '--quiet', '--no-hardlinks', src, dst], { quiet: true });

  // Apply any local changes from the src checkout. We intentionally avoid copying the full working tree,
  // since it may contain large untracked directories (e.g. nested node_modules).
  // NOTE: we do copy untracked-but-not-ignored files so local worktree changes are represented in the clone.
  applyDiff({ srcDir: src, dstDir: dst, args: [] });
  applyDiff({ srcDir: src, dstDir: dst, args: ['--cached'] });
  copyUntrackedFiles({ srcDir: src, dstDir: dst });

  commitIfDirty({ repoDir: dst });
  ensureMainBranch({ repoDir: dst });
}

main();
