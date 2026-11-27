import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, watch } from 'node:fs';
import { dirname, sep } from 'node:path';
import { once } from 'node:events';
import { gitIn } from './commitProducerClosure.mjs';

const gitEnv = () => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_INDEX_FILE;
  return env;
};

// Latin-1 is a reversible byte mapping. A Git pathname can contain any non-NUL byte.
const records = output => output.split('\0').slice(0, -1);
const removed = entry => entry.startsWith('000000 ');
const parents = function* (name) {
  for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) yield name.slice(0, i);
};

function treeChanges(git, base, tip) {
  const fields = records(git(['diff-tree', '-r', '--raw', '--no-abbrev', '--no-renames', '-z', base, tip]));
  const changes = new Map();
  for (let i = 0; i < fields.length; i += 2) {
    const [oldMode, newMode, oldBlob, newBlob] = fields[i].slice(1).split(' ');
    changes.set(fields[i + 1], { before: `${oldMode} ${oldBlob}`, after: `${newMode} ${newBlob}` });
  }
  return changes;
}

function diskMatches(git, repo, name, entry) {
  const path = Buffer.concat([Buffer.from(repo + sep), Buffer.from(name, 'latin1')]);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  const [mode, blob] = entry.split(' ');
  const symlink = mode === '120000';
  if (symlink ? !stat.isSymbolicLink() : !stat.isFile()) return false;
  if (!symlink && mode !== ((stat.mode & 0o111) ? '100755' : '100644')) return false;
  const input = symlink ? readlinkSync(path, { encoding: 'buffer' }) : readFileSync(path);
  return git(['hash-object', '--stdin'], { input }).trim() === blob;
}

function indexUpdates(git, repo, base, changes) {
  // Intent-to-add can share the mode and empty blob of a base file while
  // representing a staged deletion. Git's cached diff sees that distinction.
  const staged = new Set(records(git(['diff', '--cached', '--ita-invisible-in-index',
    '--no-renames', '--name-only', '--ignore-submodules=none', '-z', base, '--'])));
  const entries = new Map();
  for (const record of records(git(['ls-files', '--stage', '-z']))) {
    const tab = record.indexOf('\t');
    const name = record.slice(tab + 1);
    const [mode, blob, stage] = record.slice(0, tab).split(' ');
    // A conflict is never equivalent to a base entry, even if one stage matches.
    entries.set(name, stage === '0' ? `${mode} ${blob}` : null);
  }
  const deletions = [];
  const replacements = [];
  for (const [name, { before, after }] of changes) {
    // A missing entry can be a publication left behind by an earlier private
    // commit. Only exact landed disk bytes distinguish that lag from disk work.
    const missingLanded = !entries.has(name) && !removed(after) && diskMatches(git, repo, name, after);
    if (!missingLanded && (staged.has(name) || (removed(before) ? entries.has(name) : entries.get(name) !== before))) continue;
    if (removed(after)) {
      deletions.push(`0 ${after.slice(7)}\t${name}`);
      entries.delete(name);
    } else {
      replacements.push([name, after]);
    }
  }
  const directories = new Set();
  for (const name of entries.keys()) for (const parent of parents(name)) directories.add(parent);
  // Git must not replace a staged ancestor or descendant as a side effect of an addition.
  for (const [name, after] of replacements) {
    if (directories.has(name) || [...parents(name)].some(parent => entries.has(parent))) continue;
    deletions.push(`${after}\t${name}`);
  }
  return deletions;
}

function readIndexIdentity(index) {
  const stat = statSync(index, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : null;
}

function prepareAndPublishIndex(git, env, index, repo, base, commit, checkout, paths) {
  if (git(['rev-parse', '--symbolic-full-name', 'HEAD']).trim() !== checkout) return 0;
  const tip = git(['rev-parse', '--verify', 'HEAD']).trim();
  try { git(['merge-base', '--is-ancestor', commit, tip]); }
  catch (error) { if (error.status === 1) return 0; throw error; }

  const changes = treeChanges(git, base, commit);
  if (tip !== commit) {
    // Catch up only the paths from this publication, using their original base test.
    for (const [name, { after }] of treeChanges(git, commit, tip)) {
      const change = changes.get(name);
      if (!change) continue;
      if (change.before === after) changes.delete(name);
      else change.after = after;
    }
  }
  if (paths) for (const name of changes.keys()) if (!paths.has(name)) changes.delete(name);
  if (!changes.size) return 0;

  const lock = `${index}.lock`;
  const temp = `${index}.commit-writer-${randomUUID()}`;
  const tempEnv = { ...env, GIT_INDEX_FILE: temp };
  const tempGit = (args, options) => git(args, { env: tempEnv, ...options });
  try {
    const original = readIndexIdentity(index);
    if (original) copyFileSync(index, temp);
    const updates = indexUpdates(tempGit, repo, base, changes);
    if (!updates.length) return readIndexIdentity(index) === original ? 0 : null;
    tempGit(['update-index', '-z', '--index-info'], { input: Buffer.from(`${updates.join('\0')}\0`, 'latin1') });

    // Index-writing subprocesses finish before this writer takes the shared lock.
    // Publish the complete index through Git's lock path and retry if a
    // concurrent Git writer replaced the input index during preparation.
    linkSync(temp, lock);
    let ownsLock = true;
    try {
      if (readIndexIdentity(index) !== original) return null;
      // A ref writer can publish during private preparation. Re-read under
      // the lock so a later reconciliation cannot overtake this publication.
      if (git(['rev-parse', '--verify', 'HEAD']).trim() !== tip) return null;
      renameSync(lock, index);
      ownsLock = false;
      return updates.length;
    } finally {
      if (ownsLock) rmSync(lock, { force: true });
    }
  } finally {
    rmSync(temp, { force: true });
    rmSync(`${temp}.lock`, { force: true });
  }
}

/** Prepare from a private snapshot and publish through Git's lock.
 * The worktree bytes and any different stage, mode or blob stay with their owner. */
export async function syncPublishedIndex({ repo, base, commit, checkout, paths }) {
  const env = gitEnv();
  const run = gitIn(repo);
  const git = (args, options) => run(args, { env, encoding: 'latin1', ...options });
  checkout ??= git(['rev-parse', '--symbolic-full-name', 'HEAD']).trim();
  const index = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], { encoding: 'utf8' }).trim();
  const watcher = watch(dirname(index));
  try {
    for (;;) {
      const controller = new AbortController();
      const changed = once(watcher, 'change', { signal: controller.signal });
      changed.catch(() => {});
      try {
        if (!existsSync(`${index}.lock`)) {
          const result = prepareAndPublishIndex(git, env, index, repo, base, commit, checkout, paths);
          if (result !== null) return result;
          continue;
        }
        console.error('Waiting for shared index lock');
        if (existsSync(`${index}.lock`)) await changed;
      } catch (error) {
        if (error.code === 'ENOENT' && error.path === index) continue;
        if (error.code !== 'EEXIST' || error.dest !== `${index}.lock`) throw error;
        console.error('Waiting for shared index lock');
        if (existsSync(`${index}.lock`)) await changed;
      } finally {
        controller.abort();
      }
    }
  } finally {
    watcher.close();
  }
}
