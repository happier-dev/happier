import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, openSync, renameSync, rmSync, watch } from 'node:fs';
import { dirname } from 'node:path';
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

function indexUpdates(git, base, changes) {
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
    if (staged.has(name) || (removed(before) ? entries.has(name) : entries.get(name) !== before)) continue;
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

function updateLockedIndex(git, env, index, base, commit, checkout, paths) {
  const lock = `${index}.lock`;
  const fd = openSync(lock, 'wx');
  const temp = `${index}.commit-writer-${randomUUID()}`;
  let ownsLock = true;
  try {
    closeSync(fd);
    if (git(['rev-parse', '--symbolic-full-name', 'HEAD']).trim() !== checkout) return 0;
    const tip = git(['rev-parse', '--verify', 'HEAD']).trim();
    try { git(['merge-base', '--is-ancestor', commit, tip]); }
    catch (error) { if (error.status === 1) return 0; throw error; }

    const changes = treeChanges(git, base, commit);
    if (tip !== commit) {
      // A newer writer can publish while this writer waits on Git's index lock.
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
    const tempEnv = { ...env, GIT_INDEX_FILE: temp };
    const tempGit = (args, options) => git(args, { env: tempEnv, ...options });
    if (existsSync(index)) copyFileSync(index, temp);
    const updates = indexUpdates(tempGit, base, changes);
    if (!updates.length) return 0;
    tempGit(['update-index', '-z', '--index-info'], { input: Buffer.from(`${updates.join('\0')}\0`, 'latin1') });
    renameSync(temp, lock);
    renameSync(lock, index);
    ownsLock = false;
    return updates.length;
  } finally {
    rmSync(temp, { force: true });
    if (ownsLock) rmSync(lock, { force: true });
  }
}

/** Compare and update under Git's lock, independently of the ordered ref writer.
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
        return updateLockedIndex(git, env, index, base, commit, checkout, paths);
      } catch (error) {
        if (error.code !== 'EEXIST' || error.path !== `${index}.lock`) throw error;
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
