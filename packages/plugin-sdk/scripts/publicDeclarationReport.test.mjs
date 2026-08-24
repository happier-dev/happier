import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  createPublicSurfaceProgram,
  projectPublicDeclarationReport,
} from './publicDeclarationReport.mjs';

const CONTRACT_MODULE = 'src/contract.ts';
const INTERNAL_MODULE = 'src/internal.ts';

const ROWS = Object.freeze([
  Object.freeze({
    specifier: '.',
    exportName: 'RunOptions',
    kind: 'type',
    sourceModule: CONTRACT_MODULE,
    sourceExport: 'RunOptions',
  }),
  Object.freeze({
    specifier: '.',
    exportName: 'run',
    kind: 'value',
    sourceModule: CONTRACT_MODULE,
    sourceExport: 'run',
  }),
  Object.freeze({
    specifier: '.',
    exportName: 'DEFAULTS',
    kind: 'value',
    sourceModule: CONTRACT_MODULE,
    sourceExport: 'DEFAULTS',
  }),
  Object.freeze({
    specifier: '.',
    exportName: 'Envelope',
    kind: 'type',
    sourceModule: CONTRACT_MODULE,
    sourceExport: 'Envelope',
  }),
]);

function contractSource({ timeoutOptional, hiddenValueOptional = true }) {
  return [
    "import type { Nested } from './internal.js';",
    '',
    'class Hidden {',
    `  value${hiddenValueOptional ? '?' : ''}: string;`,
    '}',
    '',
    'export type RunOptions = Readonly<{',
    `  timeout${timeoutOptional ? '?' : ''}: number;`,
    '  label: string;',
    '}>;',
    '',
    'export type Envelope = Readonly<{ nested: Nested }>;',
    '',
    "export const DEFAULTS = { timeout: 30, label: 'default' } as const;",
    '',
    'export function run(): Hidden {',
    '  return new Hidden();',
    '}',
    '',
  ].join('\n');
}

async function createFixture({ timeoutOptional, hiddenValueOptional = true }) {
  const root = await mkdtemp(join(tmpdir(), 'happier-declaration-report-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'declaration-report-fixture', version: '0.0.0', type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(root, INTERNAL_MODULE), 'export type Nested = Readonly<{ id: string }>;\n', 'utf8');
  await writeFile(
    join(root, CONTRACT_MODULE),
    contractSource({ timeoutOptional, hiddenValueOptional }),
    'utf8',
  );
  return root;
}

function projectFixtureReport(root) {
  return projectPublicDeclarationReport({
    program: createPublicSurfaceProgram([resolve(root, CONTRACT_MODULE)], root),
    packageRoot: root,
    title: 'Fixture public declaration report',
    rows: ROWS,
  });
}

test('an optional published property becoming required changes the declaration record', async () => {
  const optionalRoot = await createFixture({ timeoutOptional: true });
  const requiredRoot = await createFixture({ timeoutOptional: false });
  try {
    const optionalReport = projectFixtureReport(optionalRoot);
    const requiredReport = projectFixtureReport(requiredRoot);

    assert.match(optionalReport, /timeout\?: number;/u);
    assert.doesNotMatch(optionalReport, /^\s+timeout: number;$/mu);
    assert.match(requiredReport, /^\s+timeout: number;$/mu);
    assert.doesNotMatch(requiredReport, /timeout\?: number;/u);
    assert.notEqual(optionalReport, requiredReport);
  } finally {
    await rm(optionalRoot, { recursive: true, force: true });
    await rm(requiredRoot, { recursive: true, force: true });
  }
});

test('the declaration record is byte-identical across repeated projections', async () => {
  const root = await createFixture({ timeoutOptional: true });
  try {
    assert.equal(projectFixtureReport(root), projectFixtureReport(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the declaration record materializes inferred value and return types', async () => {
  const root = await createFixture({ timeoutOptional: true });
  try {
    const report = projectFixtureReport(root);
    // `DEFAULTS` has no annotation, so only the checker knows its published shape.
    assert.match(report, /const DEFAULTS: \{ readonly timeout: 30; readonly label: "default"; \};/u);
    // `run` has no explicit return type, so an inferred return change must still show.
    assert.match(report, /function run\(\): Hidden;/u);
    // Implementation bodies are never part of the published contract.
    assert.doesNotMatch(report, /return new Hidden/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a package-owned type reached from a published signature is recorded even when unpublished', async () => {
  const root = await createFixture({ timeoutOptional: true });
  try {
    const report = projectFixtureReport(root);
    const reachable = report.slice(report.indexOf('## Reachable package-owned declarations'));
    assert.match(reachable, /### `src\/internal\.ts` — `Nested`/u);
    assert.match(reachable, /type Nested = Readonly<\{\n\s+id: string;\n\}>;/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an optional member of a returned hidden class changes the reachable declaration record', async () => {
  const optionalRoot = await createFixture({ timeoutOptional: true, hiddenValueOptional: true });
  const requiredRoot = await createFixture({ timeoutOptional: true, hiddenValueOptional: false });
  try {
    const optionalReport = projectFixtureReport(optionalRoot);
    const requiredReport = projectFixtureReport(requiredRoot);
    const optionalReachable = optionalReport.slice(optionalReport.indexOf('## Reachable package-owned declarations'));
    const requiredReachable = requiredReport.slice(requiredReport.indexOf('## Reachable package-owned declarations'));

    assert.match(optionalReport, /function run\(\): Hidden;/u);
    assert.match(optionalReachable, /class Hidden \{\n\s+value\?: string;\n\}/u);
    assert.match(requiredReachable, /class Hidden \{\n\s+value: string;\n\}/u);
    assert.doesNotMatch(requiredReachable, /value\?: string;/u);
    assert.notEqual(optionalReport, requiredReport);
  } finally {
    await rm(optionalRoot, { recursive: true, force: true });
    await rm(requiredRoot, { recursive: true, force: true });
  }
});

test('a published row the report cannot resolve fails instead of silently shrinking the record', async () => {
  const root = await createFixture({ timeoutOptional: true });
  try {
    assert.throws(
      () => projectPublicDeclarationReport({
        program: createPublicSurfaceProgram([resolve(root, CONTRACT_MODULE)], root),
        packageRoot: root,
        title: 'Fixture public declaration report',
        rows: [...ROWS, Object.freeze({
          specifier: '.',
          exportName: 'Absent',
          kind: 'type',
          sourceModule: CONTRACT_MODULE,
          sourceExport: 'Absent',
        })],
      }),
      /cannot resolve published exports: \.:Absent/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const VENDOR_MODULE = 'node_modules/vendor-pkg/index.d.ts';
const VENDORED_ROWS = Object.freeze([
  Object.freeze({
    specifier: '.',
    exportName: 'Wrapper',
    kind: 'type',
    sourceModule: CONTRACT_MODULE,
    sourceExport: 'Wrapper',
  }),
  Object.freeze({
    specifier: '.',
    exportName: 'vendorPublished',
    kind: 'value',
    sourceModule: CONTRACT_MODULE,
    sourceExport: 'vendorPublished',
  }),
]);

async function createVendoredFixture({
  directMarkerOptional = true,
  transitiveMarkerOptional = true,
} = {}) {
  // `node_modules` resolution reports the real path, so the fixture root must
  // already be one or every vendored declaration reads as another package's.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-declaration-report-vendored-')));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'vendor-pkg'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'vendor-pkg', 'node_modules', 'transitive-pkg'), {
    recursive: true,
  });
  await mkdir(join(root, 'node_modules', 'external-pkg'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: 'declaration-report-vendored-fixture',
      version: '0.0.0',
      type: 'module',
      bundledDependencies: ['vendor-pkg'],
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(root, 'node_modules', 'vendor-pkg', 'package.json'),
    `${JSON.stringify({
      name: 'vendor-pkg',
      version: '1.0.0',
      type: 'module',
      types: './index.d.ts',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(root, 'node_modules', 'vendor-pkg', 'index.js'), 'export const vendorPublished = { marker: "vendor-published" };\n', 'utf8');
  await writeFile(
    join(root, 'node_modules', 'vendor-pkg', 'node_modules', 'transitive-pkg', 'package.json'),
    `${JSON.stringify({
      name: 'transitive-pkg',
      version: '1.0.0',
      type: 'module',
      types: './index.d.ts',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(root, 'node_modules', 'vendor-pkg', 'node_modules', 'transitive-pkg', 'index.js'),
    'export {};\n',
    'utf8',
  );
  await writeFile(
    join(root, 'node_modules', 'vendor-pkg', 'node_modules', 'transitive-pkg', 'index.d.ts'),
    [
      'export type TransitiveHidden = Readonly<{',
      `  transitiveMarker${transitiveMarkerOptional ? '?' : ''}: string;`,
      '}>;',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(root, 'node_modules', 'external-pkg', 'package.json'),
    `${JSON.stringify({
      name: 'external-pkg',
      version: '1.0.0',
      type: 'module',
      types: './index.d.ts',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(root, 'node_modules', 'external-pkg', 'index.js'), 'export {};\n', 'utf8');
  await writeFile(
    join(root, 'node_modules', 'external-pkg', 'index.d.ts'),
    'export type ExternalOnly = Readonly<{ externalMarker: string }>;\n',
    'utf8',
  );
  await writeFile(
    join(root, VENDOR_MODULE),
    [
      "import type { TransitiveHidden } from 'transitive-pkg';",
      "import type { ExternalOnly } from 'external-pkg';",
      '',
      'export type VendorEnvelope = Readonly<{',
      `  directMarker${directMarkerOptional ? '?' : ''}: string;`,
      '  nested: TransitiveHidden;',
      '  external: ExternalOnly;',
      '}>;',
      'export declare const vendorPublished: Readonly<{ marker: "vendor-published" }>;',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(root, CONTRACT_MODULE),
    [
      "import type { VendorEnvelope } from 'vendor-pkg';",
      '',
      'export type Wrapper = Readonly<{ vendor: VendorEnvelope }>;',
      '',
      "export { vendorPublished } from 'vendor-pkg';",
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

test('the declaration record follows hidden direct and transitive bundled declarations while retaining external edges', async () => {
  const optionalRoot = await createVendoredFixture({
    directMarkerOptional: true,
    transitiveMarkerOptional: true,
  });
  const requiredRoot = await createVendoredFixture({
    directMarkerOptional: false,
    transitiveMarkerOptional: false,
  });
  try {
    const optionalReport = projectPublicDeclarationReport({
      program: createPublicSurfaceProgram([resolve(optionalRoot, CONTRACT_MODULE)], optionalRoot),
      packageRoot: optionalRoot,
      title: 'Fixture public declaration report',
      rows: VENDORED_ROWS,
      bundledDependencies: ['vendor-pkg'],
    });
    const requiredReport = projectPublicDeclarationReport({
      program: createPublicSurfaceProgram([resolve(requiredRoot, CONTRACT_MODULE)], requiredRoot),
      packageRoot: requiredRoot,
      title: 'Fixture public declaration report',
      rows: VENDORED_ROWS,
      bundledDependencies: ['vendor-pkg'],
    });
    const published = optionalReport.slice(
      optionalReport.indexOf('## Published exports'),
      optionalReport.indexOf('## Reachable package-owned declarations'),
    );
    const optionalReachable = optionalReport.slice(
      optionalReport.indexOf('## Reachable package-owned declarations'),
      optionalReport.indexOf('## Referenced declarations owned by other packages'),
    );
    const requiredReachable = requiredReport.slice(
      requiredReport.indexOf('## Reachable package-owned declarations'),
      requiredReport.indexOf('## Referenced declarations owned by other packages'),
    );
    const edges = optionalReport.slice(optionalReport.indexOf('## Referenced declarations owned by other packages'));

    // A vendored declaration this package publishes stays recorded in full:
    // nothing else will ever publish it.
    assert.match(published, /Declared by `node_modules\/vendor-pkg\/index\.d\.ts` as `vendorPublished`\./u);
    assert.match(published, /const vendorPublished: Readonly<\{\s*marker: "vendor-published";\s*\}>;/u);

    // Direct and nested declarations beneath a declared bundle root both ship
    // in this candidate, so their hidden optionality must reach the record.
    assert.match(optionalReachable, /node_modules\/vendor-pkg\/index\.d\.ts` — `VendorEnvelope`/u);
    assert.match(optionalReachable, /directMarker\?: string;/u);
    assert.match(
      optionalReachable,
      /node_modules\/vendor-pkg\/node_modules\/transitive-pkg\/index\.d\.ts` — `TransitiveHidden`/u,
    );
    assert.match(optionalReachable, /transitiveMarker\?: string;/u);
    assert.match(requiredReachable, /directMarker: string;/u);
    assert.match(requiredReachable, /transitiveMarker: string;/u);
    assert.doesNotMatch(requiredReachable, /(?:direct|transitive)Marker\?: string;/u);
    assert.notEqual(optionalReport, requiredReport);

    // A package that is resolved independently of the declared bundle tree is
    // still only a named edge, even when the fixture has it installed nearby.
    assert.match(edges, /- `external-pkg#ExternalOnly`/u);
    assert.doesNotMatch(optionalReachable, /externalMarker/u);
  } finally {
    await rm(optionalRoot, { recursive: true, force: true });
    await rm(requiredRoot, { recursive: true, force: true });
  }
});
