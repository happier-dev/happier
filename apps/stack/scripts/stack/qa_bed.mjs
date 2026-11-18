import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runRetainedRuntimeCli } from './stack_reload_verification.mjs';
import profileSizes from '../../../../packages/tests/src/testkit/qaBed/profiles.json' with { type: 'json' };

/**
 * QA bed: one ready, verified Stack per lane on the existing Stack lifecycle.
 * `create` makes a `stack new --qa` Stack (or adopts an earlier qa-bed Stack),
 * pins its daemon next to its server, points the Claude Agent at the fake
 * Claude fixture, starts it on the producer's built revision, seeds a fresh
 * Account through the server's own API and signs the Stack CLI in with that
 * Account's recovery key. `reset` seeds a new Account (the earlier one stays in
 * the bed's own database, unseen) and signs the CLI and daemon in again.
 * `check` proves the bed end to end. Nothing here builds code: start adopts the
 * repository producer's products, so a bed costs a start, a seed and a check.
 */
export const QA_BED_PROFILE_ENV_KEY = 'HAPPIER_STACK_QA_BED_PROFILE';
export const QA_BED_PROFILES = Object.freeze(Object.keys(profileSizes));
const FAKE_CLAUDE_FIXTURE = 'packages/tests/src/fixtures/fake-claude-code-cli.js';
const FAKE_CLAUDE_REPLY_PREFIX = 'FAKE_CLAUDE_';

/**
 * The daemon runs the fake Claude from its own host's checkout mirror, so the
 * fixture path must be that host's. The bed pins the daemon next to its server
 * (one remote host, or the controller) so the path is known before first start.
 */
export function resolveQaBedDaemonHost(config, { localRepoDir }) {
  const server = config?.runtimePlacement?.server;
  const targetName = server?.mode === 'prefer-target' && typeof server.target === 'string' ? server.target : null;
  if (!targetName) return { target: null, repoDir: localRepoDir, fakeClaudePath: join(localRepoDir, FAKE_CLAUDE_FIXTURE) };
  const target = (config?.targets ?? []).find((entry) => entry?.name === targetName);
  if (!target || typeof target.repoDir !== 'string' || !target.repoDir) {
    throw Object.assign(new Error(`[qa-bed] server target ${targetName} has no repoDir in the Stack's dev-targets config`), { code: 'qa_bed_target_unknown' });
  }
  const separator = target.platform === 'windows' ? '\\' : '/';
  const repoDir = target.repoDir.replace(/[\\/]+$/, '');
  return { target: targetName, repoDir, fakeClaudePath: `${repoDir}${separator}${FAKE_CLAUDE_FIXTURE.split('/').join(separator)}` };
}

/** One verdict: the first failing check names what to fix; READY needs every check. */
export function projectQaBedReadiness({ roles, keyLogin, auth, seeded, agentTurn }) {
  const checks = [
    ['roles', roles?.ok === true],
    ['key_login', keyLogin?.status === 200],
    ['cli_auth', auth?.authenticated === true],
    ['seeded_data', seeded?.ok === true],
    ['agent_turn', agentTurn?.ok === true],
  ];
  const failed = checks.find(([, ok]) => !ok);
  return {
    status: failed ? 'NOT_READY' : 'READY',
    ...(failed ? { check: failed[0] } : {}),
    roles: roles ?? null,
    keyLogin: keyLogin ? { status: keyLogin.status } : null,
    auth: auth ? { authenticated: auth.authenticated === true } : null,
    seeded: seeded ?? null,
    agentTurn: agentTurn ?? null,
  };
}

/** The bed marker, read through the Stack env owner (one key, never the whole file). */
export async function readQaBedProfile({ rootDir, stackName }, { runStackImpl = runStack } = {}) {
  const result = await runStackImpl({ rootDir, args: ['env', stackName, 'get', QA_BED_PROFILE_ENV_KEY] });
  // A failed read is not an absent marker: never call our own bed foreign.
  if (result?.ok !== true) {
    throw Object.assign(new Error(`[qa-bed] could not read ${stackName}'s bed marker (exit ${result?.exitCode ?? result?.code ?? 'unknown'}); retry`),
      { code: 'qa_bed_marker_unreadable' });
  }
  const value = String(result.out ?? '').trim().split(/\r?\n/).at(-1)?.trim() ?? '';
  return QA_BED_PROFILES.includes(value) ? value : null;
}

function qaBedDir(baseDir) {
  return join(baseDir, 'qa-bed');
}

async function runStack({ rootDir, args, input, env = process.env }) {
  const { runCaptureResult } = await import('../utils/proc/proc.mjs');
  return await runCaptureResult(process.execPath, [join(rootDir, 'scripts/stack.mjs'), ...args],
    { cwd: rootDir, env, ...(input == null ? {} : { input }) });
}

function requireOk(result, step) {
  if (result?.ok === true) return result;
  // Only the step and exit code leave: child output can carry URLs or ids we never log.
  throw Object.assign(new Error(`[qa-bed] ${step} failed (exit ${result?.exitCode ?? result?.code ?? 'unknown'}); rerun the step by hand for its output`), { code: `qa_bed_${step}_failed` });
}

function readJsonLine(text, kind) {
  let found = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      if (value?.kind === kind) found = value;
    } catch { /* not a JSON line */ }
  }
  return found;
}

async function seedAccount({ rootDir, repoDir, serverUrl, profile, keyFile }) {
  const { runCaptureResult } = await import('../utils/proc/proc.mjs');
  const testsDir = join(repoDir, 'packages/tests');
  const result = await runCaptureResult(process.execPath, ['scripts/runTsxEntrypoint.mjs', 'src/testkit/qaBed/seedQaBedMain.ts',
    '--server-url', serverUrl, '--profile', profile, '--key-file', keyFile], { cwd: testsDir, env: process.env });
  requireOk(result, 'seed');
  const summary = readJsonLine(result.out, 'qa_bed_seed');
  if (!summary?.ok) throw Object.assign(new Error('[qa-bed] seed printed no summary'), { code: 'qa_bed_seed_failed' });
  void rootDir;
  return summary;
}

async function signInCli({ rootDir, stackName, keyFile }) {
  const recoveryKey = (await readFile(keyFile, 'utf8')).trim();
  // The Account changes on reset; the canonical logout clears the old credential first.
  await runRetainedRuntimeCli({ rootDir, stackName, runtimeMode: 'source-snapshot', args: ['auth', 'logout'], kind: 'auth_logout' });
  const login = await runRetainedRuntimeCli({ rootDir, stackName, runtimeMode: 'source-snapshot', args: ['auth', 'login', '--secrets-json-stdin'], kind: 'auth_recovery_key_login',
    input: JSON.stringify({ v: 1, secrets: { recoveryKey } }) });
  if (login?.ok !== true) {
    throw Object.assign(new Error(`[qa-bed] CLI sign-in failed (${login?.error?.code ?? 'no envelope'})`), { code: 'qa_bed_cli_login_failed' });
  }
}

export async function probeKeyLogin(serverUrl) {
  // The key-challenge issue answers 503 when the server has no canonical URL
  // (P03-MOBILE-SESSION-OPEN). Issuing a challenge writes nothing durable.
  try {
    const response = await fetch(`${serverUrl}/v1/auth/challenge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20_000),
    });
    await response.body?.cancel();
    return { status: response.status };
  } catch {
    return { status: 0 };
  }
}

function readRoles(info) {
  const identities = info?.runtime?.sourceRuntimeIdentities ?? {};
  const roles = {};
  for (const role of ['server', 'daemon']) {
    const selected = identities?.[role]?.selected ?? null;
    const loaded = identities?.[role]?.loaded ?? null;
    roles[role] = { selected, loaded, current: Boolean(selected) && selected === loaded };
  }
  return { ok: Object.values(roles).every((role) => role.current), ...roles };
}

async function probeSeededData({ rootDir, stackName, summary }) {
  if (!summary) return { ok: false, reason: 'no_seed_summary' };
  const list = await runRetainedRuntimeCli({ rootDir, stackName, runtimeMode: 'source-snapshot', args: ['session', 'list', '--limit', String(summary.sessions + 10)], kind: 'session_list' });
  const sessions = Array.isArray(list?.data?.sessions) ? list.data.sessions : null;
  if (!sessions) return { ok: false, reason: list?.error?.code ?? 'no_session_list' };
  const ids = new Set(sessions.map((session) => session?.id));
  const longVisible = summary.longSessionIds.every((id) => ids.has(id));
  return { ok: longVisible && sessions.length >= Math.min(summary.sessions, 50), listed: sessions.length, longVisible };
}

async function probeAgentTurn({ rootDir, stackName }) {
  const startedAt = Date.now();
  const created = await runRetainedRuntimeCli({ rootDir, stackName, runtimeMode: 'source-snapshot',
    args: ['session', 'create', '--agent', 'claude', '--title', 'QA bed readiness turn', '--prompt', 'QA bed readiness probe', '--wait', '--timeout', '180'],
    kind: 'session_create' });
  const sessionId = created?.ok === true ? created.data?.session?.id : null;
  if (typeof sessionId !== 'string' || !sessionId) {
    return { ok: false, phase: 'create', code: created?.error?.code ?? null };
  }
  const history = await runRetainedRuntimeCli({ rootDir, stackName, runtimeMode: 'source-snapshot', args: ['session', 'history', sessionId, '--tail', '10', '--format', 'raw'], kind: 'session_history' });
  // Only a boolean leaves: transcript text never reaches the verdict or logs.
  const replied = JSON.stringify(history?.data ?? null).includes(FAKE_CLAUDE_REPLY_PREFIX);
  await runRetainedRuntimeCli({ rootDir, stackName, runtimeMode: 'source-snapshot', args: ['session', 'stop', sessionId], kind: 'session_stop' });
  await runRetainedRuntimeCli({ rootDir, stackName, runtimeMode: 'source-snapshot', args: ['session', 'archive', sessionId], kind: 'session_archive' });
  return { ok: replied, phase: replied ? 'replied' : 'history', durationMs: Date.now() - startedAt };
}

export async function checkQaBed({ rootDir, stackName }) {
  const { readStackInfoSnapshot } = await import('./stack_info_snapshot.mjs');
  const { resolveStackEnvPath } = await import('../utils/paths/paths.mjs');
  const startedAt = Date.now();
  const info = await readStackInfoSnapshot({ rootDir, stackName });
  const serverUrl = String(info?.urls?.canonicalServerUrl ?? info?.urls?.internalServerUrl ?? '').replace(/\/+$/, '');
  const summary = await readFile(join(qaBedDir(resolveStackEnvPath(stackName).baseDir), 'seed.json'), 'utf8').then(JSON.parse).catch(() => null);
  const roles = readRoles(info);
  const keyLogin = serverUrl ? await probeKeyLogin(serverUrl) : { status: 0 };
  const status = await runRetainedRuntimeCli({ rootDir, stackName, runtimeMode: 'source-snapshot', args: ['auth', 'status'], kind: 'auth_status' });
  const auth = { authenticated: status?.ok === true && status.data?.authenticated === true };
  const seeded = auth.authenticated ? await probeSeededData({ rootDir, stackName, summary }) : null;
  const agentTurn = auth.authenticated ? await probeAgentTurn({ rootDir, stackName }) : null;
  return {
    ...projectQaBedReadiness({ roles, keyLogin, auth, seeded, agentTurn }),
    stack: stackName,
    profile: summary?.profile ?? null,
    urls: { uiUrl: info?.urls?.uiUrl ?? null, mobileUrl: info?.urls?.mobileUrl ?? null },
    durationMs: Date.now() - startedAt,
  };
}

async function seedAndSignIn({ rootDir, stackName, profile }) {
  const { readStackInfoSnapshot } = await import('./stack_info_snapshot.mjs');
  const { resolveStackEnvPath } = await import('../utils/paths/paths.mjs');
  const info = await readStackInfoSnapshot({ rootDir, stackName });
  const serverUrl = serverUrlOf(info);
  if (!serverUrl) throw Object.assign(new Error('[qa-bed] the Stack reports no server URL; is it running?'), { code: 'qa_bed_server_url_missing' });
  const dir = qaBedDir(resolveStackEnvPath(stackName).baseDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const keyFile = join(dir, 'account.key');
  const summary = await seedAccount({ rootDir, repoDir: info.repo.dir, serverUrl, profile, keyFile });
  // Counts and Session ids only; the key stays in account.key (0600).
  await writeFile(join(dir, 'seed.json'), `${JSON.stringify({ ...summary, seededAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  await signInCli({ rootDir, stackName, keyFile });
  return { summary, keyFile };
}

export async function startQaBedStack({ rootDir, stackName, step }, { runStackImpl = runStack } = {}) {
  // Always the reload route: it selects the producer's latest built revision
  // (`--rev` default) and adopts it. A plain first start captures the checkout
  // instead and adopts the producer's newest completed capture. The default UI adopts
  // the revision's shared export when one exists; `--ui=export` is not forced:
  // a revision export captured from the moving checkout refuses on drift, which
  // would refuse the whole start (2026-11-16 19:20Z).
  const started = await runStackImpl({ rootDir, args: ['start', stackName, '--background', '--runtime=source', '--no-browser', '--restart'] });
  if (started?.ok === true) return started;
  // A start that failed part way can leave a remote runtime, its forwards or the
  // runner up, and a retry then cannot bind them. The Stack's own stop retires
  // everything it recorded; this bed is ours (create/reset checked the marker).
  const stopped = await runStackImpl({ rootDir, args: ['stop', stackName] });
  const exit = (result) => result?.exitCode ?? result?.code ?? 'unknown';
  const cleanup = stopped?.ok === true ? 'stopped' : 'stop_failed';
  throw Object.assign(new Error(`[qa-bed] ${step} failed (exit ${exit(started)}); ${cleanup === 'stopped'
    ? 'the bed was stopped, so a retry starts clean'
    : `stop also failed (exit ${exit(stopped)}); run \`hstack stack stop ${stackName}\` before retrying`}; rerun the step by hand for its output`),
  { code: `qa_bed_${step}_failed`, cleanup });
}

async function startBed(input) {
  await startQaBedStack(input);
}

export async function createQaBed({ rootDir, stackName, profile, repoDir }) {
  const { stackExistsSync } = await import('../utils/stack/stacks.mjs');
  const { loadDevTargetsConfig } = await import('../utils/dev_targets/config.mjs');
  const startedAt = Date.now();
  if (stackExistsSync(stackName)) {
    // Never adopt someone else's Stack: only an earlier qa-bed carries the marker.
    if (!(await readQaBedProfile({ rootDir, stackName }))) {
      throw Object.assign(new Error(`[qa-bed] Stack ${stackName} exists and is not a QA bed; pick another name`), { code: 'qa_bed_foreign_stack' });
    }
  } else {
    requireOk(await runStack({ rootDir, args: ['new', stackName, '--qa', `--repo=${repoDir}`, '--server=happier-server-light',
      '--db-provider=sqlite', '--no-copy-auth', '--non-interactive'] }), 'new');
  }
  const { config } = await loadDevTargetsConfig({ stackName });
  const host = resolveQaBedDaemonHost(config, { localRepoDir: repoDir });
  requireOk(await runStack({ rootDir, args: ['dev-targets', 'placement', 'set', 'daemon', host.target ?? 'local', `--stack=${stackName}`] }), 'daemon_placement');
  requireOk(await runStack({ rootDir, args: ['env', stackName, 'set', `${QA_BED_PROFILE_ENV_KEY}=${profile}`, `HAPPIER_CLAUDE_PATH=${host.fakeClaudePath}`] }), 'env');
  await startBed({ rootDir, stackName, step: 'start' });
  const { summary } = await seedAndSignIn({ rootDir, stackName, profile });
  // The daemon waited for a credential; a restart makes it load the new one now.
  await startBed({ rootDir, stackName, step: 'restart' });
  const readiness = await checkQaBed({ rootDir, stackName });
  return { ...readiness, seeded: { ...readiness.seeded, sessions: summary.sessions, messages: summary.messages },
    daemonHost: host.target ?? 'local', totalMs: Date.now() - startedAt };
}

function serverUrlOf(info) {
  return String(info?.urls?.canonicalServerUrl ?? info?.urls?.internalServerUrl ?? '').replace(/\/+$/, '');
}

async function readQaBedServerUrl({ rootDir, stackName }) {
  const { readStackInfoSnapshot } = await import('./stack_info_snapshot.mjs');
  return serverUrlOf(await readStackInfoSnapshot({ rootDir, stackName }));
}

/** Seeding needs the bed's server; a bed a failed create stopped is started first. */
export async function ensureQaBedRunning({ rootDir, stackName }, { readServerUrlImpl = readQaBedServerUrl, startImpl = startBed } = {}) {
  if (await readServerUrlImpl({ rootDir, stackName })) return;
  await startImpl({ rootDir, stackName, step: 'start' });
}

export async function resetQaBed({ rootDir, stackName, profile: requestedProfile }) {
  const startedAt = Date.now();
  const currentProfile = await readQaBedProfile({ rootDir, stackName });
  const profile = requestedProfile ?? currentProfile;
  if (!currentProfile) {
    throw Object.assign(new Error(`[qa-bed] Stack ${stackName} is not a QA bed (no ${QA_BED_PROFILE_ENV_KEY})`), { code: 'qa_bed_foreign_stack' });
  }
  if (requestedProfile && requestedProfile !== currentProfile) {
    requireOk(await runStack({ rootDir, args: ['env', stackName, 'set', `${QA_BED_PROFILE_ENV_KEY}=${requestedProfile}`] }), 'env');
  }
  await ensureQaBedRunning({ rootDir, stackName });
  // A fresh Account is the known state: no database deletion, no stale rows.
  await seedAndSignIn({ rootDir, stackName, profile });
  await startBed({ rootDir, stackName, step: 'restart' });
  return { ...(await checkQaBed({ rootDir, stackName })), totalMs: Date.now() - startedAt };
}

export async function runQaBedCommand({ rootDir, argv }) {
  const positionals = argv.filter((arg) => !arg.startsWith('--'));
  const action = positionals[1];
  const stackName = positionals[2];
  const profileArg = argv.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length);
  if (!['create', 'reset', 'check'].includes(action) || !stackName || (profileArg && !QA_BED_PROFILES.includes(profileArg))) {
    process.stderr.write(`Usage: hstack stack qa-bed create|reset|check <stack> [--profile=${QA_BED_PROFILES.join('|')}]\n`);
    process.exitCode = 2;
    return;
  }
  const { getRepoDir } = await import('../utils/paths/paths.mjs');
  let result;
  try {
    if (action === 'create') result = await createQaBed({ rootDir, stackName, profile: profileArg ?? 'small', repoDir: getRepoDir(rootDir, process.env) });
    else if (action === 'reset') result = await resetQaBed({ rootDir, stackName, profile: profileArg });
    else result = await checkQaBed({ rootDir, stackName });
  } catch (error) {
    result = { status: 'NOT_READY', check: action, code: error?.code ?? null, ...(error?.cleanup ? { cleanup: error.cleanup } : {}),
      message: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${JSON.stringify({ kind: 'qa_bed', action, ...result })}\n`);
  if (result.status !== 'READY') process.exitCode = 1;
}
