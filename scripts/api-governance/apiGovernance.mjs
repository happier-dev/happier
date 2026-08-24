import {
  lstat,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertInventoryMatchesPreparedDeclarationSurface,
  projectPreparedDeclarationSurface,
  readPreparedDeclarationEntrypoints,
} from './emittedDeclarationSurface.mjs';
import { summarizeDeclarationDiff } from './declarationDiff.mjs';
import {
  isExactCanonicalPublishedVersion,
  projectPublishedInventoryProvenance,
  projectRetainedInventoryProvenance,
} from './publicationProvenance.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRYPOINT_INVENTORY_KEYS = Object.freeze(['schemaVersion', 'packageName', 'entrypoints', 'symbols']);
const ENTRYPOINT_INVENTORY_ENTRYPOINT_KEYS = Object.freeze(['specifier', 'declarationModule']);
const ENTRYPOINT_INVENTORY_SYMBOL_KEYS = Object.freeze([
  'specifier',
  'exportName',
  'kind',
  'declarationModule',
  'declarationExport',
  'since',
  'replacement',
  'removalCondition',
]);
const ENTRYPOINT_INVENTORY_SYMBOL_KINDS = new Set(['type', 'value']);
const ENTRYPOINT_INVENTORY_DECLARATION_MODULE = /^dist\/[A-Za-z0-9][A-Za-z0-9._/-]*\.d\.ts$/u;

/**
 * The only registry of public-package API-record generators. Profiles select
 * existing package-local source projections where they already own one; they
 * do not give one package permission to import another package's internals.
 */
export const API_GOVERNANCE_PROFILES = Object.freeze({
  'plugin-sdk': Object.freeze({
    id: 'plugin-sdk',
    packageName: '@happier-dev/plugin-sdk',
    packageRoot: 'packages/plugin-sdk',
    kind: 'plugin-sdk',
    declarationTitle: 'Plugin SDK public declaration report',
  }),
  'plugin-ui': Object.freeze({
    id: 'plugin-ui',
    packageName: '@happier-dev/plugin-ui',
    packageRoot: 'packages/plugin-ui',
    kind: 'entrypoint-declarations',
    title: 'Plugin UI public API',
    declarationTitle: 'Plugin UI public declaration report',
  }),
  sdk: Object.freeze({
    id: 'sdk',
    packageName: '@happier-dev/sdk',
    packageRoot: 'packages/sdk',
    kind: 'entrypoint-declarations',
    title: 'SDK public API',
    declarationTitle: 'SDK public declaration report',
  }),
});

function compareCodePoints(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unexpectedKeys(value, allowedKeys) {
  if (!isRecord(value)) return [];
  const allowed = new Set(allowedKeys);
  return Object.keys(value).filter((key) => !allowed.has(key)).sort(compareCodePoints);
}

function entrypointSymbolKey(symbol) {
  return `${symbol.specifier}:${symbol.exportName}`;
}

/**
 * Validates the generic package inventory at its persistence/import boundary.
 * It intentionally owns no census logic: the shared declaration traversal
 * above remains the sole source for the current package rows.
 */
function validateEntrypointInventory(input, packageName) {
  const diagnostics = [];
  if (!isRecord(input)) {
    throw new Error('Public API governance inventory must be an object');
  }
  const rootUnexpected = unexpectedKeys(input, ENTRYPOINT_INVENTORY_KEYS);
  if (rootUnexpected.length > 0) {
    diagnostics.push(`inventory has unexpected keys: ${rootUnexpected.join(', ')}`);
  }
  if (input.schemaVersion !== 1) diagnostics.push('inventory.schemaVersion must be 1');
  if (input.packageName !== packageName) {
    diagnostics.push(`inventory.packageName must be ${packageName}`);
  }

  const entrypoints = [];
  const entrypointBySpecifier = new Map();
  if (!Array.isArray(input.entrypoints)) {
    diagnostics.push('inventory.entrypoints must be an array');
  } else {
    for (const [index, entrypoint] of input.entrypoints.entries()) {
      const location = `inventory.entrypoints[${index}]`;
      if (!isRecord(entrypoint)) {
        diagnostics.push(`${location} must be an object`);
        continue;
      }
      const entrypointUnexpected = unexpectedKeys(entrypoint, ENTRYPOINT_INVENTORY_ENTRYPOINT_KEYS);
      if (entrypointUnexpected.length > 0) {
        diagnostics.push(`${location} has unexpected keys: ${entrypointUnexpected.join(', ')}`);
      }
      const validSpecifier = typeof entrypoint.specifier === 'string'
        && (entrypoint.specifier === '.' || entrypoint.specifier.startsWith('./'));
      if (!validSpecifier) diagnostics.push(`${location}.specifier must be a package export specifier`);
      const validDeclarationModule = typeof entrypoint.declarationModule === 'string'
        && ENTRYPOINT_INVENTORY_DECLARATION_MODULE.test(entrypoint.declarationModule)
        && !entrypoint.declarationModule.includes('//')
        && !entrypoint.declarationModule.split('/').includes('..');
      if (!validDeclarationModule) diagnostics.push(`${location}.declarationModule must be a normalized dist/*.d.ts module`);
      if (validSpecifier && entrypointBySpecifier.has(entrypoint.specifier)) {
        diagnostics.push(`${location}.specifier duplicates ${entrypoint.specifier}`);
      }
      if (validSpecifier && validDeclarationModule && !entrypointBySpecifier.has(entrypoint.specifier)) {
        const normalized = Object.freeze({
          specifier: entrypoint.specifier,
          declarationModule: entrypoint.declarationModule,
        });
        entrypointBySpecifier.set(normalized.specifier, normalized);
        entrypoints.push(normalized);
      }
    }
  }

  const symbols = [];
  const symbolKeys = new Set();
  if (!Array.isArray(input.symbols)) {
    diagnostics.push('inventory.symbols must be an array');
  } else {
    for (const [index, symbol] of input.symbols.entries()) {
      const location = `inventory.symbols[${index}]`;
      if (!isRecord(symbol)) {
        diagnostics.push(`${location} must be an object`);
        continue;
      }
      const symbolUnexpected = unexpectedKeys(symbol, ENTRYPOINT_INVENTORY_SYMBOL_KEYS);
      if (symbolUnexpected.length > 0) {
        diagnostics.push(`${location} has unexpected keys: ${symbolUnexpected.join(', ')}`);
      }
      const validSpecifier = typeof symbol.specifier === 'string' && entrypointBySpecifier.has(symbol.specifier);
      if (!validSpecifier) diagnostics.push(`${location}.specifier must name an inventory entrypoint`);
      const validExportName = typeof symbol.exportName === 'string' && symbol.exportName.length > 0;
      if (!validExportName) diagnostics.push(`${location}.exportName must be a non-empty string`);
      if (!ENTRYPOINT_INVENTORY_SYMBOL_KINDS.has(symbol.kind)) {
        diagnostics.push(`${location}.kind must be type or value`);
      }
      const validDeclarationModule = typeof symbol.declarationModule === 'string'
        && ENTRYPOINT_INVENTORY_DECLARATION_MODULE.test(symbol.declarationModule)
        && !symbol.declarationModule.includes('//')
        && !symbol.declarationModule.split('/').includes('..');
      if (!validDeclarationModule) diagnostics.push(`${location}.declarationModule must be a normalized dist/*.d.ts module`);
      const validDeclarationExport = typeof symbol.declarationExport === 'string' && symbol.declarationExport.length > 0;
      if (!validDeclarationExport) diagnostics.push(`${location}.declarationExport must be a non-empty string`);
      const hasSince = Object.hasOwn(symbol, 'since');
      if (hasSince && !isExactCanonicalPublishedVersion(symbol.since)) {
        diagnostics.push(`${location}.since must be exact canonical semver`);
      }
      const hasReplacement = Object.hasOwn(symbol, 'replacement');
      const hasRemovalCondition = Object.hasOwn(symbol, 'removalCondition');
      if (hasReplacement !== hasRemovalCondition) {
        diagnostics.push(`${location} deprecation requires replacement and removalCondition together`);
      }
      if (hasReplacement && (typeof symbol.replacement !== 'string' || symbol.replacement.length === 0)) {
        diagnostics.push(`${location}.replacement must be a non-empty string`);
      }
      if (
        hasRemovalCondition
        && (typeof symbol.removalCondition !== 'string' || symbol.removalCondition.length === 0)
      ) {
        diagnostics.push(`${location}.removalCondition must be a non-empty string`);
      }
      const valid = validSpecifier
        && validExportName
        && ENTRYPOINT_INVENTORY_SYMBOL_KINDS.has(symbol.kind)
        && validDeclarationModule
        && validDeclarationExport
        && (!hasSince || isExactCanonicalPublishedVersion(symbol.since))
        && hasReplacement === hasRemovalCondition
        && (!hasReplacement || (typeof symbol.replacement === 'string' && symbol.replacement.length > 0))
        && (!hasRemovalCondition || (
          typeof symbol.removalCondition === 'string' && symbol.removalCondition.length > 0
        ));
      if (valid) {
        const normalized = {
          specifier: symbol.specifier,
          exportName: symbol.exportName,
          kind: symbol.kind,
          declarationModule: symbol.declarationModule,
          declarationExport: symbol.declarationExport,
          ...(hasSince ? { since: symbol.since } : {}),
          ...(hasReplacement ? {
            replacement: symbol.replacement,
            removalCondition: symbol.removalCondition,
          } : {}),
        };
        const key = entrypointSymbolKey(normalized);
        if (symbolKeys.has(key)) {
          diagnostics.push(`${location} duplicates ${key}`);
        } else {
          symbolKeys.add(key);
          symbols.push(Object.freeze(normalized));
        }
      }
    }
  }

  if (diagnostics.length > 0) {
    throw new Error(`Invalid public API governance inventory:\n- ${diagnostics.join('\n- ')}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    packageName,
    entrypoints: Object.freeze(entrypoints),
    symbols: Object.freeze(symbols),
  });
}

function isWithinRoot(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
}

async function optionalLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readJson(path, label) {
  const target = await optionalLstat(path);
  if (!target) throw new Error(`${label} is missing at ${path}`);
  if (!target.isFile()) throw new Error(`${label} must be a regular file at ${path}`);
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing at ${path}`);
    throw error;
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`${label} is not valid JSON at ${path}: ${error.message}`);
  }
}

async function readPreviousPublishedEntrypointInventory(options) {
  if (options.publishedVersion === undefined || options.previousPublishedInventoryPath === undefined) {
    return undefined;
  }
  return readJson(
    options.previousPublishedInventoryPath,
    'previous published public API inventory',
  );
}

async function readRetainedEntrypointInventory(inventoryPath, packageName) {
  const existing = await optionalLstat(inventoryPath);
  if (!existing || !existing.isFile()) return undefined;
  const raw = await readJson(inventoryPath, 'retained public API inventory');
  // These packages are unpublished while their generated records move from
  // source labels to declaration labels. No retained publication fact exists
  // until a publisher stamps `since`, so permit that one direct-cut refresh.
  const sinceCount = Array.isArray(raw?.symbols)
    ? raw.symbols.filter((symbol) => symbol !== null && typeof symbol === 'object' && Object.hasOwn(symbol, 'since')).length
    : 0;
  if (sinceCount === 0) return undefined;
  return validateEntrypointInventory(raw, packageName);
}

function assertPublicationOptions(options) {
  if (
    options.previousPublishedInventoryPath !== undefined
    && options.publishedVersion === undefined
  ) {
    throw new Error('--previous-published-inventory requires --published-version');
  }
}

/** Reads the exact prepared declaration roots published by the package. */
export const readPublishedEntrypoints = readPreparedDeclarationEntrypoints;

function projectEntrypointInventory({ packageName, entrypoints, rows }) {
  const sortedRows = [...rows].sort((left, right) => compareCodePoints(
    `${left.specifier} ${left.exportName}`,
    `${right.specifier} ${right.exportName}`,
  ));
  return validateEntrypointInventory({
    schemaVersion: 1,
    packageName,
    entrypoints: entrypoints.map((entrypoint) => ({
      specifier: entrypoint.specifier,
      declarationModule: entrypoint.declarationModule,
    })),
    symbols: sortedRows.map((row) => ({
      specifier: row.specifier,
      exportName: row.exportName,
      kind: row.kind,
      declarationModule: row.sourceModule,
      declarationExport: row.sourceExport,
      ...(row.replacement === undefined ? {} : {
        replacement: row.replacement,
        removalCondition: row.removalCondition,
      }),
    })),
  }, packageName);
}

function renderApiMarkdown({ title, inventory }) {
  const rowsByEntrypoint = new Map();
  for (const row of inventory.symbols) {
    const rows = rowsByEntrypoint.get(row.specifier) ?? [];
    rows.push(row);
    rowsByEntrypoint.set(row.specifier, rows);
  }
  return [
    `# ${title}`,
    '',
    '> Generated from prepared package declarations. Do not hand-edit.',
    '> This is the exact emitted exported-name census; `api-declarations.md` records their signatures.',
    '',
    '## Entrypoints',
    '',
    ...inventory.entrypoints.flatMap((entrypoint) => [
      `### \`${entrypoint.specifier}\``,
      '',
      `Declaration: \`${entrypoint.declarationModule}\``,
      '',
      ...(rowsByEntrypoint.get(entrypoint.specifier) ?? []).map((row) => (
        `- ${row.kind} \`${row.exportName}\` from \`${row.declarationModule}\``
      )),
      '',
    ]),
  ].join('\n').replace(/\n+$/u, '\n');
}

function reportMode(options) {
  return options.write ? 'write' : options.check ? 'check' : 'dry-run';
}

async function preflightOutput(packageRoot, output) {
  if (!isWithinRoot(packageRoot, output.absolutePath)) {
    throw new Error(`Public API governance output escapes package root: ${output.relativePath}`);
  }
  const parent = await optionalLstat(dirname(output.absolutePath));
  if (!parent?.isDirectory()) {
    throw new Error(`Public API governance output parent must be an existing directory: ${output.relativePath}`);
  }
  const existing = await optionalLstat(output.absolutePath);
  if (existing && !existing.isFile()) {
    throw new Error(`Public API governance output must be a regular file or absent: ${output.relativePath}`);
  }
  const originalContents = existing ? await readFile(output.absolutePath, 'utf8') : null;
  return Object.freeze({
    ...output,
    originalContents,
    changed: originalContents !== output.contents,
    summary: output.relativePath === 'api-declarations.md'
      ? summarizeDeclarationDiff(originalContents, output.contents)
      : Object.freeze([]),
  });
}

async function stageChangedOutputs(outputs) {
  const staged = [];
  try {
    for (const [index, output] of outputs.entries()) {
      if (!output.changed) continue;
      const temporaryPath = join(
        dirname(output.absolutePath),
        `.${basename(output.absolutePath)}.api-governance-${process.pid}-${index}.tmp`,
      );
      await writeFile(temporaryPath, output.contents, { encoding: 'utf8', flag: 'wx' });
      staged.push(Object.freeze({ output, temporaryPath }));
    }
    return staged;
  } catch (error) {
    await Promise.all(staged.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => undefined)));
    throw error;
  }
}

async function commitStagedOutputs(staged) {
  const promoted = [];
  try {
    for (const stagedOutput of staged) {
      await rename(stagedOutput.temporaryPath, stagedOutput.output.absolutePath);
      promoted.push(stagedOutput);
    }
  } catch (promotionError) {
    const rollbackErrors = [];
    for (const { output, temporaryPath } of promoted.reverse()) {
      try {
        if (output.originalContents === null) {
          await unlink(output.absolutePath);
        } else {
          await writeFile(temporaryPath, output.originalContents, { encoding: 'utf8', flag: 'wx' });
          await rename(temporaryPath, output.absolutePath);
        }
      } catch (rollbackError) {
        if (!(output.originalContents === null && rollbackError?.code === 'ENOENT')) {
          rollbackErrors.push(rollbackError);
        }
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [promotionError, ...rollbackErrors],
        'Public API governance promotion failed and one or more records could not be restored',
        { cause: promotionError },
      );
    }
    throw promotionError;
  } finally {
    await Promise.all(staged.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => undefined)));
  }
}

async function runEntrypointDeclarationProfile(profile, options) {
  const packageRoot = resolve(options.packageRoot ?? join(REPOSITORY_ROOT, profile.packageRoot));
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.name !== profile.packageName && options.packageRoot === undefined) {
    throw new Error(`Public API governance profile ${profile.id} expected ${profile.packageName}`);
  }
  const emitted = projectPreparedDeclarationSurface({
    packageRoot,
    packageJson,
    title: profile.declarationTitle,
    bundledDependencies: packageJson.bundledDependencies ?? [],
  });
  const { entrypoints, rows } = emitted;
  const emittedInventory = projectEntrypointInventory({
    packageName: packageJson.name,
    entrypoints,
    rows,
  });
  const validateInventory = (candidate) => validateEntrypointInventory(candidate, packageJson.name);
  const provenanceError = (diagnostic) => new Error(
    `Public API governance ${profile.id} inventory: ${diagnostic}`,
  );
  const previousPublishedInventory = await readPreviousPublishedEntrypointInventory(options);
  const retainedPublishedInventory = options.publishedVersion === undefined
    ? await readRetainedEntrypointInventory(join(packageRoot, 'api-surface.json'), packageJson.name)
    : undefined;
  const inventory = options.publishedVersion !== undefined
    ? projectPublishedInventoryProvenance({
      inventory: emittedInventory,
      publishedVersion: options.publishedVersion,
      previousPublishedInventory,
      validateInventory,
      symbols: (candidate) => candidate.symbols,
      symbolKey: entrypointSymbolKey,
      createError: provenanceError,
    })
    : retainedPublishedInventory === undefined
      ? emittedInventory
      : projectRetainedInventoryProvenance({
        inventory: emittedInventory,
        retainedPublishedInventory,
        validateInventory,
        symbols: (candidate) => candidate.symbols,
        symbolKey: entrypointSymbolKey,
        createError: provenanceError,
      });
  const outputs = [
    Object.freeze({
      owner: 'authorApiMarkdown',
      absolutePath: join(packageRoot, 'API.md'),
      relativePath: 'API.md',
      contents: renderApiMarkdown({ title: profile.title, inventory }),
    }),
    Object.freeze({
      owner: 'publicDeclarationReport',
      absolutePath: join(packageRoot, 'api-declarations.md'),
      relativePath: 'api-declarations.md',
      contents: emitted.declarationReport,
    }),
    Object.freeze({
      owner: 'apiSurfaceInventory',
      absolutePath: join(packageRoot, 'api-surface.json'),
      relativePath: 'api-surface.json',
      contents: `${JSON.stringify(inventory, null, 2)}\n`,
    }),
  ];
  const preflightedOutputs = await Promise.all(outputs.map((output) => preflightOutput(packageRoot, output)));
  const changedOutputs = preflightedOutputs.filter((output) => output.changed);
  if (options.write) await commitStagedOutputs(await stageChangedOutputs(changedOutputs));
  return Object.freeze({
    profileId: profile.id,
    mode: reportMode(options),
    status: options.write || changedOutputs.length === 0 ? 'current' : 'drift',
    packageRoot,
    publication: options.publishedVersion === undefined
      ? undefined
      : Object.freeze({
        publishedVersion: options.publishedVersion,
        previousPublishedInventoryPath: options.previousPublishedInventoryPath,
      }),
    summary: Object.freeze({
      plannedFiles: preflightedOutputs.length,
      changedFiles: changedOutputs.length,
      writtenFiles: options.write ? changedOutputs.length : 0,
    }),
    files: Object.freeze(preflightedOutputs.map((output) => Object.freeze({
      owner: output.owner,
      path: output.relativePath,
      changed: output.changed,
      written: options.write && output.changed,
      summary: output.summary,
    }))),
  });
}

async function runPluginSdkProfile(profile, options) {
  const packageRoot = resolve(options.packageRoot ?? join(REPOSITORY_ROOT, profile.packageRoot));
  if (options.sourcePrepared === true) {
    return runPackedPluginSdkProfile(profile, { ...options, packageRoot });
  }
  if (options.packageRoot === undefined && options.packageRootKind !== undefined) {
    throw new Error('Plugin SDK packageRootKind requires an explicit packageRoot');
  }
  if (options.packageRoot !== undefined) {
    const packageRootKind = options.packageRootKind ?? 'extracted-final-candidate';
    if (packageRootKind === 'extracted-final-candidate') {
      return runPackedPluginSdkProfile(profile, options);
    }
    if (packageRootKind !== 'source-complete-publication-sandbox') {
      throw new Error(`Unknown Plugin SDK packageRootKind: ${packageRootKind}`);
    }
  }
  const modulePath = pathToFileURL(join(packageRoot, 'scripts/apiSurfaceCli.mjs')).href;
  const { runApiSurfaceCli } = await import(modulePath);
  const report = await runApiSurfaceCli({
    ...options,
    packageRoot,
  });
  return Object.freeze({ ...report, profileId: profile.id });
}

/**
 * A packed plugin-sdk candidate has declarations and tracked records but not
 * author source or package-local generators. Verify it through the same shared
 * emitted graph so release validation cannot accidentally re-enter source.
 */
async function runPackedPluginSdkProfile(profile, options) {
  if (options.write) {
    throw new Error('Packed plugin-sdk declaration verification is check-only');
  }
  const packageRoot = resolve(options.packageRoot);
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.name !== profile.packageName) {
    throw new Error(`Packed API governance profile ${profile.id} expected ${profile.packageName}`);
  }
  const inventory = await readJson(
    join(packageRoot, 'api-surface.json'),
    'packed public API inventory',
  );
  const emitted = projectPreparedDeclarationSurface({
    packageRoot,
    packageJson,
    title: profile.declarationTitle,
    bundledDependencies: packageJson.bundledDependencies ?? [],
  });
  assertInventoryMatchesPreparedDeclarationSurface({
    inventory,
    entrypoints: emitted.entrypoints,
    rows: emitted.rows,
  });
  const output = await preflightOutput(packageRoot, {
    owner: 'publicDeclarationReport',
    absolutePath: join(packageRoot, 'api-declarations.md'),
    relativePath: 'api-declarations.md',
    contents: emitted.declarationReport,
  });
  return Object.freeze({
    profileId: profile.id,
    mode: 'check',
    status: output.changed ? 'drift' : 'current',
    packageRoot,
    publication: undefined,
    summary: Object.freeze({
      plannedFiles: 1,
      changedFiles: output.changed ? 1 : 0,
      writtenFiles: 0,
    }),
    files: Object.freeze([Object.freeze({
      owner: output.owner,
      path: output.relativePath,
      changed: output.changed,
      written: false,
      summary: output.summary,
    })]),
  });
}

/** Runs exactly one profile through the shared API-governance authority. */
export async function runApiGovernance(options) {
  const profile = API_GOVERNANCE_PROFILES[options.profileId];
  if (options.sourcePrepared === true && profile?.kind !== 'plugin-sdk') {
    throw new Error('--source-prepared is supported only by the plugin-sdk profile');
  }
  if (profile === undefined) {
    throw new Error(`Unknown API governance profile: ${options.profileId}`);
  }
  if (options.write && options.check) {
    throw new Error('--write and --check are mutually exclusive');
  }
  assertPublicationOptions(options);
  if (profile.kind === 'plugin-sdk') return runPluginSdkProfile(profile, options);
  if (profile.kind === 'entrypoint-declarations') return runEntrypointDeclarationProfile(profile, options);
  throw new Error(`API governance profile ${profile.id} has no generator kind`);
}

/** Human-oriented bounded output for CI and local no-drift failures. */
export function renderApiGovernanceSummary(report) {
  return [
    `api-governance ${report.profileId} ${report.mode}: ${report.status} (planned=${report.summary.plannedFiles} changed=${report.summary.changedFiles} written=${report.summary.writtenFiles})`,
    ...report.files
      .filter((file) => file.changed)
      .map((file) => [
        `  ${file.written ? 'wrote' : 'drift'} ${file.owner} ${file.path}`,
        ...(file.summary?.length > 0 ? [`: ${file.summary.join(', ')}`] : []),
      ].join('')),
    '',
  ].join('\n');
}
