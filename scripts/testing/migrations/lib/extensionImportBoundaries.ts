import * as path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';

import ts from 'typescript';

import { publicFeatureProtocolPackageSpecifiers } from '../../../../packages/plugin-sdk/src/featureProtocolPackagePolicy.ts';

import { collectFileInventory } from './collectFileInventory.ts';
import { type InventoryFile } from './migrationTypes.ts';

export interface ExtensionImportBoundaryViolation {
  filePath: string;
  specifier: string;
  kind:
    | 'forbidden-alias'
    | 'forbidden-apps-import'
    | 'relative-escape'
    | 'forbidden-test-support-import'
    | 'forbidden-protocol-import'
    | 'forbidden-private-happier-import'
    | 'unneeded-runtime-protocol-dependency'
    | 'undeclared-package-dependency'
    | 'non-literal-module-specifier'
    | 'duplicate-runtime-descriptor-compatibility-reader';
  details: string;
}

const NODE_BUILTIN_MODULES: ReadonlySet<string> = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);
const RUNTIME_DESCRIPTOR_COMPATIBILITY_KEYS: ReadonlySet<string> = new Set([
  'runtimeDescriptorV1',
  'agentRuntimeDescriptorV1',
  'providerId',
  'provider',
  'providerExtra',
]);

/**
 * Exact bundled adapter seams whose values remain host-private by design. These
 * are not author capabilities: each path adapts one first-party integration to
 * an already-public Session/Agent/Voice outcome or to the host-owned rotating
 * request-auth channel. Keep each exception scoped to one file and specifier.
 */
const PRIVILEGED_ADAPTER_PRIVATE_IMPORTS: ReadonlySet<string> = new Set([
  // Claude's terminal adapter still consumes two host-native prompt parsers.
  'packages/plugins/claude/src/agent/runtime/terminal/unified/turnOperations.ts\0@happier-dev/agents',
  // Claude's workflow runtime consumes the host-native flattened record port.
  'packages/plugins/claude/src/agent/workflowRecords/workflowRuntime.ts\0@happier-dev/agents',
  // The bundled ElevenLabs adapter consumes the host-owned default prompt
  // policy; external Voice authors remain free to supply their own prompt.
  'packages/plugins/elevenlabs/src/ui/voice/autoprovision.ts\0@happier-dev/agents',
  // OpenCode/Pi emit child-side clients for the host-owned rotating request-auth
  // capability. The capability path and client source are not author contracts.
  'packages/plugins/opencode/src/agent/auth/services/requestAuth/assets.ts\0@happier-dev/agents/request-auth',
  'packages/plugins/opencode/src/agent/auth/services/requestAuth/env.ts\0@happier-dev/agents/request-auth',
  'packages/plugins/pi/src/agent/auth/services/requestAuth/assets.ts\0@happier-dev/agents/request-auth',
  'packages/plugins/pi/src/agent/auth/services/requestAuth/env.ts\0@happier-dev/agents/request-auth',
]);

export interface ValidateExtensionImportBoundariesResult {
  ok: boolean;
  errors: string[];
  violations: ExtensionImportBoundaryViolation[];
}

function normalizeRepoPath(filePath: string): string {
  return filePath.split('\\').join('/');
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (/\.tsx$/u.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/u.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/u.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface PluginSourceAnalysis {
  importSpecifiers: string[];
  nonLiteralDynamicLoads: Array<
    'import()' | 'require()' | 'module.require()' | 'createRequire() loader'
  >;
  runtimeDescriptorCompatibilityKeys: ReadonlySet<string>;
}

function analyzePluginSource(filePath: string, content: string): PluginSourceAnalysis {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath),
  );
  const specifiers = new Set<string>();
  const nonLiteralDynamicLoads = new Set<
    'import()' | 'require()' | 'module.require()' | 'createRequire() loader'
  >();
  const runtimeDescriptorCompatibilityKeys = new Set<string>();
  const createRequireFactoryNames = new Set<string>();
  const createRequireLoaderNames = new Set<string>();
  const addStringLiteral = (value: ts.Expression | undefined): void => {
    if (value && ts.isStringLiteralLike(value)) specifiers.add(value.text);
  };
  const recordCompatibilityKey = (value: string): void => {
    if (RUNTIME_DESCRIPTOR_COMPATIBILITY_KEYS.has(value)) {
      runtimeDescriptorCompatibilityKeys.add(value);
    }
  };
  const recordPropertyName = (name: ts.PropertyName | undefined): void => {
    if (!name) return;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
      recordCompatibilityKey(name.text);
    }
  };

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteralLike(statement.moduleSpecifier)
      || (statement.moduleSpecifier.text !== 'node:module' && statement.moduleSpecifier.text !== 'module')
      || !statement.importClause
      || !statement.importClause.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName ?? element.name).text === 'createRequire') {
        createRequireFactoryNames.add(element.name.text);
      }
    }
  }

  const collectCreateRequireLoaders = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && createRequireFactoryNames.has(node.initializer.expression.text)
    ) {
      createRequireLoaderNames.add(node.name.text);
    }
    ts.forEachChild(node, collectCreateRequireLoaders);
  };
  collectCreateRequireLoaders(sourceFile);

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      addStringLiteral(node.moduleReference.expression);
    } else if (
      ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
    ) {
      addStringLiteral(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const dynamicLoad = node.expression.kind === ts.SyntaxKind.ImportKeyword
        ? 'import()'
        : ts.isIdentifier(node.expression) && node.expression.text === 'require'
          ? 'require()'
          : ts.isPropertyAccessExpression(node.expression)
              && ts.isIdentifier(node.expression.expression)
              && node.expression.expression.text === 'module'
              && node.expression.name.text === 'require'
            ? 'module.require()'
            : ts.isIdentifier(node.expression) && createRequireLoaderNames.has(node.expression.text)
              ? 'createRequire() loader'
          : null;
      if (dynamicLoad) {
        const specifier = node.arguments[0];
        if (specifier && ts.isStringLiteralLike(specifier)) {
          specifiers.add(specifier.text);
        } else {
          nonLiteralDynamicLoads.add(dynamicLoad);
        }
      }
    }

    if (ts.isStringLiteralLike(node)) {
      recordCompatibilityKey(node.text);
    } else if (ts.isPropertyAccessExpression(node)) {
      recordCompatibilityKey(node.name.text);
    } else if (
      ts.isElementAccessExpression(node)
      && node.argumentExpression
      && ts.isStringLiteralLike(node.argumentExpression)
    ) {
      recordCompatibilityKey(node.argumentExpression.text);
    } else if (
      ts.isPropertyAssignment(node)
      || ts.isShorthandPropertyAssignment(node)
      || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node)
      || ts.isPropertyDeclaration(node)
      || ts.isPropertySignature(node)
      || ts.isMethodSignature(node)
    ) {
      recordPropertyName(node.name);
    } else if (ts.isBindingElement(node)) {
      recordPropertyName(node.propertyName);
      if (!node.propertyName && ts.isIdentifier(node.name)) {
        recordCompatibilityKey(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    // Keep deterministic output; avoid repeated facts within the same file.
    importSpecifiers: Array.from(specifiers).sort((left, right) => left.localeCompare(right)),
    nonLiteralDynamicLoads: Array.from(nonLiteralDynamicLoads).sort((left, right) => left.localeCompare(right)),
    runtimeDescriptorCompatibilityKeys,
  };
}

function extensionPackageRootFor(filePath: string): string | null {
  // Expected: packages/plugins/<extensionId>/...
  const parts = normalizeRepoPath(filePath).split('/');
  if (parts.length < 3) {
    return null;
  }
  if (parts[0] !== 'packages' || parts[1] !== 'plugins') {
    return null;
  }
  const extensionId = parts[2];
  if (!extensionId) {
    return null;
  }
  return `packages/plugins/${extensionId}`;
}

function resolveRelativeImport(importerFilePath: string, specifier: string): string {
  const importerDir = path.posix.dirname(normalizeRepoPath(importerFilePath));
  return path.posix.normalize(path.posix.join(importerDir, specifier));
}

function isTestSupportImportSpecifier(specifier: string): boolean {
  const normalized = normalizeRepoPath(specifier);
  const segments = normalized.split('/');
  const basename = segments.at(-1) ?? '';
  return segments.some((segment) => segment === 'test-support' || segment === 'testkit')
    || /\.(?:test-support|testkit)(?:\.[^/]*)?$/u.test(basename);
}

function isProductionPluginSource(filePath: string): boolean {
  return filePath.includes('/src/')
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(filePath)
    && !/\.test-support\.[cm]?[jt]sx?$/u.test(filePath)
    && !/\.testkit\.[cm]?[jt]sx?$/u.test(filePath)
    && !filePath.includes('/__tests__/')
    && !filePath.includes('/__fixtures__/')
    && !filePath.includes('/testkit/');
}

function packageSpecifierForExportKey(packageName: string, exportKey: string): string | null {
  if (exportKey === '.') return packageName;
  return exportKey.startsWith('./') ? `${packageName}/${exportKey.slice(2)}` : null;
}

interface WorkspacePackageManifest {
  name?: unknown;
  private?: unknown;
  exports?: unknown;
}

/**
 * True when every production source in the package imports only specifiers that
 * are already public author surface. A package that satisfies this is one a
 * third-party author could have written, so sharing it does not hand a
 * first-party plugin any capability an external author lacks. Test sources are
 * excluded for the same reason plugin tests are: they ship to nobody.
 *
 * A package with no production source is not admitted, so an export map alone
 * can never open the boundary.
 */
function isAuthoredAgainstPublicSurfaceOnly(
  rootDir: string,
  packageRoot: string,
  publicAuthorSurface: ReadonlySet<string>,
): boolean {
  let productionSourceCount = 0;
  for (const source of collectFileInventory({
    rootDir,
    searchRoots: [`${packageRoot}/src`],
    include: /\.[cm]?[jt]sx?$/,
  })) {
    const filePath = normalizeRepoPath(source.filePath);
    if (!isProductionPluginSource(filePath)) continue;
    productionSourceCount += 1;
    for (const specifier of analyzePluginSource(filePath, source.content).importSpecifiers) {
      if (specifier.startsWith('@happier-dev/') && !publicAuthorSurface.has(specifier)) {
        return false;
      }
    }
  }
  return productionSourceCount > 0;
}

function publicPluginPackageSpecifiers(rootDir: string): ReadonlySet<string> {
  const specifiers = new Set<string>([
    '@happier-dev/plugin-sdk',
    '@happier-dev/plugin-ui',
  ]);

  const sdkSurfacePath = path.join(rootDir, 'packages/plugin-sdk/api-surface.json');
  if (existsSync(sdkSurfacePath)) {
    const surface = JSON.parse(readFileSync(sdkSurfacePath, 'utf8')) as {
      entrypoints?: unknown;
    };
    if (Array.isArray(surface.entrypoints)) {
      for (const entrypoint of surface.entrypoints) {
        if (
          !entrypoint
          || typeof entrypoint !== 'object'
          || (entrypoint as { visibility?: unknown }).visibility !== 'author'
          || typeof (entrypoint as { specifier?: unknown }).specifier !== 'string'
        ) {
          continue;
        }
        const specifier = packageSpecifierForExportKey(
          '@happier-dev/plugin-sdk',
          (entrypoint as { specifier: string }).specifier,
        );
        if (specifier) specifiers.add(specifier);
      }
    }
  }

  const pluginUiPackageJsonPath = path.join(rootDir, 'packages/plugin-ui/package.json');
  if (existsSync(pluginUiPackageJsonPath)) {
    const packageJson = JSON.parse(readFileSync(pluginUiPackageJsonPath, 'utf8')) as {
      exports?: unknown;
    };
    if (packageJson.exports && typeof packageJson.exports === 'object' && !Array.isArray(packageJson.exports)) {
      for (const exportKey of Object.keys(packageJson.exports)) {
        const specifier = packageSpecifierForExportKey('@happier-dev/plugin-ui', exportKey);
        if (specifier) specifiers.add(specifier);
      }
    }
  }

  const packagesRoot = path.join(rootDir, 'packages');
  if (existsSync(packagesRoot)) {
    const manifests = new Map<string, WorkspacePackageManifest>();
    const packageNames = readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    for (const packageName of packageNames) {
      const packageJsonPath = path.join(packagesRoot, packageName, 'package.json');
      if (!existsSync(packageJsonPath)) continue;
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as WorkspacePackageManifest;
      manifests.set(packageName, packageJson);
      for (const specifier of publicFeatureProtocolPackageSpecifiers(packageJson)) {
        specifiers.add(specifier);
      }
    }

    // A workspace package that declares itself public (`private: false`, the
    // same publicness declaration the feature-protocol admission above keys on)
    // and whose own production sources reach nothing beyond the public author
    // surface is admitted. This is derived, not an allowlist: no package is
    // named here, one host-private import of its own disqualifies a package,
    // and a package that stays `private: true` is never considered. Admission
    // is evaluated against the author surface as it stands before this pass, so
    // one opt-in package may not launder another and the result never depends
    // on directory-iteration order.
    const publicAuthorSurface = new Set(specifiers);
    for (const [packageName, manifest] of manifests) {
      if (manifest.private !== false || typeof manifest.name !== 'string') continue;
      if (!isAuthoredAgainstPublicSurfaceOnly(rootDir, `packages/${packageName}`, publicAuthorSurface)) {
        continue;
      }
      const exports = manifest.exports;
      if (!exports || typeof exports !== 'object' || Array.isArray(exports)) continue;
      for (const exportKey of Object.keys(exports as Record<string, unknown>)) {
        const specifier = packageSpecifierForExportKey(manifest.name, exportKey);
        if (specifier) specifiers.add(specifier);
      }
    }
  }

  return specifiers;
}

function isPrivilegedAdapterPrivateImport(filePath: string, specifier: string): boolean {
  return PRIVILEGED_ADAPTER_PRIVATE_IMPORTS.has(`${filePath}\0${specifier}`);
}

function isPluginNativeRuntimeDescriptorCodec(filePath: string): boolean {
  return filePath.includes('/src/protocol/')
    || /\/src\/agent\/(?:[^/]+\/)*runtimeDescriptor(?:V\d+)?\.[cm]?[jt]sx?$/u.test(filePath);
}

function hasDuplicateRuntimeDescriptorCompatibilityReader(
  filePath: string,
  keys: ReadonlySet<string>,
): boolean {
  if (isPluginNativeRuntimeDescriptorCodec(filePath)) return false;
  const selectsBothCarriers = keys.has('runtimeDescriptorV1')
    && keys.has('agentRuntimeDescriptorV1');
  const normalizesLegacyProviderShape = keys.has('providerId')
    || keys.has('provider')
    || keys.has('providerExtra');
  return selectsBothCarriers && normalizesLegacyProviderShape;
}

function packageNameForSpecifier(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return null;
  if (NODE_BUILTIN_MODULES.has(specifier) || specifier.startsWith('node:') || /^[a-z]+:/u.test(specifier)) return null;
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return scope && name ? `${scope}/${name}` : null;
  }
  return specifier.split('/')[0] ?? null;
}

interface DeclaredPackageDependencies {
  names: ReadonlySet<string>;
  npmAliasTargets: ReadonlyMap<string, string>;
  hasRuntimeProtocolDependency: boolean;
}

function npmAliasTargetPackage(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('npm:')) return null;
  const target = value.slice('npm:'.length);
  if (target.startsWith('@')) {
    const scopeSeparator = target.indexOf('/');
    if (scopeSeparator < 2) return null;
    const versionSeparator = target.indexOf('@', scopeSeparator + 1);
    const packageName = versionSeparator === -1 ? target : target.slice(0, versionSeparator);
    return packageName.length > scopeSeparator + 1 ? packageName : null;
  }
  const versionSeparator = target.indexOf('@');
  const packageName = versionSeparator === -1 ? target : target.slice(0, versionSeparator);
  return packageName || null;
}

function declaredPackageDependencies(rootDir: string, packageRoot: string): DeclaredPackageDependencies {
  const packageJsonPath = path.join(rootDir, packageRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return {
      names: new Set(),
      npmAliasTargets: new Map(),
      hasRuntimeProtocolDependency: false,
    };
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
  const names = new Set<string>();
  const npmAliasTargets = new Map<string, string>();
  const runtimeDependencies = packageJson.dependencies;
  const hasRuntimeProtocolDependency = Boolean(
    runtimeDependencies
    && typeof runtimeDependencies === 'object'
    && !Array.isArray(runtimeDependencies)
    && Object.prototype.hasOwnProperty.call(runtimeDependencies, '@happier-dev/protocol'),
  );
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'] as const) {
    const dependencies = packageJson[field];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const [name, value] of Object.entries(dependencies)) {
      names.add(name);
      const aliasTarget = npmAliasTargetPackage(value);
      if (aliasTarget) npmAliasTargets.set(name, aliasTarget);
    }
  }
  return { names, npmAliasTargets, hasRuntimeProtocolDependency };
}

function aliasedTargetSpecifier(
  specifier: string,
  packageName: string | null,
  npmAliasTargets: ReadonlyMap<string, string>,
): string {
  if (!packageName) return specifier;
  const targetPackage = npmAliasTargets.get(packageName);
  return targetPackage ? `${targetPackage}${specifier.slice(packageName.length)}` : specifier;
}

function nonLiteralDynamicLoadDetails(dynamicLoad: PluginSourceAnalysis['nonLiteralDynamicLoads'][number]): string {
  switch (dynamicLoad) {
    case 'import()':
      return 'Plugin production dynamic import() must use a string-literal module specifier.';
    case 'require()':
      return 'Plugin production require() must use a string-literal module specifier.';
    case 'module.require()':
      return 'Plugin production module.require() must use a string-literal module specifier.';
    case 'createRequire() loader':
      return 'Plugin production createRequire() loaders must use a string-literal module specifier.';
  }
}

export function validateExtensionImportBoundaries(options?: {
  rootDir?: string;
  inventory?: readonly InventoryFile[];
}): ValidateExtensionImportBoundariesResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const inventory =
    options?.inventory ??
    collectFileInventory({
      rootDir,
      searchRoots: ['packages'],
      include: /\.[cm]?[jt]sx?$/,
    });

  const extensionSourceFiles = inventory.filter((file) => normalizeRepoPath(file.filePath).startsWith('packages/plugins/'));
  if (extensionSourceFiles.length === 0) {
    return {
      ok: true,
      errors: [],
      violations: [],
    };
  }

  const violations: ExtensionImportBoundaryViolation[] = [];
  const publicPluginPackages = publicPluginPackageSpecifiers(rootDir);
  const packageDependencies = new Map<string, DeclaredPackageDependencies>();
  const productionProtocolImportPackages = new Set<string>();

  for (const file of extensionSourceFiles) {
    const filePath = normalizeRepoPath(file.filePath);
    const packageRoot = extensionPackageRootFor(filePath);
    if (!packageRoot) {
      continue;
    }

    const declaredDependencies = packageDependencies.get(packageRoot)
      ?? declaredPackageDependencies(rootDir, packageRoot);
    packageDependencies.set(packageRoot, declaredDependencies);

    const productionSource = isProductionPluginSource(filePath);
    if (!productionSource) continue;

    const analysis = analyzePluginSource(filePath, file.content);

    if (hasDuplicateRuntimeDescriptorCompatibilityReader(
      filePath,
      analysis.runtimeDescriptorCompatibilityKeys,
    )) {
      violations.push({
        filePath,
        specifier: 'runtimeDescriptorV1|agentRuntimeDescriptorV1',
        kind: 'duplicate-runtime-descriptor-compatibility-reader',
        details: 'Generic plugin code must delegate legacy runtime-descriptor carrier/provider normalization to a plugin-native protocol or Agent runtime-descriptor codec.',
      });
    }

    for (const dynamicLoad of analysis.nonLiteralDynamicLoads) {
      violations.push({
        filePath,
        specifier: dynamicLoad,
        kind: 'non-literal-module-specifier',
        details: nonLiteralDynamicLoadDetails(dynamicLoad),
      });
    }

    for (const specifier of analysis.importSpecifiers) {
      if (specifier.startsWith('@/')) {
        violations.push({
          filePath,
          specifier,
          kind: 'forbidden-alias',
          details: 'Extension packages must not import from the CLI @/ alias; use shared workspace packages or injected context.',
        });
        continue;
      }

      if (specifier.startsWith('#')) {
        violations.push({
          filePath,
          specifier,
          kind: 'forbidden-alias',
          details: 'Plugin production package-import aliases (#...) are not an approved public boundary.',
        });
        continue;
      }

      if (specifier.startsWith('apps/')) {
        violations.push({
          filePath,
          specifier,
          kind: 'forbidden-apps-import',
          details: 'Extension packages must not import from apps/**; use shared workspace packages or injected context.',
        });
        continue;
      }

      if (specifier.startsWith('.')) {
        if (isTestSupportImportSpecifier(specifier)) {
          violations.push({
            filePath,
            specifier,
            kind: 'forbidden-test-support-import',
            details: 'Plugin production code must not import test-support or testkit modules.',
          });
          continue;
        }
        const resolved = resolveRelativeImport(filePath, specifier);
        const packageRootPrefix = `${packageRoot}/`;
        const allowed = resolved === packageRoot || resolved.startsWith(packageRootPrefix);
        if (!allowed) {
          violations.push({
            filePath,
            specifier,
            kind: 'relative-escape',
            details: `Relative import resolves outside the extension package root (${packageRoot}): ${resolved}`,
          });
        }
        continue;
      }

      const packageName = packageNameForSpecifier(specifier);
      const boundarySpecifier = aliasedTargetSpecifier(
        specifier,
        packageName,
        declaredDependencies.npmAliasTargets,
      );
      const isProtocolImport = boundarySpecifier === '@happier-dev/protocol'
        || boundarySpecifier.startsWith('@happier-dev/protocol/');
      if (isProtocolImport) {
        productionProtocolImportPackages.add(packageRoot);
        violations.push({
          filePath,
          specifier,
          kind: 'forbidden-protocol-import',
          details: 'Plugin production code must consume public contracts through @happier-dev/plugin-sdk; do not bypass the SDK boundary.',
        });
        continue;
      }

      if (
        boundarySpecifier.startsWith('@happier-dev/')
        && !publicPluginPackages.has(boundarySpecifier)
        && !isPrivilegedAdapterPrivateImport(filePath, specifier)
      ) {
        violations.push({
          filePath,
          specifier,
          kind: 'forbidden-private-happier-import',
          details: 'External-shaped plugin production code may import only public Plugin SDK/UI paths or public feature-protocol package exports.',
        });
        continue;
      }

      if (packageName && !declaredDependencies.names.has(packageName)) {
        violations.push({
          filePath,
          specifier,
          kind: 'undeclared-package-dependency',
          details: `Plugin production import resolves through undeclared package ${JSON.stringify(packageName)}.`,
        });
      }
    }
  }

  for (const [packageRoot, declaredDependencies] of packageDependencies) {
    if (
      declaredDependencies.hasRuntimeProtocolDependency
      && !productionProtocolImportPackages.has(packageRoot)
    ) {
      violations.push({
        filePath: `${packageRoot}/package.json`,
        specifier: '@happier-dev/protocol',
        kind: 'unneeded-runtime-protocol-dependency',
        details: 'Plugin package declares @happier-dev/protocol as a runtime dependency but no production source imports it; move it to devDependencies or remove it.',
      });
    }
  }

  const sortedViolations = violations.sort((a, b) => {
    const fileCmp = a.filePath.localeCompare(b.filePath);
    if (fileCmp !== 0) {
      return fileCmp;
    }
    const kindCmp = a.kind.localeCompare(b.kind);
    if (kindCmp !== 0) {
      return kindCmp;
    }
    return a.specifier.localeCompare(b.specifier);
  });

  const errors = sortedViolations.map(
    (violation) =>
      `${violation.filePath}: forbidden import ${JSON.stringify(violation.specifier)} (${violation.kind}) - ${violation.details}`,
  );

  return {
    ok: errors.length === 0,
    errors,
    violations: sortedViolations,
  };
}
