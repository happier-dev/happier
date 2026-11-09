import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const executeFile = promisify(execFile);

it('evaluates the canonical pure command policy without importing declaration schemas', async () => {
  const coverageDirectory = await mkdtemp(join(tmpdir(), 'happier-command-policy-'));
  try {
    const child = await executeFile(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import { resolvePluginCommandProjection } from './src/cli/pluginCommandProjection.ts';
      const projection = resolvePluginCommandProjection({
        registry: { actions: [{ pluginId: 'acme.cost', definition: { id: 'read' }, admittedTarget: { declaration: {
          id: 'read', title: 'Read', surfaces: ['cli'], cli: { path: ['cost', 'read'] },
        } } }] }, reservedRoots: new Set(),
      });
      console.log(JSON.stringify(projection.roots));
    `], { env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory } });
    expect(JSON.parse(child.stdout)).toEqual(['cost']);
    const scripts = (await Promise.all((await readdir(coverageDirectory)).map(async (file) => (
      JSON.parse(await readFile(join(coverageDirectory, file), 'utf8')) as {
        result: Array<{ url: string; functions: Array<{ ranges: Array<{ count: number }> }> }>;
      }
    )))).flatMap((report) => report.result).filter((script) => script.functions.some((fn) => fn.ranges.some((range) => range.count > 0)));
    const urls = scripts.map((script) => script.url);
    expect(urls.some((url) => /cli\/pluginCommandProjection\.ts(?:\?|$)/u.test(url))).toBe(true);
    expect(urls.some((url) => /contributions\/policyEvaluation\.[jt]s(?:\?|$)/u.test(url))).toBe(true);
    expect(urls.filter((url) => /contributions\/publicTypes\.[jt]s(?:\?|$)/u.test(url))).toEqual([]);
  } finally {
    await rm(coverageDirectory, { recursive: true, force: true });
  }
}, 30_000);
