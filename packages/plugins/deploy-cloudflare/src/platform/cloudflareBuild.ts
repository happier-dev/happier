import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, posix, resolve, isAbsolute, sep } from 'node:path';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { CLOUDFLARE_BUILD_IMAGE, CLOUDFLARE_WRANGLER_VERSION } from './cloudflareToolchain.js';
export { CLOUDFLARE_BUILD_IMAGE, CLOUDFLARE_WRANGLER_VERSION } from './cloudflareToolchain.js';

export type CloudflareBuildInput = Readonly<{ rootPath: string; rootDirectory?: string; actionOperationId: string }>;
export type CloudflareBuildContext = Readonly<{ exec: Pick<ExecService, 'spawn' | 'systemTools'>; signal: AbortSignal }>;

export function stagedPath(root: string, path: string) {
  const full = resolve(root, path);
  if (isAbsolute(path) || full !== root && !full.startsWith(root + sep)) throw new Error('Invalid Cloudflare build output path');
  return full;
}
export async function stagedRealPath(root: string, path: string) {
  const full = await realpath(stagedPath(root, path));
  if (full !== root && !full.startsWith(root + sep)) throw new Error('Cloudflare build output escapes its staged root');
  return full;
}

/** Source materialization owns this operation scratch. Only its credential-free
 * child is mounted. Exec disposal owns cancellation and Docker --rm reaps it.
 */
export async function runCloudflareBuild<T>(input: CloudflareBuildInput, context: CloudflareBuildContext,
  product: 'pages' | 'workers', program: string, readOutput: (scratchRoot: string) => Promise<T>): Promise<T> {
  context.signal.throwIfAborted();
  const tool = await context.exec.systemTools.resolve({ toolId: 'docker', purpose: `Prepare the reviewed Cloudflare ${product} build`,
    cwd: input.rootPath, signal: context.signal });
  const scratch = await mkdtemp(join(input.rootPath, `.happier-${product}-`));
  const project = join(scratch, 'project');
  await mkdir(project);
  const allowed = async (path: string) => {
    const name = basename(path);
    return !['.git', '.wrangler', 'node_modules', '.npmrc', '.yarnrc', '.yarnrc.yml', '.env'].includes(name)
      && !name.startsWith('.env.') && name !== '.dev.vars' && !name.startsWith('.dev.vars.')
      && !name.startsWith('.happier-pages-') && !name.startsWith('.happier-workers-');
  };
  for (const name of await readdir(input.rootPath)) {
    const source = join(input.rootPath, name);
    if (await allowed(source)) await cp(source, join(project, name), { recursive: true, filter: allowed, verbatimSymlinks: true });
  }
  context.signal.throwIfAborted();
  const owner = await stat(scratch);
  const process = await context.exec.spawn({ executable: tool.executable, cwd: input.rootPath,
    args: ['run', '--rm', '--name', `happier-${product}-${createHash('sha256').update(input.actionOperationId).digest('hex')}`,
      '--user', `${owner.uid}:${owner.gid}`, '--interactive', '--mount', `type=bind,source=${scratch},target=/workspace`,
      '--workdir', posix.join('/workspace/project', input.rootDirectory ?? '.'), CLOUDFLARE_BUILD_IMAGE,
      'node', '--input-type=module'], stdin: new TextEncoder().encode(program) }, { signal: context.signal });
  try {
    const result = await process.wait();
    context.signal.throwIfAborted();
    if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0
      || result.termination.requestedBy.kind !== 'none') throw new Error('Cloudflare build container did not finish successfully');
    return await readOutput(await realpath(scratch));
  } finally { await process.dispose(); }
}

/** Executed only inside the pinned image, never by the importing host. */
export function cloudflareContainerToolchain(extraPackages: readonly string[] = []) {
  return `
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error('Cloudflare preparation command failed');
}
process.env.HOME = '/tmp';
process.env.npm_config_cache = '/tmp/.npm';
process.env.COREPACK_DEFAULT_TO_LATEST = '0';
process.env.WRANGLER_SEND_METRICS = 'false';
const tools = '/tmp/happier-cloudflare';
process.env.PATH = join(tools, 'node_modules', '.bin') + ':' + process.env.PATH;
run('npm', ['install', '--prefix', tools, '--no-audit', '--no-fund', 'wrangler@${CLOUDFLARE_WRANGLER_VERSION}', ...${JSON.stringify(extraPackages)}]);
const require = createRequire(tools + '/package.json');
const wrangler = require('wrangler');
const cli = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
function installProjectDependencies() {
  if (!existsSync('package.json')) return;
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const manager = pkg.packageManager;
  const name = typeof manager === 'string' ? manager.split('@')[0]
    : existsSync('pnpm-lock.yaml') ? 'pnpm' : existsSync('yarn.lock') ? 'yarn' : 'npm';
  if (name !== 'npm' || manager !== undefined) {
    run('corepack', ['enable', '--install-directory', join(tools, 'node_modules', '.bin'), name]);
  }
  run(name, name === 'npm' ? [existsSync('package-lock.json') || existsSync('npm-shrinkwrap.json') ? 'ci' : 'install', '--no-audit', '--no-fund'] : ['install']);
}
`;
}
