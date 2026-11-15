import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cloudflareContainerToolchain, runCloudflareBuild, stagedRealPath,
  type CloudflareBuildInput, type CloudflareBuildContext } from './cloudflareBuild.js';
import { isObject } from '../connectedAccounts/probe.js';

type WorkerBuildInput = CloudflareBuildInput & Readonly<{ scriptName: string; preview?: boolean }>;
export type WorkerAsset = Readonly<{ path: string; url: string; hash: string; size: number; contentType: string }>;
type PreparedWorkerBuild = Readonly<{ body: Uint8Array; contentType: string; form: FormData;
  metadata: Readonly<Record<string, unknown>>; assets?: Readonly<{ files: readonly WorkerAsset[]; config: Readonly<Record<string, unknown>> }>;
  preview?: Readonly<Record<string, unknown>>; outputManifestFingerprint: string }>;

/** Wrangler 4.156.0 deploy --dry-run --outfile serializes createWorkerUploadForm:
 * real compiled modules + metadata, including configured compatibility/bindings.
 * --keep-vars preserves the provider variables owned by the env-sync Actions.
 * The credential-free container never invokes a provider mutation.
 */
export async function prepareWorkerBuild(input: WorkerBuildInput, context: CloudflareBuildContext): Promise<PreparedWorkerBuild> {
  return runCloudflareBuild(input, context, 'workers', `
${cloudflareContainerToolchain(['mime@3.0.0'])}
import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
// Consume the exact helper versions shipped with the one pinned Wrangler.
const dependencies = require('wrangler/package.json').devDependencies;
run('npm', ['install', '--prefix', tools, '--no-audit', '--no-fund',
  ...['@cloudflare/deploy-helpers', '@cloudflare/workers-utils'].map(name => name + '@' + dependencies[name])]);
const helpers = await import(join(tools, 'node_modules/@cloudflare/deploy-helpers/dist/index.mjs'));
// deploy-helpers reads its logger from the consumer-initialized context (buildAssetManifest logs
// through it); this credential-free build needs no helper logging or API fetchers.
const { initDeployHelpersContext } = await import(join(tools, 'node_modules/@cloudflare/deploy-helpers/dist/context.mjs'));
const quiet = () => {};
initDeployHelpersContext({ logger: { loggerLevel: 'none', debug: quiet, info: quiet, log: quiet, warn: quiet, error: quiet,
  once: { debug: quiet, info: quiet, log: quiet, warn: quiet, error: quiet } } });
const workerUtils = await import(join(tools, 'node_modules/@cloudflare/workers-utils/dist/index.mjs'));
const mime = require('mime');
installProjectDependencies();
const config = wrangler.unstable_readConfig({}, { useRedirectIfAvailable: true });
if (config.site) throw new Error('Legacy Workers Sites are not Static Assets');
const preview = ${input.preview === true};
let buildConfigPath;
if (preview) {
  if (!config.previews) throw new Error('Native Preview requires explicit Preview configuration');
  // Match Wrangler Preview's compilation scope. Production defines and owned
  // bindings must never leak into a native Preview build.
  const { rawConfig } = workerUtils.experimental_readRawConfig({ config: config.configPath });
  buildConfigPath = join(dirname(config.configPath), '.happier-preview-build.json');
  writeFileSync(buildConfigPath, JSON.stringify({ ...rawConfig, define: config.previews.define ?? {},
    durable_objects: config.previews.durable_objects ?? { bindings: [] }, workflows: config.previews.workflows ?? [] }));
}
run(process.execPath, [cli, 'deploy', '--dry-run', '--name', ${JSON.stringify(input.scriptName)}, '--keep-vars',
  '--outfile', '/workspace/worker.bundle', ...(buildConfigPath ? ['--config', buildConfigPath] : [])]);
const prepared = {};
if (config.assets?.directory) {
  const options = helpers.resolveAssetOptions({ assetsDir: { directory: resolve(dirname(config.configPath ?? 'wrangler.toml'), config.assets.directory),
    binding: config.assets.binding, directoryExists: true }, main: config.main }, config);
  const manifest = await helpers.buildAssetManifest(options.directory);
  prepared.assets = Object.entries(manifest).map(([url, value]) => ({ ...value, url,
    path: relative('/workspace', join(options.directory, url)), contentType: mime.getType(url) || 'application/octet-stream' }));
  prepared.assetConfig = { ...options.assetConfig, run_worker_first: options.run_worker_first,
    _headers: options._headers, _redirects: options._redirects };
}
if (preview) {
  prepared.preview = { env: helpers.extractConfigBindings(config), limits: config.previews.limits ?? config.limits,
    cache: config.previews.cache ?? config.cache,
    placement: config.previews.placement?.mode === 'off' ? null : helpers.parseConfigPlacement(config.previews.placement ?? config.placement) };
}
writeFileSync('/workspace/worker.prepared.json', JSON.stringify(prepared));
`, async scratchRoot => {
    const body = await readFile(await stagedRealPath(scratchRoot, 'worker.bundle'), { signal: context.signal });
    const firstLine = body.subarray(0, body.indexOf('\r\n')).toString('ascii');
    if (!firstLine.startsWith('--')) throw new Error('Worker multipart output is unavailable');
    const contentType = `multipart/form-data; boundary=${firstLine.slice(2)}`;
    const form = await new Response(Uint8Array.from(body).buffer, { headers: { 'content-type': contentType } }).formData();
    const rawMetadata = form.get('metadata');
    const metadata: unknown = typeof rawMetadata === 'string' ? JSON.parse(rawMetadata) : null;
    const preparedBytes = await readFile(await stagedRealPath(scratchRoot, 'worker.prepared.json'), { signal: context.signal });
    const prepared: unknown = JSON.parse(preparedBytes.toString('utf8'));
    if (!isObject(prepared)) throw new Error('Worker preparation output is unavailable');
    let assets: PreparedWorkerBuild['assets'];
    if (prepared.assets !== undefined) {
      if (!Array.isArray(prepared.assets) || !isObject(prepared.assetConfig)) throw new Error('Worker asset manifest is unavailable');
      const files: WorkerAsset[] = [];
      for (const asset of prepared.assets) {
        if (!isObject(asset) || typeof asset.path !== 'string' || typeof asset.url !== 'string' || !asset.url.startsWith('/')
          || typeof asset.hash !== 'string' || !asset.hash || typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size < 0
          || typeof asset.contentType !== 'string') throw new Error('Worker asset output is unavailable');
        files.push({ ...asset, path: await stagedRealPath(scratchRoot, asset.path), url: asset.url,
          hash: asset.hash, size: asset.size, contentType: asset.contentType });
      }
      assets = { files, config: prepared.assetConfig };
    }
    if (!isObject(metadata) || (typeof metadata.main_module !== 'string' || !(form.get(metadata.main_module) instanceof Blob)) && !assets) {
      throw new Error('Worker executable module output is unavailable');
    }
    if (input.preview && !isObject(prepared.preview)) throw new Error('Worker Preview configuration output is unavailable');
    return { body, contentType, form, metadata, ...(assets ? { assets } : {}),
      ...(isObject(prepared.preview) ? { preview: prepared.preview } : {}),
      outputManifestFingerprint: `sha256:${createHash('sha256').update(body).update(preparedBytes).digest('hex')}` };
  });
}
