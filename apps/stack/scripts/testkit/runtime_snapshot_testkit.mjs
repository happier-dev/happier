import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const cleanEnv = {};
    for (const [key, value] of Object.entries(env ?? {})) {
      if (value == null) continue;
      cleanEnv[key] = String(value);
    }
    const proc = spawn(process.execPath, args, { cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr }));
  });
}

export async function createRuntimeSnapshotFixture(
  t,
  {
    stackName = 'prod-dev',
    cliEntrypoint = 'cli/happier',
    cliStdout = 'SNAPSHOT CLI HELP',
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-runtime-fixture-'));
  const storageDir = join(root, 'storage');
  const stackDir = join(storageDir, stackName);
  const snapshotDir = join(stackDir, 'runtime', 'builds', 'snap-1');
  const currentDir = join(stackDir, 'runtime', 'current');

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(snapshotDir, 'cli'), { recursive: true });
  await mkdir(join(snapshotDir, 'cli', 'package-dist'), { recursive: true });
  await mkdir(join(snapshotDir, 'server'), { recursive: true });
  await mkdir(join(snapshotDir, 'ui'), { recursive: true });
  await mkdir(join(currentDir, 'cli'), { recursive: true });
  await mkdir(join(currentDir, 'cli', 'package-dist'), { recursive: true });
  await mkdir(join(currentDir, 'server'), { recursive: true });
  await mkdir(join(currentDir, 'ui'), { recursive: true });
  await writeFile(join(snapshotDir, 'ui', 'index.html'), '<html></html>\n', 'utf-8');
  await writeFile(join(snapshotDir, 'server', 'happier-server'), '#!/bin/sh\nexit 0\n', 'utf-8');
  const cliRuntimeSource = cliEntrypoint.endsWith('.mjs') || cliEntrypoint.endsWith('.js') || cliEntrypoint.endsWith('.cjs')
    ? `process.stdout.write(${JSON.stringify(`${cliStdout}\n`)});\n`
    : `#!/bin/sh\necho ${cliStdout}\n`;
  await writeFile(join(snapshotDir, cliEntrypoint), cliRuntimeSource, 'utf-8');
  await writeFile(join(snapshotDir, 'cli', 'package-dist', 'index.mjs'), 'export {};\n', 'utf-8');
  await writeFile(join(currentDir, 'ui', 'index.html'), '<html></html>\n', 'utf-8');
  await writeFile(join(currentDir, 'server', 'happier-server'), '#!/bin/sh\nexit 0\n', 'utf-8');
  await writeFile(join(currentDir, cliEntrypoint), cliRuntimeSource, 'utf-8');
  await writeFile(join(currentDir, 'cli', 'package-dist', 'index.mjs'), 'export {};\n', 'utf-8');
  await chmod(join(snapshotDir, 'server', 'happier-server'), 0o755);
  await chmod(join(currentDir, 'server', 'happier-server'), 0o755);
  if (!cliEntrypoint.endsWith('.mjs') && !cliEntrypoint.endsWith('.js') && !cliEntrypoint.endsWith('.cjs')) {
    await chmod(join(snapshotDir, cliEntrypoint), 0o755);
    await chmod(join(currentDir, cliEntrypoint), 0o755);
  }
  await writeFile(
    join(snapshotDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      snapshotId: 'snap-1',
      sourceFingerprint: 'src-1',
      components: {
        web: { artifactFingerprint: 'web-1', entrypoint: 'ui/index.html' },
        server: { artifactFingerprint: 'srv-1', entrypoint: 'server/happier-server' },
        daemon: { artifactFingerprint: 'cli-1', entrypoint: cliEntrypoint },
      },
    }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(
    join(currentDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      snapshotId: 'snap-1',
      sourceFingerprint: 'src-1',
      components: {
        web: { artifactFingerprint: 'web-1', entrypoint: 'ui/index.html' },
        server: { artifactFingerprint: 'srv-1', entrypoint: 'server/happier-server' },
        daemon: { artifactFingerprint: 'cli-1', entrypoint: cliEntrypoint },
      },
    }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(
    join(stackDir, 'runtime', 'current.json'),
    JSON.stringify({
      version: 1,
      snapshotId: 'snap-1',
      snapshotPath: snapshotDir,
      sourceFingerprint: 'src-1',
    }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(join(stackDir, 'env'), 'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light\n', 'utf-8');

  return {
    root,
    storageDir,
    stackDir,
    snapshotDir,
    stackName,
  };
}
