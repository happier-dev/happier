import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncPublishedIndex } from '../workspaces/commitSharedIndex.mjs';

function gitAt(cwd, env) {
  return (...args) => runGit(cwd, env, args);
}

function runGit(cwd, env, args, options = {}) {
  return execFileSync('git', ['--no-optional-locks', ...args], {
    cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 2 ** 31 - 1, ...options,
  });
}

const diffOptions = ['--no-renames', '--no-ext-diff', '--no-textconv', '--no-color'];

function hunkDiff(git, name, ...trees) {
  return git('diff', ...diffOptions, '--unified=0', '--no-indent-heuristic', '--inter-hunk-context=0', ...trees, '--', name);
}

function textHunks(diff) {
  return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n(.*?)(?=^@@ |$(?![\s\S]))/gms)]
    .map(([, oldLine, oldCount, newLine, newCount, body]) => ({
      oldLine: Number(oldLine), oldCount: Number(oldCount ?? 1),
      newLine: Number(newLine), newCount: Number(newCount ?? 1),
      added: body.split('\n').filter((line) => line.startsWith('+')).map((line) => line.slice(1)),
      removed: body.split('\n').filter((line) => line.startsWith('-')).map((line) => line.slice(1)),
    }));
}

// Both diffs share HEAD as their reference: the right side of the landed diff
// is the left side of the checkout diff. Compare only those lines and modes.
function missingHunk(landed, checkout) {
  if (!landed || !checkout) return null;
  const mode = /^(?:new file|deleted file|old|new) mode |^Binary files .* differ$/m;
  if (mode.test(landed) && (mode.test(checkout) || /^Binary files .* differ$/m.test(landed))) {
    return 'file content or mode differs from the landed change';
  }
  const checkoutHunks = textHunks(checkout);
  for (const hunk of textHunks(landed)) {
    for (const edit of checkoutHunks) {
      const line = Math.max(hunk.newLine, edit.oldLine);
      if (hunk.newCount && edit.oldCount && line < Math.min(hunk.newLine + hunk.newCount, edit.oldLine + edit.oldCount)) {
        return `${line}: missing landed hunk ${hunk.added[line - hunk.newLine]}`;
      }
      if (!hunk.newCount && edit.oldLine === hunk.newLine && edit.added.some((line) => hunk.removed.includes(line))) {
        return `${hunk.newLine}: restored text removed by the landed hunk`;
      }
    }
  }
  return null;
}

function reconcileCheckout(cwd, env, commit) {
  const git = gitAt(cwd, env);
  const parent = git('rev-parse', `${commit}^`).trim();
  const names = git('diff', '--name-only', '--no-renames', '-z', parent, commit).split('\0').filter(Boolean);
  const patch = (from, to, name) => runGit(cwd, env, ['diff', ...diffOptions, '--binary', '--full-index',
    '--src-prefix=a/', '--dst-prefix=b/', from, to, '--', name], { encoding: 'buffer' });
  const apply = (input, ...flags) => runGit(cwd, env, ['apply', '--whitespace=nowarn', ...flags], { input });

  for (const name of names) {
    const warn = (reason) => console.error(`WARNING HSTACK_COMMITTED_CHECKOUT_DRIFT ${JSON.stringify(name)} after ${commit}: ${reason}`);
    let missing;
    try {
      const snapshot = () => {
        git('read-tree', '--empty');
        const stat = fs.lstatSync(path.join(cwd, name), { throwIfNoEntry: false });
        if (stat && !stat.isDirectory()) git('add', '--force', '--', name);
        return git('write-tree').trim();
      };
      const landed = hunkDiff(git, name, parent, commit);
      const before = snapshot();
      missing = missingHunk(landed, hunkDiff(git, name, commit, before));
      if (!missing) continue;
      if (hunkDiff(git, name, commit, 'HEAD')) {
        warn(`${missing}. A later commit changed this path`);
        continue;
      }
      if (/^deleted file mode /m.test(landed) && hunkDiff(git, name, parent, before)) {
        warn(`${missing}. The checkout still has edits to the deleted file`);
        continue;
      }
      // Resolve the three-way apply in our index. Only the clean result reaches the checkout.
      apply(patch(parent, commit, name), '--cached', '--3way');
      const merged = git('write-tree').trim();
      const update = patch(before, merged, name);
      if (update.length) apply(update);
      missing = missingHunk(landed, hunkDiff(git, name, commit, snapshot()));
      if (missing) warn(missing);
    } catch (error) {
      warn([missing, error.stderr?.trim() || error.message].filter(Boolean).join('. '));
    }
  }
}

export async function commitFromPrivateIndex({
  cwd = process.cwd(), paths = [], messageFile, patchFile, syncCommit, laneBase = process.env.P03_CP_PACKET_BASE,
}) {
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
      if (committed.length) {
        const base = git('rev-parse', '--verify', `${commit}^`);
        const count = await syncPublishedIndex({ repo: cwd, base, commit });
        console.error(`shared index: realigned ${count} entries`);
      }
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
    const { COMMIT_GATE_EXIT, finalizeGatedCommit, formatCommitGateIncomplete, formatCommitGateRefusal } = await import('../workspaces/commitGate.mjs');
    const base = git('rev-parse', 'HEAD');
    git('read-tree', base);
    if (paths.length && laneBase) {
      const authoredAt = git('rev-parse', '--verify', '--end-of-options', `${laneBase}^{commit}`);
      if (authoredAt !== base) {
        try {
          git('merge-base', '--is-ancestor', authoredAt, base);
        } catch (error) {
          if (error.status !== 1) throw error;
          throw new Error(`Paths base ${authoredAt} is not an ancestor of HEAD ${base}`);
        }
        const diff = gitAt(cwd, env);
        for (const name of paths) {
          const landed = hunkDiff(diff, name, authoredAt, base);
          const missing = /^deleted file mode /m.test(landed) && fs.lstatSync(path.join(cwd, name), { throwIfNoEntry: false })
            ? 'the checkout would restore a file deleted after the paths base'
            : missingHunk(landed, hunkDiff(diff, name, base));
          if (missing) throw new Error(`Stale checkout at ${name}:${missing}. Paths base ${authoredAt}, HEAD ${base}`);
        }
      }
    }
    if (paths.length) git('add', '--', ...paths);
    if (patchFile) git('apply', '--cached', '--check', patchFile);
    if (patchFile) git('apply', '--cached', patchFile);
    git('diff', '--cached', '--check', base);
    const committed = gitAt(cwd, env)('diff', '--cached', '--name-only', '--no-renames', '-z', base).split('\0').filter(Boolean);
    if (!committed.length) throw new Error('Refusing an empty commit');
    if (committed.some((name) => name === '.project' || name.startsWith('.project/'))) throw new Error('Never stage .project paths');

    const packet = { base, tree: git('write-tree') };
    const message = fs.readFileSync(messageFile, 'utf8');
    const commitPacket = (base, tree) => gitAt(cwd, env)('commit-tree', tree, '-p', base, '-F', messageFile).trim();
    const candidate = commitPacket(packet.base, packet.tree);
    const { commit, gate } = await finalizeGatedCommit({
      repo: cwd, packet, candidate, label: 'commitFromPrivateIndex', message,
      createCommit: ({ base, tree }) => base === packet.base && tree === packet.tree ? candidate : commitPacket(base, tree),
    });
    if (gate?.verdict === 'incomplete') {
      throw Object.assign(new Error(formatCommitGateIncomplete(gate)), { exitCode: COMMIT_GATE_EXIT.incomplete });
    }
    if (gate) throw new Error(formatCommitGateRefusal(gate));
    console.error(`Committed ${commit}`);
    reconcileCheckout(cwd, env, commit);
    // HEAD moved: the rolling HEAD typecheck (owner ruling 2026-11-15) covers this commit; it never waits.
    const { kickRollingHeadTypecheck } = await import('../workspaces/commitPackageTypecheck.mjs');
    console.error(kickRollingHeadTypecheck({ repo: cwd }));
    return commit;
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
    else if (args[i] === '--base') options.laneBase = args[++i];
    else if (args[i] === '--sync-commit') options.syncCommit = args[++i];
    else if (args[i] === '--') { options.paths = args.slice(i + 1); break; }
    else throw new Error('Usage: node scripts/git/commitFromPrivateIndex.mjs --message-file FILE [--patch-file PATCH] [--base SHA] -- <exact files>; recovery: --sync-commit SHA');
  }
  try {
    console.log(await commitFromPrivateIndex(options));
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
