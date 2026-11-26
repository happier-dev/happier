import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.each(['mutable checkout', 'immutable revision'])('reuses %s daemon TypeScript transforms without retaining payloads after GC', async (tree) => {
  const fixture = await mkdtemp(join(tmpdir(), 'happier-revision-transform-retention-'));
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const common = join(fixture, 'packages/cli-common');
  const cli = join(fixture, 'apps/cli/src');
  try {
    await mkdir(common, { recursive: true });
    await mkdir(join(cli, 'cli'), { recursive: true });
    for (const file of ['registerSourceRuntime.mjs', 'sourceRuntimeEntries.mjs', 'sourceRuntimeDependencies.mjs',
      'packageExportMatch.cjs', 'cliRuntimeSidecars.mjs']) {
      await cp(join(repo, 'packages/cli-common', file), join(common, file));
    }
    await cp(join(repo, 'apps/cli/src/cli/readStartedByArg.mjs'), join(cli, 'cli/readStartedByArg.mjs'));
    await symlink(join(repo, 'node_modules'), join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
    if (tree === 'immutable revision') {
      await writeFile(join(fixture, '.happier-revision-tree-ref.json'), JSON.stringify({ revision: 'a'.repeat(40) }));
    }
    await writeFile(join(cli, 'value.mts'), 'export enum Value { answer = 42 }');
    await writeFile(join(cli, 'value.cts'), 'export enum Value { answer = 43 }');

    const observer = join(fixture, 'observe-cache.mjs');
    const entry = join(cli, 'index.mjs');
    // Observe deserialization at the filesystem boundary. A weak reference
    // distinguishes the transform payload from its code retained by Node.
    await writeFile(observer, `
import fs from 'node:fs';
import { basename, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate } from 'node:timers/promises';
const diskPayloads = new Set();
const transforms = [];
const readFileSync = fs.readFileSync;
const parse = JSON.parse;
fs.readFileSync = function(file, ...args) {
  const data = readFileSync.call(this, file, ...args);
  if (typeof data === 'string' && basename(dirname(String(file))).startsWith('tsx-')) diskPayloads.add(data);
  return data;
};
JSON.parse = function(input, ...args) {
  const value = parse.call(this, input, ...args);
  if (diskPayloads.delete(input) && typeof value?.code === 'string') transforms.push(new WeakRef(value));
  return value;
};
syncBuiltinESMExports();
export async function transformRetention() {
  await setImmediate();
  global.gc();
  return { read: transforms.length, retained: transforms.filter(ref => ref.deref()).length };
}
`);
    await writeFile(entry, `
import { createRequire } from 'node:module';
import { transformRetention } from ${JSON.stringify(pathToFileURL(observer).href)};
await import(${JSON.stringify(pathToFileURL(join(common, 'registerSourceRuntime.mjs')).href)});
const esm = (await import('./value.mts')).Value.answer;
const cjs = createRequire(import.meta.url)('./value.cts').Value.answer;
console.log(JSON.stringify({ esm, cjs, ...await transformRetention() }));
`);
    const start = async () => {
      const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', entry, 'daemon', 'start-sync'], {
        env: { ...process.env, NODE_OPTIONS: '', TSX_DISABLE_CACHE: '1' },
      });
      return JSON.parse(stdout);
    };
    expect(await start()).toMatchObject({ esm: 42, cjs: 43, read: 0 });
    expect(await start()).toEqual({ esm: 42, cjs: 43, read: 2, retained: 0 });
    await writeFile(join(cli, 'value.mts'), 'export enum Value { answer = 44 }');
    expect(await start()).toEqual({ esm: 44, cjs: 43, read: 1, retained: 0 });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
