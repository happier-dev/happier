// Commit check: when a packet changes a dependency input (a package.json, the lockfile, pnpm-workspace.yaml, .npmrc,
// patches/, .pnpmfile.cjs), the candidate's lockfile must satisfy its manifests by pnpm's own frozen check (overrides,
// patch hashes, multi-document lockfiles), run offline on the candidate's Git objects only (~2-3 s, no install). Only
// drift the base did not already have refuses (DBW-UNBLOCK 2026-11-17 09:58Z; c7a55bbde64).
// pnpm can silently ignore a missing importer manifest, so verify it from the same Git tree.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublicRuntimeImportDiagnostic } from '../../apps/stack/scripts/utils/proc/runtimeImportProbe.mjs';

const DEPENDENCY_INPUT = /(^|\/)package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|(^|\/)\.npmrc$|^patches\/|^\.pnpmfile\.cjs$/;
const DRIFT = ['ERR_PNPM_OUTDATED_LOCKFILE', 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH', 'ERR_PNPM_PATCH'];

// pnpm 9 may write several YAML documents; read every importers map.
function lockfileImporters(lock) {
  const dirs = new Set();
  if (!lock) return dirs;
  for (const section of lock.matchAll(/^importers:\n([\s\S]*?)(?=^\S|(?![\s\S]))/gmu))
    for (const key of section[1].matchAll(/^ {2}(\S[^:\n]*):\s*$/gmu)) dirs.add(key[1].replace(/^['"]|['"]$/gu, ''));
  return dirs;
}

function untrackedImporters(git, rev) {
  if (!git(['ls-tree', '--name-only', rev, '--', 'pnpm-lock.yaml']).trim()) return [];
  const importers = [...lockfileImporters(git(['show', `${rev}:pnpm-lock.yaml`]))];
  if (!importers.length) return [];
  const packagePath = dir => dir === '.' ? 'package.json' : `${dir}/package.json`;
  const paths = importers.map(packagePath);
  const candidates = paths.filter(path => !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.'));
  const tracked = new Set(candidates.length
    ? git(['--literal-pathspecs', 'ls-tree', '--name-only', '-z', rev, '--', ...candidates]).split('\0') : []);
  return importers.filter(dir => !tracked.has(packagePath(dir)));
}

function frozen(repo, rev) {
  const git = (...args) => execFileSync('git', args, { cwd: repo, maxBuffer: 2 ** 31 });
  const files = git('ls-tree', '-r', '--name-only', '-z', rev).toString().split('\0')
    .filter(path => path && DEPENDENCY_INPUT.test(path) && !`/${path}`.includes('/node_modules/'));
  if (!files.includes('pnpm-lock.yaml')) return { status: 'no-lockfile' };
  const dir = mkdtempSync(join(tmpdir(), 'happier-commit-lockfile-'));
  try {
    execFileSync('tar', ['-x', '-C', dir], { input: git('archive', '--format=tar', rev, '--', ...files), maxBuffer: 2 ** 31 });
    const run = spawnSync('pnpm', ['install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts', '--offline'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1' }, maxBuffer: 1 << 28 });
    if (run.error?.code === 'ENOENT') return { status: 'unavailable', detail: 'pnpm not on PATH' };
    if (run.error) throw run.error;
    if (run.status === 0) return { status: 'ok', detail: '' };
    const out = `${run.stdout}${run.stderr}`.replaceAll(dir, '<candidate>');
    // pnpm's reason block: the error code, then '* in importers[...]' and its wrapped '* N dependencies ...' lines.
    const lines = [];
    let keep = false;
    for (const raw of out.split('\n')) {
      const line = raw.trim();
      if (line.includes('ERR_PNPM') || line.startsWith('* ')) { lines.push(line); keep = line.startsWith('* '); }
      else if (keep && line && !line.startsWith('help:')) lines[lines.length - 1] += ` ${line}`;
      else keep = false;
    }
    const detail = lines.slice(0, 8).join('; ') || out.trim().slice(-300);
    return { status: DRIFT.some(code => out.includes(code)) ? 'drift' : 'unavailable', detail };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Report newly introduced lockfile drift. A frozen check without a verdict must be retried. */
export function commitLockfile({ repo, base, tree }) {
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });
  const changed = git(['diff', '--no-renames', '--name-only', '-z', base, tree])
    .split('\0').filter(path => path && DEPENDENCY_INPUT.test(path));
  if (!changed.length) return { findings: [], note: 'the packet changes no dependency input' };
  const untracked = untrackedImporters(git, tree);
  if (untracked.length) {
    const inherited = new Set(untrackedImporters(git, base));
    const findings = untracked.filter(dir => !inherited.has(dir)).map(dir => {
      const label = isPublicRuntimeImportDiagnostic(dir) && /^[\w@./*+ {},$>-]+$/u.test(dir) ? dir : '[redacted import]';
      return `lockfile importer without a tracked package.json: ${label}`;
    });
    if (findings.length) return { findings, note: '' };
  }
  const candidate = frozen(repo, tree);
  if (candidate.status === 'ok') return { findings: [], note: 'the candidate passes pnpm’s frozen check' };
  if (candidate.status === 'no-lockfile') {
    if (git(['ls-tree', '--name-only', base, '--', 'pnpm-lock.yaml']).trim()) {
      return { findings: ['candidate removed pnpm-lock.yaml'], note: '' };
    }
    return { findings: [], note: 'this checkout uses no pnpm lockfile' };
  }
  if (candidate.status === 'unavailable') throw new Error(`candidate frozen check unavailable: ${candidate.detail}`);
  const previous = frozen(repo, base);
  if (previous.status === 'unavailable') throw new Error(`base frozen check unavailable: ${previous.detail}`);
  if (previous.status === 'drift') return { findings: [], note: `frozen check fails at the base too (pre-existing, not refused): ${candidate.detail}` };
  return { findings: [`lockfile out of date with the candidate's manifests: ${candidate.detail}`], note: '' };
}
