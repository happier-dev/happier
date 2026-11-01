import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateLinuxWebKitRuntime } from './linux-webkit-runtime.mjs';
import { validateLinuxAppImageRuntime } from './linux-desktop-artifact-policy.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webkit-runtime-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lib = 'usr/lib/x86_64-linux-gnu';
  const files = [
    `${lib}/libwebkit2gtk-4.1.so.0`, `${lib}/libjavascriptcoregtk-4.1.so.0`,
    `${lib}/webkit2gtk-4.1/WebKitWebProcess`, `${lib}/webkit2gtk-4.1/WebKitNetworkProcess`,
    `${lib}/webkit2gtk-4.1/WebKitGPUProcess`, `${lib}/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so`,
    `${lib}/webkit2gtk-4.1/MiniBrowser`, `${lib}/webkit2gtk-4.1/jsc`, 'usr/bin/WebKitWebDriver',
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'external ELF boundary fixture');
  }
  // ELF inspection and native library loading are genuine subprocess/OS boundaries.
  const inspect = (command) => {
    if (command === 'ldd') return 'libc.so.6 => /lib/libc.so.6\n';
    if (command === 'readelf') return 'Version needs section\n Name: GLIBC_2.35\n Name: GLIBCXX_3.4.30\n';
    if (command === 'python3') return '2.54.1\n';
    throw new Error(`Unexpected external command ${command}`);
  };
  return { root, files, inspect };
}

test('SDK validation requires the pinned native version and complete helper closure', (t) => {
  const f = fixture(t);
  assert.equal(validateLinuxWebKitRuntime(f).version, '2.54.1');
  assert.throws(() => validateLinuxWebKitRuntime({ ...f, inspect: (command, ...args) => command === 'python3' ? '2.50.4\n' : f.inspect(command, ...args) }), /expected WebKitGTK 2.54.1/);
  fs.unlinkSync(path.join(f.root, f.files.find((file) => file.endsWith('/WebKitGPUProcess'))));
  assert.throws(() => validateLinuxWebKitRuntime(f), /WebKitGPUProcess/);
});

test('SDK validation rejects unresolved symbols and ABI floors newer than Jammy', (t) => {
  const f = fixture(t);
  assert.throws(() => validateLinuxWebKitRuntime({ ...f, inspect: (command, ...args) => command === 'ldd' ? 'undefined symbol: missing_runtime_api\n' : f.inspect(command, ...args) }), /unresolved/);
  assert.throws(() => validateLinuxWebKitRuntime({ ...f, inspect: (command, ...args) => command === 'readelf' ? 'Version needs section\n Name: GLIBC_2.38\n' : f.inspect(command, ...args) }), /GLIBC_2.38/);
});

test('SDK validation rejects a cached helper symlink outside its staged tree', (t) => {
  const f = fixture(t);
  const helper = path.join(f.root, f.files.find((file) => file.endsWith('/WebKitGPUProcess')));
  fs.unlinkSync(helper);
  fs.symlinkSync(process.execPath, helper);
  assert.throws(() => validateLinuxWebKitRuntime(f), /outside/);
});


test('AppImage validation pins the engine without requiring SDK diagnostic tools or a CI environment switch', (t) => {
  const f = fixture(t);
  const lib = path.join(f.root, 'usr/lib');
  for (const name of ['libwebkit2gtk-4.1.so.0', 'libjavascriptcoregtk-4.1.so.0']) {
    fs.renameSync(path.join(lib, 'x86_64-linux-gnu', name), path.join(lib, name));
  }
  for (const file of f.files.filter((file) => /\/(MiniBrowser|jsc|WebKitWebDriver)$/.test(file))) fs.unlinkSync(path.join(f.root, file));
  assert.equal(validateLinuxAppImageRuntime(f.root, f.inspect).files.length, 6);
  assert.throws(() => validateLinuxAppImageRuntime(f.root, (command, ...args) => command === 'python3' ? '2.50.4\n' : f.inspect(command, ...args)), /expected WebKitGTK 2.54.1/);
});
