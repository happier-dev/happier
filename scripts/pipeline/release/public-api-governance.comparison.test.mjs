import assert from 'node:assert/strict';
import test from 'node:test';

import {
  comparePublicApiReleaseRecords,
  renderPublicApiReleaseComparison,
  summarizePublicApiReleaseComparison,
} from './public-api-governance.mjs';

function inventory(symbols) {
  return {
    schemaVersion: 1,
    packageName: '@happier-dev/example',
    symbols,
  };
}

function declarationReport(entries) {
  return [
    '# Example API',
    '',
    ...entries.flatMap(({ name, kind = 'type', declaration }) => [
      `### \`.\` — \`${name}\` (${kind})`,
      '',
      '```ts',
      declaration,
      '```',
      '',
    ]),
  ].join('\n');
}

test('classifies a realistic new export and its declaration block as a compatible addition', () => {
  const alpha = { specifier: '.', exportName: 'Alpha', kind: 'type' };
  const added = { specifier: '.', exportName: 'New', kind: 'value' };
  const report = comparePublicApiReleaseRecords({
    packageName: '@happier-dev/example',
    candidateVersion: '0.1.0-preview.2',
    previousVersion: '0.1.0-preview.1',
    previousInventory: inventory([alpha]),
    candidateInventory: inventory([alpha, added]),
    previousDeclarations: declarationReport([
      { name: 'Alpha', declaration: 'type Alpha = { value?: string };' },
    ]),
    candidateDeclarations: declarationReport([
      { name: 'Alpha', declaration: 'type Alpha = { value?: string };' },
      { name: 'New', kind: 'value', declaration: 'declare const New: Helper;' },
      { name: 'Helper', declaration: 'type Helper = { value: string };' },
    ]),
  });

  assert.deepEqual(report.facts.addedSymbols, ['.:New']);
  assert.deepEqual(report.facts.addedDeclarationBlocks, ['. — Helper (type)', '. — New (value)']);
  assert.deepEqual(report.facts.removedDeclarationBlocks, []);
  assert.deepEqual(report.facts.changedDeclarationBlocks, []);
  assert.deepEqual(report.disposition, {
    removedSymbolsAreBreaking: false,
    humanReviewRequired: false,
    versionDecision: 'compatible_addition',
  });
});

test('keeps removal of a reachable helper human-owned', () => {
  const exposed = { specifier: '.', exportName: 'New', kind: 'value' };
  const report = comparePublicApiReleaseRecords({
    packageName: '@happier-dev/example',
    candidateVersion: '0.1.0-preview.2',
    previousVersion: '0.1.0-preview.1',
    previousInventory: inventory([exposed]),
    candidateInventory: inventory([exposed]),
    previousDeclarations: declarationReport([
      { name: 'New', kind: 'value', declaration: 'declare const New: Helper;' },
      { name: 'Helper', declaration: 'type Helper = { value: string };' },
    ]),
    candidateDeclarations: declarationReport([
      { name: 'New', kind: 'value', declaration: 'declare const New: Helper;' },
    ]),
  });

  assert.deepEqual(report.facts.addedDeclarationBlocks, []);
  assert.deepEqual(report.facts.removedDeclarationBlocks, ['. — Helper (type)']);
  assert.deepEqual(report.facts.changedDeclarationBlocks, []);
  assert.equal(report.disposition.humanReviewRequired, true);
  assert.equal(report.disposition.versionDecision, 'human_required');
});

test('keeps an existing reachable declaration change human-owned', () => {
  const alpha = { specifier: '.', exportName: 'Alpha', kind: 'type' };
  const report = comparePublicApiReleaseRecords({
    packageName: '@happier-dev/example',
    candidateVersion: '0.1.0-preview.2',
    previousVersion: '0.1.0-preview.1',
    previousInventory: inventory([alpha]),
    candidateInventory: inventory([alpha]),
    previousDeclarations: declarationReport([
      { name: 'Alpha', declaration: 'type Alpha = { value?: string };' },
    ]),
    candidateDeclarations: declarationReport([
      { name: 'Alpha', declaration: 'type Alpha = { value: string };' },
    ]),
  });

  assert.deepEqual(report.facts.changedDeclarationBlocks, ['. — Alpha (type)']);
  assert.equal(report.disposition.humanReviewRequired, true);
  assert.equal(report.disposition.versionDecision, 'human_required');
});

test('retains complete changed-block facts while bounding only rendered presentation', () => {
  const names = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
  const symbols = names.map((name) => ({ specifier: '.', exportName: name, kind: 'type' }));
  const report = comparePublicApiReleaseRecords({
    packageName: '@happier-dev/example',
    candidateVersion: '0.1.0-preview.2',
    previousVersion: '0.1.0-preview.1',
    previousInventory: inventory(symbols),
    candidateInventory: inventory(symbols),
    previousDeclarations: declarationReport(names.map((name) => ({
      name,
      declaration: `type ${name} = { value?: string };`,
    }))),
    candidateDeclarations: declarationReport(names.map((name) => ({
      name,
      declaration: `type ${name} = { value: string };`,
    }))),
  });

  assert.equal(report.facts.changedDeclarationBlocks.length, 6);
  assert.equal(summarizePublicApiReleaseComparison(report).changedDeclarationBlocks, 6);
  const rendered = renderPublicApiReleaseComparison(report);
  assert.match(rendered, /changed-declaration-blocks=6/u);
  assert.match(rendered, /… and 1 more changed declaration blocks \(6 total\)/u);
});

test('keeps a first publication dormant rather than inventing a predecessor', () => {
  const report = comparePublicApiReleaseRecords({
    packageName: '@happier-dev/example',
    candidateVersion: '0.1.0-preview.1',
    previousVersion: null,
    previousInventory: null,
    candidateInventory: inventory([{ specifier: '.', exportName: 'New', kind: 'value' }]),
    previousDeclarations: null,
    candidateDeclarations: declarationReport([
      { name: 'New', kind: 'value', declaration: 'declare const New: unique symbol;' },
    ]),
  });

  assert.equal(report.status, 'dormant_pre_baseline');
  assert.equal(report.disposition.humanReviewRequired, false);
});

test('ignores publisher-owned since provenance when the source contract is unchanged', () => {
  const report = comparePublicApiReleaseRecords({
    packageName: '@happier-dev/example',
    candidateVersion: '0.1.0-preview.2',
    previousVersion: '0.1.0-preview.1',
    previousInventory: inventory([{
      specifier: '.',
      exportName: 'Alpha',
      kind: 'type',
      since: '0.1.0-preview.1',
    }]),
    candidateInventory: inventory([{
      specifier: '.',
      exportName: 'Alpha',
      kind: 'type',
      since: '0.1.0-preview.2',
    }]),
    previousDeclarations: declarationReport([
      { name: 'Alpha', declaration: 'type Alpha = { value?: string };' },
    ]),
    candidateDeclarations: declarationReport([
      { name: 'Alpha', declaration: 'type Alpha = { value?: string };' },
    ]),
  });

  assert.deepEqual(report.facts.changedSymbols, []);
  assert.deepEqual(report.facts.unchangedSymbols, ['.:Alpha']);
  assert.equal(report.disposition.humanReviewRequired, false);
  assert.equal(report.disposition.versionDecision, 'no_surface_change');
});
