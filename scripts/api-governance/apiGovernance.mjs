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
import { renderDeclarationDiffSample, summarizeDeclarationDiff } from './declarationDiff.mjs';
import {
  createPublicSurfaceProgram,
  projectEntrypointExportRows,
} from './publicDeclarationReport.mjs';
import {
  isExactCanonicalPublishedVersion,
  projectPublishedInventoryProvenance,
} from './publicationProvenance.mjs';
import { resolveWorkspaceBundleLockPath, withWorkspaceBundleLock } from '../workspaces/workspaceBundleLock.mjs';
import { AUTHOR_EXCLUDED_ENTRYPOINT_ROOTS } from './authorExports.mjs';

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
  embed: Object.freeze({
    id: 'embed',
    packageName: '@happier-dev/embed',
    packageRoot: 'packages/embed',
    kind: 'entrypoint-declarations',
    title: 'Embed public API',
    declarationTitle: 'Embed public declaration report',
  }),
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
    sourceEntrypointSpecs: true,
    excludedEntrypointRoots: AUTHOR_EXCLUDED_ENTRYPOINT_ROOTS['@happier-dev/plugin-ui'],
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

function authorEntrypointSpecModule(specifier) {
  return specifier === '.'
    ? 'src/index.public.ts'
    : `src/${specifier.slice(2)}/index.public.ts`;
}

function publicExportKey(row) {
  return `${row.specifier}\u0000${row.exportName}\u0000${row.kind}`;
}

function sortedDifference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort(compareCodePoints);
}

/**
 * Reads the author-owned source specification for every package export. The
 * package entrypoint barrel remains the emitted module root; these specs are
 * the source declaration of the names it is meant to carry.
 */
async function projectAuthorEntrypointSpecSurface({ packageRoot, entrypoints }) {
  const sourceEntrypoints = await Promise.all(entrypoints.map(async (entrypoint) => {
    const sourceModule = authorEntrypointSpecModule(entrypoint.specifier);
    const absolutePath = resolve(packageRoot, sourceModule);
    let sourceStat;
    try {
      sourceStat = await lstat(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(
          `Missing author-owned source spec for ${entrypoint.specifier}: ${sourceModule}`,
        );
      }
      throw error;
    }
    if (!sourceStat.isFile()) {
      throw new Error(
        `Author-owned source spec for ${entrypoint.specifier} must be a regular file: ${sourceModule}`,
      );
    }
    return Object.freeze({
      specifier: entrypoint.specifier,
      sourceModule,
      absolutePath,
    });
  }));
  const program = createPublicSurfaceProgram(
    sourceEntrypoints.map((entrypoint) => entrypoint.absolutePath),
    packageRoot,
  );
  const rows = projectEntrypointExportRows({
    program,
    packageRoot,
    entrypoints: sourceEntrypoints,
  });
  return Object.freeze({ sourceEntrypoints, rows });
}

function assertAuthorEntrypointSpecsMatchPreparedDeclarations({ sourceRows, emittedRows }) {
  const sourceExports = new Set(sourceRows.map(publicExportKey));
  const emittedExports = new Set(emittedRows.map(publicExportKey));
  const missingFromDeclarations = sortedDifference(sourceExports, emittedExports);
  const missingFromSourceSpecs = sortedDifference(emittedExports, sourceExports);
  if (missingFromDeclarations.length === 0 && missingFromSourceSpecs.length === 0) return;
  throw new Error([
    'Author-owned source specs do not match prepared public declarations:',
    ...missingFromDeclarations.map((key) => (
      `- prepared declarations are missing source-spec export ${key.replaceAll('\u0000', ':')}`
    )),
    ...missingFromSourceSpecs.map((key) => (
      `- source specs are missing prepared declaration export ${key.replaceAll('\u0000', ':')}`
    )),
  ].join('\n'));
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
    generated: output.generated === true,
    originalContents,
    changed: originalContents !== output.contents,
    summary: output.relativePath === 'api-declarations.md'
      ? renderDeclarationDiffSample(summarizeDeclarationDiff(originalContents, output.contents))
      : Object.freeze([]),
  });
}

/**
 * Only the compact exported-name census (`API.md`) is committed. The
 * declaration report and inventory are generated on demand (gitignored and
 * published by `prepack`), so they never count as drift: `--write` writes
 * every output, and a check writes only generated records, and only when a
 * same-run reader asks for them through `writeGenerated`.
 */
export function planGovernanceOutputs(outputs, options) {
  const written = outputs.filter((output) => output.changed && (
    options.write === true || (output.generated && options.writeGenerated === true)
  ));
  const drift = options.write === true
    ? []
    : outputs.filter((output) => output.changed && !output.generated);
  const writtenPaths = new Set(written.map((output) => output.relativePath));
  return Object.freeze({
    written,
    drift,
    status: drift.length === 0 ? 'current' : 'drift',
    changedFiles: options.write === true ? written.length : drift.length,
    files: Object.freeze(outputs.map((output) => {
      const isWritten = writtenPaths.has(output.relativePath);
      return Object.freeze({
        owner: output.owner,
        path: output.relativePath,
        ...(output.generated ? { generated: true } : {}),
        changed: output.generated ? isWritten : output.changed,
        written: isWritten,
        summary: output.generated && !isWritten ? Object.freeze([]) : output.summary,
      });
    })),
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
  if (options.packageRoot === undefined && options.packageRootKind !== undefined) {
    throw new Error(`${profile.id} packageRootKind requires an explicit packageRoot`);
  }
  // Source-complete is the default so an ordinary repository or publication
  // sandbox run keeps the stricter author-spec comparison; only a caller that
  // knows it holds an extracted candidate may opt out of it.
  const packageRootKind = options.packageRootKind ?? 'source-complete-publication-sandbox';
  if (
    packageRootKind !== 'source-complete-publication-sandbox'
    && packageRootKind !== 'extracted-final-candidate'
  ) {
    throw new Error(`Unknown ${profile.id} packageRootKind: ${packageRootKind}`);
  }
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
    excludedEntrypointRoots: profile.excludedEntrypointRoots,
  });
  const { entrypoints, rows } = emitted;
  // A published tarball ships `dist` and the tracked records, never `src`, so
  // the author-owned source spec is verifiable only where author source is
  // present.
  if (profile.sourceEntrypointSpecs === true && packageRootKind === 'source-complete-publication-sandbox') {
    const sourceSpecs = await projectAuthorEntrypointSpecSurface({
      packageRoot,
      entrypoints,
    });
    assertAuthorEntrypointSpecsMatchPreparedDeclarations({
      sourceRows: sourceSpecs.rows,
      emittedRows: rows,
    });
  }
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
    : emittedInventory;
  // An extracted final candidate carries the published records themselves, so
  // there every record is compared; in source every record but the census is
  // generated on demand.
  const generated = packageRootKind !== 'extracted-final-candidate';
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
      generated,
    }),
    Object.freeze({
      owner: 'apiSurfaceInventory',
      absolutePath: join(packageRoot, 'api-surface.json'),
      relativePath: 'api-surface.json',
      contents: `${JSON.stringify(inventory, null, 2)}\n`,
      generated,
    }),
  ];
  const preflightedOutputs = await Promise.all(outputs.map((output) => preflightOutput(packageRoot, output)));
  const plan = planGovernanceOutputs(preflightedOutputs, options);
  if (plan.written.length > 0) await commitStagedOutputs(await stageChangedOutputs(plan.written));
  return Object.freeze({
    profileId: profile.id,
    mode: reportMode(options),
    status: plan.status,
    packageRoot,
    publication: options.publishedVersion === undefined
      ? undefined
      : Object.freeze({
        publishedVersion: options.publishedVersion,
        previousPublishedInventoryPath: options.previousPublishedInventoryPath,
      }),
    summary: Object.freeze({
      plannedFiles: preflightedOutputs.length,
      changedFiles: plan.changedFiles,
      writtenFiles: plan.written.length,
    }),
    files: plan.files,
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
  if (profile.kind === 'entrypoint-declarations') {
    if (!options.write) return runEntrypointDeclarationProfile(profile, options);
    return withWorkspaceBundleLock(() => runEntrypointDeclarationProfile(profile, options), {
      lockPath: resolveWorkspaceBundleLockPath(options.packageRoot ?? REPOSITORY_ROOT),
      errorLabel: `${profile.id} API governance publication`,
    });
  }
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
