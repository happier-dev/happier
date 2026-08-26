import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const sdkDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(sdkDir, '..', '..');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout.trim();
}

export function parseNodeNextConsumerArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tarball: { type: 'string', default: '' },
    },
    allowPositionals: false,
  });
  const tarball = String(values.tarball ?? '').trim();
  if (!tarball) return Object.freeze({ tarballPath: null });
  if (!isAbsolute(tarball)) {
    throw new Error('SDK consumer tarball path must be absolute');
  }
  return Object.freeze({ tarballPath: resolve(tarball) });
}

async function assertExactTarball(tarballPath) {
  const stats = await lstat(tarballPath).catch((error) => {
    if (error?.code === 'ENOENT') {
      throw new Error(`SDK consumer tarball does not exist: ${tarballPath}`);
    }
    throw error;
  });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`SDK consumer tarball must be an exact regular file: ${tarballPath}`);
  }
  return tarballPath;
}

function packSdkTarball(fixture) {
  const archiveName = run('npm', [
    'pack',
    sdkDir,
    '--ignore-scripts',
    '--silent',
    '--pack-destination',
    fixture,
  ], repoRoot);
  return join(fixture, archiveName.split('\n').at(-1));
}

export async function validateNodeNextConsumer({ tarballPath = null } = {}) {
  const fixture = await mkdtemp(join(tmpdir(), 'happier-sdk-nodenext-'));
  try {
    const tarball = tarballPath
      ? await assertExactTarball(tarballPath)
      : packSdkTarball(fixture);

    await writeFile(join(fixture, 'package.json'), JSON.stringify({
      name: 'happier-sdk-nodenext-consumer',
      private: true,
      type: 'module',
    }, null, 2));
    await writeFile(join(fixture, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        lib: ['ES2022', 'DOM'],
      },
      include: ['consumer.ts'],
    }, null, 2));
    await writeFile(join(fixture, 'consumer.ts'), [
      "import { connect, type PublicActionId } from '@happier-dev/sdk';",
      "const actionId: PublicActionId = 'machines.list';",
      "const client = connect({ endpoint: 'http://127.0.0.1:3210', token: 'pat' });",
      'void client.actions.execute(actionId, {});',
      'void client.machines.list();',
      'await client.close();',
      '',
    ].join('\n'));

    run('npm', ['install', '--ignore-scripts', '--no-package-lock', tarball], fixture);
    run(process.execPath, [
      join(repoRoot, 'scripts/workspaces/runTypeScriptCli.mjs'),
      '--noEmit',
      '-p',
      join(fixture, 'tsconfig.json'),
    ], fixture);
    run(process.execPath, ['--input-type=module', '--eval', [
      "import { connect } from '@happier-dev/sdk';",
      "const client = connect({ endpoint: 'http://127.0.0.1:3210', token: 'pat' });",
      'await client.close();',
    ].join('\n')], fixture);

    const installed = JSON.parse(await readFile(join(fixture, 'node_modules/@happier-dev/sdk/package.json'), 'utf8'));
    if (installed.name !== '@happier-dev/sdk') throw new Error('Installed SDK package identity mismatch');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { tarballPath } = parseNodeNextConsumerArgs(argv);
  await validateNodeNextConsumer({ tarballPath });
}

const invokedAsMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsMain) {
  await main();
}
