#!/usr/bin/env node
// @ts-check
// desktop-setup suite — what a user hits when they download the desktop app (release validation
// layers 2 and 3). The hsetup under test is extracted from the Linux desktop artifact itself and
// drives `setup.thisComputer.v1` headlessly over its JSON-lines protocol against a relay, on a
// systemd machine that starts with no Happier CLI, daemon or service. See README.md.
//
//   fresh-setup  (desktop1): hsetup acquires the CLI from the staged release (not GitHub), pairs,
//                installs + starts the systemd user service, exposes `happier`; the machine then
//                answers a relay-routed `capabilities.describe` (INV10) and converges (INV8).
//   upgrade      (desktop2): the previous published hsetup + CLI set the machine up; the new
//                hsetup setup and `cli.update.v1` must leave the daemon restarted on the new CLI,
//                still the same machine, still answering (the Linux stale-daemon class).

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  createFeedTlsMaterial,
  downloadPinnedCliAssets,
  downloadPinnedDesktopDeb,
  extractBundledHsetup,
  resolveChannelForCliVersion,
  resolvePublishedCliTag,
  resolvePublishedStableBaseline,
  stageCliReleaseAssets,
} from './desktop-setup-artifacts.mjs';
import { PREDECESSOR_SETUP_PARAMS_BY_DESKTOP_TAG, runHsetupTask } from './desktop-setup-driver.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RELAY_URL = 'http://relay:3005';
const APPROVER_SERVER_ID = 'desktop-setup-e2e';
const APPROVER_HOME = '/approver-home';
const MACHINE_USER = 'happy';
const MACHINE_HOME = `/home/${MACHINE_USER}`;
const DEFAULT_REPO = 'happier-dev/happier';
// Readiness waits poll a concrete condition. Their bounds mirror the existing release-assets
// harness (relay: 180 s in run.sh; systemd user manager: the boot it waits on), not a new budget.
const RELAY_READY_ATTEMPTS = 90;
const USER_BUS_ATTEMPTS = 60;

/**
 * @typedef {{ check: string; pass: boolean; detail?: unknown }} Check
 * @typedef {{ id: string; status: 'PASS' | 'FAIL' | 'BLOCKED'; checks: Check[]; observations: Record<string, unknown>; durationMs: number; blockedReason?: string }} ScenarioResult
 */

/** @param {Check[]} checks */
function scenarioStatus(checks) {
  return checks.every((entry) => entry.pass) ? 'PASS' : 'FAIL';
}

/**
 * The fresh-download contract, decided from what the run observed.
 * @param {{
 *   expectedCliVersion: string;
 *   precondition: { happierOnPath: string; happierHomeExists: boolean; userUnits: string };
 *   inspection: { exitCode: unknown; result: any; prompts: { kind: string }[] };
 *   setup: { exitCode: unknown; result: any; prompts: { kind: string }[] };
 *   feedServedArchive: boolean;
 *   pathCommand: string;
 *   pathCommandResolved: string;
 *   pathVersion: string;
 *   status: any;
 *   systemd: { active: string; enabled: string };
 *   probe: any;
 * }} observed
 * @returns {Check[]}
 */
export function evaluateFreshSetup(observed) {
  const data = observed.setup.result?.data ?? {};
  const status = observed.status ?? {};
  const convergence = status.runtimeConvergence ?? {};
  return [
    { check: 'machine starts with no CLI, no ~/.happier and no user service', pass: !observed.precondition.happierOnPath && !observed.precondition.happierHomeExists && !observed.precondition.userUnits, detail: observed.precondition },
    { check: 'first-launch inspection (daemon.service.status.v1) succeeds without prompting', pass: observed.inspection.exitCode === 0 && observed.inspection.result?.ok === true && observed.inspection.prompts.length === 0, detail: observed.inspection.result?.error ?? observed.inspection.prompts.map((prompt) => prompt.kind) },
    { check: 'setup.thisComputer.v1 succeeds', pass: observed.setup.exitCode === 0 && observed.setup.result?.ok === true, detail: observed.setup.result?.error ?? null },
    { check: 'the only prompt is the pairing approval', pass: observed.setup.prompts.length === 1 && observed.setup.prompts[0]?.kind === 'setup.pairThisComputer', detail: observed.setup.prompts.map((prompt) => prompt.kind) },
    { check: 'CLI is managed and is the build under test', pass: data.cliProvenance === 'managed' && data.cliVersion === observed.expectedCliVersion, detail: { cliProvenance: data.cliProvenance, cliVersion: data.cliVersion, expected: observed.expectedCliVersion } },
    { check: 'CLI archive came from the staged release feed', pass: observed.feedServedArchive },
    { check: 'service was installed by setup', pass: data.serviceAction === 'install', detail: data.serviceAction },
    { check: '`happier` on a login PATH is the managed shim', pass: observed.pathCommand === `${MACHINE_HOME}/.happier/bin/happier` && observed.pathCommandResolved.startsWith(`${MACHINE_HOME}/.happier/`) && observed.pathVersion === observed.expectedCliVersion, detail: { command: observed.pathCommand, resolved: observed.pathCommandResolved, version: observed.pathVersion } },
    { check: 'systemd user service is enabled and active', pass: observed.systemd.active === 'active' && observed.systemd.enabled === 'enabled', detail: observed.systemd },
    { check: 'daemon status: service installed, running, service-managed', pass: status.service?.installed === true && status.service?.running === true && status.daemon?.serviceManaged === true, detail: { service: status.service, serviceManaged: status.daemon?.serviceManaged } },
    { check: 'runtimeConvergence proves the running daemon (INV8)', pass: convergence.controlReachable === true && convergence.serviceOwnsRunningDaemon === true && convergence.machineIdMatches === true && convergence.cliVersionMatches === true, detail: convergence },
    { check: 'daemon runs the build under test for the paired machine', pass: status.daemon?.startedWithCliVersion === observed.expectedCliVersion && status.auth?.machineId === data.machineId, detail: { startedWithCliVersion: status.daemon?.startedWithCliVersion, machineId: status.auth?.machineId, setupMachineId: data.machineId } },
    { check: 'machine answers a relay-routed capabilities.describe (INV10)', pass: observed.probe?.ok === true && observed.probe?.machineId === data.machineId, detail: observed.probe },
  ];
}

/**
 * The upgrade contract.
 * @param {{
 *   previousCliVersion: string;
 *   expectedCliVersion: string;
 *   previousSetup: { exitCode: unknown; result: any };
 *   previousStatus: any;
 *   previousProbe: any;
 *   newInspection: { exitCode: unknown; result: any };
 *   newSetup: { exitCode: unknown; result: any; prompts: { kind: string }[] };
 *   update: { exitCode: unknown; result: any };
 *   finalStatus: any;
 *   systemd: { active: string };
 *   finalProbe: any;
 * }} observed
 * @returns {Check[]}
 */
export function evaluateUpgrade(observed) {
  const previousMachineId = observed.previousStatus?.auth?.machineId ?? null;
  const finalStatus = observed.finalStatus ?? {};
  const convergence = finalStatus.runtimeConvergence ?? {};
  const update = observed.update.result?.data ?? {};
  return [
    { check: 'previous hsetup sets the machine up on the previous CLI', pass: observed.previousSetup.exitCode === 0 && observed.previousSetup.result?.ok === true && observed.previousStatus?.daemon?.startedWithCliVersion === observed.previousCliVersion, detail: { error: observed.previousSetup.result?.error ?? null, startedWithCliVersion: observed.previousStatus?.daemon?.startedWithCliVersion } },
    { check: 'previous daemon answers through the relay', pass: observed.previousProbe?.ok === true, detail: observed.previousProbe },
    { check: "new app's inspection reads the machine the previous app set up", pass: observed.newInspection.exitCode === 0 && observed.newInspection.result?.ok === true, detail: observed.newInspection.result?.error ?? null },
    { check: 'new hsetup setup succeeds without pairing again', pass: observed.newSetup.exitCode === 0 && observed.newSetup.result?.ok === true && !observed.newSetup.prompts.some((prompt) => prompt.kind === 'setup.pairThisComputer'), detail: { error: observed.newSetup.result?.error ?? null, prompts: observed.newSetup.prompts.map((prompt) => prompt.kind) } },
    { check: 'cli.update.v1 reports the new CLI', pass: observed.update.exitCode === 0 && observed.update.result?.ok === true && update.version === observed.expectedCliVersion, detail: observed.update.result },
    { check: 'daemon restarted on the new CLI (INV8 cliVersionMatches)', pass: finalStatus.daemon?.startedWithCliVersion === observed.expectedCliVersion && convergence.cliVersionMatches === true && convergence.serviceOwnsRunningDaemon === true && convergence.controlReachable === true, detail: { startedWithCliVersion: finalStatus.daemon?.startedWithCliVersion, convergence } },
    { check: 'still the same machine', pass: previousMachineId !== null && finalStatus.auth?.machineId === previousMachineId && convergence.machineIdMatches === true, detail: { before: previousMachineId, after: finalStatus.auth?.machineId } },
    { check: 'systemd user service still active', pass: observed.systemd.active === 'active', detail: observed.systemd },
    { check: 'upgraded daemon answers through the relay (INV10)', pass: observed.finalProbe?.ok === true && observed.finalProbe?.machineId === previousMachineId, detail: observed.finalProbe },
  ];
}

/**
 * Drive the released predecessor through its process boundaries.
 * @param {{ relayUrl: string; webappUrl: string; setupParams: unknown; inspectionParams: unknown; runHsetup: (kind: string, params: unknown, env?: Record<string, string>) => Promise<{ exitCode: unknown; result: { ok: boolean; error?: { code: string; message: string } } | null }>; runCli: (args: string[]) => unknown }} options
 */
export async function runPredecessorSetup({ relayUrl, webappUrl, setupParams, inspectionParams, runHsetup, runCli }) {
  // 0.2.12's server current reads the saved profile, not URL environment overrides. Its
  // default-following service does too. Acquire through the app's read-only inspection, then
  // select the relay using that released CLI's public command before the old app reads it.
  await runHsetup('daemon.service.status.v1', inspectionParams);
  runCli(['server', 'set', '--server-url', relayUrl, '--webapp-url', webappUrl, '--json']);
  return runHsetup('setup.thisComputer.v1', setupParams);
}

/**
 * Observe the installed Linux unit reported by the CLI, rather than its daemon ownership label.
 * @param {{ serviceStatus: { installed?: boolean; installedPath?: string } | null; run: (command: string) => { stdout: string } }} options
 */
export function readSystemdState({ serviceStatus, run }) {
  if (serviceStatus?.installed !== true || typeof serviceStatus.installedPath !== 'string' || !serviceStatus.installedPath.endsWith('.service')) {
    throw new Error('CLI service status did not report an installed systemd unit');
  }
  const unit = basename(serviceStatus.installedPath);
  return {
    unit,
    active: run(`systemctl --user is-active '${unit}'`).stdout.trim(),
    enabled: run(`systemctl --user is-enabled '${unit}'`).stdout.trim(),
  };
}

function createCompose({ projectName, envFile }) {
  const base = ['compose', '--project-name', projectName, '-f', join(here, 'compose.desktop-setup.yml'), '--env-file', envFile];
  /**
   * @param {string[]} args
   * @param {{ input?: string; allowFailure?: boolean; stdio?: 'inherit' | 'pipe' }} [options]
   */
  const run = (args, options = {}) => {
    const out = spawnSync('docker', [...base, ...args], {
      encoding: 'utf8',
      input: options.input,
      stdio: options.stdio === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (out.status !== 0 && !options.allowFailure) {
      throw new Error(`docker compose ${args.join(' ')} failed (${out.status}): ${String(out.stderr ?? '').trim() || String(out.stdout ?? '').trim()}`);
    }
    return { status: out.status, stdout: String(out.stdout ?? ''), stderr: String(out.stderr ?? '') };
  };
  return { base, run };
}

/** @param {string} text */
export function parseLastJsonObject(text) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep looking
    }
  }
  const start = text.indexOf('{');
  return start >= 0 ? JSON.parse(text.slice(start)) : null;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function main() {
  const { values } = parseArgs({
    options: {
      'desktop-artifact': { type: 'string', default: '' },
      'cli-assets-dir': { type: 'string', default: '' },
      'cli-tag': { type: 'string', default: '' },
      'cli-channel': { type: 'string', default: '' },
      channel: { type: 'string', default: '' },
      'relay-image': { type: 'string', default: '' },
      scenarios: { type: 'string', default: 'fresh-setup,upgrade' },
      'upgrade-from-cli-tag': { type: 'string', default: '' },
      'upgrade-from-desktop-tag': { type: 'string', default: '' },
      repo: { type: 'string', default: DEFAULT_REPO },
      'work-dir': { type: 'string', default: '' },
      keep: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    // Linux desktop artifacts ship for x86_64 only, and the machines run the host's architecture.
    throw new Error(`desktop-setup needs an x86_64 Linux Docker host (this host is ${process.platform}-${process.arch})`);
  }
  const startedAt = Date.now();
  const repo = String(values.repo);
  const token = String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim() || undefined;
  const scenarios = new Set(String(values.scenarios).split(',').map((entry) => entry.trim()).filter(Boolean));
  for (const scenario of scenarios) {
    if (scenario !== 'fresh-setup' && scenario !== 'upgrade') throw new Error(`unknown scenario: ${scenario}`);
  }
  const desktopArtifact = String(values['desktop-artifact']).trim();
  if (!desktopArtifact) throw new Error('--desktop-artifact <path to the Linux .deb or .AppImage under test> is required');
  if ([values['cli-assets-dir'], values['cli-tag'], values['cli-channel']].filter((value) => String(value).trim()).length !== 1) {
    throw new Error('pass exactly one of --cli-assets-dir <dir>, --cli-tag cli-v<version> or --cli-channel <channel> for the CLI under test');
  }

  const workDir = resolve(String(values['work-dir']).trim() || join(here, '..', '..', '..', 'output', `desktop-setup-${process.pid}`));
  rmSync(workDir, { recursive: true, force: true });
  const feedDir = join(workDir, 'feed');
  const desktopDir = join(workDir, 'desktop');
  const approverDir = join(workDir, 'approver');
  mkdirSync(join(feedDir, 'stages'), { recursive: true });
  mkdirSync(desktopDir, { recursive: true });
  mkdirSync(approverDir, { recursive: true });

  // Inputs — the exact bytes under test, identified in the summary.
  const identity = /** @type {Record<string, unknown>} */ ({});
  identity.desktop = extractBundledHsetup({ artifactPath: desktopArtifact, outFile: join(desktopDir, 'new', 'hsetup') });
  let cliSourceDir = String(values['cli-assets-dir']).trim();
  const cliChannel = String(values['cli-channel']).trim();
  // Resolved once: every later download and the summary use the same immutable tag.
  const cliTag = cliChannel ? await resolvePublishedCliTag({ repo, channel: cliChannel, token }) : String(values['cli-tag']).trim();
  if (!cliSourceDir) {
    cliSourceDir = join(workDir, 'downloads', 'cli-new');
    await downloadPinnedCliAssets({ repo, tag: cliTag, destDir: cliSourceDir, token });
  }
  const newCli = stageCliReleaseAssets({ sourceDir: resolve(cliSourceDir), stageDir: join(feedDir, 'stages', 'new') });
  identity.cli = { version: newCli.version, source: cliTag || resolve(cliSourceDir), ...(cliChannel ? { resolvedFrom: `cli-${cliChannel}` } : {}) };
  const channel = String(values.channel).trim() || resolveChannelForCliVersion(newCli.version);
  const relayImage = String(values['relay-image']).trim() || `happierdev/relay-server:${channel === 'stable' ? 'stable' : 'preview'}`;
  identity.channel = channel;
  identity.relayImage = relayImage;

  /** @type {{ cliTag: string; desktopTag: string; cliVersion: string } | null} */
  let baseline = null;
  /** @type {ScenarioResult[]} */
  const results = [];
  if (scenarios.has('upgrade')) {
    let cliTag = String(values['upgrade-from-cli-tag']).trim();
    let desktopTag = String(values['upgrade-from-desktop-tag']).trim();
    if ((!cliTag || !desktopTag) && channel === 'stable') {
      const resolved = await resolvePublishedStableBaseline({ repo, token });
      cliTag ||= resolved.cliTag;
      desktopTag ||= resolved.desktopTag;
    }
    if (!cliTag || !desktopTag) {
      results.push({ id: 'upgrade', status: 'BLOCKED', checks: [], observations: {}, durationMs: 0, blockedReason: `no pinned ${channel} baseline: pass --upgrade-from-cli-tag and --upgrade-from-desktop-tag` });
      scenarios.delete('upgrade');
    } else if (!Object.hasOwn(PREDECESSOR_SETUP_PARAMS_BY_DESKTOP_TAG, desktopTag)) {
      results.push({ id: 'upgrade', status: 'BLOCKED', checks: [], observations: {}, durationMs: 0, blockedReason: `the setup contract of ${desktopTag} is not characterized: add what that release's app sent to PREDECESSOR_SETUP_PARAMS_BY_DESKTOP_TAG (desktop-setup-driver.mjs) from its tagged source` });
      scenarios.delete('upgrade');
    } else {
      const debPath = await downloadPinnedDesktopDeb({ repo, tag: desktopTag, destDir: join(workDir, 'downloads', 'desktop-prev'), token });
      identity.previousDesktop = { tag: desktopTag, ...extractBundledHsetup({ artifactPath: debPath, outFile: join(desktopDir, 'prev', 'hsetup') }) };
      const prevSource = join(workDir, 'downloads', 'cli-prev');
      await downloadPinnedCliAssets({ repo, tag: cliTag, destDir: prevSource, token });
      const prevCli = stageCliReleaseAssets({ sourceDir: prevSource, stageDir: join(feedDir, 'stages', 'prev') });
      baseline = { cliTag, desktopTag, cliVersion: prevCli.version };
      identity.previousCli = { tag: cliTag, version: prevCli.version };
    }
  }

  createFeedTlsMaterial({ dir: join(feedDir, 'tls') });
  writeFileSync(join(feedDir, 'current'), 'new\n');
  writeFileSync(join(feedDir, 'requests.log'), '');
  execFileSync('tar', ['-xzf', join(feedDir, 'stages', 'new', newCli.archive), '-C', approverDir]);
  const approverCli = `/opt/approver-cli/happier-v${newCli.version}-linux-x64/happier`;
  const authorizedKeys = join(workDir, 'authorized_keys');
  writeFileSync(authorizedKeys, '');
  const envFile = join(workDir, 'compose.env');
  writeFileSync(envFile, [
    `HAPPIER_RELAY_IMAGE=${relayImage}`,
    `DESKTOP_SETUP_FEED_DIR=${feedDir}`,
    `DESKTOP_SETUP_DESKTOP_DIR=${desktopDir}`,
    `DESKTOP_SETUP_APPROVER_CLI_DIR=${approverDir}`,
    `DESKTOP_SETUP_AUTHORIZED_KEYS=${authorizedKeys}`,
    '',
  ].join('\n'));

  const compose = createCompose({ projectName: `happier-desktop-setup-${process.pid}`, envFile });
  const machines = [scenarios.has('fresh-setup') ? 'desktop1' : null, scenarios.has('upgrade') ? 'desktop2' : null].filter(Boolean);
  const log = (/** @type {string} */ message) => console.error(`[desktop-setup] ${message}`);

  const setStage = (/** @type {string} */ stage) => writeFileSync(join(feedDir, 'current'), `${stage}\n`);
  const feedServed = (/** @type {string} */ stage, /** @type {string} */ name) => readFileSync(join(feedDir, 'requests.log'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .some((entry) => entry.kind === 'asset' && entry.stage === stage && entry.name === name && entry.status === 200);

  const approverEnv = ['-e', `HAPPIER_HOME_DIR=${APPROVER_HOME}`, '-e', `HAPPIER_ACTIVE_SERVER_ID=${APPROVER_SERVER_ID}`,
    '-e', `HAPPIER_SERVER_URL=${RELAY_URL}`, '-e', `HAPPIER_PUBLIC_SERVER_URL=${RELAY_URL}`, '-e', `HAPPIER_WEBAPP_URL=${RELAY_URL}`];
  const approvePairing = async (/** @type {string} */ publicKey) => {
    compose.run(['exec', '-T', ...approverEnv, 'approver', approverCli, 'auth', 'approve', '--json', '--public-key', publicKey]);
  };

  /** @type {Map<string, string>} */
  const uidByMachine = new Map();
  const machineEnv = (/** @type {string} */ machine, /** @type {Record<string, string>} */ extra = {}) => {
    const uid = uidByMachine.get(machine) ?? '1000';
    const env = { HOME: MACHINE_HOME, USER: MACHINE_USER, LOGNAME: MACHINE_USER, SHELL: '/bin/bash', XDG_RUNTIME_DIR: `/run/user/${uid}`, NODE_EXTRA_CA_CERTS: '/opt/happier-feed/ca.crt', ...extra };
    return Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  };
  const execAs = (/** @type {string} */ machine, /** @type {string} */ script, /** @type {{ allowFailure?: boolean; env?: Record<string, string> }} */ options = {}) =>
    compose.run(['exec', '-T', '-u', MACHINE_USER, '-w', MACHINE_HOME, ...machineEnv(machine, options.env), machine, 'bash', '-lc', script], { allowFailure: options.allowFailure });
  const hsetup = (/** @type {string} */ machine, /** @type {'new' | 'prev'} */ which, /** @type {string} */ kind, /** @type {unknown} */ params, /** @type {import('./desktop-setup-driver.mjs').PromptHandlers} */ handlers, /** @type {Record<string, string>} */ extraEnv = {}) =>
    runHsetupTask({
      command: 'docker',
      args: [...compose.base, 'exec', '-T', '-u', MACHINE_USER, '-w', MACHINE_HOME, ...machineEnv(machine, extraEnv), machine, `/opt/happier-desktop/${which}/hsetup`, 'system-tasks', 'run'],
      kind,
      params,
      handlers,
      onLine: (line) => log(`${machine} ${which} ${kind}: ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`),
    });
  const daemonStatus = (/** @type {string} */ machine) => {
    const out = execAs(machine, '"$HOME/.happier/bin/happier" daemon status --json', { allowFailure: true });
    return parseLastJsonObject(out.stdout);
  };
  const probe = (/** @type {string} */ machine, /** @type {any} */ status) => {
    const out = execAs(machine, `node /opt/happier-npm-e2e/bin/machine-rpc-probe.mjs --relay-url ${RELAY_URL} --machine-id '${status?.auth?.machineId ?? ''}' --server-id '${status?.server?.activeServerId ?? ''}'`, { allowFailure: true });
    return parseLastJsonObject(out.stdout);
  };
  const systemdState = (/** @type {string} */ machine) => readSystemdState({
    serviceStatus: parseLastJsonObject(execAs(machine, '"$HOME/.happier/bin/happier" service status --json', { allowFailure: true }).stdout),
    run: (command) => execAs(machine, command, { allowFailure: true }),
  });

  let exitCode = 0;
  try {
    log(`building and starting relay, feed, approver, ${machines.join(', ')} (relay ${relayImage}, channel ${channel})`);
    compose.run(['up', '-d', '--build', 'relay', 'release-feed', 'approver', ...machines], { stdio: 'inherit' });

    for (let attempt = 1; ; attempt += 1) {
      if (compose.run(['exec', '-T', 'relay', 'curl', '-fsS', 'http://127.0.0.1:3005/v1/version'], { allowFailure: true }).status === 0) break;
      if (attempt >= RELAY_READY_ATTEMPTS) throw new Error('relay did not answer /v1/version');
      await sleep(2000);
    }
    const account = parseLastJsonObject(compose.run(['exec', '-T', 'approver', 'node', '/opt/happier-npm-e2e/bin/terminal-auth-approve.cjs',
      '--server-url', RELAY_URL, '--home-dir', APPROVER_HOME, '--active-server-id', APPROVER_SERVER_ID]).stdout);
    const accountToken = JSON.parse(compose.run(['exec', '-T', 'approver', 'cat', String(account?.keyPath)]).stdout).token;
    const profile = parseLastJsonObject(compose.run(['exec', '-T', '-e', `TOKEN=${accountToken}`, 'approver', 'bash', '-c',
      `curl -fsS -H "Authorization: Bearer $TOKEN" ${RELAY_URL}/v1/account/profile`]).stdout);
    const accountId = String(profile?.id ?? '');
    if (!accountId) throw new Error('could not read the approver account id');

    for (const machine of machines) {
      // `--wait` returns when boot finishes (a container may report "degraded"); the user manager
      // started by lingering is then expected to own its bus.
      compose.run(['exec', '-T', /** @type {string} */ (machine), 'systemctl', 'is-system-running', '--wait'], { allowFailure: true });
      const uid = compose.run(['exec', '-T', /** @type {string} */ (machine), 'id', '-u', MACHINE_USER]).stdout.trim();
      uidByMachine.set(/** @type {string} */ (machine), uid);
      // Lingering (entrypoint) keeps the user manager alive with no session; starting its unit
      // directly is idempotent and does not depend on logind having processed the linger file yet.
      compose.run(['exec', '-T', /** @type {string} */ (machine), 'systemctl', 'start', `user@${uid}.service`], { allowFailure: true });
      for (let attempt = 1; ; attempt += 1) {
        if (execAs(/** @type {string} */ (machine), 'test -S "$XDG_RUNTIME_DIR/bus"', { allowFailure: true }).status === 0) break;
        if (attempt >= USER_BUS_ATTEMPTS) {
          const diag = compose.run(['exec', '-T', /** @type {string} */ (machine), 'bash', '-c', `loginctl show-user ${MACHINE_USER} 2>&1; systemctl status user@$(id -u ${MACHINE_USER}).service --no-pager 2>&1 | head -20`], { allowFailure: true });
          throw new Error(`systemd user bus never appeared on ${machine} (lingering/user manager): ${diag.stdout}`);
        }
        await sleep(1000);
      }
    }

    // What the signed-in app sends (`apps/ui/sources/setup`): its relay, its account, its channel.
    const setupParams = {
      activeRelayUrl: RELAY_URL,
      activeWebappUrl: RELAY_URL,
      activeLocalRelayUrl: null,
      channel,
      expectedAccountId: accountId,
      surface: 'release-validation',
    };
    // `buildLocalDaemonServiceSystemTaskSpec` (apps/ui) — the inspection every app open runs.
    const inspectionParams = { target: { kind: 'local' }, surface: 'release-validation', mode: 'user', channel };

    if (scenarios.has('fresh-setup')) {
      const scenarioStart = Date.now();
      const machine = 'desktop1';
      log('fresh-setup: desktop1');
      const precondition = {
        happierOnPath: execAs(machine, 'command -v happier || true').stdout.trim(),
        happierHomeExists: execAs(machine, 'test -e "$HOME/.happier"', { allowFailure: true }).status === 0,
        userUnits: execAs(machine, "systemctl --user list-unit-files --no-legend 'happier*' 2>/dev/null || true").stdout.trim(),
      };
      setStage('new');
      // First launch order (desktopSetupCoordinator): the warm-up inspection acquires the managed CLI
      // before sign-in, then setup runs against what it found.
      const inspection = await hsetup(machine, 'new', 'daemon.service.status.v1', inspectionParams, { approvePairing, serviceConsent: 'decline' });
      const setup = await hsetup(machine, 'new', 'setup.thisComputer.v1', setupParams, { approvePairing, serviceConsent: 'decline' });
      const status = daemonStatus(machine);
      const pathCommand = execAs(machine, 'command -v happier || true').stdout.trim();
      const observed = {
        expectedCliVersion: newCli.version,
        precondition,
        inspection,
        setup,
        feedServedArchive: feedServed('new', newCli.archive),
        pathCommand,
        pathCommandResolved: pathCommand ? execAs(machine, `readlink -f '${pathCommand}'`).stdout.trim() : '',
        pathVersion: execAs(machine, 'happier --version 2>/dev/null | head -n 1 || true').stdout.trim(),
        status,
        systemd: systemdState(machine),
        probe: probe(machine, status),
      };
      const checks = evaluateFreshSetup(observed);
      results.push({ id: 'fresh-setup', status: scenarioStatus(checks), checks, observations: { setupResult: setup.result, prompts: setup.prompts, systemd: observed.systemd }, durationMs: Date.now() - scenarioStart });
    }

    if (scenarios.has('upgrade') && baseline) {
      const scenarioStart = Date.now();
      const machine = 'desktop2';
      log(`upgrade: desktop2 from ${baseline.desktopTag} + ${baseline.cliTag}`);
      setStage('prev');
      // 0.2.12's setup takes no relay parameter; select the CLI's persisted current relay first.
      // Its setup params remain exactly what that released app sent.
      const previousSetup = await runPredecessorSetup({
        relayUrl: RELAY_URL,
        webappUrl: RELAY_URL,
        setupParams: PREDECESSOR_SETUP_PARAMS_BY_DESKTOP_TAG[baseline.desktopTag],
        inspectionParams,
        runHsetup: (kind, params, env) => hsetup(machine, 'prev', kind, params, { approvePairing, serviceConsent: 'decline' }, env),
        runCli: (args) => execAs(machine, `"$HOME/.happier/bin/happier" ${args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')}`),
      });
      const previousStatus = daemonStatus(machine);
      const previousProbe = probe(machine, previousStatus);

      setStage('new');
      // A new app version setting up a machine an earlier version of the app set up. A service
      // takeover prompt here is recorded (and approved, as the user would) — it is reported, not hidden.
      const newInspection = await hsetup(machine, 'new', 'daemon.service.status.v1', inspectionParams, { approvePairing, serviceConsent: 'decline' });
      const newSetup = await hsetup(machine, 'new', 'setup.thisComputer.v1', setupParams, { approvePairing, serviceConsent: 'approve' });
      const afterSetupStatus = daemonStatus(machine);
      const update = await hsetup(machine, 'new', 'cli.update.v1', { channel }, { approvePairing, serviceConsent: 'decline' });
      const finalStatus = daemonStatus(machine);
      const observed = {
        previousCliVersion: baseline.cliVersion,
        expectedCliVersion: newCli.version,
        previousSetup,
        previousStatus,
        previousProbe,
        newInspection,
        newSetup,
        update,
        finalStatus,
        systemd: systemdState(machine),
        finalProbe: probe(machine, finalStatus),
      };
      const checks = evaluateUpgrade(observed);
      results.push({
        id: 'upgrade',
        status: scenarioStatus(checks),
        checks,
        observations: {
          newSetupResult: newSetup.result,
          newSetupPrompts: newSetup.prompts,
          // The stale-daemon window: what the service ran between the new setup and the update.
          afterNewSetup: {
            startedWithCliVersion: afterSetupStatus?.daemon?.startedWithCliVersion ?? null,
            cliVersionMatches: afterSetupStatus?.runtimeConvergence?.cliVersionMatches ?? null,
          },
          updateResult: update.result,
        },
        durationMs: Date.now() - scenarioStart,
      });
    }
  } catch (error) {
    exitCode = 1;
    console.error(`[desktop-setup] harness failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    compose.run(['logs', '--no-color', '--tail', '200'], { allowFailure: true, stdio: 'inherit' });
  } finally {
    if (values.keep) {
      log(`keeping containers: docker ${compose.base.join(' ')} down -v`);
    } else {
      compose.run(['down', '-v', '--remove-orphans'], { allowFailure: true });
    }
  }

  const summary = { suite: 'desktop-setup', identity, results, elapsedMs: Date.now() - startedAt };
  writeFileSync(join(workDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  for (const result of results) {
    console.log(`[desktop-setup] ${result.id}: ${result.status}${result.blockedReason ? ` (${result.blockedReason})` : ''} in ${Math.round(result.durationMs / 1000)}s`);
    for (const entry of result.checks) {
      console.log(`  ${entry.pass ? 'PASS' : 'FAIL'} ${entry.check}${entry.pass ? '' : ` — ${JSON.stringify(entry.detail ?? null)}`}`);
    }
  }
  console.log(`[desktop-setup] summary: ${join(workDir, 'summary.json')} (elapsed ${Math.round(summary.elapsedMs / 1000)}s)`);
  if (exitCode !== 0 || results.some((result) => result.status !== 'PASS')) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
