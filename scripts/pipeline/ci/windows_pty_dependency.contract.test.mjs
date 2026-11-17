import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const requireFromCli = createRequire(path.resolve('apps/cli/package.json'));
const packagePath = requireFromCli.resolve('@homebridge/node-pty-prebuilt-multiarch/package.json');
const packageRoot = path.dirname(packagePath);
const { scripts } = JSON.parse(readFileSync(packagePath, 'utf8'));

function runWindowsInstall(t, { rejectNativeLoad = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'happier-windows-pty-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = path.join(root, 'events');
  const preload = path.join(root, 'windows-boundary.cjs');
  // Native addon loading and Windows process creation are OS boundaries. Keep the
  // dependency's real install scripts and packaged files beneath those boundaries.
  writeFileSync(preload, `
    const fs = require('node:fs');
    const os = require('node:os');
    const Module = require('node:module');
    const cp = require('node:child_process');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    os.platform = () => 'win32';
    os.arch = () => 'x64';
    Module._extensions['.node'] = (module, filename) => {
      if (${rejectNativeLoad}) throw new Error('native load rejected by OS');
      fs.appendFileSync(process.env.PTY_INSTALL_EVENTS, 'native:' + filename + '\\n');
      module.exports = {};
    };
    const spawn = cp.spawn;
    cp.spawn = function (command, args, options) {
      if (/\\.cmd$/i.test(command) && !options?.shell) {
        throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
      }
      return spawn.call(this, command, args, options);
    };
  `);
  for (const name of ['node-gyp', 'prebuild-install']) {
    const status = name === 'node-gyp' ? 0 : 1;
    const file = path.join(root, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$PTY_INSTALL_EVENTS"\nexit ${status}\n`);
    chmodSync(file, 0o755);
    writeFileSync(`${file}.cmd`, `@echo off\r\necho ${name}>> "%PTY_INSTALL_EVENTS%"\r\nexit /b ${status}\r\n`);
  }
  const result = spawnSync(scripts.install, {
    cwd: packageRoot,
    shell: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      PTY_INSTALL_EVENTS: events,
      npm_config_build_from_source: 'false',
    },
  });
  const recorded = (() => {
    try { return readFileSync(events, 'utf8').trim().split(/\r?\n/); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  })();
  return { result, recorded };
}

test('Windows PTY dependency installs from its packaged native binaries without a network fetch or compiler', (t) => {
  const { result, recorded } = runWindowsInstall(t);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(recorded.some(event => event.endsWith(`${path.sep}conpty.node`)), 'the Windows ConPTY prebuild must load');
  assert.ok(recorded.some(event => event.endsWith(`${path.sep}conpty_console_list.node`)), 'the Windows console-list prebuild must load');
  assert.ok(recorded.every(event => event.startsWith('native:')), 'a supported prebuild needs neither downloads nor a compiler');
});

test('Windows PTY dependency falls back to the shell compiler command when a native binary cannot load', (t) => {
  const { result, recorded } = runWindowsInstall(t, { rejectNativeLoad: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(recorded, ['node-gyp'], 'the package-manager shell must launch the compiler without a direct .cmd spawn or network fetch');
});
