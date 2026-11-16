import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, test } from 'vitest';

const owner = new URL('./hostProvidedModules.mjs', import.meta.url).href;

// 2026-11-16 19:30–20:00Z: concurrent test preparations each re-derived the same Protocol
// host-module graph (7–25 min each under load). Equal inputs are analyzed once; the
// other derivations adopt that result.
test('concurrent derivations over equal inputs analyze the import graph once', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'protocol-host-single-flight-'));
  try {
    await mkdir(join(packageRoot, 'src/plugins/ui'), { recursive: true });
    await writeFile(join(packageRoot, 'src/a.ts'), 'export const a = 1;\n');
    const script = `const { deriveHostProvidedProtocolModules } = await import(${JSON.stringify(owner)});
await deriveHostProvidedProtocolModules({ packageRoot: ${JSON.stringify(packageRoot)}, publicSources: new Set(['a']), exports: {} });`;
    const runs = Array.from({ length: 3 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      return once(child, 'close').then(([code]) => ({ code, stderr }));
    });
    const results = await Promise.all(runs);
    expect(results.map(result => result.code)).toEqual([0, 0, 0]);
    const analyses = results.flatMap(result => result.stderr.split('\n')).filter(line => line.includes('[protocol-host-modules] analyzed'));
    expect(analyses).toHaveLength(1);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
}, 120_000);
