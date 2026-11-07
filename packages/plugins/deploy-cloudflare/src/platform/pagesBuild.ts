import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { isPluginError, type DeploymentTargetRoleFailureV1 } from '@happier-dev/plugin-sdk';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';

export const CLOUDFLARE_BUILD_IMAGE = 'node:24.21.0-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0';
export const CLOUDFLARE_WRANGLER_VERSION = '4.156.0';
export type PagesBuildInput = Readonly<{ rootPath: string; rootDirectory?: string; actionOperationId: string; buildCommand?: string; outputDirectory?: string }>;
export type PagesBuildContext = Readonly<{ exec: Pick<ExecService, 'spawn' | 'systemTools'>; signal: AbortSignal }>;
export type PreparedPagesBuild = Readonly<{
  outputPath: string;
  assets: readonly Readonly<{ path: string; hash: string; contentType: string }>[];
  multipartFiles: readonly Readonly<{ name: string; path: string; contentType?: string }>[];
  multipartFields?: Readonly<Record<string, string>>;
  provenance: Readonly<{ image: string; wranglerVersion: string; buildCommand?: string; outputDirectory: string }>;
}>;

// Wrangler 4.156.0 pages/build.ts implements --outfile using
// createUploadWorkerBundleContents (multipart metadata + executable modules).
// pages/validate.ts owns the asset exclusions, MIME and vendor hash contract;
// deploy-helpers/src/deploy/helpers/hash.ts uses blake3(base64(bytes) + extension).
function containerProgram(input: PagesBuildInput) {
  return `
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const input = ${JSON.stringify({ buildCommand: input.buildCommand, outputDirectory: input.outputDirectory })};
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error('Pages preparation command failed');
}
process.env.HOME = '/tmp';
process.env.npm_config_cache = '/tmp/.npm';
process.env.COREPACK_DEFAULT_TO_LATEST = '0';
const tools = '/tmp/happier-pages';
process.env.PATH = join(tools, 'node_modules', '.bin') + ':' + process.env.PATH;
run('npm', ['install', '--prefix', tools, '--no-audit', '--no-fund', 'wrangler@${CLOUDFLARE_WRANGLER_VERSION}', 'mime@3.0.0']);
const require = createRequire(tools + '/package.json');
const wrangler = require('wrangler');
const mime = require('mime');
const wranglerRequire = createRequire(require.resolve('wrangler'));
const { hash } = wranglerRequire('blake3-wasm');
const cli = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
if (existsSync('package.json') && input.buildCommand?.trim()) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const manager = pkg.packageManager;
  const name = typeof manager === 'string' ? manager.split('@')[0]
    : existsSync('pnpm-lock.yaml') ? 'pnpm' : existsSync('yarn.lock') ? 'yarn' : 'npm';
  if (name !== 'npm' || manager !== undefined) {
    run('corepack', ['enable', '--install-directory', join(tools, 'node_modules', '.bin'), name]);
  }
  run(name, name === 'npm' ? [existsSync('package-lock.json') || existsSync('npm-shrinkwrap.json') ? 'ci' : 'install', '--no-audit', '--no-fund'] : ['install']);
}
if (input.buildCommand?.trim()) run('/bin/sh', ['-c', input.buildCommand]);
const config = wrangler.unstable_readConfig({}, { useRedirectIfAvailable: true });
const output = resolve(config.pages_build_output_dir ?? input.outputDirectory ?? '.');
const project = await realpath('/workspace/project');
const application = process.cwd();
const outputRelative = relative(project, output);
if (outputRelative.startsWith('..') || outputRelative.startsWith('/')) throw new Error('Pages output must remain in the staged project');
const multipartFiles = [];
const functions = existsSync('functions') || existsSync(join(output, '_worker.js'));
if (functions) {
  const args = [cli, 'pages', 'functions', 'build', 'functions', '--outfile', '/workspace/_worker.bundle',
    '--project-directory', application, '--build-metadata-path', '/workspace/build-metadata.json',
    '--build-output-directory', output, '--output-config-path', '/workspace/functions-filepath-routing-config.json'];
  if (!existsSync(join(output, '_routes.json'))) args.push('--output-routes-path', '/workspace/_routes.json');
  run(process.execPath, args);
  const bundle = await readFile('/workspace/_worker.bundle', 'utf8');
  const boundary = bundle.slice(2, bundle.indexOf('\\r\\n'));
  multipartFiles.push({ name: '_worker.bundle', path: '_worker.bundle', contentType: 'multipart/form-data; boundary=' + boundary });
}
for (const name of ['_headers', '_redirects', '_routes.json']) {
  if (existsSync(join(output, name))) multipartFiles.push({ name, path: relative('/workspace', join(output, name)) });
  else if (existsSync(join('/workspace', name))) multipartFiles.push({ name, path: name });
}
if (existsSync('/workspace/functions-filepath-routing-config.json')) multipartFiles.push({ name: 'functions-filepath-routing-config.json', path: 'functions-filepath-routing-config.json' });
const assets = [];
const multipartFields = {};
if (existsSync('/workspace/build-metadata.json')) {
  const build = JSON.parse(await readFile('/workspace/build-metadata.json', 'utf8'));
  if (typeof build.wrangler_config_hash === 'string') multipartFields.wrangler_config_hash = build.wrangler_config_hash;
  if (typeof build.build_output_directory === 'string') multipartFields.pages_build_output_dir = build.build_output_directory;
}
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.wrangler', 'node_modules', '.DS_Store'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    const name = relative(output, path).split('\\\\').join('/');
    if (directory === output && ['_worker.js', '_headers', '_redirects', '_routes.json', 'functions'].includes(entry.name)) continue;
    const info = await stat(path);
    if (info.isDirectory()) await walk(path);
    else if (info.isFile()) {
      const contents = await readFile(path);
      assets.push({ path: name, hash: hash(contents.toString('base64') + extname(path).slice(1)).toString('hex').slice(0, 32),
        contentType: mime.getType(name) ?? 'application/octet-stream' });
    }
  }
}
await walk(output);
await writeFile('/workspace/metadata.json', JSON.stringify({ outputDirectory: outputRelative || '.', assets, multipartFiles, multipartFields }));
`;
}

function stagedPath(root: string, path: string) {
  const full = resolve(root, path);
  if (isAbsolute(path) || full !== root && !full.startsWith(root + sep)) throw new Error('Invalid Pages build output path');
  return full;
}

async function stagedRealPath(root: string, path: string) {
  const full = await realpath(stagedPath(root, path));
  if (full !== root && !full.startsWith(root + sep)) throw new Error('Pages build output escapes its staged root');
  return full;
}

/** The source owner releases this staged child with its operation scratch.
 * Only that sanitized child is mounted; provider credentials never enter Exec.
 * Existing Exec disposal owns cancellation, with Docker --rm as ordinary reaping.
 */
export async function preparePagesBuild(input: PagesBuildInput, context: PagesBuildContext): Promise<PreparedPagesBuild | DeploymentTargetRoleFailureV1> {
  context.signal.throwIfAborted();
  try {
    const tool = await context.exec.systemTools.resolve({ toolId: 'docker', purpose: 'Prepare the reviewed Cloudflare Pages build',
      cwd: input.rootPath, signal: context.signal });
    const scratch = await mkdtemp(join(input.rootPath, '.happier-pages-'));
    const project = join(scratch, 'project');
    await mkdir(project);
    const names = await readdir(input.rootPath);
    const allowed = async (path: string) => {
      const name = basename(path);
      return !['.git', '.wrangler', 'node_modules', '.npmrc', '.yarnrc', '.yarnrc.yml', '.env'].includes(name)
        && !name.startsWith('.env.') && name !== '.dev.vars' && !name.startsWith('.dev.vars.') && !name.startsWith('.happier-pages-');
    };
    for (const name of names) {
      const source = join(input.rootPath, name);
      if (await allowed(source)) await cp(source, join(project, name), { recursive: true, filter: allowed, verbatimSymlinks: true });
    }
    context.signal.throwIfAborted();
    const owner = await stat(scratch);
    const process = await context.exec.spawn({ executable: tool.executable, cwd: input.rootPath,
      args: ['run', '--rm', '--name', `happier-pages-${createHash('sha256').update(input.actionOperationId).digest('hex')}`,
        '--user', `${owner.uid}:${owner.gid}`, '--interactive', '--mount',
        `type=bind,source=${scratch},target=/workspace`, '--workdir', posix.join('/workspace/project', input.rootDirectory ?? '.'), CLOUDFLARE_BUILD_IMAGE,
        'node', '--input-type=module'], stdin: new TextEncoder().encode(containerProgram(input)) }, { signal: context.signal });
    try {
      const result = await process.wait();
      context.signal.throwIfAborted();
      if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0
        || result.termination.requestedBy.kind !== 'none') throw new Error('Pages container did not finish successfully');
      const scratchRoot = await realpath(scratch);
      const metadata: unknown = JSON.parse(await readFile(await stagedRealPath(scratchRoot, 'metadata.json'), 'utf8'));
      if (typeof metadata !== 'object' || metadata === null || !('outputDirectory' in metadata) || typeof metadata.outputDirectory !== 'string'
        || !('assets' in metadata) || !Array.isArray(metadata.assets) || !('multipartFiles' in metadata) || !Array.isArray(metadata.multipartFiles)) {
        throw new Error('Pages build metadata is unavailable');
      }
      const assets: PreparedPagesBuild['assets'][number][] = [];
      const projectRoot = await stagedRealPath(scratchRoot, 'project');
      const outputPath = await stagedRealPath(projectRoot, metadata.outputDirectory);
      for (const asset of metadata.assets as unknown[]) {
        if (typeof asset !== 'object' || asset === null || !('path' in asset) || typeof asset.path !== 'string'
          || !('hash' in asset) || typeof asset.hash !== 'string' || !('contentType' in asset) || typeof asset.contentType !== 'string') throw new Error('Invalid Pages asset');
        await stagedRealPath(outputPath, asset.path);
        assets.push({ path: asset.path, hash: asset.hash, contentType: asset.contentType });
      }
      const multipartFiles: PreparedPagesBuild['multipartFiles'][number][] = [];
      for (const file of metadata.multipartFiles as unknown[]) {
        if (typeof file !== 'object' || file === null || !('name' in file) || typeof file.name !== 'string'
          || !('path' in file) || typeof file.path !== 'string') throw new Error('Invalid Pages multipart file');
        const contentType = 'contentType' in file ? file.contentType : undefined;
        if (contentType !== undefined && typeof contentType !== 'string') throw new Error('Invalid Pages multipart content type');
        multipartFiles.push({ name: file.name, path: await stagedRealPath(scratchRoot, file.path),
          ...(contentType === undefined ? {} : { contentType }) });
      }
      const multipartFields: Record<string, string> = {};
      if ('multipartFields' in metadata && typeof metadata.multipartFields === 'object' && metadata.multipartFields !== null) {
        for (const [name, value] of Object.entries(metadata.multipartFields)) {
          if (typeof value !== 'string') throw new Error('Invalid Pages multipart field');
          multipartFields[name] = value;
        }
      }
      return { outputPath, assets, multipartFiles, multipartFields, provenance: { image: CLOUDFLARE_BUILD_IMAGE,
        wranglerVersion: CLOUDFLARE_WRANGLER_VERSION, ...(input.buildCommand ? { buildCommand: input.buildCommand } : {}), outputDirectory: metadata.outputDirectory } };
    } finally {
      await process.dispose();
    }
  } catch (error) {
    context.signal.throwIfAborted();
    if (isPluginError(error)) throw error;
    return { v: 1, code: 'deployment_content_unavailable', phase: 'build', retryable: false };
  }
}
