import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getCliBinaryArtifactSupportTargetUnavailableReason } from '../../componentArtifactTarget.mjs';
import { bundleInstalledPackageWithRuntimeDependencies } from '../workspaces/index.js';
import type { BinaryTarget } from './targets.js';
import { commandExists, execOrThrow, type RunCommand } from './commands.js';

const TARGET_RUNTIME_PACKAGES = new Set(['node-pty', '@homebridge/node-pty-prebuilt-multiarch',
  'ffmpeg-static', 'esbuild', 'sharp', 'bare-fs', 'bare-os', 'bare-url']);

/** Target acquisition belongs to the existing CLI support staging transaction. */
export async function stageCliTargetRuntimeDependencies({ repoRoot, payloadDir, target,
  platform = process.platform, arch = process.arch, commandProbe = commandExists, runCommand = execOrThrow,
}: Readonly<{
  repoRoot: string; payloadDir: string; target: BinaryTarget;
  platform?: string; arch?: string;
  commandProbe?: (command: string) => boolean;
  runCommand?: RunCommand;
}>): Promise<void> {
  if ((platform === 'win32' ? 'windows' : platform) === target.os && arch === target.arch) return;
  const reason = getCliBinaryArtifactSupportTargetUnavailableReason({ target, platform, arch, commandProbe });
  if (reason) throw new Error(reason);
  const packages = new Map<string, { name: string; version: string; paths: string[] }>();
  async function visit(directory: string): Promise<void> {
    const manifest = await readFile(join(directory, 'package.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (manifest) {
      const data: unknown = JSON.parse(manifest);
      if (data && typeof data === 'object' && 'name' in data && typeof data.name === 'string'
        && TARGET_RUNTIME_PACKAGES.has(data.name)) {
        if (!('version' in data) || typeof data.version !== 'string') throw new Error(`Missing runtime package version: ${directory}`);
        const key = `${data.name}@${data.version}`;
        const entry = packages.get(key) ?? { name: data.name, version: data.version, paths: [] };
        entry.paths.push(directory);
        packages.set(key, entry);
      }
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(directory, entry.name));
    }
  }
  await visit(join(payloadDir, 'node_modules'));
  const scratchRoot = join(repoRoot, '.project', 'tmp');
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, 'cli-target-dependencies-'));
  try {
    for (const entry of packages.values()) {
      const packageRoot = join(scratch, entry.name.replaceAll('/', '_'), entry.version);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ private: true, dependencies: { [entry.name]: entry.version } }));
      const env = { ...process.env, npm_config_arch: target.arch, npm_config_platform: target.os };
      await runCommand('npm', ['install', `--cpu=${target.arch}`, `--os=${target.os}`, '--libc=glibc',
        '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--workspaces=false'], { cwd: packageRoot, env });
      const installed = join(packageRoot, 'node_modules', ...entry.name.split('/'));
      if (entry.name === 'node-pty') {
        // node-pty 1.1.0 uses Node-API (node-addon-api), also implemented by Bun.
        // npm supplies node-gyp to its install lifecycle; build_from_source forces
        // that path rather than letting the host prebuild satisfy admission.
        await runCommand('npm', ['rebuild', 'node-pty', '--foreground-scripts', '--arch=arm64', '--workspaces=false'], {
          cwd: packageRoot, env: { ...env, npm_config_build_from_source: 'true',
            npm_package_config_node_gyp_arch: target.arch,
            CC: 'aarch64-linux-gnu-gcc', CXX: 'aarch64-linux-gnu-g++', LINK: 'aarch64-linux-gnu-g++' },
        });
      } else if (entry.name === 'ffmpeg-static') {
        await runCommand(process.execPath, [join(installed, 'install.js')], { cwd: installed, env });
      }
      for (const path of entry.paths) {
        await rm(path, { recursive: true, force: true });
        bundleInstalledPackageWithRuntimeDependencies({ packageName: entry.name, declaredSpec: entry.version,
          resolveFromPackageJsonPath: join(packageRoot, 'package.json'),
          destNodeModulesDir: entry.name.split('/').reduce(directory => dirname(directory), path),
          dereferenceRootDir: repoRoot });
      }
      if (entry.name === 'sharp') {
        // Existing Linux payloads retain both libc variants. Acquire the second
        // variant with npm's libc selector, then vendor only those packages.
        const muslRoot = `${packageRoot}-musl`;
        await mkdir(muslRoot, { recursive: true });
        await writeFile(join(muslRoot, 'package.json'), JSON.stringify({ private: true, dependencies: { sharp: entry.version } }));
        await runCommand('npm', ['install', `--cpu=${target.arch}`, '--os=linux', '--libc=musl',
          '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--workspaces=false'], { cwd: muslRoot, env });
        const manifest: unknown = JSON.parse(await readFile(join(muslRoot, 'node_modules/sharp/package.json'), 'utf8'));
        if (!manifest || typeof manifest !== 'object' || !('optionalDependencies' in manifest)
          || !manifest.optionalDependencies || typeof manifest.optionalDependencies !== 'object') throw new Error('Missing Sharp optional runtime dependencies');
        for (const [name, spec] of Object.entries(manifest.optionalDependencies)) {
          if (!name.startsWith('@img/sharp-') || !name.endsWith(`linuxmusl-${target.arch}`) || typeof spec !== 'string') continue;
          for (const path of entry.paths) bundleInstalledPackageWithRuntimeDependencies({ packageName: name, declaredSpec: spec,
            resolveFromPackageJsonPath: join(muslRoot, 'node_modules/sharp/package.json'), destNodeModulesDir: join(path, 'node_modules'),
            dereferenceRootDir: repoRoot });
        }
      }
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
