/** @moduleRealm build */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import type { ReactNativeRepackBuildPreset } from '../reactNativeBuild.js';
import type {
    PluginUiBuildSurfaceV1,
    PluginUiReactNativeBuildSurfaceV1,
} from './buildUiArtifacts.js';

export type PreparedManagedPluginUiBuildOperationV1 = Readonly<{
    surfaces: readonly PluginUiBuildSurfaceV1[];
    cleanup(): Promise<void>;
}>;

function isRepackSurface(
    surface: PluginUiBuildSurfaceV1,
): surface is PluginUiReactNativeBuildSurfaceV1 & Readonly<{ preset: ReactNativeRepackBuildPreset }> {
    return surface.kind === 'reactNative' && surface.preset.bundler === 'repack';
}

function isReactNativeWebViteSurface(surface: PluginUiBuildSurfaceV1): boolean {
    return surface.kind === 'reactNative' && surface.preset.bundler === 'vite';
}

function toPortablePath(path: string): string {
    return path.split(sep).join('/');
}

function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/gu, '&amp;')
        .replace(/"/gu, '&quot;')
        .replace(/</gu, '&lt;');
}

function withGeneratedBundlerConfig(
    surface: PluginUiBuildSurfaceV1,
    bundlerConfigPath: string,
    bundlerWorkingDirectory?: string,
): PluginUiBuildSurfaceV1 {
    return Object.freeze({
        ...surface,
        bundlerConfigPath,
        ...(bundlerWorkingDirectory === undefined ? {} : { bundlerWorkingDirectory }),
    }) as PluginUiBuildSurfaceV1;
}

function generatedHostedWebHtmlSource(params: Readonly<{
    operationRoot: string;
    projectRoot: string;
    sourceEntry: string;
}>): string {
    const sourcePath = resolve(params.projectRoot, params.sourceEntry);
    let relativeSource = toPortablePath(relative(params.operationRoot, sourcePath));
    if (!relativeSource.startsWith('.')) relativeSource = `./${relativeSource}`;
    return [
        '<!doctype html>',
        '<html>',
        '  <head><meta charset="UTF-8" /></head>',
        '  <body>',
        `    <script type="module" src="${escapeHtmlAttribute(relativeSource)}"></script>`,
        '  </body>',
        '</html>',
        '',
    ].join('\n');
}

function generatedHostedWebViteConfigSource(params: Readonly<{
    operationRoot: string;
    outputRoot: string;
    authorConfigPath?: string;
}>): string {
    const hasAuthorConfig = params.authorConfigPath !== undefined;
    const htmlEntryPath = join(params.operationRoot, 'index.html');
    return [
        `import { defineConfig${hasAuthorConfig ? ', mergeConfig' : ''} } from 'vite';`,
        ...(hasAuthorConfig ? [`import authorViteConfig from ${JSON.stringify(params.authorConfigPath)};`] : []),
        '',
        `const managedHtmlEntry = ${JSON.stringify(htmlEntryPath)};`,
        '',
        'const managedConfig = {',
        `  root: ${JSON.stringify(params.operationRoot)},`,
        "  base: './',",
        '  build: {',
        `    outDir: ${JSON.stringify(params.outputRoot)},`,
        "    assetsDir: 'assets',",
        '    sourcemap: false,',
        '    emptyOutDir: true,',
        '    lib: false,',
        '    rollupOptions: {',
        '      input: managedHtmlEntry,',
        '      external: [],',
        '    },',
        '  },',
        '};',
        '',
        'function applyManagedHostedBuildOptions(build) {',
        `  build.outDir = ${JSON.stringify(params.outputRoot)};`,
        '  build.lib = false;',
        '  build.rollupOptions ??= {};',
        '  build.rollupOptions.input = managedHtmlEntry;',
        '  build.rollupOptions.external = [];',
        '  delete build.rollupOptions.output;',
        '}',
        '',
        'async function assertBoundedAuthorViteConfig(authorConfig) {',
        '  const pending = [authorConfig?.plugins];',
        '  while (pending.length > 0) {',
        '    const candidate = await pending.pop();',
        '    if (candidate == null || candidate === false) continue;',
        '    if (Array.isArray(candidate)) {',
        '      pending.push(...candidate);',
        '      continue;',
        '    }',
        "    if (typeof candidate === 'object' && candidate.configResolved != null) {",
        "      throw new Error('Managed plugin UI Vite extensions must not register configResolved; managed root, entry, output, externals, and package identity are finalized by the builder.');",
        '    }',
        '  }',
        '}',
        '',
        'const managedConfigGuard = {',
        "  name: 'happier-plugin-ui-managed-vite-config-guard',",
        "  enforce: 'post',",
        '  config: {',
        "    order: 'post',",
        '    handler(config) {',
        `      config.root = ${JSON.stringify(params.operationRoot)};`,
        "      config.base = './';",
        '      config.build ??= {};',
        '      applyManagedHostedBuildOptions(config.build);',
        '    },',
        '  },',
        '  configEnvironment: {',
        "    order: 'post',",
        '    handler(name, config) {',
        "      if (name !== 'client') return;",
        '      config.build ??= {};',
        '      applyManagedHostedBuildOptions(config.build);',
        '    },',
        '  },',
        '};',
        '',
        'managedConfig.plugins = [managedConfigGuard];',
        '',
        ...(hasAuthorConfig
            ? [
                'async function resolveAuthorViteConfig(env) {',
                "  const resolved = typeof authorViteConfig === 'function' ? await authorViteConfig(env) : await authorViteConfig;",
                '  const authorConfig = resolved ?? {};',
                '  await assertBoundedAuthorViteConfig(authorConfig);',
                '  return authorConfig;',
                '}',
                '',
                'export default defineConfig(async (env) => mergeConfig(await resolveAuthorViteConfig(env), managedConfig));',
            ]
            : ['export default defineConfig(managedConfig);']),
        '',
    ].join('\n');
}

function generatedReactNativeWebViteConfigSource(params: Readonly<{
    operationRoot: string;
    projectRoot: string;
    sourceEntry: string;
    outputRoot: string;
    authorConfigPath?: string;
}>): string {
    const hasAuthorConfig = params.authorConfigPath !== undefined;
    const sourceEntry = resolve(params.projectRoot, params.sourceEntry);
    return [
        "import react from '@vitejs/plugin-react';",
        `import { defineConfig${hasAuthorConfig ? ', mergeConfig' : ''} } from 'vite';`,
        "import { createReactNativeWebVitePlugins } from '@happier-dev/plugin-sdk/ui/build';",
        ...(hasAuthorConfig ? [`import authorViteConfig from ${JSON.stringify(params.authorConfigPath)};`] : []),
        '',
        'function createManagedLibrary() {',
        '  return {',
        `    entry: ${JSON.stringify(sourceEntry)},`,
        "    formats: ['es'],",
        "    fileName: () => 'entry.mjs',",
        '  };',
        '}',
        '',
        'const managedConfig = {',
        `  root: ${JSON.stringify(params.operationRoot)},`,
        "  plugins: [react({ jsxRuntime: 'classic' }), ...createReactNativeWebVitePlugins()],",
        '  resolve: {',
        "    alias: [{ find: 'react-native', replacement: 'react-native-web' }],",
        '  },',
        '  build: {',
        `    outDir: ${JSON.stringify(params.outputRoot)},`,
        '    minify: false,',
        '    sourcemap: false,',
        '    emptyOutDir: true,',
        '    lib: {',
        `      entry: ${JSON.stringify(sourceEntry)},`,
        "      formats: ['es'],",
        "      fileName: () => 'entry.mjs',",
        '    },',
        '  },',
        '};',
        '',
        'function applyManagedReactNativeWebBuildOptions(build) {',
        `  build.outDir = ${JSON.stringify(params.outputRoot)};`,
        '  build.lib = createManagedLibrary();',
        '  build.rollupOptions ??= {};',
        '  delete build.rollupOptions.input;',
        '  delete build.rollupOptions.output;',
        '  build.rollupOptions.external = [];',
        '}',
        '',
        'async function assertBoundedAuthorViteConfig(authorConfig) {',
        '  const pending = [authorConfig?.plugins];',
        '  while (pending.length > 0) {',
        '    const candidate = await pending.pop();',
        '    if (candidate == null || candidate === false) continue;',
        '    if (Array.isArray(candidate)) {',
        '      pending.push(...candidate);',
        '      continue;',
        '    }',
        "    if (typeof candidate === 'object' && candidate.configResolved != null) {",
        "      throw new Error('Managed plugin UI Vite extensions must not register configResolved; managed root, entry, output, externals, and package identity are finalized by the builder.');",
        '    }',
        '  }',
        '}',
        '',
        'const managedConfigGuard = {',
        "  name: 'happier-plugin-ui-managed-vite-config-guard',",
        "  enforce: 'post',",
        '  config: {',
        "    order: 'post',",
        '    handler(config) {',
        `      config.root = ${JSON.stringify(params.operationRoot)};`,
        '      config.build ??= {};',
        '      applyManagedReactNativeWebBuildOptions(config.build);',
        '    },',
        '  },',
        '  configEnvironment: {',
        "    order: 'post',",
        '    handler(name, config) {',
        "      if (name !== 'client') return;",
        '      config.build ??= {};',
        '      applyManagedReactNativeWebBuildOptions(config.build);',
        '    },',
        '  },',
        '};',
        '',
        'managedConfig.plugins = [...managedConfig.plugins, managedConfigGuard];',
        '',
        ...(hasAuthorConfig
            ? [
                'async function resolveAuthorViteConfig(env) {',
                "  const resolved = typeof authorViteConfig === 'function' ? await authorViteConfig(env) : await authorViteConfig;",
                '  const authorConfig = resolved ?? {};',
                '  await assertBoundedAuthorViteConfig(authorConfig);',
                '  return authorConfig;',
                '}',
                '',
                'export default defineConfig(async (env) => mergeConfig(await resolveAuthorViteConfig(env), managedConfig));',
            ]
            : ['export default defineConfig(managedConfig);']),
        '',
    ].join('\n');
}

function generatedRepackConfigSource(params: Readonly<{
    projectRoot: string;
    operationRoot: string;
    sourceEntry: string;
    platform: 'ios' | 'android';
    outputRoot: string;
    module: Readonly<{ containerName: string; modulePath: string; exportName: string }>;
}>): string {
    // Native source maps are staged as Artifact bytes. Their module names must
    // be portable across the author root, physical pack topology, and ephemeral
    // managed operation root.
    return [
        "import { isAbsolute, relative, sep } from 'node:path';",
        "import * as Repack from '@callstack/repack';",
        'import {',
        '  createPluginUiPackageInstanceRepackPlugin,',
        '  createReactNativeRepackResolveOptions,',
        '  createReactNativeRepackSharedModules,',
        "} from '@happier-dev/plugin-sdk/ui/build';",
        '',
        `const projectRoot = ${JSON.stringify(params.projectRoot)};`,
        `const managedOperationRoot = ${JSON.stringify(params.operationRoot)};`,
        "const managedOperationSourceRoot = '.happier-plugin-ui-build';",
        `const expectedPlatform = ${JSON.stringify(params.platform)};`,
        `const moduleIdentity = Object.freeze(${JSON.stringify(params.module)});`,
        '',
        'function portableDevtoolResourcePath(absoluteResourcePath) {',
        "  const jsonModulePrefix = absoluteResourcePath.startsWith('json|') ? 'json|' : '';",
        "  const resourcePath = jsonModulePrefix === '' ? absoluteResourcePath : absoluteResourcePath.slice(jsonModulePrefix.length);",
        '  const operationRelativePath = relative(managedOperationRoot, resourcePath);',
        "  if (!isAbsolute(operationRelativePath) && operationRelativePath !== '..' && !operationRelativePath.startsWith(`..${sep}`)) {",
        "    return `${jsonModulePrefix}${managedOperationSourceRoot}/${operationRelativePath.replace(/\\\\/gu, '/')}`;",
        '  }',
        "  return `${jsonModulePrefix}${relative(projectRoot, resourcePath).replace(/\\\\/gu, '/')}`;",
        '}',
        '',
        'function portableDevtoolModuleFilenameTemplate(info) {',
        '  return `webpack://${moduleIdentity.containerName}/${portableDevtoolResourcePath(info.absoluteResourcePath)}`;',
        '}',
        '',
        'function portableDevtoolFallbackModuleFilenameTemplate(info) {',
        '  return `${portableDevtoolModuleFilenameTemplate(info)}?${info.hash}`;',
        '}',
        '',
        'export default function config(env = {}) {',
        "  const { platform = expectedPlatform, mode = 'production' } = env;",
        '  if (platform !== expectedPlatform) {',
        "    throw new Error(`Managed Re.Pack config expected ${expectedPlatform}, received ${platform}`);",
        '  }',
        '  return {',
        '    mode,',
        '    context: projectRoot,',
        '    entry: {},',
        '    resolve: {',
        '      ...createReactNativeRepackResolveOptions(Repack.getResolveOptions(platform)),',
        '    },',
        '    output: {',
        '      uniqueName: moduleIdentity.containerName,',
        `      path: ${JSON.stringify(params.outputRoot)},`,
        "      publicPath: 'noop:///',",
        "      chunkFilename: '[name].chunk.bundle',",
        '      devtoolModuleFilenameTemplate: portableDevtoolModuleFilenameTemplate,',
        '      devtoolFallbackModuleFilenameTemplate: portableDevtoolFallbackModuleFilenameTemplate,',
        '    },',
        '    module: {',
        '      rules: [',
        '        ...Repack.getJsTransformRules({ codegen: { enabled: false } }),',
        '        ...Repack.getAssetTransformRules(),',
        '      ],',
        '    },',
        '    plugins: [',
        '      createPluginUiPackageInstanceRepackPlugin(),',
        '      new Repack.plugins.RepackTargetPlugin(),',
        '      new Repack.plugins.ModuleFederationPlugin({',
        '        name: moduleIdentity.containerName,',
        '        filename: `${platform}.bundle.js`,',
        '        exposes: {',
        `          [moduleIdentity.modulePath]: ${JSON.stringify(`./${params.sourceEntry}`)},`,
        '        },',
        '        shared: createReactNativeRepackSharedModules(),',
        '      }),',
        '    ],',
        '  };',
        '}',
        '',
    ].join('\n');
}

const REPACK_COMMAND_CONFIG_SOURCE = [
    'module.exports = {',
    "  commands: require('@callstack/repack/commands/rspack'),",
    '};',
    '',
].join('\n');

/**
 * Materializes the canonical Vite/Re.Pack configuration for every author
 * target. The files live in one unique, project-contained operation root and
 * are removed after the build. An advanced Vite config is imported as a
 * bounded pre-resolution extension. Its post-order config guards retain
 * ownership of root and output after Vite author hooks run; mutable author
 * `configResolved` hooks are rejected before Vite derives its final state.
 * React Native Web additionally retains host-runtime externals and the
 * physical plugin-ui check; native retains Module Federation identity. Re.Pack
 * has no author config path at all.
 */
export async function prepareManagedPluginUiBuildOperation(
    input: Readonly<{
        projectRoot: string;
        surfaces: readonly PluginUiBuildSurfaceV1[];
    }>,
): Promise<PreparedManagedPluginUiBuildOperationV1> {
    const projectRoot = await realpath(input.projectRoot);
    const operationRoot = await realpath(await mkdtemp(join(projectRoot, '.happier-plugin-ui-build-')));
    try {
        await writeFile(
            join(operationRoot, 'package.json'),
            '{"private":true,"name":"happier-plugin-ui-build-operation"}\n',
            'utf8',
        );
        const surfaces: PluginUiBuildSurfaceV1[] = [];
        let registeredRepackCommand = false;
        for (const surface of input.surfaces) {
            if (isRepackSurface(surface)) {
                if (!registeredRepackCommand) {
                    await writeFile(join(operationRoot, 'react-native.config.cjs'), REPACK_COMMAND_CONFIG_SOURCE, 'utf8');
                    registeredRepackCommand = true;
                }
                const configPath = join(
                    operationRoot,
                    `repack.${surface.preset.contributionId}.${surface.preset.platform}.config.mjs`,
                );
                await writeFile(configPath, generatedRepackConfigSource({
                    projectRoot,
                    operationRoot,
                    sourceEntry: surface.preset.sourceEntry,
                    platform: surface.preset.platform,
                    outputRoot: resolve(projectRoot, surface.preset.output.root),
                    module: surface.preset.module,
                }), 'utf8');
                surfaces.push(withGeneratedBundlerConfig(surface, configPath, operationRoot));
                continue;
            }
            const configPath = join(operationRoot, `vite.${surface.preset.contributionId}.config.mjs`);
            const outputRoot = resolve(projectRoot, surface.preset.output.root);
            let bundlerWorkingDirectory: string;
            if (isReactNativeWebViteSurface(surface)) {
                await writeFile(configPath, generatedReactNativeWebViteConfigSource({
                    operationRoot,
                    projectRoot,
                    sourceEntry: surface.preset.sourceEntry,
                    outputRoot,
                    authorConfigPath: surface.bundlerConfigPath,
                }), 'utf8');
                bundlerWorkingDirectory = operationRoot;
            } else {
                // Vite preserves the input HTML basename. Give every generated
                // hosted surface its own `index.html` root so the declared
                // artifact entry remains exactly `index.html` even when one
                // operation builds several hosted targets.
                const htmlRoot = join(operationRoot, `hosted-web.${surface.preset.contributionId}`);
                const htmlPath = join(htmlRoot, 'index.html');
                await mkdir(htmlRoot, { recursive: true });
                await writeFile(htmlPath, generatedHostedWebHtmlSource({
                    operationRoot: htmlRoot,
                    projectRoot,
                    sourceEntry: surface.preset.sourceEntry,
                }), 'utf8');
                await writeFile(configPath, generatedHostedWebViteConfigSource({
                    operationRoot: htmlRoot,
                    outputRoot,
                    authorConfigPath: surface.bundlerConfigPath,
                }), 'utf8');
                bundlerWorkingDirectory = htmlRoot;
            }
            surfaces.push(withGeneratedBundlerConfig(
                surface,
                configPath,
                bundlerWorkingDirectory,
            ));
        }
        return Object.freeze({
            surfaces: Object.freeze(surfaces),
            cleanup: async () => {
                await rm(operationRoot, { recursive: true, force: true });
            },
        });
    } catch (cause) {
        await rm(operationRoot, { recursive: true, force: true });
        throw cause;
    }
}
