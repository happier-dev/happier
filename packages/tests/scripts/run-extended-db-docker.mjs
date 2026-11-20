#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { resolvePnpmCommandInvocation } from '../../../scripts/workspaces/execPnpmCommand.mjs';
import {
  buildDbContainerPlan,
  buildDatabaseUrlForContainer,
  buildExtendedDbCommandPlan,
  parseDockerPortLine,
  sanitizeDockerEnv,
} from './extended-db-docker.plan.mjs';
import { EXTENDED_DB_OWNER_LABEL, extendedDbOwnerToken, selectOrphanedExtendedDbContainers } from './extended-db-docker.ownership.mjs';

function usage() {
  // Keep this short; the pnpm scripts are the primary UX.
  console.log(`
Run Happier extended DB tests with an auto-provisioned Docker database.

Usage:
  node packages/tests/scripts/run-extended-db-docker.mjs --db postgres|mysql [--mode e2e|ui|contract|extended|session-system-record-upgrade] [--contract-file <server-relative-test-file> (repeatable)] [--e2e-file <tests-relative-slow-test-file> (repeatable)] [--ui-file <tests-relative-browser-file>] [--ui-grep <test-name-pattern>] [--keep]

Examples:
  node packages/tests/scripts/run-extended-db-docker.mjs --db postgres --mode e2e
  node packages/tests/scripts/run-extended-db-docker.mjs --db mysql --mode extended
`.trim());
}

export function resolveExtendedDbPnpmInvocation(args, options = {}) {
  return resolvePnpmCommandInvocation(args, options);
}

export function resolveExtendedDbCommandTimeoutMs(raw, fallbackMs) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.max(5_000, parsed);
}

export function resolveExtendedDbStepTimeoutMs(env) {
  // An explicitly unbounded admitted step waits for its own completion/cancel.
  if (String(env?.HAPPIER_E2E_EXTENDED_DB_STEP_TIMEOUT_MS ?? '').trim() === '0') return 0;
  return resolveExtendedDbCommandTimeoutMs(env?.HAPPIER_E2E_EXTENDED_DB_STEP_TIMEOUT_MS, 3_600_000);
}

function formatCommand(cmd, args) {
  // Database container environment arguments contain credentials.
  if (cmd === 'docker' && args[0] === 'run') return 'docker run';
  return `${cmd} ${args.join(' ')}`.trim();
}

function runOrThrow(cmd, args, opts = {}) {
  const { timeoutMs = 120_000, ...spawnOptions } = opts;
  const res = spawnSync(cmd, args, { stdio: 'inherit', timeout: timeoutMs, ...spawnOptions });
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') {
      throw new Error(`Command timed out after ${timeoutMs}ms: ${formatCommand(cmd, args)}`);
    }
    throw res.error;
  }
  if (res.signal === 'SIGTERM' && res.status == null) {
    throw new Error(`Command timed out after ${timeoutMs}ms: ${formatCommand(cmd, args)}`);
  }
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
}

function runCapture(cmd, args, opts = {}) {
  const { timeoutMs = 120_000, ...spawnOptions } = opts;
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, ...spawnOptions });
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') {
      throw new Error(`Command timed out after ${timeoutMs}ms: ${formatCommand(cmd, args)}`);
    }
    throw res.error;
  }
  if (res.signal === 'SIGTERM' && res.status == null) {
    throw new Error(`Command timed out after ${timeoutMs}ms: ${formatCommand(cmd, args)}`);
  }
  if (res.status !== 0) {
    const stderr = typeof res.stderr === 'string' ? res.stderr : '';
    const stdout = typeof res.stdout === 'string' ? res.stdout : '';
    throw new Error(`Command failed: ${formatCommand(cmd, args)}\n${stdout}\n${stderr}`.trim());
  }
  return (typeof res.stdout === 'string' ? res.stdout : '').trim();
}

function dockerEnv() {
  return sanitizeDockerEnv(process.env);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealthy(name, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = runCapture('docker', ['inspect', '--format', '{{.State.Health.Status}}', name], {
      env: dockerEnv(),
      timeoutMs: 30_000,
    });
    if (health === 'healthy') return;
    if (health === 'unhealthy') throw new Error(`Container is unhealthy: ${name}`);
    await sleep(250);
  }
  throw new Error(`Timed out waiting for container health: ${name}`);
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  /** @type {Record<string, string|boolean|string[]>} */
  const out = { mode: 'extended', keep: false };
  const selectedFiles = { '--contract-file': [], '--e2e-file': [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--keep') {
      out.keep = true;
      continue;
    }
    if (a === '--db' || a === '--mode' || a === '--name' || a === '--contract-file' || a === '--e2e-file'
      || a === '--ui-file' || a === '--ui-grep') {
      const v = args[++i];
      if (!v) throw new Error(`Missing value for ${a}`);
      if (a === '--contract-file' || a === '--e2e-file') {
        const files = selectedFiles[a];
        files.push(v);
        out[a.slice(2)] = files.length === 1 ? v : files;
      } else out[a.slice(2)] = v;
      continue;
    }
    throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

export async function main(argv = process.argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    usage();
    return 0;
  }

  const dockerCommandTimeoutMs = resolveExtendedDbCommandTimeoutMs(
    process.env.HAPPIER_E2E_EXTENDED_DB_DOCKER_TIMEOUT_MS,
    120_000,
  );
  const testStepTimeoutMs = resolveExtendedDbStepTimeoutMs(process.env);

  const db = parsed.db;
  const mode = parsed.mode ?? 'extended';
  const keep = Boolean(parsed.keep);
  const nameArg = parsed.name;
  if (db !== 'postgres' && db !== 'mysql') {
    console.error(`Missing/invalid --db. Expected postgres|mysql, got: ${String(db)}`);
    usage();
    return 2;
  }
  if (
    mode !== 'e2e'
    && mode !== 'ui'
    && mode !== 'contract'
    && mode !== 'extended'
    && mode !== 'session-system-record-upgrade'
  ) {
    console.error(`Invalid --mode. Expected e2e|ui|contract|extended|session-system-record-upgrade, got: ${String(mode)}`);
    usage();
    return 2;
  }

  // Preconditions (nice error messages).
  if (typeof process.env.DOCKER_API_VERSION === 'string' && process.env.DOCKER_API_VERSION.trim()) {
    console.warn(
      `[extended-db] Ignoring DOCKER_API_VERSION=${process.env.DOCKER_API_VERSION.trim()} to allow docker client/daemon negotiation.`,
    );
  }

  runOrThrow('docker', ['info'], { stdio: 'ignore', env: dockerEnv(), timeoutMs: dockerCommandTimeoutMs });
  // A harness killed outright (SIGKILL, lost SSH session) leaves its container running.
  // Remove the containers whose owning harness process is gone before starting another.
  const ownedRows = runCapture('docker', ['ps', '-a', '--filter', `label=${EXTENDED_DB_OWNER_LABEL}`,
    '--format', `{{.ID}} {{.Label "${EXTENDED_DB_OWNER_LABEL}"}}`], { env: dockerEnv(), timeoutMs: dockerCommandTimeoutMs });
  const orphaned = selectOrphanedExtendedDbContainers(ownedRows);
  if (orphaned.length) {
    console.log(`[extended-db] Removing ${orphaned.length} container(s) left by exited harness runs`);
    runOrThrow('docker', ['rm', '-f', '-v', ...orphaned], { stdio: 'ignore', env: dockerEnv(), timeoutMs: dockerCommandTimeoutMs });
  }

  const plan = buildDbContainerPlan({ db, name: nameArg });

  let shouldCleanup = !keep;
  let containerId;
  const cleanup = () => {
    if (!shouldCleanup || !containerId) return;
    try {
      // Forced removal bypasses `--rm` volume cleanup; remove our anonymous DB volumes too.
      spawnSync('docker', ['rm', '-f', '-v', containerId], { stdio: 'ignore', env: dockerEnv(), timeout: dockerCommandTimeoutMs });
    } catch {
      // ignore
    }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('SIGHUP', () => {
    cleanup();
    process.exit(129);
  });

  try {
    const envPairs = Object.entries(plan.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    console.log(`[extended-db] Starting ${db} container (${plan.image})...`);
    const startedId = runCapture(
      'docker',
      [
      'run',
      '-d',
      '--rm',
      '--label',
      `${EXTENDED_DB_OWNER_LABEL}=${extendedDbOwnerToken()}`,
      '--name',
      plan.name,
      '-p',
      plan.ports.publishSpec,
      '--health-cmd',
      plan.healthCmd,
      '--health-interval',
      '1s',
      '--health-timeout',
      '3s',
      '--health-retries',
      '60',
      ...envPairs,
      plan.image,
      ],
      { env: dockerEnv(), timeoutMs: dockerCommandTimeoutMs },
    );
    if (!/^[a-f0-9]{64}$/.test(startedId)) throw new Error('Docker did not return an exact container id');
    containerId = startedId;
    console.log(`[extended-db] Started container: ${containerId}`);

    console.log(`[extended-db] Waiting for ${db} healthcheck...`);
    await waitForHealthy(containerId, 120_000);

    const portLine = runCapture('docker', ['port', containerId, `${plan.ports.containerPort}/tcp`], {
      env: dockerEnv(),
      timeoutMs: dockerCommandTimeoutMs,
    }).split('\n')[0];
    const { host, port } = parseDockerPortLine(portLine);
    const databaseUrl = buildDatabaseUrlForContainer({ db, host, port });

    const steps = buildExtendedDbCommandPlan({ db, mode, databaseUrl, contractFile: parsed['contract-file'],
      e2eFile: parsed['e2e-file'], uiFile: parsed['ui-file'], uiGrep: parsed['ui-grep'], containerId });
    for (const step of steps) {
      const invocation = resolveExtendedDbPnpmInvocation(step.args);
      const env = { ...process.env, ...step.env };
      console.log(`[extended-db] Running: ${step.kind}`);
      runOrThrow(invocation.command, invocation.args, {
        env,
        timeoutMs: testStepTimeoutMs,
        ...(invocation.windowsVerbatimArguments
          ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
          : {}),
      });
    }

    // If the run succeeded and we're in keep mode, make that obvious.
    if (keep) {
      shouldCleanup = false;
      console.log(`[extended-db] Keeping container: ${containerId}`);
    }
  } finally {
    cleanup();
  }
  return 0;
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main().then((code) => {
    if (typeof code === 'number' && Number.isFinite(code) && code !== 0) process.exit(code);
  }).catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
