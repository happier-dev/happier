import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

type LedgerEvidenceModule = typeof import('./ledgerEvidenceClosure.ts');

async function loadValidator(): Promise<LedgerEvidenceModule> {
  try {
    return await import('./ledgerEvidenceClosure.ts');
  } catch (error) {
    assert.fail(`ledger evidence validator module should load: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createRepo(): string {
  return mkdtempSync(join(tmpdir(), 'happier-ledger-evidence-validator-'));
}

function writeRepoFile(rootDir: string, filePath: string, content: string): void {
  const absolutePath = join(rootDir, filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

function sourceLedger(rows: readonly string[]): string {
  return [
    [
      'row_id',
      'current_path',
      'package_area',
      'loc',
      'top_level_exports',
      'key_symbols',
      'behavior_summary',
      'source_read_depth',
      'current_owner',
      'concept_id',
      'surface',
      'disposition',
      'target_owner',
      'target_path',
      'owning_stage',
      'owning_packet',
      'proof_required',
      'source_consumers',
      'mixed_responsibility',
      'confidence',
      'review_owner',
      'file_anchor',
      'adjudication_status',
      'source_evidence_refs',
      'notes',
    ].join('\t'),
    ...rows,
  ].join('\n');
}

function structureLedger(rows: readonly string[]): string {
  return [
    [
      'row_id',
      'current_path',
      'path_kind',
      'package_area',
      'current_role',
      'target_role',
      'violated_rule',
      'issue_kind',
      'target_path',
      'disposition',
      'owning_concept',
      'owning_packet',
      'proof_required',
      'confidence',
      'source_evidence_refs',
      'notes',
    ].join('\t'),
    ...rows,
  ].join('\n');
}

test('validateSourceDispositionAnchors rejects stale and missing current anchors', async () => {
  const { validateSourceDispositionAnchors } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(rootDir, 'src/current.ts', 'export const value = 1;\n');
  const ledger = sourceLedger([
    [
      'S-1',
      '[CURRENT]src/current.ts',
      'pkg',
      '1',
      '-',
      '-',
      '-',
      'full',
      'owner',
      'concept',
      'surface',
      'KEEP_IN_CORE',
      'owner',
      '[TARGET]src/current.ts',
      'A',
      'A.1',
      'n/a',
      '-',
      'none',
      'high',
      '-',
      'wronghash000',
      'open',
      '[CURRENT]src/current.ts',
      '-',
    ].join('\t'),
    [
      'S-2',
      '[CURRENT]src/missing.ts',
      'pkg',
      '1',
      '-',
      '-',
      '-',
      'full',
      'owner',
      'concept',
      'surface',
      'KEEP_IN_CORE',
      'owner',
      '[TARGET]src/missing.ts',
      'A',
      'A.1',
      'n/a',
      '-',
      'none',
      'high',
      '-',
      '',
      'open',
      '[CURRENT]src/missing.ts',
      '-',
    ].join('\t'),
    [
      'S-3',
      '[STALE]src/deleted.ts',
      'pkg',
      '1',
      '-',
      '-',
      '-',
      'full',
      'owner',
      'concept',
      'surface',
      'DELETE',
      'owner',
      '[TARGET]src/deleted.ts',
      'A',
      'A.1',
      'n/a',
      '-',
      'none',
      'high',
      '-',
      '',
      'open',
      '[STALE]src/deleted.ts',
      '-',
    ].join('\t'),
  ]);
  writeRepoFile(rootDir, 'ledger/source.tsv', ledger);

  const result = validateSourceDispositionAnchors({
    rootDir,
    ledgerPath: 'ledger/source.tsv',
  });

  assert.equal(result.ok, false);
  assert.equal(result.checkedRows, 2);
  assert.deepEqual(result.errors.map((error) => error.rowId), ['S-1', 'S-2']);
  assert.match(result.errors[0]?.message ?? '', /stale anchor/);
  assert.match(result.errors[1]?.message ?? '', /missing current source file/);
});

test('validateSourceDispositionAnchors accepts explicitly reconciled stale anchors only when current reality still matches', async () => {
  const { computeFileAnchor, validateSourceDispositionAnchors } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(rootDir, 'src/current.ts', 'export const value = 2;\n');
  const actualAnchor = computeFileAnchor(join(rootDir, 'src/current.ts'));
  writeRepoFile(
    rootDir,
    'ledger/source.tsv',
    sourceLedger([
      [
        'S-1',
        '[CURRENT]src/current.ts',
        'pkg',
        '1',
        '-',
        '-',
        '-',
        'full',
        'owner',
        'concept',
        'surface',
        'KEEP_IN_CORE',
        'owner',
        '[TARGET]src/current.ts',
        'A',
        'A.1',
        'n/a',
        '-',
        'none',
        'high',
        '-',
        'oldhash00000',
        'open',
        '[CURRENT]src/current.ts',
        '-',
      ].join('\t'),
    ]),
  );
  writeRepoFile(
    rootDir,
    'ledger/reconciled.tsv',
    [
      'row_id\tcurrent_path\texpected_anchor\tactual_anchor\treason',
      `S-1\t[CURRENT]src/current.ts\toldhash00000\t${actualAnchor}\tsource-reality drift, owner lane still open`,
    ].join('\n'),
  );

  const result = validateSourceDispositionAnchors({
    rootDir,
    ledgerPath: 'ledger/source.tsv',
    reconciliationPath: 'ledger/reconciled.tsv',
  });

  assert.equal(result.ok, true);
  assert.equal(result.checkedRows, 1);
  assert.equal(result.reconciledRows, 1);
  assert.deepEqual(result.errors, []);
});

test('validateSourceDispositionAnchors rejects stale reconciliation rows that no longer match source reality', async () => {
  const { validateSourceDispositionAnchors } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(rootDir, 'src/current.ts', 'export const value = 3;\n');
  writeRepoFile(
    rootDir,
    'ledger/source.tsv',
    sourceLedger([
      [
        'S-1',
        '[CURRENT]src/current.ts',
        'pkg',
        '1',
        '-',
        '-',
        '-',
        'full',
        'owner',
        'concept',
        'surface',
        'KEEP_IN_CORE',
        'owner',
        '[TARGET]src/current.ts',
        'A',
        'A.1',
        'n/a',
        '-',
        'none',
        'high',
        '-',
        'oldhash00000',
        'open',
        '[CURRENT]src/current.ts',
        '-',
      ].join('\t'),
    ]),
  );
  writeRepoFile(
    rootDir,
    'ledger/reconciled.tsv',
    [
      'row_id\tcurrent_path\texpected_anchor\tactual_anchor\treason',
      'S-1\t[CURRENT]src/current.ts\toldhash00000\twrongactual0\tsource-reality drift, owner lane still open',
    ].join('\n'),
  );

  const result = validateSourceDispositionAnchors({
    rootDir,
    ledgerPath: 'ledger/source.tsv',
    reconciliationPath: 'ledger/reconciled.tsv',
  });

  assert.equal(result.ok, false);
  assert.equal(result.checkedRows, 1);
  assert.equal(result.reconciledRows, 0);
  assert.match(result.errors[0]?.message ?? '', /stale anchor/);
});

test('validateSourceDispositionAnchors accepts explicitly reconciled missing current files only when marked missing', async () => {
  const { validateSourceDispositionAnchors } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(
    rootDir,
    'ledger/source.tsv',
    sourceLedger([
      [
        'S-1',
        '[CURRENT]src/deleted.ts',
        'pkg',
        '1',
        '-',
        '-',
        '-',
        'full',
        'owner',
        'concept',
        'surface',
        'DELETE',
        'owner',
        '[DELETE]',
        'A',
        'A.1',
        'n/a',
        '-',
        'none',
        'high',
        '-',
        'oldhash00000',
        'open',
        '[CURRENT]src/deleted.ts',
        '-',
      ].join('\t'),
    ]),
  );
  writeRepoFile(
    rootDir,
    'ledger/reconciled.tsv',
    [
      'row_id\tcurrent_path\texpected_anchor\tactual_anchor\treason',
      'S-1\t[CURRENT]src/deleted.ts\toldhash00000\t[MISSING]\tsource-reality drift, obsolete ledger current path',
    ].join('\n'),
  );

  const result = validateSourceDispositionAnchors({
    rootDir,
    ledgerPath: 'ledger/source.tsv',
    reconciliationPath: 'ledger/reconciled.tsv',
  });

  assert.equal(result.ok, true);
  assert.equal(result.checkedRows, 1);
  assert.equal(result.reconciledRows, 1);
  assert.deepEqual(result.errors, []);
});

test('validateSourceDispositionAnchors accepts matching current anchors', async () => {
  const { computeFileAnchor, validateSourceDispositionAnchors } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(rootDir, 'src/current.ts', 'export const value = 1;\n');
  const anchor = computeFileAnchor(join(rootDir, 'src/current.ts'));
  writeRepoFile(
    rootDir,
    'ledger/source.tsv',
    sourceLedger([
      [
        'S-1',
        '[CURRENT]src/current.ts',
        'pkg',
        '1',
        '-',
        '-',
        '-',
        'full',
        'owner',
        'concept',
        'surface',
        'KEEP_IN_CORE',
        'owner',
        '[TARGET]src/current.ts',
        'A',
        'A.1',
        'n/a',
        '-',
        'none',
        'high',
        '-',
        anchor,
        'open',
        '[CURRENT]src/current.ts',
        '-',
      ].join('\t'),
    ]),
  );

  const result = validateSourceDispositionAnchors({
    rootDir,
    ledgerPath: 'ledger/source.tsv',
  });

  assert.equal(result.ok, true);
  assert.equal(result.checkedRows, 1);
  assert.deepEqual(result.errors, []);
});

test('validateStructureCurrentPaths reports missing ok/keep paths without scanning non-current rows', async () => {
  const { validateStructureCurrentPaths } = await loadValidator();
  const rootDir = createRepo();
  writeRepoFile(rootDir, 'src/exists.ts', 'export const exists = true;\n');
  writeRepoFile(
    rootDir,
    'ledger/structure.tsv',
    structureLedger([
      [
        'STR-1',
        '[CURRENT]src/exists.ts',
        'file',
        'pkg',
        'canonical-path',
        'canonical-path',
        'none',
        'ok',
        '[TARGET]src/exists.ts',
        'keep',
        'concept',
        'A.1',
        'n/a',
        'high',
        '[CURRENT]src/exists.ts',
        '-',
      ].join('\t'),
      [
        'STR-2',
        '[CURRENT]src/missing.ts',
        'file',
        'pkg',
        'canonical-path',
        'canonical-path',
        'none',
        'ok',
        '[TARGET]src/missing.ts',
        'keep',
        'concept',
        'A.1',
        'n/a',
        'high',
        '[CURRENT]src/missing.ts',
        '-',
      ].join('\t'),
      [
        'STR-3',
        '[STALE]src/deleted.ts',
        'file',
        'pkg',
        'canonical-path',
        'canonical-path',
        'none',
        'ok',
        '[TARGET]src/deleted.ts',
        'keep',
        'concept',
        'A.1',
        'n/a',
        'high',
        '[STALE]src/deleted.ts',
        '-',
      ].join('\t'),
    ]),
  );

  const result = validateStructureCurrentPaths({
    rootDir,
    ledgerPath: 'ledger/structure.tsv',
  });

  assert.equal(result.ok, false);
  assert.equal(result.checkedRows, 2);
  assert.deepEqual(result.errors.map((error) => error.rowId), ['STR-2']);
});
