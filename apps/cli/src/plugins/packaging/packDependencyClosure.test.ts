import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestNpmTarball, sriSha512 } from '../distribution/testkit/npmTarball';
import * as tar from 'tar';
import { packLocalPlugin } from './pack';

const execFileAsync = promisify(execFile);

// Registry distribution is the boundary: dependency installation, source
// evaluation, bundling and archive admission all run through production owners.
async function createRegistry() {
  const packages = [
    { name: '@happier-dev/plugin-sdk', bin: { 'happier-plugin-build-ui': './build-ui.js' }, dependencies: { '@noble/hashes': '0.0.0' },
      exports: { '.': './index.js' }, files: {
        'build-ui.js': '// This fixture declares no UI artifacts.\n',
        'index.js': "import { sha256 } from '@noble/hashes/sha2'; import { bytesToHex } from '@noble/hashes/utils'; export const marker = bytesToHex(sha256());",
      } },
    { name: '@happier-dev/triage-protocol', dependencies: { '@happier-dev/channels-protocol': '0.0.0' },
      exports: { './ci/v1': './index.js' }, files: {
        'index.js': "export { marker } from '@happier-dev/channels-protocol/v1';",
      } },
    { name: '@happier-dev/channels-protocol', dependencies: {},
      exports: { './v1': './index.js' }, files: { 'index.js': "export const marker = 'channels-transitive';" } },
    { name: '@noble/hashes', dependencies: {},
      exports: { './sha2': './sha2.js', './utils': './utils.js' }, files: {
        'sha2.js': "export const sha256 = () => 'sha2-transitive';",
        'utils.js': "export const bytesToHex = value => 'utils:' + value;",
      } },
  ];
  const tarballs = new Map<string, Buffer>();
  for (const pkg of packages) {
    tarballs.set(pkg.name, await createTestNpmTarball([
      { name: 'package/package.json', body: JSON.stringify({
        name: pkg.name, version: '0.0.0', type: 'module', exports: pkg.exports, dependencies: pkg.dependencies, bin: pkg.bin,
      }) },
      ...Object.entries(pkg.files).map(([name, body]) => ({ name: `package/${name}`, body })),
    ]));
  }
  let origin = '';
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url ?? '');
    const isTarball = path.startsWith('/tarballs/');
    const name = path.slice(isTarball ? '/tarballs/'.length : 1);
    const bytes = tarballs.get(name);
    if (!bytes) { response.writeHead(404).end(); return; }
    if (isTarball) { response.end(bytes); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ name, 'dist-tags': { latest: '0.0.0' }, versions: {
      '0.0.0': { ...packages.find(pkg => pkg.name === name), version: '0.0.0',
        dist: { tarball: `${origin}/tarballs/${encodeURIComponent(name)}`, integrity: sriSha512(bytes) } },
    } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function writeAuthorPackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'happier-plugin-pack-closure-fixture', version: '1.0.0', type: 'module',
    keywords: ['happier-plugin'], happier: { manifest: '.happier-plugin/plugin.json' },
    files: ['index.ts'], dependencies: { '@happier-dev/plugin-sdk': '0.0.0', '@happier-dev/triage-protocol': '0.0.0' },
  }));
  await writeFile(join(root, 'index.ts'), [
    'export const manifest = {',
    "  schemaVersion: 2, id: 'acme.pack-closure', version: '1.0.0', displayName: 'Pack closure',",
    "  engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },",
    "  entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] }, contributes: {},",
    '};',
    'export function activate() {}',
    "import { marker as sdkMarker } from '@happier-dev/plugin-sdk';",
    "import { marker as triageMarker } from '@happier-dev/triage-protocol/ci/v1';",
    'export function dependencyProbe() { return { sdkMarker, triageMarker }; }',
  ].join('\n'));
}

describe('plugin pack dependency closure', () => {
  it('packs SDK and triage-protocol transitive dependencies into an executable archive', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-transitive-pack-'));
    const root = join(parent, 'plugin');
    const archivePath = join(parent, 'closure.tgz');
    const registry = await createRegistry();
    try {
      await writeAuthorPackage(root);
      await writeFile(join(root, '.npmrc'), `registry=${registry.origin}\n`);
      const result = await packLocalPlugin({ locator: root, outPath: archivePath, sdkRegistryOrigin: registry.origin });
      expect(result, result.ok ? '' : JSON.stringify(result.diagnostics)).toMatchObject({ ok: true });
      if (!result.ok) return;
      const extractedRoot = join(parent, 'extracted');
      await mkdir(extractedRoot);
      await tar.x({ file: archivePath, cwd: extractedRoot });
      const runtimePath = join(extractedRoot, 'package', result.manifest.entrypoints!.daemon!);
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e',
        `const runtime = await import(${JSON.stringify(pathToFileURL(runtimePath).href)}); console.log(JSON.stringify(runtime.dependencyProbe()));`,
      ], { env: { ...process.env, NODE_OPTIONS: '' } });
      expect(JSON.parse(stdout)).toEqual({
        sdkMarker: 'utils:sha2-transitive',
        triageMarker: 'channels-transitive',
      });
    } finally {
      await registry.close();
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);

});
