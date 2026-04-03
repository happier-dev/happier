import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDepsInstalled } from './pm.mjs';

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

async function writeStubYarnThatRequiresYes({ binDir }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      "if (args.includes('--version')) {",
      '  let buf = "";',
      '  let done = false;',
      '  const finish = (code) => {',
      '    if (done) return;',
      '    done = true;',
      '    process.exit(code);',
      '  };',
      '  const t = setTimeout(() => finish(3), 1500);',
      '  process.stdin.on("data", (d) => {',
      '    buf += String(d);',
      '    if (buf.toLowerCase().includes("y")) {',
      '      clearTimeout(t);',
      '      finish(0);',
      '    }',
      '  });',
      '  process.stdin.on("end", () => {',
      '    clearTimeout(t);',
      '    finish(buf.toLowerCase().includes("y") ? 0 : 4);',
      '  });',
      '  try { process.stdin.resume(); } catch {}',
      '  return;',
      '}',
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
}

test('ensureDepsInstalled auto-answers Corepack-style prompts for yarn readiness in a TTY parent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-yarn-ready-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeJson(join(componentDir, 'package.json'), { name: 'component', version: '0.0.0' });
  await writeFile(join(componentDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(componentDir, 'node_modules'), { recursive: true });

  const binDir = join(root, 'bin');
  await writeStubYarnThatRequiresYes({ binDir });

  const originalIsTty = process.stdin.isTTY;
  let restored = false;
  try {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    t.after(() => {
      if (restored) return;
      restored = true;
      try {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTty, configurable: true });
      } catch {
        // ignore
      }
    });
  } catch {
    // If isTTY is non-configurable in this environment, the test still provides coverage on CI
    // where stdin tends to be a pipe; fall back without forcing TTY mode.
  }

  await ensureDepsInstalled(componentDir, 'stub-component', {
    quiet: false,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
    },
  });
});
