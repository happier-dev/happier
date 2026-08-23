import { resolve } from 'node:path';

import {
  createPublicSurfaceProgram,
  projectEntrypointExportRows,
  projectPublicDeclarationReport,
} from './publicDeclarationReport.mjs';

const TYPES_CONDITION_TARGET = /^\.\/(?<declarationModule>dist\/[A-Za-z0-9][A-Za-z0-9._/-]*\.d\.ts)$/u;

function compareCodePoints(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function declarationEntrypointRows(entrypoints) {
  return entrypoints.map((entrypoint) => Object.freeze({
    specifier: entrypoint.specifier,
    // The declaration reporter predates emitted-root governance and calls this
    // field `sourceModule`. Its program is nevertheless rooted at this exact
    // prepared .d.ts file, never at the authored TypeScript source.
    sourceModule: entrypoint.declarationModule,
  }));
}

/**
 * Reads the declaration roots a package actually publishes. This deliberately
 * follows the `types` targets verbatim rather than inferring a matching source
 * path: tarballs contain these declarations, and source is neither the public
 * contract nor guaranteed to be present when a packed candidate is checked.
 */
export function readPreparedDeclarationEntrypoints(packageJson) {
  const packageExports = packageJson?.exports;
  if (!packageExports || typeof packageExports !== 'object' || Array.isArray(packageExports)) {
    throw new Error('Public API governance package.json must declare an exports object');
  }
  return Object.freeze(Object.entries(packageExports).flatMap(([specifier, conditions]) => {
    // A direct file target (for example ./package.json) has no TypeScript API.
    if (typeof conditions === 'string') return [];
    const declarationModule = TYPES_CONDITION_TARGET.exec(conditions?.types ?? '')?.groups?.declarationModule;
    if (declarationModule === undefined) {
      throw new Error(`Public API governance export ${specifier} must declare a ./dist/*.d.ts types condition`);
    }
    return [Object.freeze({ specifier, declarationModule })];
  }).sort((left, right) => compareCodePoints(left.specifier, right.specifier)));
}

/**
 * Projects the exact declaration graph that a prepared package would ship.
 * `rows` are emitted exports, so both the name census and declaration report
 * have one authoritative graph and cannot silently follow source instead.
 */
export function projectPreparedDeclarationSurface({
  packageRoot,
  packageJson,
  title,
  bundledDependencies = [],
}) {
  const entrypoints = readPreparedDeclarationEntrypoints(packageJson);
  const reportEntrypoints = declarationEntrypointRows(entrypoints);
  const program = createPublicSurfaceProgram(
    reportEntrypoints.map((entrypoint) => resolve(packageRoot, entrypoint.sourceModule)),
  );
  const rows = projectEntrypointExportRows({
    program,
    packageRoot,
    entrypoints: reportEntrypoints,
  });
  return Object.freeze({
    entrypoints,
    program,
    rows,
    declarationReport: projectPublicDeclarationReport({
      program,
      packageRoot,
      title,
      rows,
      bundledDependencies,
    }),
  });
}

function publicExportKey({ specifier, exportName, kind }) {
  return `${specifier}\u0000${exportName}\u0000${kind}`;
}

function setDifference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort(compareCodePoints);
}

/**
 * Package-specific inventories may retain owner-local metadata such as realms,
 * but their published names must still agree with the exact emitted roots.
 * This is a mechanical equality check, not a SemVer classifier.
 */
export function assertInventoryMatchesPreparedDeclarationSurface({
  inventory,
  entrypoints,
  rows,
}) {
  if (!Array.isArray(inventory?.entrypoints) || !Array.isArray(inventory?.symbols)) {
    throw new Error('Public API governance inventory must declare entrypoints and symbols arrays');
  }
  const inventoryEntrypoints = new Set(inventory.entrypoints.map((entrypoint) => entrypoint?.specifier));
  const emittedEntrypoints = new Set(entrypoints.map((entrypoint) => entrypoint.specifier));
  const inventoryExports = new Set(inventory.symbols.map((symbol) => publicExportKey(symbol ?? {})));
  const emittedExports = new Set(rows.map((row) => publicExportKey(row)));
  const missingEntrypoints = setDifference(emittedEntrypoints, inventoryEntrypoints);
  const extraEntrypoints = setDifference(inventoryEntrypoints, emittedEntrypoints);
  const missingExports = setDifference(emittedExports, inventoryExports);
  const extraExports = setDifference(inventoryExports, emittedExports);
  if (
    missingEntrypoints.length === 0
    && extraEntrypoints.length === 0
    && missingExports.length === 0
    && extraExports.length === 0
  ) return;
  const diagnostics = [
    ...missingEntrypoints.map((specifier) => `inventory is missing emitted entrypoint ${specifier}`),
    ...extraEntrypoints.map((specifier) => `inventory has no emitted entrypoint ${specifier}`),
    ...missingExports.map((key) => `inventory is missing emitted export ${key.replaceAll('\u0000', ':')}`),
    ...extraExports.map((key) => `inventory has no emitted export ${key.replaceAll('\u0000', ':')}`),
  ];
  throw new Error(`Public API inventory does not match prepared declarations:\n- ${diagnostics.join('\n- ')}`);
}
