import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureEnvFileUpdated } from '../../env/env_file.mjs';
import { readEnvObjectFromFile } from '../../env/read.mjs';
import { sanitizeDnsLabel } from '../../net/dns.mjs';
import { pickNextFreeTcpPort } from '../../net/ports.mjs';
import { pmExecBin } from '../../proc/pm.mjs';
import { run, runCapture } from '../../proc/proc.mjs';
import { randomToken } from '../../crypto/tokens.mjs';
import { coercePort, INFRA_RESERVED_PORT_KEYS } from '../port.mjs';

const readEnvObject = readEnvObjectFromFile;

async function ensureTextFile({ path, generate }) {
  if (existsSync(path)) {
    const v = (await readFile(path, 'utf-8')).trim();
    if (v) return v;
  }
  const next = String(generate()).trim();
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  await writeFile(path, next + '\n', 'utf-8');
  return next;
}

function composeProjectName(stackName) {
  return sanitizeDnsLabel(`happier-stacks-${stackName}-happier-server`, { fallback: 'happier-stacks-happier-server' });
}

export async function stopHappyServerManagedInfra({ stackName, baseDir, removeVolumes = false }) {
  const infraDir = join(baseDir, 'happier-server', 'infra');
  const composePath = join(infraDir, 'docker-compose.yml');
  if (!existsSync(composePath)) {
    return { ok: true, skipped: true, reason: 'missing_compose', composePath };
  }

  try {
    await ensureDockerCompose();
  } catch (e) {
    return {
      ok: false,
      skipped: true,
      reason: 'docker_unavailable',
      error: e instanceof Error ? e.message : String(e),
      composePath,
    };
  }

  const projectName = composeProjectName(stackName);
  const args = ['down', '--remove-orphans', ...(removeVolumes ? ['--volumes'] : [])];
  await dockerCompose({ composePath, projectName, args, options: { cwd: baseDir } });
  return { ok: true, skipped: false, projectName, composePath };
}

function buildComposeYaml({
  infraDir,
  pgPort,
  pgUser,
  pgPassword,
  pgDb,
  redisPort,
  minioPort,
  minioConsolePort,
  s3AccessKey,
  s3SecretKey,
  s3Bucket,
}) {
  // Keep it explicit (no env substitution); we generate this file per stack.
  return `services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${pgUser}
      POSTGRES_PASSWORD: ${pgPassword}
      POSTGRES_DB: ${pgDb}
    ports:
      - "127.0.0.1:${pgPort}:5432"
    volumes:
      - "${join(infraDir, 'pgdata')}:/var/lib/postgresql/data"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${pgUser} -d ${pgDb}"]
      interval: 2s
      timeout: 3s
      retries: 30

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    ports:
      - "127.0.0.1:${redisPort}:6379"
    volumes:
      - "${join(infraDir, 'redis')}:/data"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 30

  minio:
    image: minio/minio:latest
    command: ["server", "/data", "--console-address", ":9001"]
    environment:
      MINIO_ROOT_USER: ${s3AccessKey}
      MINIO_ROOT_PASSWORD: ${s3SecretKey}
    ports:
      - "127.0.0.1:${minioPort}:9000"
      - "127.0.0.1:${minioConsolePort}:9001"
    volumes:
      - "${join(infraDir, 'minio')}:/data"

  minio-init:
    image: minio/mc:latest
    depends_on:
      - minio
    entrypoint: ["/bin/sh", "-lc"]
    command: >
      mc alias set local http://minio:9000 ${s3AccessKey} ${s3SecretKey} &&
      mc mb -p local/${s3Bucket} || true &&
      mc anonymous set download local/${s3Bucket} || true
    restart: "no"
`;
}

async function ensureDockerCompose() {
  const waitMsRaw = (process.env.HAPPIER_STACK_DOCKER_WAIT_MS ?? '').trim();
  const waitMs = waitMsRaw ? Number(waitMsRaw) : process.stdout.isTTY ? 0 : 60_000;
  const deadline = waitMs > 0 ? Date.now() + waitMs : Date.now();

  try {
    await runCapture('docker', ['compose', 'version'], { timeoutMs: 10_000 });
  } catch (e) {
    const msg = e?.message ? String(e.message) : String(e);
    throw new Error(
      `[infra] docker compose is required for managed happier-server stacks.\n` +
        `Fix: install Docker Desktop and ensure \`docker compose\` works.\n` +
        `Details: ${msg}`
    );
  }

  const autostartRaw = (process.env.HAPPIER_STACK_DOCKER_AUTOSTART ?? '').trim();
  const autostart = autostartRaw ? autostartRaw !== '0' : !process.stdout.isTTY;

  // Ensure the Docker daemon is ready (launchd/SwiftBar often runs before Docker Desktop starts).
  // If not ready, wait up to waitMs (non-interactive default: 60s) to avoid restart loops.
  while (true) {
    try {
      await runCapture('docker', ['info'], { timeoutMs: 10_000 });
      return;
    } catch (e) {
      if (autostart) {
        await maybeStartDockerDaemon().catch(() => {});
      }
      if (Date.now() >= deadline) {
        const msg = e?.message ? String(e.message) : String(e);
        throw new Error(
          `[infra] docker is installed but the daemon is not ready.\n` +
            `Fix: start Docker Desktop, or disable managed infra (HAPPIER_STACK_MANAGED_INFRA=0).\n` +
            `You can also increase wait time with HAPPIER_STACK_DOCKER_WAIT_MS, or disable auto-start with HAPPIER_STACK_DOCKER_AUTOSTART=0.\n` +
            `Details: ${msg}`
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(1000);
    }
  }
}

async function maybeStartDockerDaemon() {
  // Best-effort. This may be a no-op depending on platform/permissions.
  if (process.platform === 'darwin') {
    const app = (process.env.HAPPIER_STACK_DOCKER_APP ?? '/Applications/Docker.app').trim();
    // `open` exits quickly; Docker Desktop will start in the background.
    await runCapture('open', ['-gj', '-a', app], { timeoutMs: 5_000 }).catch(() => {});
    return;
  }

  if (process.platform === 'linux') {
    // Rootless / Docker Desktop / system Docker can differ. Try a few user-scope units first.
    const candidates = ['docker.service', 'docker.socket', 'docker-desktop.service', 'docker-desktop'];
    for (const unit of candidates) {
      // eslint-disable-next-line no-await-in-loop
      await runCapture('systemctl', ['--user', 'start', unit], { timeoutMs: 5_000 }).catch(() => {});
    }
    // As a last resort, try system scope (may fail without sudo; ignore).
    await runCapture('systemctl', ['start', 'docker'], { timeoutMs: 5_000 }).catch(() => {});
  }
}

async function dockerCompose({ composePath, projectName, args, options = {}, quiet = false, retries = 0 }) {
  const cmdArgs = ['compose', '-f', composePath, '-p', projectName, ...args];
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (quiet) {
        // Capture stderr so callers can surface it in structured JSON errors.
        await runCapture('docker', cmdArgs, { timeoutMs: 120_000, ...options });
      } else {
        await run('docker', cmdArgs, { ...options, stdio: options?.stdio ?? 'inherit' });
      }
      return;
    } catch (e) {
      if (attempt >= retries) throw e;
      attempt += 1;
      // eslint-disable-next-line no-await-in-loop
      await delay(800);
    }
  }
}

async function waitForHealthyPostgres({ composePath, projectName, pgUser, pgDb }) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await runCapture(
        'docker',
        ['compose', '-f', composePath, '-p', projectName, 'exec', '-T', 'postgres', 'pg_isready', '-U', pgUser, '-d', pgDb],
        { timeoutMs: 5_000 }
      );
      return;
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(800);
  }
  throw new Error('[infra] timed out waiting for postgres to become ready');
}

async function waitForHealthyRedis({ composePath, projectName }) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const out = await runCapture('docker', ['compose', '-f', composePath, '-p', projectName, 'exec', '-T', 'redis', 'redis-cli', 'ping'], {
        timeoutMs: 5_000,
      });
      if (out.trim().toUpperCase().includes('PONG')) {
        return;
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(600);
  }
  throw new Error('[infra] timed out waiting for redis to become ready');
}

async function waitForMinioReady({ composePath, projectName }) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      // Minio doesn't ship a healthcheck in our compose; exec'ing a trivial command is a good enough
      // readiness proxy for running/accepting execs before we run minio-init.
      await runCapture('docker', ['compose', '-f', composePath, '-p', projectName, 'exec', '-T', 'minio', 'sh', '-lc', 'echo ok'], {
        timeoutMs: 5_000,
      });
      return;
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(600);
  }
  throw new Error('[infra] timed out waiting for minio to become ready');
}

export async function ensureHappyServerManagedInfra({
  stackName,
  baseDir,
  serverPort,
  publicServerUrl,
  envPath,
  env = process.env,
  quiet = false,
  skipMinioInit = false,
}) {
  await ensureDockerCompose();

  const infraDir = join(baseDir, 'happier-server', 'infra');
  await mkdir(infraDir, { recursive: true });

  const existingEnv = envPath ? await readEnvObject(envPath) : {};
  const reservedPorts = new Set();

  // Reserve known ports (if present) to avoid picking duplicates when auto-filling.
  for (const key of INFRA_RESERVED_PORT_KEYS) {
    const p = coercePort(existingEnv[key] ?? env[key]);
    if (p) reservedPorts.add(p);
  }
  if (Number.isFinite(serverPort) && serverPort > 0) reservedPorts.add(serverPort);

  const pgPort =
    coercePort(existingEnv.HAPPIER_STACK_PG_PORT ?? env.HAPPIER_STACK_PG_PORT) ??
    (await pickNextFreeTcpPort(serverPort + 1000, { reservedPorts }));
  reservedPorts.add(pgPort);
  const redisPort =
    coercePort(existingEnv.HAPPIER_STACK_REDIS_PORT ?? env.HAPPIER_STACK_REDIS_PORT) ??
    (await pickNextFreeTcpPort(pgPort + 1, { reservedPorts }));
  reservedPorts.add(redisPort);
  const minioPort =
    coercePort(existingEnv.HAPPIER_STACK_MINIO_PORT ?? env.HAPPIER_STACK_MINIO_PORT) ??
    (await pickNextFreeTcpPort(redisPort + 1, { reservedPorts }));
  reservedPorts.add(minioPort);
  const minioConsolePort =
    coercePort(existingEnv.HAPPIER_STACK_MINIO_CONSOLE_PORT ?? env.HAPPIER_STACK_MINIO_CONSOLE_PORT) ??
    (await pickNextFreeTcpPort(minioPort + 1, { reservedPorts }));
  reservedPorts.add(minioConsolePort);

  const pgUser = (existingEnv.HAPPIER_STACK_PG_USER ?? env.HAPPIER_STACK_PG_USER ?? 'handy').trim() || 'handy';
  const pgPassword = (existingEnv.HAPPIER_STACK_PG_PASSWORD ?? env.HAPPIER_STACK_PG_PASSWORD ?? '').trim() || randomToken(24);
  const pgDb = (existingEnv.HAPPIER_STACK_PG_DATABASE ?? env.HAPPIER_STACK_PG_DATABASE ?? 'handy').trim() || 'handy';

  const s3Bucket =
    (existingEnv.S3_BUCKET ?? env.S3_BUCKET ?? '').trim() || sanitizeDnsLabel(`happier-${stackName}`, { fallback: 'happier' });
  const s3AccessKey = (existingEnv.S3_ACCESS_KEY ?? env.S3_ACCESS_KEY ?? '').trim() || randomToken(12);
  const s3SecretKey = (existingEnv.S3_SECRET_KEY ?? env.S3_SECRET_KEY ?? '').trim() || randomToken(24);

  const secretFile = (existingEnv.HAPPIER_STACK_HANDY_MASTER_SECRET_FILE ?? env.HAPPIER_STACK_HANDY_MASTER_SECRET_FILE ?? '').trim()
    ? (existingEnv.HAPPIER_STACK_HANDY_MASTER_SECRET_FILE ?? env.HAPPIER_STACK_HANDY_MASTER_SECRET_FILE).trim()
    : join(baseDir, 'happier-server', 'handy-master-secret.txt');
  const handyMasterSecret = (existingEnv.HANDY_MASTER_SECRET ?? env.HANDY_MASTER_SECRET ?? '').trim()
    ? (existingEnv.HANDY_MASTER_SECRET ?? env.HANDY_MASTER_SECRET).trim()
    : await ensureTextFile({ path: secretFile, generate: () => randomToken(32) });

  const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPassword)}@127.0.0.1:${pgPort}/${encodeURIComponent(pgDb)}`;
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  const s3Host = '127.0.0.1';
  const s3UseSsl = 'false';
  const pub = String(publicServerUrl ?? '').trim().replace(/\/+$/, '');
  if (!pub) {
    throw new Error('[infra] publicServerUrl is required for managed infra (to set S3_PUBLIC_URL)');
  }
  const s3PublicUrl = `${pub}/files`;

  if (envPath) {
    // Ephemeral stacks should not pin ports in env files. In stack runtime, callers set
    // HAPPIER_STACK_EPHEMERAL_PORTS=1 (via stack.runtime.json overlay) while the stack owner is alive.
    //
    // For offline tooling (e.g. auth seeding) we still want to preserve the invariant:
    // - non-main stacks are ephemeral-by-default unless the user explicitly pinned ports already.
    const runtimeEphemeral = (env.HAPPIER_STACK_EPHEMERAL_PORTS ?? '').toString().trim() === '1';
    const alreadyPinnedPorts =
      Boolean((existingEnv.HAPPIER_STACK_PG_PORT ?? '').trim()) ||
      Boolean((existingEnv.HAPPIER_STACK_REDIS_PORT ?? '').trim()) ||
      Boolean((existingEnv.HAPPIER_STACK_MINIO_PORT ?? '').trim()) ||
      Boolean((existingEnv.HAPPIER_STACK_MINIO_CONSOLE_PORT ?? '').trim());
    const ephemeralPorts = runtimeEphemeral || (stackName !== 'main' && !alreadyPinnedPorts);
    await ensureEnvFileUpdated({
      envPath,
      updates: [
        // Stable credentials/files: persist these so restarts keep the same DB/user and S3 creds.
        { key: 'HAPPIER_STACK_PG_USER', value: pgUser },
        { key: 'HAPPIER_STACK_PG_PASSWORD', value: pgPassword },
        { key: 'HAPPIER_STACK_PG_DATABASE', value: pgDb },
        { key: 'HAPPIER_STACK_HANDY_MASTER_SECRET_FILE', value: secretFile },
        { key: 'S3_ACCESS_KEY', value: s3AccessKey },
        { key: 'S3_SECRET_KEY', value: s3SecretKey },
        { key: 'S3_BUCKET', value: s3Bucket },
        // Ports + derived URLs: persist only when ports are explicitly pinned (non-ephemeral mode).
        ...(ephemeralPorts
          ? []
          : [
              { key: 'HAPPIER_STACK_PG_PORT', value: String(pgPort) },
              { key: 'HAPPIER_STACK_REDIS_PORT', value: String(redisPort) },
              { key: 'HAPPIER_STACK_MINIO_PORT', value: String(minioPort) },
              { key: 'HAPPIER_STACK_MINIO_CONSOLE_PORT', value: String(minioConsolePort) },
              // Vars consumed by happier-server:
              { key: 'DATABASE_URL', value: databaseUrl },
              { key: 'REDIS_URL', value: redisUrl },
              { key: 'S3_HOST', value: s3Host },
              { key: 'S3_PORT', value: String(minioPort) },
              { key: 'S3_USE_SSL', value: s3UseSsl },
              { key: 'S3_PUBLIC_URL', value: s3PublicUrl },
            ]),
      ],
    });
  }

  const composePath = join(infraDir, 'docker-compose.yml');
  const projectName = composeProjectName(stackName);
  const yaml = buildComposeYaml({
    infraDir,
    pgPort,
    pgUser,
    pgPassword,
    pgDb,
    redisPort,
    minioPort,
    minioConsolePort,
    s3AccessKey,
    s3SecretKey,
    s3Bucket,
  });
  await writeFile(composePath, yaml, 'utf-8');

  await dockerCompose({
    composePath,
    projectName,
    args: ['up', '-d', '--remove-orphans'],
    options: { cwd: baseDir, stdio: quiet ? 'ignore' : 'inherit' },
    quiet,
  });
  await waitForHealthyPostgres({ composePath, projectName, pgUser, pgDb });
  await waitForHealthyRedis({ composePath, projectName });

  if (!skipMinioInit) {
    // Ensure bucket exists (idempotent). This can race with Minio startup; retry a few times.
    await waitForMinioReady({ composePath, projectName });
    await dockerCompose({
      composePath,
      projectName,
      args: ['run', '--rm', '--no-deps', 'minio-init'],
      options: { cwd: baseDir, stdio: quiet ? 'ignore' : 'inherit' },
      quiet,
      retries: 3,
    });
  }

  return {
    composePath,
    projectName,
    infraDir,
    env: {
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      S3_HOST: s3Host,
      S3_PORT: String(minioPort),
      S3_USE_SSL: s3UseSsl,
      S3_ACCESS_KEY: s3AccessKey,
      S3_SECRET_KEY: s3SecretKey,
      S3_BUCKET: s3Bucket,
      S3_PUBLIC_URL: s3PublicUrl,
      HANDY_MASTER_SECRET: handyMasterSecret,
    },
  };
}

export async function applyHappyServerMigrations({ serverDir, env, quiet = false }) {
  // Non-interactive + idempotent. Safe for dev; also safe for managed stacks on start.
  await pmExecBin({ dir: serverDir, bin: 'prisma', args: ['migrate', 'deploy'], env, quiet });
}
