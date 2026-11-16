import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureBuildInputFiles, mountCapturedWorkspaceDependencies } from '../../../../../scripts/workspaces/buildInputConvergence.mjs';
import { readSourceComponentBuildInputs } from '../../utils/fs/workspaceBuildInputs.mjs';

/** Relocate owner imports, leaving generated source templates untouched.
 * A null replacement keeps an existing fixture-owned external boundary. */
export function relocateSourceOwnerImports(source, sourceUrl, replacements = new Map()) {
  const target = (specifier) => replacements.get(specifier) ?? new URL(specifier, sourceUrl);
  return source.replace(/^(import|export) (\{[^}]*\}|[^\n]*) from '(\.[^'\n]+)'/gm, (match, declaration, clause, specifier) => {
    if (replacements.get(specifier) === null) return match;
    return `${declaration} ${clause} from ${JSON.stringify(target(specifier).href)}`;
  }).replace(/import\('(\.[^'\n$]+)'\)/g, (match, specifier) => {
    if (replacements.get(specifier) === null) return match;
    return `import(${JSON.stringify(target(specifier).href)})`;
  });
}

export async function prepareFiniteSourceWebFixture({ sourceRepo, repoDir }) {
  const { files, workspaceDirs } = await readSourceComponentBuildInputs({ repoDir: sourceRepo, component: 'expo' });
  // This fixture authors its own app below and has no native modules. Copy
  // the real compiler/tooling, without first copying the app it replaces. The
  // other UI sources stay: the real asset owner (prepareSourceUiAssets) compiles
  // the web workers and the atmosphere worklet from them.
  await captureBuildInputFiles({ sourceDir: sourceRepo, captureDir: repoDir,
    readPaths: async () => files.filter(path => !path.startsWith('apps/ui/sources/app/') && !path.startsWith('apps/ui/modules/')) });
  await mountCapturedWorkspaceDependencies({ sourceDir: sourceRepo, captureDir: repoDir, workspaceDirs });
  // Keep the real captured compiler/tooling, but author one small app/plugin.
  // The separate whole-app export case exercises the complete plugin census.
  const pluginName = '@happier-dev/plugins-admission-fixture';
  await writeFile(join(repoDir, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli',
    type: 'module', bundledDependencies: [pluginName] }));
  await writeFile(join(repoDir, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/ui',
    type: 'module', dependencies: { [pluginName]: '0.0.0' } }));
  await rm(join(repoDir, 'apps/ui/sources/app'), { recursive: true, force: true });
  await mkdir(join(repoDir, 'apps/ui/sources/app'), { recursive: true });
  const uiInput = join(repoDir, 'apps/ui/sources/app/_layout.tsx');
  const uiSource = 'export const admissionInput = "captured-ui-input";';
  await writeFile(uiInput, uiSource);
  // The tiny app still goes through the real source asset generators.
  await mkdir(join(repoDir, 'apps/ui/sources/text'), { recursive: true });
  await writeFile(join(repoDir, 'apps/ui/sources/text/_all.ts'), 'export const SUPPORTED_LANGUAGE_CODES = ["en"] as const;');
  const pluginRoot = join(repoDir, 'packages/plugins/admission-fixture');
  await mkdir(join(pluginRoot, 'src'), { recursive: true });
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: pluginName, version: '0.0.0',
    type: 'module', exports: { './manifest': './src/manifest.ts', './happier-plugin-ui/panel': './src/panel.ts' } }));
  await writeFile(join(pluginRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify({
    id: 'happier.admission-fixture', contributes: { ui: {
      renderers: [{ id: 'panel', kind: 'reactNative', artifact: 'panel' }],
    } },
  })};`);
  const pluginInput = join(pluginRoot, 'src/panel.ts');
  await writeFile(pluginInput, 'export function renderSurface() { return "captured-plugin-input"; }');
  const toolInput = 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs';
  const toolDigest = createHash('sha256').update(await readFile(join(repoDir, toolInput))).digest('hex');
  return { uiInput, uiSource, pluginInput, toolInput, toolDigest };
}
