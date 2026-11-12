import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const buildOwner = new URL('./ensureWorkspacePackagesBuilt.mjs', import.meta.url).href;

async function startCapture(t, root, name) {
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { ensureWorkspacePackagesBuiltByName } from ${JSON.stringify(buildOwner)};
    import { mkdir, writeFile } from 'node:fs/promises';
    import { resolve, join } from 'node:path';
    await ensureWorkspacePackagesBuiltByName(process.argv[1], [process.argv[2]], {
      quiet: true,
      workspaceBuildBoundary: {
        prepareEnv: async (_directory, env) => env,
        runPackageBuild: async (directory, { env }) => {
          process.send(resolve(directory, '../../..'));
          await new Promise(resolve => process.once('message', resolve));
          await mkdir(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
          await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, 'index.js'), 'export const value = 1;');
        },
      },
    });
    process.disconnect();
  `, root, name], {
    env: { ...process.env, TMPDIR: join(root, 'captures'), TMP: join(root, 'captures'), TEMP: join(root, 'captures') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let diagnostic = '';
  writer.stderr.on('data', data => { diagnostic += data; });
  t.after(async () => {
    if (writer.exitCode !== null || writer.signalCode !== null) return;
    const exited = once(writer, 'exit');
    writer.kill('SIGKILL');
    await exited;
  });
  const directory = await new Promise((resolve, reject) => {
    writer.once('message', resolve);
    writer.once('error', reject);
    writer.once('exit', (code, signal) => reject(new Error(`Capture writer exited ${code ?? signal}: ${diagnostic}`)));
  });
  return { writer, directory };
}

async function stopCapture(capture, signal) {
  const exited = once(capture.writer, 'exit');
  if (signal) capture.writer.kill(signal);
  else capture.writer.send('finish');
  const [code, terminalSignal] = await exited;
  if (!signal) assert.equal(code, 0, `capture completion failed: ${terminalSignal}`);
}

test('workspace captures reclaim killed owners while preserving live and unrelated temporary directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-capture-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'captures'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true }));
  await writeFile(join(root, 'pnpm-lock.yaml'), '# fixture\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  for (const app of ['cli', 'ui', 'server']) {
    const directory = join(root, 'apps', app);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@fixture/${app}` }));
  }
  for (const name of ['one', 'two', 'three']) {
    const directory = join(root, 'packages', name);
    await mkdir(join(directory, 'src'), { recursive: true });
    await writeFile(join(directory, 'src', 'index.js'), 'export const value = 1;');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@fixture/${name}`,
      type: 'module', main: './dist/index.js', scripts: { build: 'fixture-compiler' } }));
  }
  const unrelated = join(root, 'captures', 'happier-workspace-capture-unstamped');
  await mkdir(unrelated);
  const abandoned = await startCapture(t, root, '@fixture/one');
  const live = await startCapture(t, root, '@fixture/two');
  assert.equal((await stat(abandoned.directory)).isDirectory(), true, 'a live capture must survive a sibling build');
  await stopCapture(abandoned, 'SIGKILL');
  const unrelatedStaging = join(root, 'captures', `.tmp.1.${abandoned.writer.pid}.abc`);
  const unstampedCapture = join(root, 'captures', `happier-workspace-capture.1.${abandoned.writer.pid}.abc`);
  await mkdir(unrelatedStaging);
  await mkdir(unstampedCapture);
  const next = await startCapture(t, root, '@fixture/three');
  await assert.rejects(stat(abandoned.directory), { code: 'ENOENT' });
  await assert.rejects(stat(`${abandoned.directory}.owner.json`), { code: 'ENOENT' });
  assert.equal((await stat(live.directory)).isDirectory(), true);
  assert.equal((await stat(unrelated)).isDirectory(), true);
  assert.equal((await stat(unrelatedStaging)).isDirectory(), true);
  assert.equal((await stat(unstampedCapture)).isDirectory(), true);
  const owner = JSON.parse(await readFile(`${live.directory}.owner.json`, 'utf8'));
  assert.equal(owner.pid, live.writer.pid);
  await stopCapture(next);
  await stopCapture(live);
  for (const capture of [next, live]) {
    await assert.rejects(stat(capture.directory), { code: 'ENOENT' });
    await assert.rejects(stat(`${capture.directory}.owner.json`), { code: 'ENOENT' });
  }
});
