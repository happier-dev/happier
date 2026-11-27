// One-off cutover transform. Run against the latest checkout before pnpm import.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import ts from 'typescript';
import { collectWorkspacePackageJsonPaths } from '../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs';

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const write = (file, value) => fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
const manifest = read('package.json');
const cli = read('apps/cli/package.json');
const version = '12.14.0';
const integrity = Buffer.from('wYum2HmT09Fky16JSPMrLAbuhUSH4GzY2GeBNC+z5btGNDZwNHEehoArqpw3vqkGzhkprQjXCITJfYAd8TOJpg==', 'base64').toString('hex');
const workspacePath = path.join(root, 'pnpm-workspace.yaml');
const workspace = fs.existsSync(workspacePath) ? parse(fs.readFileSync(workspacePath, 'utf8')) : {};
const currentWorkspacePatterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
if (currentWorkspacePatterns) workspace.packages = currentWorkspacePatterns;
if (!Array.isArray(workspace.packages)) throw new Error('Expected the current workspace package patterns');
workspace.nodeLinker = 'hoisted';
workspace.linkWorkspacePackages = true;
workspace.autoInstallPeers = false;
workspace.strictDepBuilds = true;
// Stack owns dependency preparation; script dispatch must not retry workspace installs.
workspace.verifyDepsBeforeRun = false;
// Linux CLI payloads retain both libc variants of the host OS/CPU. Foreign
// release targets are still selected explicitly by the CI install action.
workspace.supportedArchitectures = { os: ['current'], cpu: ['current'], libc: ['glibc', 'musl'] };
if (manifest.resolutions) workspace.overrides = {};
workspace.overrides ??= {};
// Yarn 1.22.22 reads resolutions only from the workspace root. Promoting a
// dormant workspace pin changes the graph, including unrelated consumers.
for (const [selector, resolution] of Object.entries(manifest.resolutions ?? {})) {
  const unrooted = selector.startsWith('**/');
  const packages = (unrooted ? selector.slice(3) : selector).match(/@[^/]+\/[^/]+|[^/]+/g) ?? [];
  let translated;
  if (selector === '**/minio/fast-xml-parser/fast-xml-builder') {
    // Audited retained Yarn graph (7cb748d766): minio@8.0.7 is the only
    // fast-xml-parser consumer, resolving 5.7.0. pnpm supports one parent.
    translated = 'fast-xml-parser@5.7.0>fast-xml-builder';
  } else {
    // @fastify/otel is absent from the retained graph, so its dormant nested
    // resolution has no parent version we can qualify. Reject it, and any
    // other ancestry/glob we cannot represent, rather than widening scope.
    if (!packages.length || packages.length > 2 || (!unrooted && packages.length > 1)
      || packages.some(name => /[*?\[\]{}!]/.test(name))) {
      throw new Error(`Cannot preserve Yarn resolution scope: ${selector}`);
    }
    translated = packages.join('>');
  }
  workspace.overrides[translated] = resolution;
}
// Preserve the retained Yarn graph: Pierre imports themes introduced in Shiki 4,
// while the UI directly owns Shiki 3.22.0. Theming's optional peer ranges are
// broader than the theme subpaths its published code actually imports.
workspace.overrides['@pierre/diffs>shiki'] = '4.5.0';
workspace.overrides['@pierre/diffs>@shikijs/transformers'] = '4.5.0';
// Yarn resolved these broad ranges to the root's Vite 7.3.1. Shared CLI/UI
// Vitest configs require that identity; unrelated Vite 6 consumers keep theirs.
workspace.overrides['vitest@3.2.4>vite'] = '7.3.1';
workspace.overrides['vite-node@3.2.4>vite'] = '7.3.1';
workspace.packageExtensions ??= {};
workspace.packageExtensions['@pierre/theming@1.0.1'] = {
  ...workspace.packageExtensions['@pierre/theming@1.0.1'],
  dependencies: {
    ...workspace.packageExtensions['@pierre/theming@1.0.1']?.dependencies,
    shiki: '4.5.0', '@shikijs/themes': '4.5.0',
  },
};
workspace.allowBuilds = {
  esbuild: true, '@homebridge/node-pty-prebuilt-multiarch': true, 'node-pty': true,
  sharp: true, '@prisma/engines': true, '@more-tech/react-native-libsodium': true,
  '@shopify/react-native-skia': true, 'cbor-extract': true, protobufjs: true,
  'onnxruntime-node': false, 'core-js': false, '@sentry/node-cpu-profiler': true,
  '@sentry/cli': true, 'ffmpeg-static': true, 'redis-memory-server': true,
  prisma: true, '@google/genai': false, '@prisma/client': true,
  // The root CLI edge is local-only; the registry package must never run its installer.
  '@happier-dev/cli': false,
};
workspace.patchedDependencies ??= {};
for (const specifier of Object.keys(workspace.patchedDependencies)) {
  const separator = specifier.lastIndexOf('@');
  workspace.overrides[specifier.slice(0, separator)] = specifier.slice(separator + 1);
}
manifest.packageManager = `pnpm@${version}+sha512.${integrity}`;
manifest.devDependencies.yaml = '2.9.0';
manifest.devDependencies.diff = '8.0.2';
// Supply Pierre's optional peer from the workspace root. With the hoisted
// linker, a lock-only peer binding can otherwise resolve the UI's Shiki 3.
manifest.devDependencies.shiki = '4.5.0';
delete manifest.devDependencies['patch-package'];
manifest.scripts.postinstall = manifest.scripts.postinstall?.replace(/^patch-package --error-on-fail\s*&&\s*/, '');
manifest.dependencies['@happier-dev/cli'] = 'workspace:^';
delete manifest.workspaces;
delete manifest.resolutions;
delete cli.packageManager;
write('package.json', manifest);
write('apps/cli/package.json', cli);
const uiPath = path.join(root, 'apps/ui/package.json');
if (fs.existsSync(uiPath)) {
  const ui = read('apps/ui/package.json');
  ui.devDependencies ??= {};
  // Preserve the UI's observed Yarn ambient types instead of pnpm's transitive hoist choice.
  ui.devDependencies['@types/node'] ??= '25.0.10';
  write('apps/ui/package.json', ui);
  const configPath = path.join(root, 'apps/ui/tsconfig.json');
  const text = fs.readFileSync(configPath, 'utf8');
  const source = ts.parseJsonText(configPath, text);
  const property = (object, name) => object?.properties?.find(value => ts.isPropertyAssignment(value) && value.name.text === name)?.initializer;
  const paths = property(property(source.statements[0]?.expression, 'compilerOptions'), 'paths');
  if (source.parseDiagnostics.length || !paths || !ts.isObjectLiteralExpression(paths)) {
    throw new Error('Expected the UI compiler paths object');
  }
  const config = ts.parseConfigFileTextToJson(configPath, text).config;
  const aliases = { zod: ['../../node_modules/zod'], 'zod/*': ['../../node_modules/zod/*'] };
  const missing = [];
  for (const [name, targets] of Object.entries(aliases)) {
    const current = config.compilerOptions.paths[name];
    if (current && JSON.stringify(current) !== JSON.stringify(targets)) throw new Error(`Conflicting UI compiler alias: ${name}`);
    if (!current) missing.push(`      ${JSON.stringify(name)}: ${JSON.stringify(targets)},`);
  }
  if (missing.length) {
    // Keep the authored JSONC comments and every unrelated host alias intact.
    const insertion = paths.getStart(source) + 1;
    fs.writeFileSync(configPath, text.slice(0, insertion)
      + '\n      // Hoisted imports and vendored SDK declarations share the host Zod brand identity.\n'
      + missing.join('\n') + text.slice(insertion));
  }
}
fs.writeFileSync(workspacePath, stringify(workspace));
for (const full of await collectWorkspacePackageJsonPaths(root)) {
  const value = JSON.parse(fs.readFileSync(full, 'utf8'));
  let changed = false;
  if (value.resolutions) {
    console.warn(`Ignored non-root Yarn resolutions in ${path.relative(root, full)}; only root resolutions were active.`);
    delete value.resolutions;
    changed = true;
  }
  if (value.packageManager) {
    delete value.packageManager;
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`);
  }
}
console.log(`Configured pnpm ${version}; regenerate the lockfile before frozen installs.`);
