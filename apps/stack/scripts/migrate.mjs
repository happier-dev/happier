import './utils/env/env.mjs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { ensureEnvFileUpdated } from './utils/env/env_file.mjs';
import { readEnvObjectFromFile } from './utils/env/read.mjs';
import { getComponentDir, getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { ensureDepsInstalled } from './utils/proc/pm.mjs';
import { ensureHappyServerManagedInfra, applyHappyServerMigrations } from './utils/server/infra/happy_server_infra.mjs';
import { runCapture } from './utils/proc/proc.mjs';
import { pickNextFreeTcpPort } from './utils/net/ports.mjs';
import { getEnvValue } from './utils/env/values.mjs';
import { importPrismaClientForHappyServerLight, importPrismaClientFromNodeModules } from './utils/server/prisma_import.mjs';

function usage() {
  return [
    '[migrate] usage:',
    '  hstack migrate light-to-server --from-stack=<name> --to-stack=<name> [--include-files] [--force] [--json]',
    '',
    'Notes:',
    '- This migrates chat data from happy-server-light (SQLite) to happy-server (Postgres).',
    '- It preserves IDs, so existing session URLs keep working on the new server.',
    '- If --include-files is set, it mirrors server-light local files into Minio (S3) in the target stack.',
  ].join('\n');
}

const readEnvObject = readEnvObjectFromFile;

function parseFileDatabaseUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('file:')) {
    const path = raw.slice('file:'.length);
    return { url: raw, path };
  }
  return null;
}

async function ensureTargetSecretMatchesSource({ sourceSecretPath, targetSecretPath }) {
  try {
    const src = (await readFile(sourceSecretPath, 'utf-8')).trim();
    if (!src) return null;
    await mkdir(join(targetSecretPath, '..'), { recursive: true }).catch(() => {});
    const { rename, writeFile } = await import('node:fs/promises');
    // Write with a trailing newline, via atomic replace.
    const tmp = join(join(targetSecretPath, '..'), `.handy-master-secret.${Date.now()}.tmp`);
    await writeFile(tmp, src + '\n', { encoding: 'utf-8', mode: 0o600 });
    await rename(tmp, targetSecretPath);
    return src;
  } catch {
    return null;
  }
}

async function migrateLightToServer({ rootDir, fromStack, toStack, includeFiles, force, json }) {
  const from = resolveStackEnvPath(fromStack);
  const to = resolveStackEnvPath(toStack);

  const fromEnv = await readEnvObject(from.envPath);
  const toEnv = await readEnvObject(to.envPath);

  const fromFlavor = getEnvValue(fromEnv, 'HAPPIER_STACK_SERVER_COMPONENT') || 'happy-server-light';
  const toFlavor = getEnvValue(toEnv, 'HAPPIER_STACK_SERVER_COMPONENT') || 'happy-server-light';

  if (fromFlavor !== 'happy-server-light') {
    throw new Error(`[migrate] from-stack must use happy-server-light (got: ${fromFlavor})`);
  }
  if (toFlavor !== 'happy-server') {
    throw new Error(`[migrate] to-stack must use happy-server (got: ${toFlavor})`);
  }

  const fromDataDir = getEnvValue(fromEnv, 'HAPPY_SERVER_LIGHT_DATA_DIR') || join(from.baseDir, 'server-light');
  const fromFilesDir = getEnvValue(fromEnv, 'HAPPY_SERVER_LIGHT_FILES_DIR') || join(fromDataDir, 'files');
  const fromDbUrl = getEnvValue(fromEnv, 'DATABASE_URL') || `file:${join(fromDataDir, 'happy-server-light.sqlite')}`;
  const fromParsed = parseFileDatabaseUrl(fromDbUrl);
  if (!fromParsed?.path) {
    throw new Error(`[migrate] from-stack DATABASE_URL must be file:... (got: ${fromDbUrl})`);
  }

  const toPortRaw = getEnvValue(toEnv, 'HAPPIER_STACK_SERVER_PORT');
  let toPort = toPortRaw ? Number(toPortRaw) : NaN;
  const toEphemeral = !toPortRaw;
  if (!Number.isFinite(toPort) || toPort <= 0) {
    // Ephemeral-port stacks don't pin ports in env. Pick a free port for this one-off migration run.
    toPort = await pickNextFreeTcpPort(3005);
    if (!json) {
      // eslint-disable-next-line no-console
      console.log(`[migrate] to-stack has no pinned port; using ephemeral port ${toPort} for this migration run`);
    }
  }

  // Ensure target secret is the same as source so auth tokens remain valid after migration.
  const sourceSecretPath = join(fromDataDir, 'handy-master-secret.txt');
  const targetSecretPath = getEnvValue(toEnv, 'HAPPIER_STACK_HANDY_MASTER_SECRET_FILE') || join(to.baseDir, 'happy-server', 'handy-master-secret.txt');
  await ensureTargetSecretMatchesSource({ sourceSecretPath, targetSecretPath });
  await ensureEnvFileUpdated({
    envPath: to.envPath,
    updates: [{ key: 'HAPPIER_STACK_HANDY_MASTER_SECRET_FILE', value: targetSecretPath }],
  });

  // Resolve component dirs (prefer stack-pinned dirs).
  const lightDir = getComponentDir(rootDir, 'happy-server-light', fromEnv);
  const fullDir = getComponentDir(rootDir, 'happy-server', toEnv);

  await ensureDepsInstalled(lightDir, 'happy-server-light');
  await ensureDepsInstalled(fullDir, 'happy-server');

  // Bring up infra and ensure env vars are present.
  const infra = await ensureHappyServerManagedInfra({
    stackName: toStack,
    baseDir: to.baseDir,
    serverPort: toPort,
    publicServerUrl: `http://127.0.0.1:${toPort}`,
    envPath: to.envPath,
    env: {
      ...process.env,
      ...(toEphemeral ? { HAPPIER_STACK_EPHEMERAL_PORTS: '1' } : {}),
    },
  });
  await applyHappyServerMigrations({ serverDir: fullDir, env: { ...process.env, ...infra.env } });

  // Copy sqlite DB to a snapshot so migration is consistent even if the source server is running.
  const snapshotDir = join(to.baseDir, 'migrations');
  await mkdir(snapshotDir, { recursive: true });
  const snapshotPath = join(snapshotDir, `happy-server-light.${basename(fromParsed.path)}.${Date.now()}.sqlite`);
  await copyFile(fromParsed.path, snapshotPath);
  const snapshotDbUrl = `file:${snapshotPath}`;

  const SourcePrismaClient = await importPrismaClientForHappyServerLight({ serverDir: lightDir });
  const TargetPrismaClient = await importPrismaClientFromNodeModules({ dir: fullDir });

  const sourceDb = new SourcePrismaClient({ datasources: { db: { url: snapshotDbUrl } } });
  const targetDb = new TargetPrismaClient({ datasources: { db: { url: infra.env.DATABASE_URL } } });

  try {
    // Fail-fast unless target is empty (keeps this safe).
    const existingSessions = await targetDb.session.count();
    const existingMessages = await targetDb.sessionMessage.count();
    if (!force && (existingSessions > 0 || existingMessages > 0)) {
      throw new Error(
        `[migrate] target database is not empty (sessions=${existingSessions}, messages=${existingMessages}).\n` +
          `Pass --force to attempt a merge (skipDuplicates), or migrate into a fresh stack.`
      );
    }

    // Core entities
    const accounts = await sourceDb.account.findMany();
    if (accounts.length) {
      await targetDb.account.createMany({ data: accounts, skipDuplicates: true });
    }

    const machines = await sourceDb.machine.findMany();
    if (machines.length) {
      await targetDb.machine.createMany({ data: machines, skipDuplicates: true });
    }

    const accessKeys = await sourceDb.accessKey.findMany();
    if (accessKeys.length) {
      await targetDb.accessKey.createMany({ data: accessKeys, skipDuplicates: true });
    }

    const sessions = await sourceDb.session.findMany();
    if (sessions.length) {
      await targetDb.session.createMany({ data: sessions, skipDuplicates: true });
    }

    // Messages: stream in batches to avoid high memory.
    let migrated = 0;
    const batchSize = 1000;
    let cursor = null;
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const page = await sourceDb.sessionMessage.findMany({
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { id: 'asc' },
        take: batchSize,
      });
      if (!page.length) break;
      cursor = page[page.length - 1].id;
      // eslint-disable-next-line no-await-in-loop
      await targetDb.sessionMessage.createMany({ data: page, skipDuplicates: true });
      migrated += page.length;
      // eslint-disable-next-line no-console
      if (!json && migrated % (batchSize * 20) === 0) console.log(`[migrate] migrated ${migrated} messages...`);
    }

    // Pending queue (small)
    const pending = await sourceDb.sessionPendingMessage.findMany();
    if (pending.length) {
      await targetDb.sessionPendingMessage.createMany({ data: pending, skipDuplicates: true });
    }

    if (includeFiles) {
      // Mirror server-light local files (public/*) into Minio bucket root.
      // This assumes server-light stored public files under HAPPY_SERVER_LIGHT_FILES_DIR/public/...
      // (Matches happy-server Minio object keys).
      const { composePath, projectName } = infra;
      await runCapture('docker', [
        'compose',
        '-f',
        composePath,
        '-p',
        projectName,
        'run',
        '--rm',
        '-T',
        '-v',
        `${fromFilesDir}:/src:ro`,
        'minio-init',
        'sh',
        '-lc',
        [
          `mc alias set local http://minio:9000 ${infra.env.S3_ACCESS_KEY} ${infra.env.S3_SECRET_KEY}`,
          `mc mirror --overwrite /src local/${infra.env.S3_BUCKET}`,
        ].join(' && '),
      ]);
    }

    printResult({
      json,
      data: {
        ok: true,
        fromStack,
        toStack,
        snapshotPath,
        migrated: { accounts: accounts.length, sessions: sessions.length, messages: migrated, machines: machines.length, accessKeys: accessKeys.length },
        filesMirrored: Boolean(includeFiles),
      },
      text: [
        `[migrate] ok`,
        `[migrate] from: ${fromStack} (${fromFlavor})`,
        `[migrate] to:   ${toStack} (${toFlavor})`,
        `[migrate] sqlite snapshot: ${snapshotPath}`,
        `[migrate] messages: ${migrated}`,
        includeFiles ? `[migrate] files: mirrored from ${fromFilesDir} -> minio bucket ${infra.env.S3_BUCKET}` : `[migrate] files: skipped`,
      ].join('\n'),
    });
  } finally {
    await sourceDb.$disconnect().catch(() => {});
    await targetDb.$disconnect().catch(() => {});
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({ json, data: { ok: true }, text: usage() });
    return;
  }

  const cmd = argv.find((a) => !a.startsWith('--')) ?? '';
  if (!cmd) {
    throw new Error(usage());
  }

  if (cmd !== 'light-to-server') {
    throw new Error(`[migrate] unknown subcommand: ${cmd}\n\n${usage()}`);
  }

  const fromStack = (kv.get('--from-stack') ?? 'main').trim();
  const toStack = (kv.get('--to-stack') ?? '').trim();
  const includeFiles = flags.has('--include-files') || (kv.get('--include-files') ?? '').trim() === '1';
  const force = flags.has('--force');
  if (!toStack) {
    throw new Error('[migrate] --to-stack is required');
  }

  const rootDir = getRootDir(import.meta.url);
  await migrateLightToServer({ rootDir, fromStack, toStack, includeFiles, force, json });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
