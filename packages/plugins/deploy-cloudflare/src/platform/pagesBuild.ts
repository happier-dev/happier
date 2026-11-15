import { readFile } from 'node:fs/promises';
import { CLOUDFLARE_BUILD_IMAGE, CLOUDFLARE_WRANGLER_VERSION, cloudflareContainerToolchain,
  runCloudflareBuild, stagedRealPath, type CloudflareBuildContext } from './cloudflareBuild.js';
export { CLOUDFLARE_BUILD_IMAGE, CLOUDFLARE_WRANGLER_VERSION } from './cloudflareBuild.js';
export type PagesBuildInput = Readonly<{ rootPath: string; rootDirectory?: string; actionOperationId: string; buildCommand?: string; outputDirectory?: string }>;
export type PagesBuildContext = CloudflareBuildContext;
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
${cloudflareContainerToolchain(['mime@3.0.0'])}
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
const input = ${JSON.stringify({ buildCommand: input.buildCommand, outputDirectory: input.outputDirectory })};
const mime = require('mime');
const wranglerRequire = createRequire(require.resolve('wrangler'));
const { hash } = wranglerRequire('blake3-wasm');
if (input.buildCommand?.trim()) installProjectDependencies();
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

export async function preparePagesBuild(input: PagesBuildInput, context: PagesBuildContext): Promise<PreparedPagesBuild> {
  return runCloudflareBuild(input, context, 'pages', containerProgram(input), async scratchRoot => {
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
  });
}
