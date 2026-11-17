// @happier-test-preparation source-condition
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { smokeSourceRuntimeReload } from './smokeSourceRuntimeReload.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

const repoDir = fileURLToPath(new URL('../../../../../', import.meta.url));

async function createServerFixture(root, provider, witness) {
  const serverDir = join(root, 'candidate', 'apps', 'server');
  const entrypoint = join(serverDir, 'sources', 'main.mjs');
  await mkdir(join(serverDir, 'sources'), { recursive: true });
  await writeFile(entrypoint, `
    import {createServer} from 'node:http';
    import {writeFileSync} from 'node:fs';
    const provider = process.env.HAPPIER_DB_PROVIDER;
    if (provider === 'sqlite' && !process.env.DATABASE_URL.startsWith('file:')) throw new Error('wrong sqlite scratch database');
    if (provider === 'pglite' && !process.env.HAPPIER_SERVER_LIGHT_DB_DIR.endsWith('/pglite')) throw new Error('wrong pglite scratch database');
    writeFileSync(${JSON.stringify(witness)}, provider);
    createServer((_request,response)=>{
      response.setHeader('content-type','application/json');
      response.end(JSON.stringify({status:'ok',service:'happier-server'}));
    }).listen(Number(process.env.PORT),'127.0.0.1');
  `);
  return {
    identity: `${provider}-candidate`,
    runtimeDir: serverDir,
    serverDir,
    entrypoint,
    serverComponent: 'happier-server-light',
    dbProvider: provider,
    env: { HAPPIER_DB_PROVIDER: provider },
    migration: { mode: 'disabled' },
  };
}

test('source reload probes local database server code on isolated scratch data', async (t) => {
  for (const provider of ['sqlite', 'pglite']) {
    const root = await mkdtemp(join(tmpdir(), `hstack-reload-smoke-${provider}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const witness = join(root, 'observed-provider');
    const server = await createServerFixture(root, provider, witness);
    await smokeSourceRuntimeReload({ components: { server },
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir,
        DATABASE_URL: 'postgresql://retained.invalid/live', HAPPIER_DB_PROVIDER: 'postgres' } });
    assert.equal(await readFile(witness, 'utf8'), provider);
  }

  const root = await mkdtemp(join(tmpdir(), 'hstack-reload-smoke-unsupported-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const witness = join(root, 'observed-provider');
  await assert.rejects(smokeSourceRuntimeReload({
      components: { server: await createServerFixture(root, 'mysql', witness) },
      env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir } }),
    /cannot smoke mysql without a separately authorized scratch database/);
  await assert.rejects(access(witness), { code: 'ENOENT' });
});

test('PostgreSQL replacement migrates, boots and serves /health on a scratch PostgreSQL endpoint, never the retained database', async (t) => {
  // P03 ORCH 2026-11-17: the health smoke runs on every flavour before retirement.
  const fixture = await createTempFixture(t, { prefix: 'hstack-postgres-health-smoke-' });
  const witness = fixture.path('observed');
  const server = await createServerFixture(fixture.root, 'postgres', witness);
  const migrate = join(server.serverDir, 'scripts', 'migrate.mjs');
  await mkdir(join(server.serverDir, 'scripts'), { recursive: true });
  // The fixture migration and server reach the scratch endpoint over the real
  // PostgreSQL wire protocol: a startup message must get an authentication reply.
  const probe = `
    import {connect} from 'node:net';
    import {appendFileSync} from 'node:fs';
    const url = new URL(process.env.DATABASE_URL);
    if (url.hostname !== '127.0.0.1' || process.env.DATABASE_URL.includes('retained')) throw new Error('not a scratch database');
    if (process.env.HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE || process.env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK) throw new Error('retained database authority leaked');
    const reply = await new Promise((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname);
      const params = Buffer.from('user\\0postgres\\0database\\0postgres\\0\\0');
      const header = Buffer.alloc(8); header.writeInt32BE(8 + params.length); header.writeInt32BE(196608, 4);
      socket.once('data', data => { socket.destroy(); resolve(String.fromCharCode(data[0])); });
      socket.once('error', reject);
      socket.write(Buffer.concat([header, params]));
    });
    if (reply !== 'R') throw new Error('no PostgreSQL authentication reply');
  `;
  await writeFile(migrate, `${probe}\nappendFileSync(${JSON.stringify(witness)}, 'migrated\\n');`);
  await writeFile(server.entrypoint, `${probe}
    import {createServer} from 'node:http';
    if (!process.env.HANDY_MASTER_SECRET) throw new Error('HANDY_MASTER_SECRET is required');
    if (process.env.HANDY_MASTER_SECRET !== 'fixture-owner-secret') throw new Error('wrong owner-provided master secret');
    appendFileSync(${JSON.stringify(witness)}, 'served\\n');
    createServer((_request,response)=>{
      response.setHeader('content-type','application/json');
      response.end(JSON.stringify({status:'ok',service:'happier-server'}));
    }).listen(Number(process.env.PORT),'127.0.0.1');
  `);
  server.migration = { mode: 'external', command: migrate, args: [], cwd: server.serverDir };
  await writeFile(fixture.path('retained.env'), [
    'HAPPIER_DB_PROVIDER=postgres', 'DATABASE_URL=postgresql://retained.invalid/live',
    'HANDY_MASTER_SECRET=fixture-owner-secret',
    `HAPPIER_SERVER_LIGHT_DATA_DIR=${fixture.path('retained-data')}`,
  ].join('\n'));
  const env = { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir, DATABASE_URL: 'postgresql://retained.invalid/live',
    HANDY_MASTER_SECRET: '', HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'fixture-source',
    HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: fixture.path('retained.env'),
    HAPPIER_SERVER_LIGHT_DATA_DIR: fixture.path('retained-data') };
  await smokeSourceRuntimeReload({ components: { server }, env, logger: { log() {} } });
  assert.deepEqual((await readFile(witness, 'utf8')).trim().split('\n'), ['migrated', 'served']);
  await assert.rejects(access(fixture.path('retained-data')), { code: 'ENOENT' });

  await writeFile(server.entrypoint, 'throw new TypeError("replacement-schema.optional is not a function");');
  await assert.rejects(smokeSourceRuntimeReload({ components: { server }, env, logger: { log() {} } }),
    /exited before becoming ready|replacement-schema.optional is not a function/);
});

test('source reload isolates its health smoke on loopback despite inherited server exposure', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-smoke-listen-host-' });
  const witness = fixture.path('listen-host');
  const server = await createServerFixture(fixture.root, 'sqlite', witness);
  await writeFile(server.entrypoint, `
    import {createServer} from 'node:http';
    import {writeFileSync} from 'node:fs';
    const http = createServer((_request,response)=>{
      response.setHeader('content-type','application/json');
      response.end(JSON.stringify({status:'ok',service:'happier-server'}));
    });
    http.listen(Number(process.env.PORT), process.env.HAPPIER_SERVER_HOST ?? '0.0.0.0', () => {
      writeFileSync(${JSON.stringify(witness)}, http.address().address);
    });
  `);
  await smokeSourceRuntimeReload({ components: { server },
    env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_SERVER_HOST: '0.0.0.0',
      HAPPY_SERVER_HOST: '0.0.0.0' } });
  assert.equal(await readFile(witness, 'utf8'), '127.0.0.1');
});
