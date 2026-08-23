import { posix as path } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  isExactCanonicalPublishedVersion,
  projectPublishedInventoryProvenance,
  projectRetainedInventoryProvenance,
} from '../../../scripts/api-governance/publicationProvenance.mjs';

const ENTRYPOINT_KEYS = Object.freeze([
  'specifier',
  'sourceModule',
  'visibility',
  'realm',
  'conditions',
]);
const CONDITION_KEYS = Object.freeze(['types', 'browser', 'react-native', 'default']);
const SYMBOL_KEYS = Object.freeze([
  'specifier',
  'exportName',
  'kind',
  'sourceModule',
  'sourceExport',
  'realm',
  'since',
  'replacement',
  'removalCondition',
]);
const REALMS = new Set(['any', 'browser', 'react-native', 'client', 'daemon', 'build']);
const VISIBILITIES = new Set(['author', 'host']);
const SYMBOL_KINDS = new Set(['type', 'value']);
const HOST_EXPORTS_BY_ENTRYPOINT = new Map([
  ['./host/registration', new Map([
    ['createPluginRegistrationScope', 'value'],
    ['PluginRegistrationRight', 'type'],
    ['PluginAgentRuntimeRegistration', 'type'],
    ['PluginRuntimeRegistration', 'type'],
  ])],
  ['./host/fs/json-owner-file-lock', new Map([
    ['reclaimJsonOwnerFileLockSnapshot', 'value'],
    ['withJsonOwnerFileLock', 'value'],
  ])],
  ['./host/targeted-contributions', new Map([
    ['decodeTargetedContributionPointSemantics', 'value'],
    ['readTargetedContributionPointSemanticRefs', 'value'],
    ['TargetedContributionPointSemanticInput', 'type'],
    ['TargetedContributionPointSemanticOperation', 'type'],
    ['TargetedContributionPointSemanticProjection', 'type'],
    ['TargetedContributionPointSemanticSurface', 'type'],
  ])],
]);
const HOST_REALMS_BY_ENTRYPOINT = new Map([
  ['./host/registration', 'any'],
  ['./host/fs/json-owner-file-lock', 'daemon'],
  ['./host/targeted-contributions', 'daemon'],
]);
const HOST_ENTRYPOINTS = new Set(HOST_EXPORTS_BY_ENTRYPOINT.keys());
const HOST_ONLY_EXPORT_NAMES = new Set(
  [...HOST_EXPORTS_BY_ENTRYPOINT.values()].flatMap((exportsByName) => [...exportsByName.keys()]),
);
const RESERVED_AUTHOR_SPECIFIER_NAMESPACES = Object.freeze([
  './experimental',
  './internal',
  './host',
]);
const SPECIFIER_PATTERN = /^(?:\.|\.\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)$/u;
const SOURCE_MODULE_PATTERN = /^src\/[A-Za-z0-9][A-Za-z0-9._/-]*\.tsx?$/u;
const TYPES_CONDITION_TARGET_PATTERN = /^\.\/dist\/[A-Za-z0-9][A-Za-z0-9._/-]*\.d\.ts$/u;
const RUNTIME_CONDITION_TARGET_PATTERN = /^\.\/dist\/[A-Za-z0-9][A-Za-z0-9._/-]*\.js$/u;
const EXPORT_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

export class ApiSurfaceValidationError extends Error {
  /** @param {readonly string[]} diagnostics */
  constructor(diagnostics) {
    super(`Invalid Plugin SDK API surface:\n- ${diagnostics.join('\n- ')}`);
    this.name = 'ApiSurfaceValidationError';
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unexpectedKeys(value, allowedKeys) {
  if (!isRecord(value)) return [];
  const allowed = new Set(allowedKeys);
  return Object.keys(value).filter((key) => !allowed.has(key)).sort();
}

function hasNormalizedRelativeModule(value) {
  return typeof value === 'string'
    && SOURCE_MODULE_PATTERN.test(value)
    && !value.includes('//')
    && !value.split('/').includes('..')
    && path.normalize(value) === value;
}

function symbolKey(symbol) {
  return `${symbol.specifier}:${symbol.exportName}`;
}

function reservedAuthorSpecifierNamespace(specifier) {
  return RESERVED_AUTHOR_SPECIFIER_NAMESPACES.find((namespace) => (
    specifier === namespace || specifier.startsWith(`${namespace}/`)
  ));
}

function compareCodePoints(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => compareCodePoints(left, right)));
}

function orderPackageExportConditions(conditions) {
  return Object.fromEntries(CONDITION_KEYS
    .filter((condition) => Object.hasOwn(conditions, condition))
    .map((condition) => [condition, conditions[condition]]));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Strictly validates the package-owned product inventory. It runs on what
 * `projectApiSurfaceInventory` produces from package source, so an invalid
 * inventory is always an invalid source declaration.
 *
 * @param {unknown} input
 */
export function validateApiSurfaceInventory(input) {
  const diagnostics = [];
  if (!isRecord(input)) {
    throw new ApiSurfaceValidationError(['inventory must be an object']);
  }
  for (const key of unexpectedKeys(input, ['schemaVersion', 'entrypoints', 'symbols'])) {
    diagnostics.push(`inventory has unknown property ${key}`);
  }
  if (input.schemaVersion !== 1) diagnostics.push('schemaVersion must be 1');
  if (!Array.isArray(input.entrypoints) || input.entrypoints.length === 0) {
    diagnostics.push('entrypoints must be a non-empty array');
  }
  if (!Array.isArray(input.symbols) || input.symbols.length === 0) {
    diagnostics.push('symbols must be a non-empty array');
  }

  const entrypoints = Array.isArray(input.entrypoints) ? input.entrypoints : [];
  const symbols = Array.isArray(input.symbols) ? input.symbols : [];
  const entrypointBySpecifier = new Map();
  const entrypointOwnerBySourceModule = new Map();
  const entrypointSourceModuleByFoldedName = new Map();
  const hostSpecifiers = new Set();

  for (const [index, entrypoint] of entrypoints.entries()) {
    const location = `entrypoints[${index}]`;
    if (!isRecord(entrypoint)) {
      diagnostics.push(`${location} must be an object`);
      continue;
    }
    for (const key of unexpectedKeys(entrypoint, ENTRYPOINT_KEYS)) {
      diagnostics.push(`${location} has unknown property ${key}`);
    }
    if (typeof entrypoint.specifier !== 'string' || !SPECIFIER_PATTERN.test(entrypoint.specifier)) {
      diagnostics.push(`${location}.specifier must be a normalized package export key`);
    } else if (entrypointBySpecifier.has(entrypoint.specifier)) {
      diagnostics.push(`duplicate entrypoint specifier ${entrypoint.specifier}`);
    } else {
      entrypointBySpecifier.set(entrypoint.specifier, entrypoint);
    }
    if (!hasNormalizedRelativeModule(entrypoint.sourceModule)) {
      diagnostics.push(`${location}.sourceModule must be a normalized package-relative src/*.ts module`);
    } else {
      const existingOwner = entrypointOwnerBySourceModule.get(entrypoint.sourceModule);
      if (existingOwner && existingOwner !== entrypoint.specifier) {
        diagnostics.push(
          `entrypoint sourceModule ${entrypoint.sourceModule} is owned by both ${existingOwner} and ${entrypoint.specifier}`,
        );
      } else {
        entrypointOwnerBySourceModule.set(entrypoint.sourceModule, entrypoint.specifier);
      }
      const foldedSourceModule = entrypoint.sourceModule.toLowerCase();
      const existingSourceModule = entrypointSourceModuleByFoldedName.get(foldedSourceModule);
      if (existingSourceModule && existingSourceModule !== entrypoint.sourceModule) {
        diagnostics.push(
          `entrypoint sourceModule ${entrypoint.sourceModule} has a case-insensitive collision with ${existingSourceModule}`,
        );
      } else {
        entrypointSourceModuleByFoldedName.set(foldedSourceModule, entrypoint.sourceModule);
      }
    }
    if (!VISIBILITIES.has(entrypoint.visibility)) {
      diagnostics.push(`${location}.visibility must be author or host`);
    }
    if (!REALMS.has(entrypoint.realm)) diagnostics.push(`${location}.realm is invalid`);
    if (entrypoint.visibility === 'host') {
      hostSpecifiers.add(entrypoint.specifier);
      if (!HOST_ENTRYPOINTS.has(entrypoint.specifier)) {
        diagnostics.push(`${location} declares unapproved host entrypoint ${entrypoint.specifier}`);
      }
      const expectedRealm = HOST_REALMS_BY_ENTRYPOINT.get(entrypoint.specifier);
      if (expectedRealm && entrypoint.realm !== expectedRealm) {
        diagnostics.push(`${location} host entrypoint ${entrypoint.specifier} must have ${expectedRealm} realm`);
      }
    } else if (typeof entrypoint.specifier === 'string') {
      const reservedNamespace = reservedAuthorSpecifierNamespace(entrypoint.specifier);
      if (reservedNamespace) {
        diagnostics.push(
          `${location} author entrypoint cannot use reserved namespace ${entrypoint.specifier}`,
        );
      }
    }

    if (!isRecord(entrypoint.conditions)) {
      diagnostics.push(`${location}.conditions must be an object`);
    } else {
      for (const key of unexpectedKeys(entrypoint.conditions, CONDITION_KEYS)) {
        diagnostics.push(`${location}.conditions has unknown property ${key}`);
      }
      if (!TYPES_CONDITION_TARGET_PATTERN.test(entrypoint.conditions.types ?? '')) {
        diagnostics.push(`${location}.conditions.types must be a ./dist/*.d.ts target`);
      }
      for (const condition of ['browser', 'react-native', 'default']) {
        const target = entrypoint.conditions[condition];
        if (target !== undefined && !RUNTIME_CONDITION_TARGET_PATTERN.test(target)) {
          diagnostics.push(`${location}.conditions.${condition} must be a ./dist/*.js target`);
        }
      }
      if (entrypoint.realm === 'browser' && !entrypoint.conditions.browser && !entrypoint.conditions.default) {
        diagnostics.push(`${location} browser entrypoint needs browser or default output`);
      }
      if (entrypoint.realm === 'react-native' && !entrypoint.conditions['react-native']) {
        diagnostics.push(`${location} react-native entrypoint needs react-native output`);
      }
      if (entrypoint.realm === 'client') {
        for (const condition of ['browser', 'react-native', 'default']) {
          if (!entrypoint.conditions[condition]) {
            diagnostics.push(`${location} client entrypoint needs ${condition} output`);
          }
        }
      }
      if (
        (entrypoint.realm === 'daemon' || entrypoint.realm === 'build')
        && !entrypoint.conditions.default
      ) {
        diagnostics.push(`${location} ${entrypoint.realm} entrypoint needs default output`);
      }
      if (
        (entrypoint.realm === 'daemon' || entrypoint.realm === 'build')
        && (entrypoint.conditions.browser || entrypoint.conditions['react-native'])
      ) {
        diagnostics.push(`${location} ${entrypoint.realm} entrypoint cannot expose client conditions`);
      }
      if (entrypoint.specifier === './host/registration') {
        for (const condition of ['browser', 'react-native', 'default']) {
          if (!entrypoint.conditions[condition]) {
            diagnostics.push(`${location} host registration entrypoint needs ${condition} output`);
          }
        }
      }
    }
  }

  for (const requiredHostSpecifier of HOST_ENTRYPOINTS) {
    if (!hostSpecifiers.has(requiredHostSpecifier)) {
      diagnostics.push(`missing approved host entrypoint ${requiredHostSpecifier}`);
    }
  }

  const exactSymbolKeys = new Set();
  const authorOwnerByName = new Map();
  const symbolCountBySpecifier = new Map();
  const hostExportKindsByEntrypoint = new Map();
  for (const [index, symbol] of symbols.entries()) {
    const location = `symbols[${index}]`;
    if (!isRecord(symbol)) {
      diagnostics.push(`${location} must be an object`);
      continue;
    }
    for (const key of unexpectedKeys(symbol, SYMBOL_KEYS)) {
      diagnostics.push(`${location} has unknown property ${key}`);
    }
    const entrypoint = entrypointBySpecifier.get(symbol.specifier);
    if (!entrypoint) {
      diagnostics.push(`${location} references undeclared entrypoint ${String(symbol.specifier)}`);
    } else {
      symbolCountBySpecifier.set(symbol.specifier, (symbolCountBySpecifier.get(symbol.specifier) ?? 0) + 1);
    }
    if (!EXPORT_NAME_PATTERN.test(symbol.exportName ?? '')) {
      diagnostics.push(`${location}.exportName must be an identifier`);
    }
    if (!EXPORT_NAME_PATTERN.test(symbol.sourceExport ?? '')) {
      diagnostics.push(`${location}.sourceExport must be an identifier`);
    }
    if (!SYMBOL_KINDS.has(symbol.kind)) diagnostics.push(`${location}.kind must be type or value`);
    if (!hasNormalizedRelativeModule(symbol.sourceModule)) {
      diagnostics.push(`${location}.sourceModule must be a normalized package-relative src/*.ts module`);
    }
    if (
      typeof symbol.sourceModule === 'string'
      && entrypointSourceModuleByFoldedName.has(symbol.sourceModule.toLowerCase())
    ) {
      diagnostics.push(`${location}.sourceModule must be the canonical sourceModule, not a generated barrel`);
    }
    if (!REALMS.has(symbol.realm)) diagnostics.push(`${location}.realm is invalid`);
    if (
      symbol.since !== undefined
      && !isExactCanonicalPublishedVersion(symbol.since)
    ) {
      diagnostics.push(`${location}.since must be exact canonical semver`);
    }

    if (entrypoint?.visibility === 'host') {
      const hostExportKinds = hostExportKindsByEntrypoint.get(symbol.specifier) ?? new Map();
      if (typeof symbol.exportName === 'string') {
        hostExportKinds.set(symbol.exportName, symbol.kind);
      }
      hostExportKindsByEntrypoint.set(symbol.specifier, hostExportKinds);
      const expectedKind = HOST_EXPORTS_BY_ENTRYPOINT.get(symbol.specifier)?.get(symbol.exportName);
      const expectedRealm = HOST_REALMS_BY_ENTRYPOINT.get(symbol.specifier);
      if (!expectedKind) {
        diagnostics.push(`${location} declares unapproved host export ${symbolKey(symbol)}`);
      } else if (symbol.kind !== expectedKind) {
        diagnostics.push(`${location} host export ${symbolKey(symbol)} must have ${expectedKind} kind`);
      }
      if (expectedRealm && symbol.realm !== expectedRealm) {
        diagnostics.push(`${location} host export ${symbolKey(symbol)} must have ${expectedRealm} realm`);
      }
    }

    const key = symbolKey(symbol);
    if (exactSymbolKeys.has(key)) diagnostics.push(`duplicate symbol ${key}`);
    exactSymbolKeys.add(key);

    if (entrypoint?.visibility === 'author') {
      if (HOST_ONLY_EXPORT_NAMES.has(symbol.exportName) || HOST_ONLY_EXPORT_NAMES.has(symbol.sourceExport)) {
        diagnostics.push(
          `${location} author symbol cannot expose host-only export ${String(symbol.exportName)}`,
        );
      }
      if (typeof symbol.sourceModule === 'string' && symbol.sourceModule.startsWith('src/host/')) {
        diagnostics.push(`${location} author symbol cannot project a src/host/** source owner`);
      }
      const existingOwner = authorOwnerByName.get(symbol.exportName);
      if (existingOwner && existingOwner !== symbol.specifier) {
        diagnostics.push(
          `author-visible name ${symbol.exportName} appears on both ${existingOwner} and ${symbol.specifier}`,
        );
      } else {
        authorOwnerByName.set(symbol.exportName, symbol.specifier);
      }
    }

    const hasReplacement = symbol.replacement !== undefined;
    const hasRemovalCondition = symbol.removalCondition !== undefined;
    if (hasReplacement !== hasRemovalCondition) {
      diagnostics.push(`${location} deprecation requires replacement and removalCondition together`);
    }
    if (hasReplacement && (typeof symbol.replacement !== 'string' || symbol.replacement.length === 0)) {
      diagnostics.push(`${location} deprecation replacement must be a non-empty string`);
    }
    if (
      hasRemovalCondition
      && (typeof symbol.removalCondition !== 'string' || symbol.removalCondition.length === 0)
    ) {
      diagnostics.push(`${location} deprecation removalCondition must be a non-empty string`);
    }
  }

  for (const entrypoint of entrypoints) {
    if (isRecord(entrypoint) && !symbolCountBySpecifier.has(entrypoint.specifier)) {
      diagnostics.push(`entrypoint ${String(entrypoint.specifier)} has no symbols`);
    }
  }

  for (const [hostSpecifier, approvedExports] of HOST_EXPORTS_BY_ENTRYPOINT) {
    const actualExports = hostExportKindsByEntrypoint.get(hostSpecifier) ?? new Map();
    for (const [exportName, kind] of approvedExports) {
      if (!actualExports.has(exportName)) {
        diagnostics.push(
          `host entrypoint ${hostSpecifier} is missing approved export ${exportName} (${kind})`,
        );
      }
    }
  }

  if (diagnostics.length > 0) throw new ApiSurfaceValidationError(diagnostics);
  return deepFreeze(structuredClone(input));
}

/** Reads and validates the package-owned inventory at every filesystem boundary. */
export async function readValidatedApiSurfaceInventory(inventoryPath) {
  return validateApiSurfaceInventory(JSON.parse(await readFile(inventoryPath, 'utf8')));
}

/**
 * Distinguishes a not-yet-generated inventory from a malformed one, for the
 * readers that consume the generated artifact rather than produce it.
 */
export async function readValidatedApiSurfaceInventoryIfPresent(inventoryPath) {
  try {
    return Object.freeze({
      status: 'available',
      inventory: await readValidatedApiSurfaceInventory(inventoryPath),
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ status: 'missing' });
    throw error;
  }
}

function entrypointModule(specifier, filename) {
  return specifier === '.' ? `src/${filename}` : `src/${specifier.slice(2)}/${filename}`;
}

function entrypointSourceModule(specifier) {
  return entrypointModule(specifier, 'index.ts');
}

function entrypointPublicationSourceModule(specifier) {
  return entrypointModule(specifier, 'index.public.ts');
}

function entrypointOutputBase(specifier) {
  return specifier === '.' ? 'index' : `${specifier.slice(2)}/index`;
}

function deriveEntrypointRealm(symbols) {
  const valueRealms = new Set(
    symbols.filter((symbol) => symbol.kind === 'value').map((symbol) => symbol.realm),
  );
  valueRealms.delete('any');
  if (valueRealms.size > 1) {
    throw new ApiSurfaceValidationError([
      `entrypoint ${symbols[0]?.specifier ?? '<empty>'} has incompatible value realms ${[...valueRealms].sort(compareCodePoints).join(', ')}`,
    ]);
  }
  return valueRealms.values().next().value ?? 'any';
}

function deriveEntrypoint(specifier, visibility, symbols, browserRuntimeTarget) {
  const realm = visibility === 'host'
    ? HOST_REALMS_BY_ENTRYPOINT.get(specifier) ?? deriveEntrypointRealm(symbols)
    : deriveEntrypointRealm(symbols);
  const outputBase = entrypointOutputBase(specifier);
  const runtimeTarget = `./dist/${outputBase}.js`;
  const conditions = { types: `./dist/${outputBase}.d.ts` };
  if (
    browserRuntimeTarget
    || realm === 'browser'
    || realm === 'client'
    || (visibility === 'host' && realm === 'any')
  ) conditions.browser = browserRuntimeTarget ?? runtimeTarget;
  if (
    realm === 'react-native'
    || realm === 'client'
    || (visibility === 'host' && realm === 'any')
  ) conditions['react-native'] = runtimeTarget;
  conditions.default = runtimeTarget;
  return {
    specifier,
    sourceModule: entrypointSourceModule(specifier),
    visibility,
    realm,
    conditions,
  };
}

/** Package-relative generated entrypoint barrel every published specifier materializes to. */
export function apiSurfaceEntrypointSourceModule(specifier) {
  return entrypointSourceModule(specifier);
}

/** Package-relative author-owned named-reexport publication spec every entrypoint reads from. */
export function apiSurfaceEntrypointPublicationSourceModule(specifier) {
  return entrypointPublicationSourceModule(specifier);
}

/** Package-relative realm-split browser entry a specifier publishes when present. */
export function apiSurfaceEntrypointBrowserSourceModule(specifier) {
  return `src/${entrypointOutputBase(specifier)}.browser.ts`;
}

/** `./dist` browser condition target for a realm-split browser entry. */
export function apiSurfaceEntrypointBrowserRuntimeTarget(specifier) {
  return `./dist/${entrypointOutputBase(specifier)}.browser.js`;
}

/**
 * The single producer of the package-owned inventory. Its whole input is what
 * package source publishes: the author-owned publication specs, what each
 * spec re-exports, and the realm each canonical declaration carries. Nothing
 * is read back out of generated barrels, package exports, or
 * `api-surface.json`, so regenerating can never strip a symbol source already
 * publishes.
 *
 * @param {{ entrypoints: readonly Readonly<{
 *   specifier: string,
 *   browserRuntimeTarget?: string,
 *   symbols: readonly Readonly<{
 *     exportName: string,
 *     kind: 'type' | 'value',
 *     sourceModule: string,
 *     sourceExport: string,
 *     realm: string,
 *     replacement?: string,
 *     removalCondition?: string,
 *   }>[],
 * }>[] }} input
 */
export function projectApiSurfaceInventory(input) {
  const entrypoints = [];
  const symbols = [];
  const publishedEntrypoints = [...input.entrypoints]
    .sort((left, right) => compareCodePoints(left.specifier, right.specifier));
  for (const published of publishedEntrypoints) {
    const visibility = HOST_ENTRYPOINTS.has(published.specifier) ? 'host' : 'author';
    const entrypointSymbols = published.symbols
      .map((symbol) => {
        if (Object.hasOwn(symbol, 'stability')) {
          throw new ApiSurfaceValidationError([
            `publication symbol ${published.specifier}:${symbol.exportName} uses retired per-symbol stability metadata`,
          ]);
        }
        if (Object.hasOwn(symbol, 'since')) {
          throw new ApiSurfaceValidationError([
            `publication symbol ${published.specifier}:${symbol.exportName} uses publisher-owned @since metadata`,
          ]);
        }
        const row = {
          specifier: published.specifier,
          exportName: symbol.exportName,
          kind: symbol.kind,
          sourceModule: symbol.sourceModule,
          sourceExport: symbol.sourceExport,
          realm: symbol.realm,
        };
        if (symbol.replacement !== undefined || symbol.removalCondition !== undefined) {
          row.replacement = symbol.replacement;
          row.removalCondition = symbol.removalCondition;
        }
        return row;
      })
      .sort((left, right) => compareCodePoints(symbolKey(left), symbolKey(right)));
    entrypoints.push(deriveEntrypoint(
      published.specifier,
      visibility,
      entrypointSymbols,
      published.browserRuntimeTarget,
    ));
    symbols.push(...entrypointSymbols);
  }
  return validateApiSurfaceInventory({ schemaVersion: 1, entrypoints, symbols });
}

/**
 * Projects the inventory included in one official SDK publication. Publication
 * is the sole owner of the current package version and of retaining the
 * immediately previous official inventory. A previous inventory already
 * carries every earlier first-publication fact, so this needs no parallel
 * per-symbol registry or author-maintained source tags.
 *
 * @param {{
 *   inventory: unknown,
 *   publishedVersion: string,
 *   previousPublishedInventory?: unknown,
 * }} input
 */
export function projectPublishedApiSurfaceInventory(input) {
  if (!isRecord(input)) {
    throw new ApiSurfaceValidationError(['published inventory input must be an object']);
  }
  return projectPublishedInventoryProvenance({
    inventory: input.inventory,
    publishedVersion: input.publishedVersion,
    previousPublishedInventory: input.previousPublishedInventory,
    validateInventory: validateApiSurfaceInventory,
    symbols: (inventory) => inventory.symbols,
    symbolKey,
    createError: (diagnostic) => new ApiSurfaceValidationError([diagnostic]),
  });
}

/**
 * Reapplies only publication-owned `@since` facts retained in the generated
 * inventory to the current source-owned surface. New source symbols remain
 * unstamped until the next actual publication, while removed symbols cannot
 * survive because this starts from the current source inventory.
 *
 * @param {{
 *   inventory: unknown,
 *   retainedPublishedInventory: unknown,
 * }} input
 */
export function projectRetainedPublishedApiSurfaceInventory(input) {
  if (!isRecord(input)) {
    throw new ApiSurfaceValidationError(['retained published inventory input must be an object']);
  }
  return projectRetainedInventoryProvenance({
    inventory: input.inventory,
    retainedPublishedInventory: input.retainedPublishedInventory,
    validateInventory: validateApiSurfaceInventory,
    symbols: (inventory) => inventory.symbols,
    symbolKey,
    createError: (diagnostic) => new ApiSurfaceValidationError([diagnostic]),
  });
}

function moduleSpecifier(barrelModule, sourceModule) {
  const relativeModule = path.relative(path.dirname(barrelModule), sourceModule)
    .replace(/\.tsx?$/u, '.js');
  return relativeModule.startsWith('.') ? relativeModule : `./${relativeModule}`;
}

function symbolDocumentationDoc(symbol) {
  const tags = [];
  if (symbol.since !== undefined) tags.push(`@since ${symbol.since}`);
  if (symbol.replacement !== undefined) {
    tags.push(`@deprecated ${symbol.replacement}; remove when ${symbol.removalCondition}`);
  }
  if (tags.length === 0) return '';
  if (tags.length === 1) return `/** ${tags[0]} */\n`;
  return `/**\n${tags.map((tag) => ` * ${tag}`).join('\n')}\n */\n`;
}

function renderBarrel(entrypoint, symbols) {
  return `${symbols.map((symbol) => {
    const importedName = symbol.sourceExport === symbol.exportName
      ? symbol.exportName
      : `${symbol.sourceExport} as ${symbol.exportName}`;
    return `${symbolDocumentationDoc(symbol)}export${symbol.kind === 'type' ? ' type' : ''} { ${importedName} } from '${moduleSpecifier(entrypoint.sourceModule, symbol.sourceModule)}';`;
  }).join('\n')}\n`;
}

/**
 * Produces the complete deterministic output plan consumed by the later atomic
 * EU-3/EU-4 writer. It intentionally returns bytes/data only and never mutates
 * package.json, barrels, declarations, docs, or tests.
 *
 * @param {unknown} input
 */
export function createApiSurfaceGenerationPlan(input) {
  const inventory = validateApiSurfaceInventory(input);
  const entrypoints = [...inventory.entrypoints]
    .sort((left, right) => compareCodePoints(left.specifier, right.specifier));
  const symbols = [...inventory.symbols]
    .sort((left, right) => compareCodePoints(symbolKey(left), symbolKey(right)));
  const symbolsBySpecifier = new Map(entrypoints.map((entrypoint) => [entrypoint.specifier, []]));
  for (const symbol of symbols) symbolsBySpecifier.get(symbol.specifier).push(symbol);

  const packageExports = {};
  const sourceBarrels = {};
  const authorDeclarationAssertions = {};
  const testkitAssertions = {};
  const authorDocumentationRows = [];
  const hasAuthorSince = symbols.some((symbol) => (
    symbol.since !== undefined
    && entrypoints.find((entrypoint) => entrypoint.specifier === symbol.specifier)?.visibility === 'author'
  ));
  for (const entrypoint of entrypoints) {
    const entrypointSymbols = symbolsBySpecifier.get(entrypoint.specifier);
    packageExports[entrypoint.specifier] = orderPackageExportConditions(entrypoint.conditions);
    sourceBarrels[entrypoint.sourceModule] = renderBarrel(entrypoint, entrypointSymbols);
    if (entrypoint.visibility !== 'author') continue;
    const names = entrypointSymbols.map((symbol) => symbol.exportName).sort(compareCodePoints);
    authorDeclarationAssertions[entrypoint.specifier] = names;
    testkitAssertions[entrypoint.specifier] = names;
    for (const symbol of entrypointSymbols) {
      authorDocumentationRows.push(
        `| \`${entrypoint.specifier}\` | \`${symbol.exportName}\` | ${symbol.kind} | ${symbol.realm}${hasAuthorSince ? ` | ${symbol.since ?? ''}` : ''} |`,
      );
    }
  }

  return deepFreeze({
    packageExports: sortRecord(packageExports),
    sourceBarrels: sortRecord(sourceBarrels),
    authorDeclarationAssertions: sortRecord(authorDeclarationAssertions),
    authorApiMarkdown: [
      '# Plugin SDK API surface',
      '',
      '> This package is Developer Preview.',
      '> `capability-matrix.json` records public-family availability with its proving consumer or explicit deferred disposition.',
      '> Generated from `api-surface.json`. Do not hand-edit.',
      '',
      `| Specifier | Export | Kind | Realm${hasAuthorSince ? ' | Since' : ''} |`,
      `|---|---|---|---${hasAuthorSince ? '|---' : ''}|`,
      ...authorDocumentationRows,
      '',
    ].join('\n'),
    testkitAssertions: sortRecord(testkitAssertions),
  });
}
