// Development-only measurement; Expo writes only to an external temporary directory.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createExternalScratch } from './schemaLibraryScratch.mjs';

const repo = process.cwd();
const ui = resolve(repo, 'apps/ui');
const req = createRequire(resolve(ui, 'package.json'));
const scratch = createExternalScratch(repo, 'happier-schema-ui-bundle-');
const output = resolve(scratch, 'web');
const args = [req.resolve('expo/bin/cli'), 'export', '--platform', 'web', '--output-dir', output, '--max-workers', '1'];
console.log(JSON.stringify({ event: 'ui-bundle-basis', host: hostname(), node: process.version, output, args }));
const exported = spawnSync(process.execPath, args, {
  cwd: ui, stdio: 'inherit', env: { ...process.env, CI: '1', EXPO_UNSTABLE_WEB_MODAL: '1' },
});
console.log(JSON.stringify({ event: 'ui-export-result', status: exported.status, signal: exported.signal, error: exported.error?.message }));
if (exported.status !== 0) {
  process.exitCode = exported.status ?? 1;
} else {
  const bundles = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:js|mjs)$/.test(entry.name)) {
        const bytes = readFileSync(path);
        bundles.push({ path: relative(output, path), bytes: bytes.length, gzipBytes: gzipSync(bytes).length });
      }
    }
  };
  visit(output);
  console.log(JSON.stringify({ event: 'ui-bundle-measurement', files: bundles.length,
    bytes: bundles.reduce((sum, file) => sum + file.bytes, 0),
    gzipBytes: bundles.reduce((sum, file) => sum + file.gzipBytes, 0),
    largest: bundles.sort((a, b) => b.bytes - a.bytes).slice(0, 3),
  }));
}
