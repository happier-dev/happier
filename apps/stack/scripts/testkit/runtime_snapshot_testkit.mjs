import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function cleanEnv(env) {
  const cleaned = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value == null) continue;
    cleaned[key] = String(value);
  }
  return cleaned;
}

export function runNode(args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd,
      env: cleanEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.on('error', reject);
    proc.on('exit', (code, signal) => {
      resolve({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr });
    });
  });
}

async function ensureMinimalRepo({ root }) {
  for (const component of ['ui', 'cli', 'server']) {
    const dir = join(root, 'apps', component);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), '{}\n', 'utf-8');
  }
}

async function writeRuntimeSnapshotCliEntrypoint({ snapshotDir, cliEntrypoint, cliStdout }) {
  const cliPath = join(snapshotDir, cliEntrypoint);
  await mkdir(join(cliPath, '..'), { recursive: true });
  await writeFile(
    cliPath,
    `console.log(${JSON.stringify(cliStdout)});\n`,
    'utf-8',
  );
}

async function writeRuntimeSnapshotServerEntrypoint({ snapshotDir, serverEntrypoint }) {
  const serverPath = join(snapshotDir, serverEntrypoint);
  await mkdir(join(serverPath, '..'), { recursive: true });
  await writeFile(serverPath, 'export {};\n', 'utf-8');
}

export async function createRuntimeSnapshotFixture(t, options = {}) {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'hstack-runtime-snapshot-'));
  t.after(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const root = join(tmpRoot, 'repo');
  const storageDir = join(tmpRoot, 'storage');
  const stackName = String(options.stackName ?? 'dev-built');
  const stackDir = join(storageDir, stackName);
  const snapshotId = String(options.snapshotId ?? 'snap-1');
  const snapshotDir = join(stackDir, 'runtime', 'builds', snapshotId);
  const currentDir = join(stackDir, 'runtime', 'current');
  const cliEntrypoint = String(options.cliEntrypoint ?? 'cli/package-dist/index.mjs');
  const cliStdout = String(options.cliStdout ?? 'SNAPSHOT CLI HELP');
  const serverEntrypoint = String(options.serverEntrypoint ?? 'server/dist/runtime/main.js');
  const sourceFingerprint = String(options.sourceFingerprint ?? 'src-1');
  const runtimeMode = String(options.runtimeMode ?? 'prefer');
  const serverPort = Number(options.serverPort ?? 4102);

  await ensureMinimalRepo({ root });
  await mkdir(join(snapshotDir, 'ui'), { recursive: true });
  await writeFile(join(snapshotDir, 'ui', 'index.html'), '<!doctype html><html><body>runtime ui</body></html>\n', 'utf-8');
  await writeRuntimeSnapshotCliEntrypoint({ snapshotDir, cliEntrypoint, cliStdout });
  await writeRuntimeSnapshotServerEntrypoint({ snapshotDir, serverEntrypoint });

  const manifest = {
    version: 1,
    snapshotId,
    sourceFingerprint,
    source: {
      repoDir: root,
    },
    components: {
      web: { artifactFingerprint: 'web-1', entrypoint: 'ui/index.html' },
      server: { artifactFingerprint: 'srv-1', entrypoint: serverEntrypoint },
      daemon: { artifactFingerprint: 'cli-1', entrypoint: cliEntrypoint },
    },
  };
  await writeFile(join(snapshotDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  await mkdir(currentDir, { recursive: true });
  await cp(join(snapshotDir, 'ui'), join(currentDir, 'ui'), { recursive: true });
  await cp(join(snapshotDir, 'server'), join(currentDir, 'server'), { recursive: true });
  await cp(join(snapshotDir, 'cli'), join(currentDir, 'cli'), { recursive: true });
  await writeFile(join(currentDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  await mkdir(stackDir, { recursive: true });
  await writeFile(
    join(stackDir, 'runtime', 'current.json'),
    `${JSON.stringify({
      version: 1,
      snapshotId,
      snapshotPath: snapshotDir,
      sourceFingerprint,
    }, null, 2)}\n`,
    'utf-8',
  );
  await writeFile(
    join(stackDir, 'env'),
    [
      `HAPPIER_STACK_STACK=${stackName}`,
      `HAPPIER_STACK_REPO_DIR=${root}`,
      `HAPPIER_STACK_RUNTIME_MODE=${runtimeMode}`,
      'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
      Number.isFinite(serverPort) && serverPort > 0 ? `HAPPIER_STACK_SERVER_PORT=${serverPort}` : '',
      '',
    ].filter(Boolean).join('\n'),
    'utf-8',
  );

  return {
    root,
    storageDir,
    stackName,
    stackDir,
    snapshotId,
    snapshotDir,
    currentDir,
    envPath: join(stackDir, 'env'),
    serverPort: Number.isFinite(serverPort) && serverPort > 0 ? serverPort : null,
  };
}
