import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

function gitAt(cwd, env) {
  return (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// Git owns index.lock. Retry its atomic update only when that lock is occupied;
// never remove another writer's lock, and prepare fresh HEAD records after waiting.
async function syncSharedIndex(cwd, commit, paths) {
  const env = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };
  delete env.GIT_INDEX_FILE;
  const git = gitAt(cwd, env);
  const index = git('rev-parse', '--path-format=absolute', '--git-path', 'index').trim();
  const watcher = fs.watch(path.dirname(index));
  try {
    for (;;) {
      const controller = new AbortController();
      const changed = once(watcher, 'change', { signal: controller.signal });
      changed.catch(() => {});
      try {
        const head = git('rev-parse', 'HEAD').trim();
        git('merge-base', '--is-ancestor', commit, head);
        const selected = new Set(paths);
        const entries = git('ls-tree', '-rz', head, '--', ...paths).split('\0')
          .filter((entry) => selected.has(entry.slice(entry.indexOf('\t') + 1)));
        const present = new Set(entries.map((entry) => entry.slice(entry.indexOf('\t') + 1)));
        const records = entries.map((entry) => entry.replace(/^(\d+) \S+ (\w+)\t/, '$1 $2\t'));
        for (const name of paths) {
          if (!present.has(name)) records.push(`0 ${'0'.repeat(head.length)}\t${name}`);
        }
        execFileSync('git', ['update-index', '-z', '--index-info'], {
          cwd, env, input: `${records.join('\0')}\0`, stdio: ['pipe', 'pipe', 'pipe'],
        });
        return;
      } catch (error) {
        if (!error.stderr?.toString().includes('index.lock') || !error.stderr.toString().includes('File exists')) throw error;
        console.error('Waiting for shared index lock');
        // If it was released between Git's refusal and this observation, retry now.
        if (fs.existsSync(`${index}.lock`)) await changed;
      } finally {
        controller.abort();
      }
    }
  } finally {
    watcher.close();
  }
}

export async function commitFromPrivateIndex({ cwd = process.cwd(), paths = [], messageFile, patchFile, syncCommit }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-commit-'));
  const env = { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_INDEX_FILE: path.join(temp, 'index') };
  const git = (...args) => gitAt(cwd, env)(...args).trim();
  try {
    const root = git('rev-parse', '--show-toplevel');
    cwd = root;
    if (syncCommit) {
      const commit = git('rev-parse', '--verify', `${syncCommit}^{commit}`);
      const committed = gitAt(cwd, env)('diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', commit).split('\0').filter(Boolean);
      if (committed.some((name) => name === '.project' || name.startsWith('.project/'))) throw new Error('Never stage .project paths');
      if (committed.length) await syncSharedIndex(cwd, commit, committed);
      return commit;
    }
    if (!messageFile || (!paths.length && !patchFile)) throw new Error('Provide a message file and exact paths or a patch');
    for (const name of paths) {
      if (path.isAbsolute(name) || name.split(/[\\/]/).some((part) => part === '..') || name === '.project' || name.startsWith('.project/')) throw new Error('Use exact repository-relative files outside .project');
      if (fs.existsSync(path.join(cwd, name)) && fs.lstatSync(path.join(cwd, name)).isDirectory()) throw new Error('Expand directories to exact files');
    }
    for (const key of ['user.name', 'user.email']) {
      if (!git('config', '--get', key)) throw new Error(`Missing Git ${key}`);
    }
    for (;;) {
      const head = git('rev-parse', 'HEAD');
      git('read-tree', head);
      if (paths.length) git('add', '--', ...paths);
      if (patchFile) git('apply', '--cached', '--check', patchFile);
      if (patchFile) git('apply', '--cached', patchFile);
      git('diff', '--cached', '--check');
      const committed = gitAt(cwd, env)('diff', '--cached', '--name-only', '--no-renames', '-z', head).split('\0').filter(Boolean);
      if (!committed.length) throw new Error('Refusing an empty commit');
      if (committed.some((name) => name === '.project' || name.startsWith('.project/'))) throw new Error('Never stage .project paths');
      const tree = git('write-tree');
      // Blocking producer closure (owner 2026-11-15, supersedes the 11-07 warn-only rule for this
      // check): the commit checker's textual scan runs on every packet, at every CAS attempt.
      const { commitProducerClosure } = await import('../workspaces/checkCommitTypeCoherence.mjs');
      const closure = commitProducerClosure({ repo: cwd, base: head, tree });
      if (closure.findings.length) {
        throw new Error([`Commit refused: producer closure found ${closure.findings.length} new break(s) in the packet's tree:`,
          ...closure.findings.map(finding => `  ${finding}`),
          'Commit each producer (export, module, package.json) with its consumer, or the importer adaptations with the producer change; otherwise leave the consumer uncommitted.'].join('\n'));
      }
      // Blocking plugin import-boundary check of the packet tree (changed plugin files, Git-object manifests).
      const { commitExtensionBoundaries } = await import('../workspaces/checkCommitTypeCoherence.mjs');
      const boundary = commitExtensionBoundaries({ repo: cwd, base: head, tree });
      if (boundary.findings.length) {
        throw new Error([`Commit refused: the packet adds ${boundary.findings.length} extension import-boundary violation(s):`,
          ...boundary.findings.map(finding => `  ${finding}`)].join('\n'));
      }
      const commit = git('commit-tree', tree, '-p', head, '-F', messageFile);
      try {
        git('update-ref', 'HEAD', commit, head);
      } catch (error) {
        if (git('rev-parse', 'HEAD') !== head) continue; // Rebuild, never attach an old tree to a new parent.
        throw error;
      }
      console.error(`Committed ${commit}; synchronizing shared index`);
      // HEAD moved: the rolling HEAD typecheck (owner ruling 2026-11-15) covers this commit; it never waits.
      const { kickRollingHeadTypecheck } = await import('../workspaces/commitPackageTypecheck.mjs');
      console.error(kickRollingHeadTypecheck({ repo: cwd }));
      await syncSharedIndex(cwd, commit, committed);
      return commit;
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = { paths: [] };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--message-file') options.messageFile = path.resolve(args[++i]);
    else if (args[i] === '--patch-file') options.patchFile = path.resolve(args[++i]);
    else if (args[i] === '--sync-commit') options.syncCommit = args[++i];
    else if (args[i] === '--') { options.paths = args.slice(i + 1); break; }
    else throw new Error('Usage: node scripts/git/commitFromPrivateIndex.mjs --message-file FILE [--patch-file PATCH] -- <exact files>; recovery: --sync-commit SHA');
  }
  try {
    console.log(await commitFromPrivateIndex(options));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
