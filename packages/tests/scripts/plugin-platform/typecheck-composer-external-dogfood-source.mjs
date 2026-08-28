import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..', '..', '..');
const fixtureRoot = join(repoRoot, 'packages', 'tests', 'fixtures', 'plugin-platform', 'composer-external-dogfood');
const sdkRoot = join(repoRoot, 'packages', 'plugin-sdk');
const pluginUiRoot = join(repoRoot, 'packages', 'plugin-ui');
const workRoot = await mkdtemp(join(tmpdir(), 'happier-composer-external-source-'));
const projectRoot = join(workRoot, 'project');

async function linkPackage(packageName, sourcePath) {
  const segments = packageName.split('/');
  const targetPath = join(projectRoot, 'node_modules', ...segments);
  await mkdir(dirname(targetPath), { recursive: true });
  await symlink(sourcePath, targetPath, 'dir');
}

try {
  await cp(fixtureRoot, projectRoot, { recursive: true });
  await Promise.all([
    linkPackage('@happier-dev/plugin-sdk', sdkRoot),
    linkPackage('@happier-dev/plugin-ui', pluginUiRoot),
    linkPackage('@types/react', join(sdkRoot, 'node_modules', '@types', 'react')),
    linkPackage('react', join(sdkRoot, 'node_modules', 'react')),
    linkPackage('react-dom', join(sdkRoot, 'node_modules', 'react-dom')),
    linkPackage('react-native', join(sdkRoot, 'node_modules', 'react-native')),
    linkPackage('react-native-web', join(sdkRoot, 'node_modules', 'react-native-web')),
    linkPackage('csstype', join(pluginUiRoot, 'node_modules', 'csstype')),
  ]);

  const result = spawnSync(process.execPath, [
    join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs'),
    '--noEmit',
    '-p',
    'tsconfig.public.json',
  ], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(workRoot, { recursive: true, force: true });
}
