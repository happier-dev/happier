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

function contractSource({ timeoutOptional }) {
  return [
    "import type { Nested } from './internal.js';",
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
    'export function run(options: RunOptions) {',
    '  return options.label;',
    '}',
    '',
  ].join('\n');
}

async function createFixture({ timeoutOptional }) {
  const root = await mkdtemp(join(tmpdir(), 'happier-declaration-report-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'declaration-report-fixture', version: '0.0.0', type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(root, INTERNAL_MODULE), 'export type Nested = Readonly<{ id: string }>;\n', 'utf8');
  await writeFile(join(root, CONTRACT_MODULE), contractSource({ timeoutOptional }), 'utf8');
  return root;
}

function projectFixtureReport(root) {
  return projectPublicDeclarationReport({
    program: createPublicSurfaceProgram([resolve(root, CONTRACT_MODULE)]),
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
    assert.match(report, /function run\(options: RunOptions\): string;/u);
    // Implementation bodies are never part of the published contract.
    assert.doesNotMatch(report, /return options\.label/u);
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

test('a published row the report cannot resolve fails instead of silently shrinking the record', async () => {
  const root = await createFixture({ timeoutOptional: true });
  try {
    assert.throws(
      () => projectPublicDeclarationReport({
        program: createPublicSurfaceProgram([resolve(root, CONTRACT_MODULE)]),
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

async function createVendoredFixture() {
  // `node_modules` resolution reports the real path, so the fixture root must
  // already be one or every vendored declaration reads as another package's.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-declaration-report-vendored-')));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'vendor-pkg'), { recursive: true });
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
    join(root, VENDOR_MODULE),
    [
      'export type VendorDeep = Readonly<{ deepMarker: string }>;',
      'export type VendorEnvelope = Readonly<{ nested: VendorDeep }>;',
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

test('a vendored declaration is published in full but is a leaf of the reachability walk', async () => {
  const root = await createVendoredFixture();
  try {
    const report = projectPublicDeclarationReport({
      program: createPublicSurfaceProgram([resolve(root, CONTRACT_MODULE)]),
      packageRoot: root,
      title: 'Fixture public declaration report',
      rows: VENDORED_ROWS,
      bundledDependencies: ['vendor-pkg'],
    });
    const published = report.slice(
      report.indexOf('## Published exports'),
      report.indexOf('## Reachable package-owned declarations'),
    );
    const reachable = report.slice(
      report.indexOf('## Reachable package-owned declarations'),
      report.indexOf('## Referenced declarations owned by other packages'),
    );
    const edges = report.slice(report.indexOf('## Referenced declarations owned by other packages'));

    // A vendored declaration this package publishes stays recorded in full:
    // nothing else will ever publish it.
    assert.match(published, /Declared by `node_modules\/vendor-pkg\/index\.d\.ts` as `vendorPublished`\./u);
    assert.match(published, /const vendorPublished: Readonly<\{\s*marker: "vendor-published";\s*\}>;/u);

    // A vendored declaration merely reached from a published signature is a
    // named edge, not an inlined block, and the walk does not descend past it.
    assert.doesNotMatch(reachable, /VendorEnvelope/u);
    assert.doesNotMatch(report, /VendorDeep/u);
    assert.match(edges, /- `vendor-pkg#VendorEnvelope`/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
