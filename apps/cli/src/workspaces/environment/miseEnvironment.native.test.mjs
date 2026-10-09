import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { produceProjectNativeEnvironment } from './produceProjectNativeEnvironment.ts';

// Native qualification is explicit: unit fixtures cannot qualify a native CLI.
// Run with B3_NATIVE_MISE_PATH pointing to the checksum-verified 2026.10.4 binary.
const binary = process.env.B3_NATIVE_MISE_PATH;
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function run(args, cwd, env, signal) {
  return new Promise((resolve, reject) => {
    execFile(binary, [...args], { cwd, env, signal }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function fixture(config) {
  const path = await mkdtemp(join(tmpdir(), 'happier-b3-mise-'));
  directories.push(path);
  const cwd = join(path, 'project with spaces');
  await mkdir(cwd);
  const file = join(cwd, 'mise.toml');
  await writeFile(file, config);
  return { cwd, file, env: { PATH: process.env.PATH, MISE_DATA_DIR: join(path, 'data'), MISE_CACHE_DIR: join(path, 'cache'), MISE_STATE_DIR: join(path, 'state'), MISE_CONFIG_DIR: join(path, 'config'), MISE_TRUSTED_CONFIG_PATHS: cwd, B3_KEEP: 'keep', B3_UNSET: 'remove' } };
}

describe('Mise 2026.10.4 native boundary', { skip: !binary }, () => {
  it('produces the complete environment through the host adapter', async () => {
    const f = await fixture('[env]\nB3_VALUE = "native"\nB3_UNSET = false\n');
    const result = await produceProjectNativeEnvironment({
      selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, cwd: f.cwd, env: f.env, platform: 'linux',
      io: {
        resolveTool: async () => ({ executablePath: binary, version: '2026.10.4' }),
        run: async (request) => ({ exitCode: 0, stdout: await run(request.args, request.cwd, request.env, request.signal) }),
      },
    });
    assert.equal(result.status, 'ready');
    assert.equal(result.env.B3_VALUE, 'native');
    assert.equal(result.env.B3_KEEP, 'keep');
    assert.equal(result.env.B3_UNSET, undefined);
  });
  it('pins version and characterizes env JSON, cwd, literal argv and unset variables', async () => {
    const f = await fixture('[env]\nB3_VALUE = "native"\nB3_UNSET = false\n');
    assert.match(await run(['--version'], f.cwd, f.env), /^2026\.10\.4 linux-x64/);
    const environment = JSON.parse(await run(['env', '--json'], f.cwd, f.env));
    assert.equal(environment.B3_VALUE, 'native');
    // Native JSON is a patch without inherited values or removal information.
    assert.equal(environment.B3_KEEP, undefined);
    assert.equal(environment.B3_UNSET, undefined);
    const dump = await run(['exec', '--', '/usr/bin/env', '-0'], f.cwd, f.env);
    const entries = Object.fromEntries(dump.split('\0').filter(Boolean).map((entry) => {
      const separator = entry.indexOf('=');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
    assert.equal(entries.B3_VALUE, 'native');
    assert.equal(entries.B3_KEEP, 'keep');
    assert.equal(entries.B3_UNSET, undefined);
    const output = await run(['exec', '--', process.execPath, '-e', 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),keep:process.env.B3_KEEP,value:process.env.B3_VALUE,unset:process.env.B3_UNSET}))', 'literal $() ; " argument'], f.cwd, f.env);
    assert.deepEqual(JSON.parse(output), { cwd: f.cwd, args: ['literal $() ; " argument'], keep: 'keep', value: 'native' });
  });

  it('fails bad configuration and recovers after explicit repair without a host fallback', async () => {
    const f = await fixture('[env\n');
    await assert.rejects(run(['env', '--json'], f.cwd, f.env), { code: 1 });
    await writeFile(f.file, '[env]\nB3_VALUE = "repaired"\n');
    assert.equal(JSON.parse(await run(['env', '--json'], f.cwd, f.env)).B3_VALUE, 'repaired');
  });

  it('uses an exact selected config path through Mise native configuration', async () => {
    const f = await fixture('[env]\nB3_VALUE = "default"\n');
    const selected = join(f.cwd, 'selected config.toml');
    await writeFile(selected, '[env]\nB3_VALUE = "selected"\n');
    const output = await run(['exec', '--', '/usr/bin/env', '-0'], f.cwd, { ...f.env, MISE_OVERRIDE_CONFIG_FILENAMES: selected });
    assert.ok(output.split('\0').includes('B3_VALUE=selected'));
    assert.ok(!output.split('\0').includes('B3_VALUE=default'));
  });

  it('refuses a missing selected configuration without evaluating the default config', async () => {
    const f = await fixture('[env]\nB3_VALUE = "must-not-fallback"\n');
    const result = await produceProjectNativeEnvironment({
      selection: { kind: 'toolchain', tool: 'mise', configPath: 'missing.toml' }, cwd: f.cwd, env: f.env, platform: 'linux',
      io: {
        resolveTool: async () => ({ executablePath: binary, version: '2026.10.4' }),
        run: async (request) => ({ exitCode: 0, stdout: await run(request.args, request.cwd, request.env, request.signal) }),
      },
    });
    assert.deepEqual(result, { status: 'refused', kind: 'unavailable', code: 'native_configuration_unavailable' });
  });

  it('resolves the selected config against the Project root while retaining a nested launch cwd', async () => {
    const f = await fixture('[env]\nB3_VALUE = "project-root"\n');
    const cwd = join(f.cwd, 'nested command');
    await mkdir(cwd);
    const result = await produceProjectNativeEnvironment({
      selection: { kind: 'toolchain', tool: 'mise', configPath: 'mise.toml' }, root: f.cwd, cwd, env: f.env, platform: 'linux',
      io: {
        resolveTool: async () => ({ executablePath: binary, version: '2026.10.4' }),
        run: async (request) => {
          assert.equal(request.cwd, cwd);
          return { exitCode: 0, stdout: await run(request.args, request.cwd, request.env, request.signal) };
        },
      },
    });
    assert.equal(result.status, 'ready');
    assert.equal(result.env.B3_VALUE, 'project-root');
  });

  it('cancels a native child and permits a fresh invocation', { timeout: 30_000 }, async () => {
    const f = await fixture('[env]\nB3_VALUE = "native"\n');
    const controller = new AbortController();
    let childPid;
    let closed;
    const running = new Promise((resolve, reject) => {
      const child = execFile(binary, ['exec', '--', process.execPath, '-e', 'console.log(process.pid);setInterval(()=>{},1000)'], { cwd: f.cwd, env: f.env, detached: true, signal: controller.signal }, (error, stdout) => error ? reject(error) : resolve(stdout));
      closed = new Promise((resolve) => child.once('close', resolve));
      child.stdout.once('data', (chunk) => {
        childPid = Number(chunk.toString().trim());
        // Mise can move its child out of the parent's group. The incumbent
        // process-tree owner must retire descendants, not only the launcher.
        controller.abort();
        for (const pid of [childPid, -child.pid]) {
          try { process.kill(pid, 'SIGTERM'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      });
    });
    await assert.rejects(running, { name: 'AbortError' });
    await closed;
    assert.ok(childPid > 0);
    // Descendant cancellation kills the actual child. Recovery below creates
    // a fresh invocation, never replay of the cancelled command.
    // A reparented, already-dead zombie can await the OS reaper; it is not a
    // running native child. Wait for the observed child to stop executing.
    for (;;) {
      const stat = await readFile(`/proc/${childPid}/stat`, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat === null || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(JSON.parse(await run(['env', '--json'], f.cwd, f.env)).B3_VALUE, 'native');
  });
});
