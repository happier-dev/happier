import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync,
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
export async function withCommitLock({ repo, ref = 'HEAD', label = 'commit-gate', arrival, packet, prepare, plan,
  onPublishedHold, restoresHead }, run) {
  const git = gitIn(repo);
  const currentHead = () => git(['rev-parse', '--verify', ref]).trim();
  const moveRef = ({ commit, head, reason }) => git(['update-ref', '-m', reason, ref, commit, head]);
  const withoutLock = async () => await run(moveRef, undefined, undefined, plan && await plan(currentHead()));
  if (process.platform === 'win32') return await withoutLock();

  const scopeRef = git(['rev-parse', '--symbolic-full-name', ref]).trim();
  const path = commitGateLockPath(repo);
  const queue = `${path}.writers`;
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const draft = mkdtempSync(join(queue, '.writer-'));
  const ticket = openSync(join(draft, 'writer'), 'wx+', 0o600);
  const at = Number(arrival);
  const arrived = String(Number.isSafeInteger(at) && at > 0 ? at : Date.now()).padStart(16, '0');
  // Keep the existing sortable ticket spelling so writers already waiting see the priority too.
  const rank = restoresHead ? '0'.repeat(16) : arrived;
  const sequence = restoresHead ? arrived : '';
  const name = `${rank}-${sequence}${basename(draft).slice('.writer-'.length)}`;
  let dir = draft;
  let mark;
  let lock;
  let lockedAt;
  try {
    try { await flock(repo, ticket, ['-x', '-n']); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      process.stderr.write('commit gate: no flock on this host; plain compare-and-swap\n');
      return await withoutLock();
    }
    writeFileSync(ticket, JSON.stringify({ repo, ref: scopeRef, packet, restoresHead }));
    renameSync(draft, join(queue, name));
    dir = join(queue, name);

    const ordered = () => readdirSync(queue).filter(entry => /^\d{16}-[\w]+$/u.test(entry)).sort();
    const grouped = () => readRecord(join(dir, 'landing'));
    const olderTickets = () => ordered().filter(entry => entry < name);
    const queueVersion = () => ordered().filter(entry => entry > name)
      .map(entry => existsSync(join(queue, entry, 'entry-proof')) ? `${entry}+` : entry).join(' ');
    const waitForTicket = async entry => {
      const waiting = join(queue, entry);
      const fd = openTicket(waiting);
      if (fd === undefined) return;
      try {
        await flock(repo, fd, ['-s']);
        rmSync(waiting, { recursive: true, force: true });
      } finally { closeSync(fd); }
    };
    const queued = async function* () {
      for (const entry of ordered()) {
        if (olderTickets().length) return;
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
          yield { id: entry, packet: record.packet, restoresHead: record.restoresHead, entryProof: readRecord(join(waiting, 'entry-proof')), saveLanding: result => {
            const pending = join(waiting, 'landing.tmp');
            writeFileSync(pending, JSON.stringify(result), { mode: 0o600 });
            renameSync(pending, join(waiting, 'landing'));
          } };
        } finally { closeSync(fd); }
      }
    };
    // Prepare near the front instead of probing a tree many commits before landing.
    let predecessor;
    let predecessorProof;
    if (prepare) {
      let older = olderTickets();
      while (older.length > 1) {
        await waitForTicket(older.at(-2));
        older = olderTickets();
      }
      if (older.length) {
        predecessor = readRecord(join(queue, older[0], 'writer'));
        predecessorProof = readRecord(join(queue, older[0], 'entry-proof'));
      }
    }
    const entryProof = predecessor?.repo === repo && predecessor.ref === scopeRef
      ? await prepare(predecessor.packet, predecessorProof) : undefined;
    if (entryProof) {
      const pending = join(dir, 'entry-proof.tmp');
      writeFileSync(pending, JSON.stringify(entryProof), { mode: 0o600 });
      renameSync(pending, join(dir, 'entry-proof'));
    }
    let planned;
    for (;;) {
      const landed = grouped();
      if (landed && isLanded(git, landed.commit, ref)) return landed;
      const older = olderTickets().at(-1);
      if (older) {
        await waitForTicket(older);
        continue;
      }
      const head = plan && currentHead();
      const version = plan && queueVersion();
      if (plan) planned = await plan(head, queued, entryProof);
      // A restoration may have been admitted or completed during preparation.
      if (olderTickets().length) continue;
      lock = openSync(path, 'a');
      const waitingAt = performance.now();
      await flock(repo, lock, ['-x']);
      lockedAt = performance.now();
      // A writer with an earlier arrival can finish admission while we wait.
      if (!olderTickets().length && (!plan || (head === currentHead() && version === queueVersion()))) {
        if (plan) console.error(`commit gate: ref lock acquisition ${Math.round(lockedAt - waitingAt)} ms`);
        break;
      }
      closeSync(lock);
      lock = undefined;
      lockedAt = undefined;
      if (plan) console.error('commit gate: prepared ref or ready queue changed; rechecking before publication');
    }
    const landed = grouped();
    if (landed && isLanded(git, landed.commit, ref)) return landed;
    mark = `${path}.holder`;
    writeFileSync(mark, `pid=${process.pid} since=${new Date().toISOString().slice(11, 19)}Z msg=${label}\n`);
    return await run(moveRef, queued, entryProof, planned);
  } finally {
    try { if (mark) rmSync(mark, { force: true }); }
    finally {
      if (lock !== undefined) closeSync(lock);
      const holdMs = lockedAt === undefined ? undefined : performance.now() - lockedAt;
      try { rmSync(dir, { recursive: true, force: true }); }
      finally { closeSync(ticket); }
      if (holdMs !== undefined && mark) onPublishedHold?.(holdMs);
    }
  }
}

function isLanded(git, commit, ref) {
  try { git(['merge-base', '--is-ancestor', commit, ref]); return true; }
  catch (error) { if (error.status !== 1) throw error; return false; }
}
