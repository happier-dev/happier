import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { prepareReferencedTypecheckDeclarations } from './prepareTypecheckSourceReferences.mjs';

for (const jsx of [false, true]) {
  test(`reference preparation reads projects per producer, preserving JSX=${jsx}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'happier-reference-cost-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    // The loaded CLI preparation had 9896 reference edges to 17 producers.
    const edgeCount = jsx ? 18 : 9896;
    const ownerCount = jsx ? 2 : 17;
    const consumer = join(root, 'apps/cli/tsconfig.source.json');
    await mkdir(dirname(consumer), { recursive: true });
    const consumerFile = join(dirname(consumer), 'entry.ts');
    await writeFile(consumerFile, 'export const entry = true;');
    await writeFile(consumer, JSON.stringify({
      compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, types: [] },
      files: [consumerFile], include: [],
    }));
    const foreignProjects = [];
    const required = [];
    for (let owner = 0; owner < ownerCount; owner++) {
      const directory = join(root, 'apps', `producer-${owner}`);
      await mkdir(directory, { recursive: true });
      const configPath = join(directory, 'tsconfig.json');
      const files = [];
      for (let edge = owner; edge < edgeCount; edge += ownerCount) {
        const file = join(directory, `entry-${edge}.${jsx && owner === ownerCount - 1 ? 'tsx' : 'ts'}`);
        await writeFile(file, 'export const value = true;');
        files.push(file);
        required.push({ configPath, file });
      }
      await writeFile(configPath, JSON.stringify({ compilerOptions: { types: [] }, files, include: [] }));
      foreignProjects.push({ configPath, files, references: [], ambientInputs: [] });
    }
    const inventory = {
      baseline: { configPath: consumer }, foreignProjects,
      sourceReferences: new Map([[consumer, required]]),
    };
    let projectReads = 0;
    const read = ts.sys.readFile;
    // Observe the real filesystem boundary; retain real parsing and preparation.
    t.mock.method(ts.sys, 'readFile', (path, ...args) => {
      if (path.endsWith('tsconfig.consumer-declarations.json')) projectReads++;
      return read(path, ...args);
    });
    await prepareReferencedTypecheckDeclarations([{ project: consumer }], dirname(consumer), inventory);
    t.diagnostic(`${edgeCount} edges / ${ownerCount} producers / ${projectReads} project reads`);
    // Reference writing, dependency order, implementation membership, and JSX.
    assert.ok(projectReads <= ownerCount * 4,
      `project reads must follow producer projects, not ${edgeCount} edges; observed ${projectReads}`);
    const prepared = JSON.parse(await readFile(consumer, 'utf8'));
    assert.equal(prepared.references.length, ownerCount);
    assert.equal(new Set(prepared.references.map(reference => reference.path)).size, ownerCount);
    assert.equal(prepared.compilerOptions.jsx, jsx ? 'preserve' : undefined);
  });
}
