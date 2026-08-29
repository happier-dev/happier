import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const forbiddenPrivateImportPattern = /^(?:apps\/ui|@\/components|@\/sync|@\/theme|@happier-dev\/protocol)(?:\/|$)/u;

/**
 * Read the module specifiers a file actually imports.
 *
 * This deliberately parses `import`/`export … from` and `import(…)` rather than
 * scanning raw text: shared modules must be able to NAME the canonical Happier
 * owner they were extracted from (§3.10.3 requires it), and a text scan would
 * turn documenting `apps/ui/sources/components/ui/text/Text.tsx` into a boundary
 * violation. A prose mention is not a dependency; an import is.
 */
function importedSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/(?:^|[\s;}])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/gu),
    ...source.matchAll(/(?:^|[\s;({])import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu),
    ...source.matchAll(/(?:^|[\s;({])require\s*\(\s*['"]([^'"]+)['"]\s*\)/gu),
    ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gmu),
  ].map((match) => match[1]);
}

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(entryPath);
    if (/\.(?:ts|tsx)$/u.test(entry.name) && !/\.(?:test|spec)\.tsx?$/u.test(entry.name)) {
      return [entryPath];
    }
    return [];
  });
}

describe('author package boundary', () => {
  it('uses only public SDK contracts and framework dependencies', () => {
    const sourceRoot = new URL('.', import.meta.url).pathname;
    const offenders = collectSourceFiles(sourceRoot).filter((filePath) =>
      importedSpecifiers(readFileSync(filePath, 'utf8'))
        .some((specifier) => forbiddenPrivateImportPattern.test(specifier)),
    );

    expect(offenders.map((filePath) => relative(sourceRoot, filePath))).toEqual([]);
  });

  /**
   * §3.10.1.1 — dependency direction inside this package.
   *
   *   presentation → React/RN + the environment seam only
   *   adapters     → presentation + plugin-sdk/ui
   *
   * Without this, shared primitives could quietly start requiring
   * `PluginUiProvider`, which would make them unusable from Happier core and
   * turn "shared presentation" back into "plugin-only components".
   */
  it('keeps shared presentation free of plugin-host transport', () => {
    const sourceRoot = new URL('.', import.meta.url).pathname;
    const presentationRoot = join(sourceRoot, 'presentation');
    const allowedPresentationSpecifier = (specifier: string): boolean => (
      specifier === 'react'
      || specifier.startsWith('react/')
      || specifier === 'react-native'
      || specifier.startsWith('react-native/')
      || specifier.startsWith('./')
      || specifier.startsWith('../')
    );

    const offenders = collectSourceFiles(presentationRoot).flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8');
      const isTypeOnlyEnvironmentContract = /environment/u.test(filePath);
      const isCanonicalIconContract = /presentation[\\/]content[\\/]Icon\.ts$/u.test(filePath);
      const isCanonicalRenderableImageContract = /presentation[\\/]content[\\/]renderableImage\.ts$/u.test(filePath);
      return importedSpecifiers(source)
        .filter((specifier) => !allowedPresentationSpecifier(specifier))
        .filter((specifier) => !(isTypeOnlyEnvironmentContract && specifier === '@happier-dev/plugin-sdk/ui'))
        .filter((specifier) => !(isCanonicalIconContract && specifier === '@happier-dev/plugin-sdk/ui'))
        .filter((specifier) => !(isCanonicalRenderableImageContract && specifier === '@happier-dev/plugin-sdk/ui'))
        .map((specifier) => `${relative(sourceRoot, filePath)} → ${specifier}`);
    });

    expect(offenders).toEqual([]);

    // The environment seam may name the SDK's theme contract, but only as a
    // type: importing a value would drag host transport into core's dependency
    // graph.
    const environmentSources = collectSourceFiles(join(sourceRoot, 'environment'));
    expect(environmentSources.length).toBeGreaterThan(0);
    for (const filePath of environmentSources) {
      const source = readFileSync(filePath, 'utf8');
      const sdkImports = [...source.matchAll(/(?:import|export)(\s+type)?\s[^'"]*?from\s*['"](@happier-dev\/[^'"]+)['"]/gu)];
      for (const [, typeOnly, specifier] of sdkImports) {
        expect(
          typeOnly ? 'type-only' : `value import of ${specifier}`,
        ).toBe('type-only');
      }
    }
  });

  it('describes the published contents selected by the declared files inventory', () => {
    // The README used to promise "only compiled `dist` output, `package.json`,
    // and this README" while `files` also shipped three API-governance
    // artifacts. Release publication reads `files`, so that inventory is the
    // only authority the prose can be checked against.
    const packageRoot = join(new URL('.', import.meta.url).pathname, '..');
    const files = (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      files?: readonly string[];
    }).files ?? [];
    expect(files.length).toBeGreaterThan(0);
    const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8');
    const sectionStart = readme.indexOf('## Published package contents');
    expect(sectionStart, 'README.md has no "## Published package contents" section').toBeGreaterThanOrEqual(0);
    const section = readme.slice(sectionStart);

    const documented = new Set(
      [...section.matchAll(/^\| `([^`]+)` \|/gmu)].map((match) => match[1]!.replace(/\/\*\*$/u, '')),
    );
    expect([...documented].sort()).toEqual([...files].sort());
  });

  it('depends on plugin-sdk rather than the private Protocol runtime', () => {
    const packageRoot = join(new URL('.', import.meta.url).pathname, '..');
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      description?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, unknown>;
      private?: boolean;
      scripts?: Record<string, string>;
      happier?: {
        publicSdkRelease?: { posture?: string };
        internalRuntimePackage?: unknown;
      };
    };

    expect(packageJson.description).toMatch(/author|plugin UI/i);
    expect(packageJson.dependencies).toHaveProperty('@happier-dev/plugin-sdk');
    expect(packageJson.dependencies).not.toHaveProperty('@happier-dev/protocol');
    expect(packageJson.exports).toHaveProperty('./data');
    expect(packageJson.exports).toHaveProperty('./presentation');
    expect(packageJson.exports).toHaveProperty('./environment');
    expect(packageJson.exports).toHaveProperty('./advanced');
    expect(packageJson.exports).not.toHaveProperty('./compatibility');
    expect(existsSync(join(packageRoot, 'src/compatibility.ts'))).toBe(false);
    expect(readFileSync(join(packageRoot, 'src/index.ts'), 'utf8'))
      .not.toContain("./compatibility.js");
    expect(packageJson.devDependencies?.['react-native']).toMatch(/^\d+\.\d+\.\d+$/u);
    // The framework-neutral semantic fixture remains SDK-owned. Plugin UI
    // contributes only the RNW semantic mount adapter through this narrow
    // public entry; it must not reopen a raw renderer-tree contract.
    expect(packageJson.exports).toHaveProperty('./testing', {
      types: './dist/testing/index.d.ts',
      default: './dist/testing/index.js',
    });
    expect(packageJson.peerDependencies).not.toHaveProperty('react-test-renderer');
    expect(packageJson.peerDependenciesMeta).not.toHaveProperty('react-test-renderer');

    // Publication metadata changes atomically with EU-3/EU-4; source authoring is proven here.
    expect(packageJson.private).toBe(true);
    expect(packageJson.happier?.publicSdkRelease?.posture).toBe('developer_preview');
    expect(packageJson.happier?.internalRuntimePackage).toBeUndefined();
    expect(packageJson.scripts?.['test:external-authoring']).toBe(
      'node --test ./scripts/validateExternalAuthoringFixture.test.mjs',
    );
    const currentSourceAuthoringScript = packageJson.scripts?.['test:external-authoring:current-source'] ?? '';
    expect(currentSourceAuthoringScript).toContain(
      'node ./scripts/validateExternalAuthoringFixture.mjs',
    );
    expect(currentSourceAuthoringScript).toMatch(/--mode(?:=|\s+)current-source(?:\s|$)/u);
    expect(packageJson.scripts?.['test:external-authoring:tarballs']).toBe(
      'node ./scripts/validateExternalAuthoringFixture.mjs',
    );
    // A direct `yarn pack` builds current source and verifies its public
    // declaration report; actual publication approval stays at release dispatch.
    const prepack = packageJson.scripts?.prepack ?? '';
    const prepareCandidate = packageJson.scripts?.['prepare:api-governance'] ?? '';
    const declarationCheck = packageJson.scripts?.['check:api-declarations'] ?? '';
    expect(declarationCheck).toContain('check:api-governance');
    expect(prepack).toContain('check:api-governance:prepared');
    expect(prepareCandidate).toContain('build');
    expect(prepack.indexOf('prepare:api-governance')).toBeLessThan(prepack.indexOf('check:api-governance:prepared'));
    expect(packageJson.scripts?.pretypecheck).toBeUndefined();
    expect(packageJson.scripts?.prebuild).toBe('yarn --cwd ../plugin-sdk -s check:public-toolchain');
    expect(packageJson.scripts?.['typecheck:local']).toBe(
      'yarn --cwd ../plugin-sdk -s check:public-toolchain && node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.json',
    );
    expect(packageJson.scripts?.test).toBe('../../apps/stack/bin/hstack-exec --script=test:local');
    expect(packageJson.scripts?.['test:local']).toContain('test:external-authoring');
  });

  it('derives renderable-image diagnostics from the browser-safe UI contract', () => {
    const packageRoot = resolve(new URL('.', import.meta.url).pathname, '..');
    for (const relativePath of [
      'src/presentation/content/renderableImage.ts',
      'src/hostApi/resourceStore.ts',
    ]) {
      const source = readFileSync(join(packageRoot, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(
        /import type \{[^}]*PluginDiagnosticData[^}]*\} from '@happier-dev\/plugin-sdk';/u,
      );
      expect(source, relativePath).toMatch(
        /import type \{[^}]*PluginUiHostApi[^}]*\} from '@happier-dev\/plugin-sdk\/ui';/u,
      );
    }
  });

  it('exports environment facts only from their dedicated public entry', () => {
    const packageRoot = resolve(new URL('.', import.meta.url).pathname, '..');
    const presentationEntry = readFileSync(join(packageRoot, 'src/presentation/index.ts'), 'utf8');

    expect(presentationEntry).not.toContain("from '../environment/index.js'");
  });

  it('does not declare a second PluginUiHostApi or export the host factory', () => {
    const packageRoot = resolve(new URL('.', import.meta.url).pathname, '..');
    const sdkSourceRoot = resolve(packageRoot, '../plugin-sdk/src');
    const frameworkSources = collectSourceFiles(join(packageRoot, 'src'));
    const sdkSources = collectSourceFiles(sdkSourceRoot);
    // A staged package build can leave a declaration mirror beside the source
    // while this source-level boundary test runs. It is output from the one
    // authoring declaration, not a second owner of the public type.
    const declarations = [...sdkSources, ...frameworkSources].filter((filePath) =>
      !filePath.endsWith('.d.ts')
      && /\b(?:interface|type)\s+PluginUiHostApi\b/u.test(readFileSync(filePath, 'utf8')),
    );
    const authorBarrels = [
      join(packageRoot, 'src/index.ts'),
      join(packageRoot, 'src/hostApi/index.ts'),
    ].map((filePath) => readFileSync(filePath, 'utf8')).join('\n');

    expect(declarations.map((filePath) => relative(resolve(packageRoot, '..'), filePath))).toEqual([
      'plugin-sdk/src/ui/hostApi.ts',
    ]);
    expect(authorBarrels).not.toContain('createPluginSurfaceHostApi');
    expect(authorBarrels).not.toContain('createPluginUiHostApiFacade');
  });

  it('keeps Resource lifetime injection behind the bundled-entry boundary', () => {
    const packageRoot = resolve(new URL('.', import.meta.url).pathname, '..');
    const hostApiBarrel = readFileSync(join(packageRoot, 'src/hostApi/index.ts'), 'utf8');
    const hostApiContext = readFileSync(join(packageRoot, 'src/hostApi/context.ts'), 'utf8');
    const componentsBarrel = readFileSync(join(packageRoot, 'src/components/index.ts'), 'utf8');
    const providerSource = readFileSync(join(packageRoot, 'src/components/PluginUiProvider.tsx'), 'utf8');
    const publicProviderProps = providerSource.match(/export type PluginUiProviderProps = Readonly<\{[\s\S]*?\}>;/u)?.[0] ?? '';
    const publicHostApiProviderProps = hostApiContext.match(/export type PluginHostApiProviderProps = Readonly<\{[\s\S]*?\}>;/u)?.[0] ?? '';

    expect(hostApiBarrel).not.toContain('PluginUiResourceStoreScope');
    expect(componentsBarrel).not.toContain('PluginUiProviderInternal');
    expect(componentsBarrel).not.toContain('PluginUiProviderInternalProps');
    expect(existsSync(join(packageRoot, 'src/privateResourceStoreScope.ts'))).toBe(false);
    expect(hostApiContext).not.toContain('resourceScope');
    expect(providerSource).not.toContain('resourceScope');
    expect(hostApiContext).not.toContain('happier.pluginUi.privateResourceStoreScope.v1');
    expect(publicProviderProps).not.toContain('resourceScope');
    expect(publicProviderProps).not.toContain('dataClient');
    expect(publicProviderProps).not.toContain('ephemeralSharedScope');
    expect(publicHostApiProviderProps).not.toContain('resourceScope');
    expect(publicHostApiProviderProps).not.toContain('ephemeralSharedScope');
  });

  it('keeps plugin-ui bundled while the production host transforms shared source', () => {
    const packageRoot = resolve(new URL('.', import.meta.url).pathname, '..');
    const repositoryRoot = resolve(packageRoot, '../..');
    const runtimeFacts = readFileSync(
      join(repositoryRoot, 'packages/protocol/src/plugins/ui/hostRuntimeExternals.ts'),
      'utf8',
    );
    const babelConfig = readFileSync(join(repositoryRoot, 'apps/ui/babel.config.js'), 'utf8');
    const webClosure = runtimeFacts.match(/PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/u)?.[1] ?? '';
    const nativeClosure = runtimeFacts.match(/PLUGIN_UI_HOST_NATIVE_RUNTIME_EXTERNAL_SPECIFIERS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\s+as const\)/u)?.[1] ?? '';

    expect(webClosure).not.toContain('@happier-dev/plugin-ui');
    expect(nativeClosure).not.toContain('@happier-dev/plugin-ui');
    expect(babelConfig).toContain("autoProcessPaths: ['packages/plugin-ui/src']");
  });

  it('keeps the external NodeNext, Vite, and Metro fixtures on public package imports', () => {
    const packageRoot = resolve(new URL('.', import.meta.url).pathname, '..');
    const fixtureRoot = join(packageRoot, 'fixtures/external-authoring');
    const fixtureSources = collectSourceFiles(join(fixtureRoot, 'src'));
    const imports = fixtureSources.flatMap((filePath) =>
      importedSpecifiers(readFileSync(filePath, 'utf8')),
    );

    expect(fixtureSources.length).toBeGreaterThan(0);
    expect(imports).toEqual(expect.arrayContaining([
      '@happier-dev/plugin-ui',
      '@happier-dev/plugin-sdk/browser',
      '@happier-dev/plugin-sdk/ui',
    ]));
    expect(imports.every((specifier) => (
      specifier.startsWith('./')
      || specifier === 'react'
      || specifier === 'react-dom/client'
      || specifier === 'node:assert/strict'
      || specifier === '@happier-dev/plugin-sdk'
      || specifier === '@happier-dev/plugin-ui'
      || specifier.startsWith('@happier-dev/plugin-ui/')
      || specifier === '@happier-dev/plugin-sdk/browser'
      || specifier === '@happier-dev/plugin-sdk/manifest'
      || specifier === '@happier-dev/plugin-sdk/protocol'
      || specifier === '@happier-dev/plugin-sdk/contributions'
      || specifier === '@happier-dev/plugin-sdk/ui'
      || specifier === '@happier-dev/plugin-sdk/testing'
      || specifier === '@happier-dev/plugin-sdk/voice/client'
    ))).toBe(true);
    expect(imports).not.toContain('@happier-dev/plugin-ui/testing');
    expect(imports).not.toContain('@happier-dev/plugin-ui/compatibility');
    expect(imports).not.toContain('jsdom');
    for (const config of [
      'tsconfig.nodenext.json',
      'tsconfig.vite.json',
      'tsconfig.metro.json',
      'tsconfig.voice-native.json',
      'tsconfig.runtime.json',
      'vite.config.ts',
    ]) {
      expect(readFileSync(join(fixtureRoot, config), 'utf8')).not.toContain('paths');
    }
    const metroConfig = JSON.parse(
      readFileSync(join(fixtureRoot, 'tsconfig.metro.json'), 'utf8'),
    ) as { compilerOptions?: { customConditions?: string[] } };
    expect(metroConfig.compilerOptions?.customConditions).toContain('react-native');
    const voiceNativeConfig = JSON.parse(
      readFileSync(join(fixtureRoot, 'tsconfig.voice-native.json'), 'utf8'),
    ) as { compilerOptions?: { customConditions?: string[]; lib?: string[]; skipLibCheck?: boolean; types?: string[] } };
    expect(voiceNativeConfig.compilerOptions?.customConditions).toContain('react-native');
    expect(voiceNativeConfig.compilerOptions?.lib).toEqual(['ES2022']);
    expect(voiceNativeConfig.compilerOptions?.skipLibCheck).toBe(false);
    expect(voiceNativeConfig.compilerOptions?.types).toEqual(['react-native']);
    const baseConfig = JSON.parse(
      readFileSync(join(fixtureRoot, 'tsconfig.base.json'), 'utf8'),
    ) as { compilerOptions?: { skipLibCheck?: boolean; types?: string[] }; exclude?: string[] };
    expect(baseConfig.compilerOptions?.skipLibCheck).toBe(false);
    expect(baseConfig.compilerOptions?.types).toEqual([]);
    expect(baseConfig.exclude).toBeUndefined();
  });

});
