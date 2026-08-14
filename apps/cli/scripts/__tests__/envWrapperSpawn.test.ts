import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const wrapperSource = join(dirname(fileURLToPath(import.meta.url)), '..', 'env-wrapper.cjs');

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

/**
 * `env-wrapper.cjs` is published (`apps/cli` ships `scripts/**\/*.cjs`) and forwards
 * arbitrary user CLI arguments to the real bin. Its Windows branch is unreachable on
 * macOS, so these tests force `process.platform` in a preload: `node:path` is already
 * bootstrapped POSIX by then, so only the wrapper's own platform decision changes.
 */
async function createWrapperTree(): Promise<{
  root: string;
  wrapperPath: string;
  binPath: string;
  homeDir: string;
  reportPath: string;
}> {
  // A space in the install path is the exact input a concatenating shell command line
  // splits apart (Node DEP0190) — a default Windows install lives in `C:\Program Files`.
  const created = await mkdtemp(join(tmpdir(), 'happier env wrapper '));
  roots.push(created);
  // The wrapper derives its bin path from `__dirname`, which Node reports realpath-resolved
  // (macOS `/var` is a symlink to `/private/var`).
  const root = await realpath(created);
  const wrapperPath = join(root, 'scripts', 'env-wrapper.cjs');
  const binPath = join(root, 'bin', 'happier.mjs');
  const homeDir = join(root, 'home');
  const reportPath = join(root, 'delivered-argv.json');
  await mkdir(dirname(wrapperPath), { recursive: true });
  await mkdir(dirname(binPath), { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeFile(wrapperPath, await readFile(wrapperSource, 'utf8'), 'utf8');
  await writeFile(
    binPath,
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(process.argv.slice(2)), 'utf8');`,
      '',
    ].join('\n'),
    'utf8',
  );
  return { root, wrapperPath, binPath, homeDir, reportPath };
}

async function writeWin32Preload(root: string, extra = ''): Promise<string> {
  const preloadPath = join(root, 'force-win32.cjs');
  await writeFile(
    preloadPath,
    [`Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });`, extra, ''].join('\n'),
    'utf8',
  );
  return preloadPath;
}

describe('apps/cli/scripts/env-wrapper.cjs', () => {
  it('starts the CLI from argv rather than a concatenated shell command line', async () => {
    const tree = await createWrapperTree();
    const recordPath = join(tree.root, 'spawn-decision.json');
    const preloadPath = await writeWin32Preload(
      tree.root,
      [
        `const childProcess = require('node:child_process');`,
        `const { writeFileSync } = require('node:fs');`,
        `childProcess.spawn = (command, args, options) => {`,
        `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ command, args, shell: options?.shell ?? null }), 'utf8');`,
        `  return { on() { return this; } };`,
        `};`,
      ].join('\n'),
    );

    spawnSync(process.execPath, ['--require', preloadPath, tree.wrapperPath, 'dev', 'auth', 'arg with spaces'], {
      env: { ...process.env, HOME: tree.homeDir },
      encoding: 'utf8',
    });

    const decision = JSON.parse(await readFile(recordPath, 'utf8')) as {
      command: string;
      args: string[];
      shell: unknown;
    };

    // A shell makes Node concatenate argv into one unescaped command line, which both
    // corrupts spaced paths and hands user arguments to a shell parser.
    expect(decision.shell).toBeFalsy();
    // The wrapper must re-enter the Node runtime already running it, not a bare PATH
    // lookup that Windows can only resolve through that same shell.
    expect(isAbsolute(decision.command)).toBe(true);
    expect(decision.command).toBe(process.execPath);
    expect(decision.args).toEqual([tree.binPath, 'auth', 'arg with spaces']);
  }, 30_000);

  it('delivers user arguments to the CLI byte-for-byte from an install path containing spaces', async () => {
    const tree = await createWrapperTree();
    const preloadPath = await writeWin32Preload(tree.root);
    const userArgs = ['arg with spaces', 'quote"inside', '$(exit 3)', 'semi;colon&amp'];

    spawnSync(
      process.execPath,
      ['--require', preloadPath, tree.wrapperPath, 'dev', 'auth', ...userArgs],
      { env: { ...process.env, HOME: tree.homeDir }, encoding: 'utf8' },
    );

    expect(JSON.parse(await readFile(tree.reportPath, 'utf8'))).toEqual(['auth', ...userArgs]);
  }, 30_000);
});
