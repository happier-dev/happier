import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildNodeSingleExecutableMain,
  ensurePinnedNodeBinary,
  readPinnedNodeVersion,
  resolveNodeReleaseAsset,
} from './nodeSingleExecutable.js';
import { CLI_BINARY_TARGETS } from './targets.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('Node single executable', () => {
  let embeddedMain: string;
  beforeAll(async () => { embeddedMain = await buildNodeSingleExecutableMain(); });
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-node-sea-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('pins a verified official Node asset for every CLI target at the repository Node version', () => {
    const version = readPinnedNodeVersion(repoRoot);
    for (const target of CLI_BINARY_TARGETS) {
      const asset = resolveNodeReleaseAsset({ version, target });
      expect(asset.path.startsWith(`v${version}/`)).toBe(true);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it('refuses a downloaded Node asset whose digest differs from the pin', async () => {
    const root = tempDir();
    writeFileSync(join(root, '.node-version'), `${readPinnedNodeVersion(repoRoot)}\n`);
    const target = CLI_BINARY_TARGETS.find((candidate) => candidate.os === 'windows')!;
    await expect(ensurePinnedNodeBinary({
      repoRoot: root,
      target,
      cacheRoot: join(root, 'cache'),
      fetchImpl: async () => new Response(Buffer.from('not node')),
    })).rejects.toThrow(/SHA-256/u);
  });

  it('runs an absolute Happier script with Node semantics, past the executable\'s own flags', () => {
    const dir = tempDir();
    const main = join(dir, 'main.cjs');
    const script = join(dir, 'forwarder.cjs');
    writeFileSync(main, embeddedMain);
    writeFileSync(script, 'process.stdout.write(JSON.stringify({ main: require.main === module, argv: process.argv.slice(1) }));\n');
    // The single executable's argv[1] is the typed executable path; `node main.cjs` has the same shape.
    for (const prefix of [[], ['--no-warnings', '--no-deprecation']]) {
      const output = execFileSync(process.execPath, [main, ...prefix, script, '4123', 'Stop'], { encoding: 'utf8' });
      expect(JSON.parse(output)).toEqual({ main: true, argv: [script, '4123', 'Stop'] });
    }
  });

  it('loads the original CLI graph when the installer runs a copied executable', () => {
    const dir = tempDir();
    const main = join(dir, 'copied-runtime.cjs');
    const packageRoot = join(dir, 'payload');
    const entry = join(packageRoot, 'package-dist', 'index.mjs');
    mkdirSync(join(packageRoot, 'package-dist'), { recursive: true });
    writeFileSync(main, embeddedMain);
    writeFileSync(entry, 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), inheritedRoot: process.env.HAPPIER_CLI_PACKAGE_ROOT ?? null }));\n');
    const output = execFileSync(process.execPath, [main, 'self', '__install-payload'], {
      encoding: 'utf8', env: { ...process.env, HAPPIER_CLI_PACKAGE_ROOT: packageRoot },
    });
    expect(JSON.parse(output)).toEqual({ argv: [entry, 'self', '__install-payload'], inheritedRoot: null });
  });

  it.each(['happier.exe', 'hdev.exe'])('loads the active installed payload through the %s hard-link shim', (name) => {
    const dir = tempDir();
    const shim = join(dir, 'bin', name);
    const main = join(dir, 'main.cjs');
    const installRoot = join(dir, 'cli-dev');
    const entry = join(installRoot, 'versions', 'test-version', 'package-dist', 'index.mjs');
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(installRoot, 'versions', 'test-version', 'package-dist'), { recursive: true });
    writeFileSync(join(dir, 'default-cli-release-channel.json'), JSON.stringify({ releaseChannel: 'publicdev' }));
    writeFileSync(join(installRoot, 'current.version'), 'test-version\n');
    writeFileSync(entry, 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1) }));\n');
    // Genuine process boundary: Node SEA reports the launched hard-link path as execPath.
    writeFileSync(main, `Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(shim)} });\n${embeddedMain}`);
    const output = execFileSync(process.execPath, [main, '--version'], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual({ argv: [entry, '--version'] });
  });
});
