import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { validateAgentIdsGenerated } from './validators/validateAgentIdsGenerated.ts';
import { validateNoHostImposedPermissionTtl } from './validators/validateNoHostImposedPermissionTtl.ts';
import { validateCrossCuttingDuplicateClosure } from './validators/crossCuttingDuplicateClosure.ts';
import { validateBackendExtractionClosure } from './validators/backendExtractionClosure.ts';
import { validateProviderSettingsSingleOwner } from './validators/providerSettingsSingleOwner.ts';
import { validateFinalCanonicalLayoutClosure } from './validators/finalCanonicalLayoutClosure.ts';
import { validateReleaseGovernanceClosure } from './validators/releaseGovernanceClosure.ts';
import { validateRpcActionCoverage } from '../lib/rpcActionCoverage.ts';

export interface RuntimeUnificationValidatorEntry {
  id: string;
  validate: (options: Readonly<{ rootDir: string }>) => Promise<RuntimeUnificationRunnerValidatorResult> | RuntimeUnificationRunnerValidatorResult;
}

export interface RuntimeUnificationRunnerValidatorResult {
  validatorId: string;
  ok: boolean;
  errors: readonly string[];
  scannedFiles?: readonly string[];
}

export interface RuntimeUnificationRunnerResult {
  ok: boolean;
  totalValidators: number;
  failedValidators: number;
  results: readonly RuntimeUnificationRunnerValidatorResult[];
}

export interface RuntimeUnificationFinalClosureDependencyBlocker {
  id: string;
  source: 'packet-ledger' | 'sdk-freeze-gate' | 'structure-ledger';
  status: string;
  detail: string;
}

export interface RuntimeUnificationFinalClosureResult {
  finalClosureOk: boolean;
  validatorResult: RuntimeUnificationRunnerResult;
  dependencyBlockers: readonly RuntimeUnificationFinalClosureDependencyBlocker[];
}

const FINAL_CLOSURE_REQUIRED_PACKET_IDS = Object.freeze([
  'B.8',
  'C.5.1-opencode-host-compatibility-drain',
  'D.7',
  'E.8.1-gemini-acp-revival-finish-and-host-deletion',
  'ANTIGRAVITY-1-agent-plugin-foundation-and-terminal-runtime',
  'ANTIGRAVITY-2-localharness-runtime',
  'F.1',
  'F.3',
  'F.5',
  'F.6',
  'F.7',
  'A.13o.2-session-mutation-outbox-retry-dependency-semantics',
  'A.13o.2.1-outbox-dead-letter-prerequisite-retention',
  'SDK-GENERIC-HELPERS-1-plugin-adoption',
  'MESSAGE-META-REGISTRY-1-deletion',
  'ENGINE-REGISTRY-SPLIT-1-registry-decomposition',
  'A.13q.5-public-sdk-surface-and-first-party-dogfood',
]);

const SDK_FREEZE_ROWS_REQUIRED_FOR_FINAL_CLOSURE = Object.freeze([
  'GATE-47',
  'GATE-48',
]);

export function listRuntimeUnificationValidators(): readonly RuntimeUnificationValidatorEntry[] {
  return [
    {
      id: 'A.X-agent-ids-codegen',
      validate({ rootDir }) {
        const result = validateAgentIdsGenerated({ rootDir });
        return {
          validatorId: 'A.X-agent-ids-codegen',
          ok: result.ok,
          errors: prefixErrors('A.X-agent-ids-codegen', result.errors),
          scannedFiles: result.scannedFiles,
        };
      },
    },
    {
      id: 'J.X-no-host-imposed-permission-ttl',
      validate({ rootDir }) {
        const result = validateNoHostImposedPermissionTtl({ rootDir });
        return {
          validatorId: 'J.X-no-host-imposed-permission-ttl',
          ok: result.ok,
          errors: prefixErrors('J.X-no-host-imposed-permission-ttl', result.errors),
          scannedFiles: result.scannedFiles,
        };
      },
    },
    {
      id: 'F.5-cross-cutting-duplicate-closure',
      validate({ rootDir }) {
        const result = validateCrossCuttingDuplicateClosure({ rootDir });
        return {
          validatorId: result.validatorId,
          ok: result.ok,
          errors: prefixErrors(result.validatorId, result.violations.map((violation) => violation.message)),
          scannedFiles: result.scannedFiles,
        };
      },
    },
    {
      id: 'F.5-backend-extraction-closure',
      validate({ rootDir }) {
        const result = validateBackendExtractionClosure({ rootDir });
        return {
          validatorId: 'F.5-backend-extraction-closure',
          ok: result.ok,
          errors: prefixErrors('F.5-backend-extraction-closure', result.violations.map((violation) => violation.message)),
          scannedFiles: result.scannedFiles,
        };
      },
    },
    {
      id: 'PROVIDER-SETTINGS-SDK-1-single-owner',
      validate({ rootDir }) {
        const result = validateProviderSettingsSingleOwner({ rootDir });
        return {
          validatorId: result.validatorId,
          ok: result.ok,
          errors: prefixErrors(result.validatorId, result.errors),
          scannedFiles: result.scannedFiles,
        };
      },
    },
    {
      id: 'RPC-ACTION-SPEC-closure',
      validate({ rootDir }) {
        const result = validateRpcActionCoverage(
          hasRpcActionCoverageSources(rootDir)
            ? {}
            : {
              rpcMethods: {},
              sessionRpcMethods: {},
              actionSpecs: [],
              genericActionSpecRpcMethods: [],
              actionSpecRpcExceptions: [],
              internalOnlyEntries: [],
              machineRpcRoutePolicies: [],
            },
        );
        return {
          validatorId: 'RPC-ACTION-SPEC-closure',
          ok: result.ok,
          errors: prefixErrors('RPC-ACTION-SPEC-closure', result.errors.map((error) => error.message)),
          scannedFiles: [],
        };
      },
    },
    {
      id: 'F.7-final-canonical-layout-closure',
      validate({ rootDir }) {
        const result = validateFinalCanonicalLayoutClosure({ rootDir });
        return {
          validatorId: result.validatorId,
          ok: result.ok,
          errors: prefixErrors(result.validatorId, result.errors),
          scannedFiles: result.scannedFiles,
        };
      },
    },
    {
      id: 'RU2-release-governance-closure',
      validate({ rootDir }) {
        const result = validateReleaseGovernanceClosure({ rootDir });
        return {
          validatorId: result.validatorId,
          ok: result.ok,
          errors: prefixErrors(result.validatorId, result.violations.map((violation) => violation.message)),
          scannedFiles: result.scannedFiles,
        };
      },
    },
  ];
}

function hasRpcActionCoverageSources(rootDir: string): boolean {
  return existsSync(resolve(rootDir, 'apps/cli/src/rpc'))
    || existsSync(resolve(rootDir, 'packages/protocol/src/rpc'));
}

function prefixErrors(validatorId: string, errors: readonly string[]): readonly string[] {
  return errors.map((error) => `${validatorId}: ${error}`);
}

export async function runAllValidators(options?: Readonly<{
  rootDir?: string;
}>): Promise<RuntimeUnificationRunnerResult> {
  const rootDir = options?.rootDir ?? process.cwd();
  const results: RuntimeUnificationRunnerValidatorResult[] = [];
  for (const validator of listRuntimeUnificationValidators()) {
    results.push(await validator.validate({ rootDir }));
  }
  const failedValidators = results.filter((result) => !result.ok).length;
  return {
    ok: failedValidators === 0,
    totalValidators: results.length,
    failedValidators,
    results,
  };
}

export async function runFinalClosureValidators(options?: Readonly<{
  rootDir?: string;
  includeF6SelfAcceptance?: boolean;
}>): Promise<RuntimeUnificationFinalClosureResult> {
  const rootDir = options?.rootDir ?? process.cwd();
  const validatorResult = await runAllValidators({ rootDir });
  const dependencyBlockers = collectFinalClosureDependencyBlockers(rootDir, {
    includeF6SelfAcceptance: options?.includeF6SelfAcceptance === true,
  });
  return {
    finalClosureOk: validatorResult.ok && dependencyBlockers.length === 0,
    validatorResult,
    dependencyBlockers,
  };
}

function collectFinalClosureDependencyBlockers(
  rootDir: string,
  options: Readonly<{ includeF6SelfAcceptance: boolean }>,
): RuntimeUnificationFinalClosureDependencyBlocker[] {
  return [
    ...collectPacketLedgerBlockers(rootDir, options),
    ...collectSdkFreezeBlockers(rootDir),
    ...collectF7StructureAdjudicationBlockers(rootDir),
  ];
}

function collectPacketLedgerBlockers(
  rootDir: string,
  options: Readonly<{ includeF6SelfAcceptance: boolean }>,
): RuntimeUnificationFinalClosureDependencyBlocker[] {
  const ledgerPath = resolve(rootDir, '.project/plans/runtime-unification-v2/execution/packet-ledger.tsv');
  if (!existsSync(ledgerPath)) {
    return [{
      id: 'packet-ledger',
      source: 'packet-ledger',
      status: 'missing',
      detail: 'missing final-closure packet status ledger',
    }];
  }
  const rows = readTsvRecords(ledgerPath);
  const byPacketId = new Map(rows.map((row) => [row.packet_id ?? '', row]));
  const blockers: RuntimeUnificationFinalClosureDependencyBlocker[] = [];
  const requiredPacketIds = options.includeF6SelfAcceptance
    ? FINAL_CLOSURE_REQUIRED_PACKET_IDS
    : FINAL_CLOSURE_REQUIRED_PACKET_IDS.filter((packetId) => packetId !== 'F.6');
  for (const packetId of requiredPacketIds) {
    const row = byPacketId.get(packetId);
    if (!row) {
      blockers.push({
        id: packetId,
        source: 'packet-ledger',
        status: 'missing',
        detail: 'required final-closure packet row is missing from packet-ledger.tsv',
      });
      continue;
    }
    const status = row.status ?? '';
    if (status !== 'accepted') {
      blockers.push({
        id: packetId,
        source: 'packet-ledger',
        status,
        detail: 'final closure requires accepted packet status',
      });
    }
  }
  return blockers;
}

function collectSdkFreezeBlockers(rootDir: string): RuntimeUnificationFinalClosureDependencyBlocker[] {
  const freezeGatePath = resolve(rootDir, '.project/plans/runtime-unification-v2/execution/SDK-FREEZE-GATE.md');
  if (!existsSync(freezeGatePath)) {
    return [{
      id: 'SDK-FREEZE-GATE',
      source: 'sdk-freeze-gate',
      status: 'missing',
      detail: 'missing SDK freeze predicate',
    }];
  }
  const rows = readMarkdownTableRows(freezeGatePath);
  const byRowId = new Map(rows.map((row) => [row.id ?? '', row]));
  const blockers: RuntimeUnificationFinalClosureDependencyBlocker[] = [];
  for (const rowId of SDK_FREEZE_ROWS_REQUIRED_FOR_FINAL_CLOSURE) {
    const row = byRowId.get(rowId);
    if (!row) {
      blockers.push({
        id: `SDK-FREEZE-GATE:${rowId}`,
        source: 'sdk-freeze-gate',
        status: 'missing',
        detail: 'required SDK freeze row is missing',
      });
      continue;
    }
    const state = row.state ?? '';
    if (state !== 'closed') {
      blockers.push({
        id: `SDK-FREEZE-GATE:${rowId}`,
        source: 'sdk-freeze-gate',
        status: state,
        detail: 'full final closure requires this SDK freeze row to close; do not close it early',
      });
    }
  }
  return blockers;
}

function collectF7StructureAdjudicationBlockers(rootDir: string): RuntimeUnificationFinalClosureDependencyBlocker[] {
  const ledgerPath = resolve(rootDir, '.project/plans/runtime-unification-v2/execution/structure-disposition-ledger.tsv');
  if (!existsSync(ledgerPath)) {
    return [];
  }
  return readTsvRecords(ledgerPath)
    .filter((row) => row.owning_packet === 'F.7' && readStructureRowStatus(row) === 'UNKNOWN_NEEDS_ADJUDICATION')
    .map((row) => ({
      id: row.row_id ?? 'F.7-structure-row',
      source: 'structure-ledger' as const,
      status: readStructureRowStatus(row),
      detail: `F.7 structure row remains unadjudicated: ${row.current_path ?? '<missing path>'}`,
    }));
}

function readStructureRowStatus(row: Readonly<Record<string, string>>): string {
  return row.adjudication_status ?? row.issue_kind ?? '';
}

function readTsvRecords(filePath: string): Array<Record<string, string>> {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter((line) => line.length > 0);
  const header = (lines[0] ?? '').split('\t');
  return lines.slice(1).map((line) => {
    const columns = line.split('\t');
    const record: Record<string, string> = {};
    for (let index = 0; index < header.length; index += 1) {
      record[header[index] ?? ''] = columns[index] ?? '';
    }
    return record;
  });
}

function readMarkdownTableRows(filePath: string): Array<Record<string, string>> {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  const tableRows = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
  const headerIndex = tableRows.findIndex((row) => row.includes('id') && row.includes('state'));
  if (headerIndex < 0) {
    return [];
  }
  const header = tableRows[headerIndex] ?? [];
  return tableRows.slice(headerIndex + 2).map((row) => {
    const record: Record<string, string> = {};
    for (let index = 0; index < header.length; index += 1) {
      record[header[index] ?? ''] = row[index] ?? '';
    }
    return record;
  });
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  if (hasArg('--list')) {
    for (const validator of listRuntimeUnificationValidators()) {
      console.log(validator.id);
    }
  } else if (hasArg('--final-closure')) {
    const result = await runFinalClosureValidators({ includeF6SelfAcceptance: true });
    if (hasArg('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`runtime-unification final closure: validator_ok=${result.validatorResult.ok} dependency_blockers=${result.dependencyBlockers.length} final_closure_ok=${result.finalClosureOk}`);
      for (const blocker of result.dependencyBlockers) {
        console.log(`BLOCKED ${blocker.id} [${blocker.source}] status=${blocker.status}: ${blocker.detail}`);
      }
      if (!result.validatorResult.ok) {
        console.log(`validator_failures=${result.validatorResult.failedValidators}`);
      }
    }
    if (!result.finalClosureOk) {
      process.exitCode = 1;
    }
  } else {
    const result = await runAllValidators();
    if (hasArg('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`runtime-unification validators: total=${result.totalValidators} failed=${result.failedValidators}`);
      for (const validatorResult of result.results) {
        console.log(`${validatorResult.ok ? 'PASS' : 'FAIL'} ${validatorResult.validatorId}`);
        for (const error of validatorResult.errors) {
          console.log(`  - ${error}`);
        }
      }
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
  }
}

if (isDirectRun()) {
  void main();
}
