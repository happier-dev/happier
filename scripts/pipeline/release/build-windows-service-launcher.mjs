import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const source = resolve(repoRoot, 'packages/cli-common/native/windows/service-launcher.cpp');
const output = resolve(repoRoot, 'packages/cli-common/native/windows/bin/windows-x64/happier-service-launcher.exe');
const object = resolve(dirname(output), 'service-launcher.obj');

if (process.platform !== 'win32') {
  throw new Error('[windows-service-launcher] MSVC build must run on Windows');
}
mkdirSync(dirname(output), { recursive: true });
rmSync(output, { force: true });
rmSync(object, { force: true });

const result = spawnSync('cl.exe', [
  '/nologo',
  '/std:c++20',
  '/O2',
  '/MT',
  '/Brepro',
  `/Fo:${object}`,
  source,
  '/link',
  '/SUBSYSTEM:WINDOWS',
  "/MANIFESTUAC:level='asInvoker' uiAccess='false'",
  'shell32.lib',
  'pathcch.lib',
  `/OUT:${output}`,
], { cwd: repoRoot, stdio: 'inherit', windowsHide: true });

rmSync(object, { force: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const bytes = readFileSync(output);
const peOffset = bytes.readUInt32LE(0x3c);
if (
  bytes.readUInt16LE(0) !== 0x5a4d
  || bytes.readUInt32LE(peOffset) !== 0x00004550
  || bytes.readUInt16LE(peOffset + 4) !== 0x8664
  || bytes.readUInt16LE(peOffset + 24) !== 0x20b
  || bytes.readUInt16LE(peOffset + 24 + 68) !== 2
  || !bytes.includes(Buffer.from('HAPPIER_SERVICE_LAUNCHER_V1', 'ascii'))
) {
  throw new Error('[windows-service-launcher] compiler output is not the expected x64 PE32+ GUI launcher');
}
console.log(`[windows-service-launcher] built ${output}`);
