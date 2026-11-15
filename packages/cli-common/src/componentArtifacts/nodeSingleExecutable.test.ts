import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  NODE_SINGLE_EXECUTABLE_MAIN,
  ensurePinnedNodeBinary,
  readPinnedNodeVersion,
  resolveNodeReleaseAsset,
} from './nodeSingleExecutable.js';
import { CLI_BINARY_TARGETS } from './targets.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('Node single executable', () => {
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
    writeFileSync(main, NODE_SINGLE_EXECUTABLE_MAIN);
    writeFileSync(script, 'process.stdout.write(JSON.stringify({ main: require.main === module, argv: process.argv.slice(1) }));\n');
    // The single executable's argv[1] is the typed executable path; `node main.cjs` has the same shape.
    for (const prefix of [[], ['--no-warnings', '--no-deprecation']]) {
      const output = execFileSync(process.execPath, [main, ...prefix, script, '4123', 'Stop'], { encoding: 'utf8' });
      expect(JSON.parse(output)).toEqual({ main: true, argv: [script, '4123', 'Stop'] });
    }
  });
});
