import { mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExecService, PluginExecSpawnRequest, PluginProcessHandle, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { CLOUDFLARE_BUILD_IMAGE, preparePagesBuild } from './pagesBuild.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function source() {
  const rootPath = await mkdtemp(join(tmpdir(), 'pages-build-test-'));
  roots.push(rootPath);
  await writeFile(join(rootPath, 'package.json'), JSON.stringify({ scripts: { build: 'framework build' } }));
  await writeFile(join(rootPath, 'wrangler.jsonc'), '{"pages_build_output_dir":"./public","compatibility_date":"2026-11-01"}');
  await mkdir(join(rootPath, 'functions'));
  await writeFile(join(rootPath, 'functions', 'hello.ts'), 'export const onRequest = () => new Response("hello");');
  await symlink('functions/hello.ts', join(rootPath, 'function-alias.ts'));
  await writeFile(join(rootPath, '.env.production'), 'PRIVATE=not-for-build');
  await writeFile(join(rootPath, '.npmrc'), '//registry.npmjs.org/:_authToken=not-for-build');
  return rootPath;
}
function processResult(exitCode: number): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
    stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
// Exec and Docker are the genuine process boundary; filesystem staging and result parsing stay real.
function boundary(options: { exitCode?: number; corruptMetadata?: boolean; cancel?: AbortController; escapeAsset?: boolean; escapeMultipart?: boolean; escapeMetadata?: boolean; internalAsset?: boolean } = {}) {
  let staged = '';
  const dispose = vi.fn(async () => {});
  const spawn = vi.fn(async (request: PluginExecSpawnRequest, _options?: { signal?: AbortSignal }): Promise<PluginProcessHandle> => {
    const mount = request.args?.find(arg => arg.startsWith('type=bind,'));
    staged = mount?.slice('type=bind,source='.length).split(',target=')[0] ?? '';
    const workdir = request.args?.[(request.args?.indexOf('--workdir') ?? -1) + 1] ?? '/workspace/project';
    const projectDirectory = join(staged, workdir.slice('/workspace/'.length));
    const outputDirectory = relative(join(staged, 'project'), join(projectDirectory, 'public')).split(sep).join('/');
    const outputPath = join(projectDirectory, 'public');
    const wait = vi.fn(async () => {
      if (options.cancel) { options.cancel.abort(); throw options.cancel.signal.reason; }
      if ((options.exitCode ?? 0) === 0) {
        await mkdir(outputPath, { recursive: true });
        await writeFile(join(outputPath, 'index.html'), '<h1>compiled</h1>');
        await writeFile(join(staged, '_worker.bundle'), '--vendor-multipart\r\nContent-Disposition: form-data; name="metadata"\r\n');
        if (options.internalAsset) {
          await writeFile(join(outputPath, 'actual.html'), '<h1>compiled</h1>');
          await rm(join(outputPath, 'index.html'));
          await symlink('actual.html', join(outputPath, 'index.html'));
        }
        if (options.escapeAsset) {
          await rm(join(outputPath, 'index.html'));
          await symlink(join(String(request.cwd), '.env.production'), join(outputPath, 'index.html'));
        }
        if (options.escapeMultipart) {
          await rm(join(staged, '_worker.bundle'));
          await symlink(join(String(request.cwd), '.env.production'), join(staged, '_worker.bundle'));
        }
        const metadata = options.corruptMetadata ? '{}' : JSON.stringify({ outputDirectory,
          assets: [{ path: 'index.html', hash: 'pinned-vendor-hash', contentType: 'text/html' }],
          multipartFiles: [{ name: '_worker.bundle', path: '_worker.bundle', contentType: 'multipart/form-data; boundary=vendor-multipart' }],
          multipartFields: { wrangler_config_hash: 'config-hash', pages_build_output_dir: 'public' } });
        if (options.escapeMetadata) {
          const external = join(String(request.cwd), '.env.build-result');
          await writeFile(external, metadata);
          await symlink(external, join(staged, 'metadata.json'));
        } else await writeFile(join(staged, 'metadata.json'), metadata);
      }
      return processResult(options.exitCode ?? 0);
    });
    return { async waitForExit() { return (await this.wait()).termination; },
    wait, dispose, write: async () => {}, closeStdin: async () => {}, onOutput: () => ({ dispose() {} }) };
  });
  const resolve: ExecService['systemTools']['resolve'] = vi.fn(async () => ({
    executable: { kind: 'systemTool', id: 'docker' }, executablePath: '/native/docker',
  }));
  return { exec: { spawn, systemTools: { resolve } }, spawn, dispose, staged: () => staged };
}

it('stages exact source without credential files and returns only container-prepared Pages assets and multipart Functions', async () => {
  const rootPath = await source();
  const h = boundary();
  const signal = new AbortController().signal;
  const prepared = await preparePagesBuild({ rootPath, actionOperationId: 'pages:operation/one', buildCommand: 'npm run build' }, { exec: h.exec, signal });
  expect(prepared).toMatchObject({ outputPath: join(h.staged(), 'project', 'public'),
    assets: [{ path: 'index.html', hash: 'pinned-vendor-hash', contentType: 'text/html' }],
    multipartFiles: [{ name: '_worker.bundle', path: join(h.staged(), '_worker.bundle'), contentType: 'multipart/form-data; boundary=vendor-multipart' }],
    multipartFields: { wrangler_config_hash: 'config-hash', pages_build_output_dir: 'public' },
    provenance: { image: CLOUDFLARE_BUILD_IMAGE, wranglerVersion: '4.156.0', buildCommand: 'npm run build', outputDirectory: 'public' } });
  const stagedNames = await readdir(join(h.staged(), 'project'));
  expect(stagedNames).toContain('wrangler.jsonc');
  expect(stagedNames).toContain('functions');
  expect(await readlink(join(h.staged(), 'project', 'function-alias.ts'))).toBe('functions/hello.ts');
  expect(stagedNames).not.toContain('.env.production');
  expect(stagedNames).not.toContain('.npmrc');
  expect(await readFile(join(rootPath, '.env.production'), 'utf8')).toBe('PRIVATE=not-for-build');
  expect(h.spawn).toHaveBeenCalledOnce();
  const request = h.spawn.mock.calls[0][0];
  expect(request.args).toContain(CLOUDFLARE_BUILD_IMAGE);
  expect(request.args).toContain('--rm');
  expect(request.args).toContain('--name');
  expect(request.env).toBeUndefined();
  expect(request.deploymentEnv).toBeUndefined();
  expect(h.spawn.mock.calls[0][1]).toEqual({ signal, outputDelivery: 'invocation' });
  expect(h.dispose).toHaveBeenCalledOnce();
});

it('stages sibling monorepo source while building in the configured application directory', async () => {
  const rootPath = await source();
  await mkdir(join(rootPath, 'apps', 'web'), { recursive: true });
  await mkdir(join(rootPath, 'packages'));
  await writeFile(join(rootPath, 'packages', 'shared.txt'), 'sibling source');
  await writeFile(join(rootPath, 'apps', 'web', 'package.json'), '{"scripts":{"build":"read ../../packages/shared.txt"}}');
  const h = boundary();
  const prepared = await preparePagesBuild({ rootPath, rootDirectory: 'apps/web', actionOperationId: 'pages-monorepo', buildCommand: 'npm run build' },
    { exec: h.exec, signal: new AbortController().signal });
  const args = h.spawn.mock.calls[0][0].args ?? [];
  expect(args[args.indexOf('--workdir') + 1]).toBe('/workspace/project/apps/web');
  expect(await readFile(join(h.staged(), 'project', 'packages', 'shared.txt'), 'utf8')).toBe('sibling source');
  expect(prepared).toMatchObject({ outputPath: join(h.staged(), 'project', 'apps', 'web', 'public'),
    assets: [{ path: 'index.html', contentType: 'text/html' }], provenance: { outputDirectory: 'apps/web/public' } });
});

it('does not return uploadable output after a failed container or malformed result', async () => {
  for (const options of [{ exitCode: 1 }, { corruptMetadata: true }]) {
    const h = boundary(options);
    await expect(preparePagesBuild({ rootPath: await source(), actionOperationId: 'pages-failed' }, { exec: h.exec, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'deployment_failed', retryable: false,
        data: { details: { phase: 'build' }, failureCause: { phase: 'deployment.cloudflare.build', errorClass: 'Error' } } });
    expect(h.dispose).toHaveBeenCalledOnce();
  }
});

it('disposes the existing Exec handle and preserves cancellation before output is eligible for upload', async () => {
  const controller = new AbortController();
  const h = boundary({ cancel: controller });
  await expect(preparePagesBuild({ rootPath: await source(), actionOperationId: 'pages-cancelled' }, { exec: h.exec, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(h.dispose).toHaveBeenCalledOnce();
});

it('refuses container-produced paths that would read host bytes outside the staged output', async () => {
  const valid = boundary({ internalAsset: true });
  expect(await preparePagesBuild({ rootPath: await source(), actionOperationId: 'pages-internal' }, { exec: valid.exec, signal: new AbortController().signal }))
    .toHaveProperty('assets');
  for (const options of [{ escapeAsset: true }, { escapeMultipart: true }, { escapeMetadata: true }]) {
    const h = boundary(options);
    await expect(preparePagesBuild({ rootPath: await source(), actionOperationId: 'pages-escape' }, { exec: h.exec, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'deployment_failed', data: { details: { phase: 'build' } } });
    expect(h.dispose).toHaveBeenCalledOnce();
  }
});

it('uses the existing operation identity for a deterministic Docker-safe recovery name', async () => {
  const names = [];
  for (const actionOperationId of ['pages:operation/one', 'pages:operation/one', 'pages:operation/two']) {
    const h = boundary();
    await preparePagesBuild({ rootPath: await source(), actionOperationId }, { exec: h.exec, signal: new AbortController().signal });
    const args = h.spawn.mock.calls[0][0].args ?? [];
    names.push(args[args.indexOf('--name') + 1]);
  }
  expect(names[0]).toMatch(/^happier-pages-[a-z0-9]+$/);
  expect(names[0]).toBe(names[1]);
  expect(names[0]).not.toBe(names[2]);
});

it('runs as the staged directory owner so failed or cancelled builds remain removable by the source owner', async () => {
  const h = boundary();
  await preparePagesBuild({ rootPath: await source(), actionOperationId: 'pages-owner' }, { exec: h.exec, signal: new AbortController().signal });
  const owner = await stat(h.staged());
  const args = h.spawn.mock.calls[0][0].args ?? [];
  expect(args[args.indexOf('--user') + 1]).toBe(`${owner.uid}:${owner.gid}`);
});
