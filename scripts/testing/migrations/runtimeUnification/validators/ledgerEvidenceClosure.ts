import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LedgerEvidenceError {
  rowId: string;
  filePath: string;
  message: string;
}

export interface LedgerEvidenceResult {
  ok: boolean;
  checkedRows: number;
  reconciledRows: number;
  errors: readonly LedgerEvidenceError[];
}

interface LedgerRow {
  rowNumber: number;
  values: Readonly<Record<string, string>>;
}

const DEFAULT_SOURCE_LEDGER_PATH = '.project/plans/runtime-unification-v2/execution/source-disposition-ledger.tsv';
const DEFAULT_STRUCTURE_LEDGER_PATH = '.project/plans/runtime-unification-v2/execution/structure-disposition-ledger.tsv';
const DEFAULT_ANCHOR_RECONCILIATION_PATH = '.project/plans/runtime-unification-v2/_validation/source-anchor-reconciliation.tsv';
const CURRENT_PREFIX = '[CURRENT]';
const MISSING_RECONCILIATION_ANCHOR = '[MISSING]';

export function computeFileAnchor(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 12);
}

export function validateSourceDispositionAnchors(options?: Readonly<{
  rootDir?: string;
  ledgerPath?: string;
  reconciliationPath?: string;
}>): LedgerEvidenceResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const ledgerPath = options?.ledgerPath ?? DEFAULT_SOURCE_LEDGER_PATH;
  const rows = readTsvRows(resolve(rootDir, ledgerPath));
  const reconciliations = readAnchorReconciliations(
    resolve(rootDir, options?.reconciliationPath ?? DEFAULT_ANCHOR_RECONCILIATION_PATH),
  );
  const usedReconciliations = new Set<string>();
  const errors: LedgerEvidenceError[] = [];
  let checkedRows = 0;
  let reconciledRows = 0;

  for (const row of rows) {
    const currentPath = row.values.current_path ?? '';
    if (!currentPath.startsWith(CURRENT_PREFIX)) {
      continue;
    }
    checkedRows += 1;
    const filePath = stripCurrentPrefix(currentPath);
    const absoluteFilePath = resolve(rootDir, filePath);
    const rowId = row.values.row_id ?? `line-${row.rowNumber}`;
    if (!existsSync(absoluteFilePath)) {
      const reconciliationKey = createReconciliationKey(rowId, currentPath);
      const reconciliation = reconciliations.get(reconciliationKey);
      const expectedAnchor = row.values.file_anchor ?? '';
      if (
        reconciliation
        && reconciliation.expectedAnchor === expectedAnchor
        && reconciliation.actualAnchor === MISSING_RECONCILIATION_ANCHOR
      ) {
        usedReconciliations.add(reconciliationKey);
        reconciledRows += 1;
        continue;
      }
      errors.push({
        rowId,
        filePath,
        message: `${rowId}: missing current source file: ${filePath}`,
      });
      continue;
    }
    const expectedAnchor = row.values.file_anchor ?? '';
    if (!expectedAnchor) {
      errors.push({
        rowId,
        filePath,
        message: `${rowId}: missing source file anchor for current file: ${filePath}`,
      });
      continue;
    }
    const actualAnchor = computeFileAnchor(absoluteFilePath);
    if (expectedAnchor !== actualAnchor) {
      const reconciliationKey = createReconciliationKey(rowId, currentPath);
      const reconciliation = reconciliations.get(reconciliationKey);
      if (
        reconciliation
        && reconciliation.expectedAnchor === expectedAnchor
        && reconciliation.actualAnchor === actualAnchor
      ) {
        usedReconciliations.add(reconciliationKey);
        reconciledRows += 1;
        continue;
      }
      errors.push({
        rowId,
        filePath,
        message: `${rowId}: stale anchor for ${filePath}: expected=${expectedAnchor} actual=${actualAnchor}`,
      });
    }
  }

  for (const [key, reconciliation] of reconciliations) {
    if (usedReconciliations.has(key)) {
      continue;
    }
    errors.push({
      rowId: reconciliation.rowId,
      filePath: stripCurrentPrefix(reconciliation.currentPath),
      message: `${reconciliation.rowId}: unused or stale anchor reconciliation for ${reconciliation.currentPath}`,
    });
  }

  return {
    ok: errors.length === 0,
    checkedRows,
    reconciledRows,
    errors,
  };
}

export function validateStructureCurrentPaths(options?: Readonly<{
  rootDir?: string;
  ledgerPath?: string;
}>): LedgerEvidenceResult {
  const rootDir = options?.rootDir ?? process.cwd();
  const ledgerPath = options?.ledgerPath ?? DEFAULT_STRUCTURE_LEDGER_PATH;
  const rows = readTsvRows(resolve(rootDir, ledgerPath));
  const errors: LedgerEvidenceError[] = [];
  let checkedRows = 0;

  for (const row of rows) {
    const currentPath = row.values.current_path ?? '';
    if (!currentPath.startsWith(CURRENT_PREFIX)) {
      continue;
    }
    if (row.values.issue_kind !== 'ok' || row.values.disposition !== 'keep') {
      continue;
    }
    checkedRows += 1;
    const filePath = stripCurrentPrefix(currentPath);
    const absoluteFilePath = resolve(rootDir, filePath);
    if (existsSync(absoluteFilePath)) {
      continue;
    }
    const rowId = row.values.row_id ?? `line-${row.rowNumber}`;
    errors.push({
      rowId,
      filePath,
      message: `${rowId}: missing current structure path: ${filePath}`,
    });
  }

  return {
    ok: errors.length === 0,
    checkedRows,
    reconciledRows: 0,
    errors,
  };
}

interface AnchorReconciliation {
  rowId: string;
  currentPath: string;
  expectedAnchor: string;
  actualAnchor: string;
}

function readAnchorReconciliations(filePath: string): Map<string, AnchorReconciliation> {
  if (!existsSync(filePath)) {
    return new Map();
  }
  const reconciliations = new Map<string, AnchorReconciliation>();
  for (const row of readTsvRows(filePath)) {
    const rowId = row.values.row_id ?? '';
    const currentPath = row.values.current_path ?? '';
    if (!rowId || !currentPath.startsWith(CURRENT_PREFIX)) {
      continue;
    }
    reconciliations.set(createReconciliationKey(rowId, currentPath), {
      rowId,
      currentPath,
      expectedAnchor: row.values.expected_anchor ?? '',
      actualAnchor: row.values.actual_anchor ?? '',
    });
  }
  return reconciliations;
}

function createReconciliationKey(rowId: string, currentPath: string): string {
  return `${rowId}\t${currentPath}`;
}

function readTsvRows(filePath: string): LedgerRow[] {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter((line) => line.length > 0);
  const header = (lines[0] ?? '').split('\t');
  const rows: LedgerRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const columns = (lines[index] ?? '').split('\t');
    const values: Record<string, string> = {};
    for (let columnIndex = 0; columnIndex < header.length; columnIndex += 1) {
      values[header[columnIndex] ?? ''] = columns[columnIndex] ?? '';
    }
    rows.push({
      rowNumber: index + 1,
      values,
    });
  }
  return rows;
}

function stripCurrentPrefix(value: string): string {
  return value.slice(CURRENT_PREFIX.length);
}

function printResult(result: LedgerEvidenceResult): void {
  console.log(`checked_rows=${result.checkedRows}`);
  console.log(`reconciled_rows=${result.reconciledRows}`);
  console.log(`error_rows=${result.errors.length}`);
  for (const error of result.errors.slice(0, 50)) {
    console.log(error.message);
  }
  if (result.errors.length > 50) {
    console.log(`additional_error_rows=${result.errors.length - 50}`);
  }
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
}

if (isDirectRun()) {
  const mode = process.argv.includes('--structure-current-paths')
    ? 'structure-current-paths'
    : 'source-anchors';
  const rootDirArgIndex = process.argv.indexOf('--root');
  const rootDir = rootDirArgIndex >= 0 ? process.argv[rootDirArgIndex + 1] : process.cwd();
  const ledgerArgIndex = process.argv.indexOf('--ledger');
  const ledgerPath = ledgerArgIndex >= 0 ? process.argv[ledgerArgIndex + 1] : undefined;
  const result = mode === 'structure-current-paths'
    ? validateStructureCurrentPaths({ rootDir, ledgerPath })
    : validateSourceDispositionAnchors({ rootDir, ledgerPath });
  printResult(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}
