// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isLinuxDesktopPackage, isLinuxHostGraphicsLibrary, validateLinuxPackageMetadata } from './linux-desktop-artifact-policy.mjs';

function fail(message) {
  throw new Error(`[linux-artifact-audit] ${message}`);
}

function listFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile()) out.push(file);
    }
  }
  return out;
}

function main() {
  const { values } = parseArgs({
    options: { appimage: { type: 'string' }, package: { type: 'string', multiple: true } },
    allowPositionals: false,
  });
  const appImage = path.resolve(String(values.appimage ?? '').trim());
  if (!appImage || !fs.existsSync(appImage)) fail(`missing AppImage: ${appImage || '<empty>'}`);
  if (!fs.statSync(appImage).isFile()) fail(`AppImage is not a file: ${appImage}`);
  if ((fs.statSync(appImage).mode & 0o111) === 0) fail(`AppImage is not executable: ${appImage}`);

  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-linux-audit-'));
  try {
    execFileSync(appImage, ['--appimage-extract'], {
      cwd: extractionRoot,
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
      stdio: 'pipe',
      timeout: 120_000,
    });
    const appDir = path.join(extractionRoot, 'squashfs-root');
    if (!fs.existsSync(appDir)) fail('AppImage extraction did not produce squashfs-root');
    const forbidden = listFiles(appDir).filter((file) => isLinuxHostGraphicsLibrary(path.relative(appDir, file)));
    if (forbidden.length) fail(`bundled host graphics libraries: ${forbidden.map((file) => path.relative(appDir, file)).join(', ')}`);
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }

  for (const packageName of values.package ?? []) {
    const packagePath = path.resolve(String(packageName));
    if (!isLinuxDesktopPackage(packagePath) || !fs.existsSync(packagePath) || fs.statSync(packagePath).size === 0) {
      fail(`invalid Linux desktop package: ${packagePath}`);
    }
    try {
      validateLinuxPackageMetadata(packagePath, (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 }));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  console.log(`[linux-artifact-audit] passed: ${path.basename(appImage)} packages=${(values.package ?? []).length}`);
}

main();
