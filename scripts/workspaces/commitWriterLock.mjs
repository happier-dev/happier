import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync,
  writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gitIn } from './commitProducerClosure.mjs';

export function commitGateLockPath(repo) {
  const common = gitIn(repo)(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  return join(common, 'p03-commit-partial.lock');
}

async function flock(repo, fd, flags) {
  const child = spawn('flock', [...flags, '3'], { cwd: repo, stdio: ['ignore', 'ignore', 'inherit', fd] });
  const [code, signal] = await once(child, 'exit');
  if (code === 1 && flags.includes('-n')) return false;
  if (code !== 0) throw new Error(`commit gate: flock failed (${signal ?? code})`);
  return true;
}

function readRecord(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function openTicket(dir) {
  try { return openSync(join(dir, 'writer'), 'r+'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** The record exists only while this admitted writer is waiting or landing. Its
 * flock releases if the process dies, even if the pathname survives the writer.
 */
export async function withCommitLock({ repo, ref = 'HEAD', label = 'commit-gate', arrival, packet }, run) {
  const git = gitIn(repo);
  const moveRef = ({ commit, head, reason }) => git(['update-ref', '-m', reason, ref, commit, head]);
  if (process.platform === 'win32') return await run(moveRef);

  const scopeRef = git(['rev-parse', '--symbolic-full-name', ref]).trim();
  const path = commitGateLockPath(repo);
  const queue = `${path}.writers`;
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const draft = mkdtempSync(join(queue, '.writer-'));
  const ticket = openSync(join(draft, 'writer'), 'wx+', 0o600);
  const at = Number(arrival);
  const rank = String(Number.isSafeInteger(at) && at > 0 ? at : Date.now()).padStart(16, '0');
  const name = `${rank}-${basename(draft).slice('.writer-'.length)}`;
  let dir = draft;
  let mark;
  let lock;
  try {
    try { await flock(repo, ticket, ['-x', '-n']); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      process.stderr.write('commit gate: no flock on this host; plain compare-and-swap\n');
      return await run(moveRef);
    }
    writeFileSync(ticket, JSON.stringify({ repo, ref: scopeRef, packet }));
    renameSync(draft, join(queue, name));
    dir = join(queue, name);

    const ordered = () => readdirSync(queue).filter(entry => /^\d{16}-[\w]+$/u.test(entry)).sort();
    const grouped = () => readRecord(join(dir, 'landing'));
    const previousTicket = () => ordered().findLast(entry => entry < name);
    const queued = async function* () {
      for (const entry of ordered()) {
        if (previousTicket()) return;
        if (entry <= name) continue;
        const waiting = join(queue, entry);
        const fd = openTicket(waiting);
        if (fd === undefined) continue;
        try {
          if (await flock(repo, fd, ['-x', '-n'])) {
            rmSync(waiting, { recursive: true, force: true });
            continue;
          }
          const record = readRecord(join(waiting, 'writer'));
          if (!record || record.repo !== repo || record.ref !== scopeRef) return;
          yield { packet: record.packet, saveLanding: result => {
            const pending = join(waiting, 'landing.tmp');
            writeFileSync(pending, JSON.stringify(result), { mode: 0o600 });
            renameSync(pending, join(waiting, 'landing'));
          } };
        } finally { closeSync(fd); }
      }
    };
    for (;;) {
      const landed = grouped();
      if (landed && isLanded(git, landed.commit, ref)) return landed;
      const older = previousTicket();
      if (older) {
        const previous = join(queue, older);
        const fd = openTicket(previous);
        if (fd === undefined) continue;
        try {
          await flock(repo, fd, ['-s']);
          rmSync(previous, { recursive: true, force: true });
        } finally { closeSync(fd); }
        continue;
      }
      lock = openSync(path, 'a');
      await flock(repo, lock, ['-x']);
      // A writer with an earlier arrival can finish admission while we wait.
      if (!previousTicket()) break;
      closeSync(lock);
      lock = undefined;
    }
    const landed = grouped();
    if (landed && isLanded(git, landed.commit, ref)) return landed;
    mark = `${path}.holder`;
    writeFileSync(mark, `pid=${process.pid} since=${new Date().toISOString().slice(11, 19)}Z msg=${label}\n`);
    return await run(moveRef, queued);
  } finally {
    try { if (mark) rmSync(mark, { force: true }); }
    finally {
      if (lock !== undefined) closeSync(lock);
      try { rmSync(dir, { recursive: true, force: true }); }
      finally { closeSync(ticket); }
    }
  }
}

function isLanded(git, commit, ref) {
  try { git(['merge-base', '--is-ancestor', commit, ref]); return true; }
  catch (error) { if (error.status !== 1) throw error; return false; }
}
