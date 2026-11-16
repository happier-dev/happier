// @happier-test-preparation source-condition
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { withDependencyRefresh } from '../../utils/proc/dependency_refresh.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeStubCliDistBuildManifest } from '../../testkit/core/stub_happier_cli_files.mjs';
import { resolveCliEntrypoint } from './resolveCliEntrypoint.mjs';

async function makeCliFixture(name) {
  const checkout = join(tmpdir(), `happier-stack-cli-entrypoint-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const root = join(checkout, 'apps', 'cli');
  await mkdir(join(checkout, 'packages', 'cli-common'), { recursive: true });
  await writeFile(join(checkout, 'packages', 'cli-common', 'registerSourceRuntime.mjs'), 'export {};\n', 'utf8');
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, 'package-dist'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'bin', 'happier.mjs'), [
    '#!/usr/bin/env node',
    "import '../package-dist/index.mjs';",
    '',
  ].join('\n'), 'utf8');
  await writeFile(join(root, 'package-dist', 'index.mjs'), 'export {};\n', 'utf8');
  writeStubCliDistBuildManifest(root, { entrypointDir: 'package-dist' });
  await writeFile(join(root, 'src', 'index.ts'), 'export {};\n', 'utf8');
  await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
  return root;
}

test('resolveCliEntrypoint prefers TSX source when source mode is selected even if dist exists', async () => {
  const cliDir = await makeCliFixture('source-prefers-tsx');

  const resolved = await resolveCliEntrypoint({ cliDir, preferSource: true });

  assert.equal(resolved?.kind, 'tsx');
  assert.equal(resolved?.nodeArgs.at(-1), join(cliDir, 'src', 'index.ts'));
  assert.equal(resolved?.distEntrypoint, join(cliDir, 'package-dist', 'index.mjs'));
});

test('resolveCliEntrypoint keeps dist first for packaged/runtime mode', async () => {
  const cliDir = await makeCliFixture('dist-first');

  const resolved = await resolveCliEntrypoint({ cliDir, preferSource: false });

  assert.equal(resolved?.kind, 'dist');
  assert.deepEqual(resolved?.nodeArgs, [join(cliDir, 'package-dist', 'index.mjs')]);
});

test('resolveCliEntrypoint registers the selected checkout source runtime, not stack-local tooling', async () => {
  const cliDir = await makeCliFixture('source-runtime-from-cli-checkout');

  const resolved = await resolveCliEntrypoint({ cliDir, preferSource: true });

  assert.equal(resolved?.kind, 'tsx');
  assert.equal(await realpath(fileURLToPath(resolved?.nodeArgs[2])),
    await realpath(join(cliDir, '..', '..', 'packages', 'cli-common', 'registerSourceRuntime.mjs')));
  assert.equal(resolved?.nodeArgs.at(-1), join(cliDir, 'src', 'index.ts'));
});

test('source CLI launch consumes authored workspace exports, not compiled dist', async () => {
  // The real checkout CLI: a stale package dist must not shadow its authored
  // source export (HOME-ENROLL: login failed on an export missing from dist).
  const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'cli');
  const resolved = await resolveCliEntrypoint({ cliDir, preferSource: true });
  assert.equal(resolved?.kind, 'tsx');
  const probe = "process.stdout.write(import.meta.resolve('@happier-dev/sync-client'))";
  const result = spawnSync(process.execPath, [...resolved.nodeArgs.slice(0, -1), '--input-type=module', '--eval', probe], {
    cwd: cliDir,
    env: { ...process.env, NODE_OPTIONS: '', TSX_TSCONFIG_PATH: resolved.tsconfigPath },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\/packages\/sync-client\/src\/index\.ts$/);
});

test('source CLI selection waits for an in-progress installation before admitting its source loader', async t => {
  const fixture = await createTempFixture(t, { prefix: 'source-cli-install-wait-' });
  const cliDir = fixture.path('apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await writeFile(join(cliDir, 'src/index.ts'), 'export {};\n');
  await mkdir(fixture.path('packages/cli-common'), { recursive: true });
  await writeFile(fixture.path('packages/cli-common/registerSourceRuntime.mjs'), 'export {};\n');
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true }));
  for (const component of ['ui', 'cli', 'server']) {
    await mkdir(fixture.path(`apps/${component}`), { recursive: true });
    await writeFile(fixture.path(`apps/${component}/package.json`), JSON.stringify({ private: true }));
  }
  await writeFile(fixture.path('pnpm-lock.yaml'), '# fixture\n');
  await writeFile(fixture.path('pnpm-workspace.yaml'), 'packages: []\n');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const waiting = Promise.withResolvers();
  const originalWrite = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', function (chunk, ...args) {
    if (String(chunk).includes('waiting for dependency refresh lock')) waiting.resolve();
    return originalWrite(chunk, ...args);
  });
  const env = { ...process.env, HAPPIER_WORKSPACE_BUILD_NOTICE_AFTER_MS: '0',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  const writer = withDependencyRefresh({ installDir: fixture.root, env, force: true, signal: t.signal }, async () => {
    entered.resolve(); await release.promise;
    await mkdir(fixture.path('node_modules'), { recursive: true });
  });
  await entered.promise;
  const selected = resolveCliEntrypoint({ cliDir, preferSource: true, env, signal: t.signal });
  try {
    await Promise.race([waiting.promise, Promise.resolve(selected).then(() => {
      assert.fail('source loader admitted while the installation was still rewriting dependencies');
    })]);
  } finally { release.resolve(); await writer; }
  assert.equal((await selected).kind, 'tsx');
});


test('hot source CLI uses the completed producer guest tree without selecting a runtime bundle', async t => {
  const fixture = await createTempFixture(t, { prefix: 'source-cli-guest-payload-' });
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await mkdir(join(repoDir, 'packages/cli-common'), { recursive: true });
  await writeFile(join(repoDir, 'packages/cli-common/registerSourceRuntime.mjs'), 'export {};\n');
  await writeFile(join(cliDir, 'src/index.ts'), 'console.log(JSON.stringify({root:process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT??null,metadata:process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA??null}));\n');
  const stacksRoot = fixture.path('stacks');
  const bundleRoot = join(stacksRoot, 'source-bundles');
  const outputName = 'runtime-completed-daemon';
  const guestRoot = join(bundleRoot, outputName, 'guest-payload');
  const metadata = JSON.stringify({ root: guestRoot, identity: 'a'.repeat(64) });
  const producerEnv = { HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: guestRoot,
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA: metadata, UNRELATED_PRODUCER_SETTING: 'not-a-cli-setting' };
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: stacksRoot,
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer' };
  delete env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT;
  delete env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA;
  const missing = await resolveCliEntrypoint({ cliDir, preferSource: true, env });
  assert.equal(missing.env?.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT, undefined);
  await mkdir(guestRoot, { recursive: true });
  // This is the producer's persisted locator schema, not a replacement internal lookup.
  const candidateKey = createHash('sha256').update(JSON.stringify([repoDir, 'daemon', 'happier-server-light', undefined])).digest('hex');
  const candidate = { outputName, inputIdentity: 'b'.repeat(64), reuseFingerprint: 'c'.repeat(64),
    producerCompletedAt: '2026-11-15T12:00:00.000Z', producerCandidateKey: candidateKey };
  const record = { inputIdentity: candidate.inputIdentity, reuseFingerprint: candidate.reuseFingerprint,
    env: producerEnv, guestPayload: { root: guestRoot, identity: 'a'.repeat(64) } };
  await writeFile(join(bundleRoot, `candidate-${candidateKey}.json`), JSON.stringify(candidate));
  const recordPath = join(bundleRoot, outputName, 'source-bundle.json');
  await writeFile(recordPath, JSON.stringify(record));
  const resolved = await resolveCliEntrypoint({ cliDir, preferSource: true, env });
  assert.equal(resolved.kind, 'tsx');
  assert.equal(resolved.nodeArgs.at(-1), join(cliDir, 'src/index.ts'));
  const child = spawnSync(process.execPath, resolved.nodeArgs, { env: { ...env, ...resolved.env }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { root: guestRoot, metadata });
  assert.equal(resolved.env.UNRELATED_PRODUCER_SETTING, undefined);
  await writeFile(recordPath, JSON.stringify({ ...record, inputIdentity: 'd'.repeat(64) }));
  const mismatched = await resolveCliEntrypoint({ cliDir, preferSource: true, env });
  assert.equal(mismatched.env?.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT, undefined,
    'an incomplete or replaced producer publication cannot supply the guest tree');
  await writeFile(recordPath, JSON.stringify(record));
  const explicitRoot = fixture.path('operator-payload');
  const explicitMetadata = JSON.stringify({ root: explicitRoot, identity: 'e'.repeat(64) });
  await mkdir(explicitRoot, { recursive: true });
  const explicit = await resolveCliEntrypoint({ cliDir, preferSource: true, env: { ...env,
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: explicitRoot,
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA: explicitMetadata } });
  assert.deepEqual(explicit.env, { HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: explicitRoot,
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA: explicitMetadata });
  const rootOnly = await resolveCliEntrypoint({ cliDir, preferSource: true, env: { ...env,
    HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: explicitRoot } });
  assert.deepEqual(rootOnly.env, { HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT: explicitRoot },
    'an operator root cannot acquire metadata from a different producer tree');
});
