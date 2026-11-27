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
  const nodeModuleNamespaces = new Set<string>();
  const commonRequireLoaderNames = new Set(['require']);
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

  const propertyAccess = (expression: ts.Expression): { owner: ts.Expression; name: string } | null => {
    if (ts.isPropertyAccessExpression(expression)) {
      return { owner: expression.expression, name: expression.name.text };
    }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)) {
      return { owner: expression.expression, name: expression.argumentExpression.text };
    }
    return null;
  };
  const isModuleRequire = (expression: ts.Expression): boolean => {
    const property = propertyAccess(expression);
    return property?.name === 'require' && ts.isIdentifier(property.owner) && property.owner.text === 'module';
  };
  const isCommonRequireLoader = (expression: ts.Expression): boolean => (
    ts.isIdentifier(expression) && commonRequireLoaderNames.has(expression.text) || isModuleRequire(expression)
  );
  const isNodeModuleNamespace = (expression: ts.Expression): boolean => (
    ts.isAwaitExpression(expression) && isNodeModuleNamespace(expression.expression)
    ||
    ts.isIdentifier(expression) && nodeModuleNamespaces.has(expression.text)
    || ts.isCallExpression(expression)
      && (isCommonRequireLoader(expression.expression) || expression.expression.kind === ts.SyntaxKind.ImportKeyword)
      && !!expression.arguments[0] && ts.isStringLiteralLike(expression.arguments[0])
      && ['node:module', 'module'].includes(expression.arguments[0].text)
  );
  const isCreateRequireFactory = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression) && createRequireFactoryNames.has(expression.text)) return true;
    const property = propertyAccess(expression);
    return property?.name === 'createRequire' && isNodeModuleNamespace(property.owner);
  };
  const isCreateRequireLoader = (expression: ts.Expression): boolean => (
    ts.isIdentifier(expression) && createRequireLoaderNames.has(expression.text)
    || ts.isCallExpression(expression) && isCreateRequireFactory(expression.expression)
  );

  for (const statement of sourceFile.statements) {
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression && ts.isStringLiteralLike(statement.moduleReference.expression)
      && ['node:module', 'module'].includes(statement.moduleReference.expression.text)) {
      nodeModuleNamespaces.add(statement.name.text);
    }
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)
      || !['node:module', 'module'].includes(statement.moduleSpecifier.text) || !statement.importClause) continue;
    if (statement.importClause.name) nodeModuleNamespaces.add(statement.importClause.name.text);
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) nodeModuleNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'createRequire') createRequireFactoryNames.add(element.name.text);
      }
    }
  }

  const collectCreateRequireLoaders = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        if (isCommonRequireLoader(node.initializer)) commonRequireLoaderNames.add(node.name.text);
        if (isNodeModuleNamespace(node.initializer)) nodeModuleNamespaces.add(node.name.text);
        if (isCreateRequireFactory(node.initializer)) createRequireFactoryNames.add(node.name.text);
        if (isCreateRequireLoader(node.initializer)) createRequireLoaderNames.add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name) && isNodeModuleNamespace(node.initializer)) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          if ((ts.isIdentifier(property) || ts.isStringLiteralLike(property)) && property.text === 'createRequire'
            && ts.isIdentifier(element.name)) createRequireFactoryNames.add(element.name.text);
        }
      }
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
        : ts.isIdentifier(node.expression) && commonRequireLoaderNames.has(node.expression.text)
          ? 'require()'
          : isModuleRequire(node.expression)
            ? 'module.require()'
            : isCreateRequireLoader(node.expression)
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
    && !/\.d\.[cm]?ts$/u.test(filePath)
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
    const analysis = analyzePluginSource(filePath, source.content);
    if (analysis.nonLiteralDynamicLoads.length > 0) return false;
    const dependencies = declaredPackageDependencies(rootDir, packageRoot);
    for (const specifier of analysis.importSpecifiers) {
      const target = aliasedTargetSpecifier(specifier, packageNameForSpecifier(specifier), dependencies.npmAliasTargets);
      if (forbiddenImport(filePath, specifier, target, packageRoot, publicAuthorSurface)) return false;
    }
  }
  return productionSourceCount > 0;
}

function publicPluginPackageSpecifiers(rootDir: string): ReadonlySet<string> {
  const specifiers = new Set<string>([
    '@happier-dev/plugin-sdk',
    '@happier-dev/plugin-ui',
  ]);

  // The SDK's committed package exports are generated from its author
  // publication specs. Host entrypoints live only under the reserved `./host`
  // namespace (the API-surface validator rejects any author entrypoint there),
  // so every other export key is an author entrypoint.
  const pluginSdkPackageJsonPath = path.join(rootDir, 'packages/plugin-sdk/package.json');
  if (existsSync(pluginSdkPackageJsonPath)) {
    const packageJson = JSON.parse(readFileSync(pluginSdkPackageJsonPath, 'utf8')) as {
      exports?: unknown;
    };
    if (packageJson.exports && typeof packageJson.exports === 'object' && !Array.isArray(packageJson.exports)) {
      for (const exportKey of Object.keys(packageJson.exports)) {
        if (exportKey === './host' || exportKey.startsWith('./host/')) continue;
        const specifier = packageSpecifierForExportKey('@happier-dev/plugin-sdk', exportKey);
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

    // Public shared packages may depend on other admitted public packages. Grow
    // from the existing author surface until no more packages qualify; host
    // imports and dependency cycles without a public leaf never enter it.
    const pending = new Map([...manifests].filter(([, manifest]) => (
      manifest.private === false && typeof manifest.name === 'string'
      && manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports)
    )));
    let admitted: boolean;
    do {
      admitted = false;
      for (const [packageName, manifest] of pending) {
        if (!isAuthoredAgainstPublicSurfaceOnly(rootDir, `packages/${packageName}`, specifiers)) continue;
        for (const exportKey of Object.keys(manifest.exports as Record<string, unknown>)) {
          const specifier = packageSpecifierForExportKey(manifest.name as string, exportKey);
          if (specifier) specifiers.add(specifier);
        }
        pending.delete(packageName);
        admitted = true;
      }
    } while (admitted);

  }

  return specifiers;
}

function isHostProtocolSpecifier(specifier: string): boolean {
  return specifier === '@happier-dev/protocol' || specifier.startsWith('@happier-dev/protocol/');
}

function forbiddenImport(
  filePath: string,
  specifier: string,
  boundarySpecifier: string,
  packageRoot: string,
  publicPackages: ReadonlySet<string>,
): ExtensionImportBoundaryViolation | null {
  const violation = (kind: ExtensionImportBoundaryViolation['kind'], details: string): ExtensionImportBoundaryViolation => (
    { filePath, specifier, kind, details }
  );
  if (specifier.startsWith('@/')) {
    return violation('forbidden-alias', 'Extension packages must not import from the CLI @/ alias; use shared workspace packages or injected context.');
  }
  if (specifier.startsWith('#')) {
    return violation('forbidden-alias', 'Plugin production package-import aliases (#...) are not an approved public boundary.');
  }
  if (specifier.startsWith('apps/')) {
    return violation('forbidden-apps-import', 'Extension packages must not import from apps/**; use shared workspace packages or injected context.');
  }
  if (specifier.startsWith('.')) {
    if (isTestSupportImportSpecifier(specifier)) {
      return violation('forbidden-test-support-import', 'Plugin production code must not import test-support or testkit modules.');
    }
    const resolved = resolveRelativeImport(filePath, specifier);
    return resolved === packageRoot || resolved.startsWith(`${packageRoot}/`) ? null
      : violation('relative-escape', `Relative import resolves outside the extension package root (${packageRoot}): ${resolved}`);
  }
  if (isHostProtocolSpecifier(boundarySpecifier)) {
    return violation('forbidden-protocol-import', 'Plugin production code must consume public contracts through @happier-dev/plugin-sdk; do not bypass the SDK boundary.');
  }
  if (boundarySpecifier.startsWith('@happier-dev/') && !publicPackages.has(boundarySpecifier)) {
    return violation('forbidden-private-happier-import', 'External-shaped plugin production code may import only public Plugin SDK/UI paths or public feature-protocol package exports.');
  }
  return null;
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

function collectChangedPluginInventory(rootDir: string, changedFiles: readonly string[]): InventoryFile[] {
  const inventory = new Map<string, InventoryFile>();
  for (const changedFile of changedFiles) {
    const filePath = normalizeRepoPath(changedFile);
    const packageRoot = extensionPackageRootFor(filePath);
    if (!packageRoot) continue;
    if (filePath === `${packageRoot}/package.json`) {
      for (const file of collectFileInventory({ rootDir, searchRoots: [`${packageRoot}/src`], include: /\.[cm]?[jt]sx?$/ })) {
        inventory.set(file.filePath, file);
      }
    } else if (/\.[cm]?[jt]sx?$/u.test(filePath) && existsSync(path.join(rootDir, filePath))) {
      inventory.set(filePath, { filePath, content: readFileSync(path.join(rootDir, filePath), 'utf8') });
    }
  }
  return [...inventory.values()];
}

export function validateExtensionImportBoundaries(options?: {
  rootDir?: string;
  inventory?: readonly InventoryFile[];
  changedFiles?: readonly string[];
}): ValidateExtensionImportBoundariesResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const inventory =
    options?.inventory ??
    (options?.changedFiles ? collectChangedPluginInventory(rootDir, options.changedFiles) : collectFileInventory({
      rootDir,
      searchRoots: ['packages'],
      include: /\.[cm]?[jt]sx?$/,
    }));

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
      const packageName = packageNameForSpecifier(specifier);
      const boundarySpecifier = aliasedTargetSpecifier(specifier, packageName, declaredDependencies.npmAliasTargets);
      if (isHostProtocolSpecifier(boundarySpecifier)) {
        productionProtocolImportPackages.add(packageRoot);
      }
      const violation = forbiddenImport(filePath, specifier, boundarySpecifier, packageRoot, publicPluginPackages);
      if (violation) {
        violations.push(violation);
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
      && (!options?.changedFiles || !collectFileInventory({ rootDir, searchRoots: [`${packageRoot}/src`], include: /\.[cm]?[jt]sx?$/ })
        .some(file => isProductionPluginSource(file.filePath) && analyzePluginSource(file.filePath, file.content).importSpecifiers
          .some(specifier => {
            const target = aliasedTargetSpecifier(specifier, packageNameForSpecifier(specifier), declaredDependencies.npmAliasTargets);
            return isHostProtocolSpecifier(target);
          })))
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
