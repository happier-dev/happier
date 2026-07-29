import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runNodeCapture } from './testkit/core/run_node_capture.mjs';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const repoLocalScript = join(import.meta.dirname, 'repo_local.mjs');

async function createFixture(t, lines) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-repo-local-provider-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const storageDir = join(root, 'storage');
  const id = (await readFile(join(repoRoot, '.git', 'happier-stack-stackless-id'), 'utf8')).trim();
  const stackName = `repo-${basename(repoRoot)}-${id.slice(0, 10)}`;
  const stackDir = join(storageDir, stackName);
  const envPath = join(stackDir, 'env');
  await mkdir(stackDir, { recursive: true });
  await writeFile(envPath, [...lines, ''].join('\n'), 'utf8');

  const env = { ...process.env };
  for (const key of ['HAPPIER_STACK_SERVER_COMPONENT', 'HAPPIER_DB_PROVIDER', 'HAPPY_DB_PROVIDER', 'DATABASE_URL', 'HAPPIER_STACK_ENV_FILE', 'HAPPIER_STACK_STACK']) {
    delete env[key];
  }
  Object.assign(env, {
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_REPO_LOCAL_AUTO_INSTALL: '0',
    HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ONLY: '1',
  });
  return { env, envPath, root };
}

async function runRepoLocal(fixture) {
  return await runNodeCapture([repoLocalScript, 'dev'], { cwd: repoRoot, env: fixture.env });
}

async function runRepoLocalCapturingSpawn(fixture) {
  const markerPath = join(fixture.root, 'spawn-env.json');
  const loaderPath = join(fixture.root, 'loader.mjs');
  const registerPath = join(fixture.root, 'register.mjs');
  const childProcessStub = `data:text/javascript,${encodeURIComponent(`
import { writeFileSync } from 'node:fs';
export function spawnSync(_command, _args, options = {}) {
  const env = options.env ?? {};
  writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
    component: env.HAPPIER_STACK_SERVER_COMPONENT ?? null,
    primary: env.HAPPIER_DB_PROVIDER ?? null,
    legacy: env.HAPPY_DB_PROVIDER ?? null,
    databaseUrl: env.DATABASE_URL ?? null,
  }), 'utf8');
  return { status: 0 };
}
`)}`;
  await writeFile(loaderPath, `
export async function resolve(specifier, context, defaultResolve) {
  if (specifier === 'node:child_process' && context.parentURL?.endsWith('/scripts/repo_local.mjs')) {
    return { url: ${JSON.stringify(childProcessStub)}, shortCircuit: true };
  }
  return defaultResolve(specifier, context, defaultResolve);
}
`, 'utf8');
  await writeFile(registerPath, [
    `import { register } from 'node:module';`,
    `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);`,
    '',
  ].join('\n'), 'utf8');
  const env = { ...fixture.env };
  delete env.HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ONLY;
  const result = await runNodeCapture(['--import', registerPath, repoLocalScript, 'dev'], { cwd: repoRoot, env });
  return { result, captured: JSON.parse(await readFile(markerPath, 'utf8')) };
}

test('repo-local writer preserves compatible PGlite and prunes light DATABASE_URL', async (t) => {
  const fixture = await createFixture(t, [
    'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
    'HAPPIER_DB_PROVIDER=pglite',
    'DATABASE_URL=mysql://stale-shell/db',
  ]);
  const result = await runRepoLocal(fixture);
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const raw = await readFile(fixture.envPath, 'utf8');
  assert.match(raw, /^HAPPIER_DB_PROVIDER=pglite$/m);
  assert.doesNotMatch(raw, /^DATABASE_URL=/m);
});

test('repo-local writer preserves compatible MySQL provider and DATABASE_URL', async (t) => {
  const databaseUrl = 'mysql://operator:secret@db.example.test:3306/happier';
  const fixture = await createFixture(t, [
    'HAPPIER_STACK_SERVER_COMPONENT=happier-server',
    'HAPPIER_DB_PROVIDER=mysql',
    `DATABASE_URL=${databaseUrl}`,
  ]);
  const result = await runRepoLocal(fixture);
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const raw = await readFile(fixture.envPath, 'utf8');
  assert.match(raw, /^HAPPIER_STACK_SERVER_COMPONENT=happier-server$/m);
  assert.match(raw, /^HAPPIER_DB_PROVIDER=mysql$/m);
  assert.match(raw, new RegExp(`^DATABASE_URL=${databaseUrl}$`, 'm'));
});

test('repo-local writer fails closed on corrupt explicit provider metadata', async (t) => {
  const fixture = await createFixture(t, [
    'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
    'HAPPIER_DB_PROVIDER=unsupported',
  ]);
  const before = await readFile(fixture.envPath, 'utf8');
  const result = await runRepoLocal(fixture);
  assert.notEqual(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /invalid DB provider/i);
  assert.equal(await readFile(fixture.envPath, 'utf8'), before);
});

test('repo-local child receives canonical persisted authority instead of exported shell provider state', async (t) => {
  const fixture = await createFixture(t, [
    'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
    'HAPPIER_DB_PROVIDER=sqlite',
  ]);
  Object.assign(fixture.env, {
    HAPPIER_DB_PROVIDER: 'mysql',
    HAPPY_DB_PROVIDER: 'mysql',
    DATABASE_URL: 'mysql://shell-override/db',
  });

  const { result, captured } = await runRepoLocalCapturingSpawn(fixture);
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(captured, {
    component: 'happier-server-light',
    primary: 'sqlite',
    legacy: null,
    databaseUrl: null,
  });
});

test('repo-local child retains compatible persisted external Postgres authority', async (t) => {
  const databaseUrl = 'postgresql://operator:secret@db.example.test:5432/happier';
  const fixture = await createFixture(t, [
    'HAPPIER_STACK_SERVER_COMPONENT=happier-server',
    'HAPPIER_DB_PROVIDER=postgres',
    `DATABASE_URL=${databaseUrl}`,
  ]);
  Object.assign(fixture.env, {
    HAPPIER_DB_PROVIDER: 'mysql',
    HAPPY_DB_PROVIDER: 'mysql',
    DATABASE_URL: 'mysql://shell-override/db',
  });

  const { result, captured } = await runRepoLocalCapturingSpawn(fixture);
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(captured, {
    component: 'happier-server',
    primary: 'postgres',
    legacy: null,
    databaseUrl,
  });
});
