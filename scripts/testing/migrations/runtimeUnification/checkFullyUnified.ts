import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  runFinalClosureValidators,
  runAllValidators,
  type RuntimeUnificationFinalClosureDependencyBlocker,
  type RuntimeUnificationRunnerResult,
} from './runAllValidators.ts';
import {
  validateReleaseContract,
  type RuntimeUnificationReleaseContractResult,
} from './validateReleaseContract.ts';
import {
  runStrippedPathBinarySmoke,
  runRepresentativeRuntimeFixture,
  type StrippedPathBinarySmokeResult,
  type RepresentativeRuntimeFixtureResult,
} from '../../smoke/strippedPathBinarySmoke.ts';
import {
  runV2ZeroInventoryGate,
  type V2ZeroInventoryGateResult,
} from '../validateV2ZeroInventory.ts';

export interface FullyUnifiedStatus {
  ok: boolean;
  detail: string;
}

export interface FullyUnifiedStrippedPathStatus extends FullyUnifiedStatus {
  sourceScan: StrippedPathBinarySmokeResult;
  representativeRuntime: RepresentativeRuntimeFixtureResult;
}

export interface FullyUnifiedFinalClosureStatus extends FullyUnifiedStatus {
  mode: 'focused' | 'final';
  blockers: readonly RuntimeUnificationFinalClosureDependencyBlocker[];
}

export interface FullyUnifiedCheckResult {
  fullyUnified: boolean;
  foundationGate: RuntimeUnificationRunnerResult;
  v2ZeroInventory: V2ZeroInventoryGateResult;
  releaseContract: RuntimeUnificationReleaseContractResult;
  strippedPathSmoke: FullyUnifiedStrippedPathStatus;
  finalClosure: FullyUnifiedFinalClosureStatus;
  finalClosureBlockers: readonly RuntimeUnificationFinalClosureDependencyBlocker[];
  validatorResult: RuntimeUnificationRunnerResult;
  dependencyBlockers: readonly RuntimeUnificationFinalClosureDependencyBlocker[];
}

export async function checkFullyUnified(options?: Readonly<{
  rootDir?: string;
  finalMode?: boolean;
}>): Promise<FullyUnifiedCheckResult> {
  const rootDir = options?.rootDir ?? process.cwd();
  const finalMode = options?.finalMode === true;
  const foundationGate = await runAllValidators({ rootDir });
  const v2ZeroInventory = await runV2ZeroInventoryGate({ rootDir });
  const releaseContract = await validateReleaseContract({ rootDir });
  const sourceScan = runStrippedPathBinarySmoke({ rootDir });
  const representativeRuntime = await runRepresentativeRuntimeFixture({ rootDir });
  const finalClosureResult = await runFinalClosureValidators({
    rootDir,
    includeF6SelfAcceptance: finalMode,
  });
  const strippedPathSmoke: FullyUnifiedStrippedPathStatus = {
    ok: sourceScan.ok && representativeRuntime.ok,
    detail: `source_violations=${sourceScan.violations.length} representative_errors=${representativeRuntime.errors.length}`,
    sourceScan,
    representativeRuntime,
  };
  const finalClosure: FullyUnifiedFinalClosureStatus = {
    ok: finalClosureResult.dependencyBlockers.length === 0,
    detail: `dependency_blockers=${finalClosureResult.dependencyBlockers.length}`,
    mode: finalMode ? 'final' : 'focused',
    blockers: finalClosureResult.dependencyBlockers,
  };
  const fullyUnified = foundationGate.ok
    && v2ZeroInventory.ok
    && releaseContract.ok
    && strippedPathSmoke.ok
    && finalClosure.ok;
  return {
    fullyUnified,
    foundationGate,
    v2ZeroInventory,
    releaseContract,
    strippedPathSmoke,
    finalClosure,
    finalClosureBlockers: finalClosureResult.dependencyBlockers,
    validatorResult: foundationGate,
    dependencyBlockers: finalClosureResult.dependencyBlockers,
  };
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false;
}

async function main(): Promise<void> {
  const finalMode = process.argv.includes('--final');
  const result = await checkFullyUnified({ finalMode });
  console.log(`runtime-unification fully unified: foundation_ok=${result.foundationGate.ok} release_contract_ok=${result.releaseContract.ok} stripped_path_ok=${result.strippedPathSmoke.ok} final_mode=${result.finalClosure.mode} final_blockers=${result.finalClosureBlockers.length} fully_unified=${result.fullyUnified}`);
  console.log(`foundation gate: total=${result.foundationGate.totalValidators} failed=${result.foundationGate.failedValidators}`);
  console.log(`v2-zero inventory: ok=${result.v2ZeroInventory.ok} errors=${result.v2ZeroInventory.errors.length}`);
  console.log(`release contract: validator_ok=${result.releaseContract.validatorResult.ok} surface_ok=${result.releaseContract.surfaceResult.ok} surface_errors=${result.releaseContract.surfaceResult.errors.length}`);
  console.log(`stripped PATH smoke: source_violations=${result.strippedPathSmoke.sourceScan.violations.length} representative_errors=${result.strippedPathSmoke.representativeRuntime.errors.length}`);
  console.log(`final closure blockers: mode=${result.finalClosure.mode} count=${result.finalClosureBlockers.length}`);
  for (const blocker of result.finalClosureBlockers) {
    console.log(`BLOCKED ${blocker.id} [${blocker.source}] status=${blocker.status}: ${blocker.detail}`);
  }
  if (!result.foundationGate.ok) {
    console.log(`foundation_validator_failures=${result.foundationGate.failedValidators}`);
  }
  if (!result.v2ZeroInventory.ok) {
    for (const error of result.v2ZeroInventory.errors) {
      console.log(`  - ${error}`);
    }
  }
  if (!result.releaseContract.surfaceResult.ok) {
    for (const error of result.releaseContract.surfaceResult.errors) {
      console.log(`  - ${error}`);
    }
  }
  if (!result.strippedPathSmoke.ok) {
    for (const violation of result.strippedPathSmoke.sourceScan.violations) {
      console.log(`  - ${violation.message}`);
    }
    for (const error of result.strippedPathSmoke.representativeRuntime.errors) {
      console.log(`  - representative-runtime: ${error}`);
    }
  }
  if (!result.fullyUnified) {
    process.exitCode = 1;
  }
}

if (isDirectRun()) {
  void main();
}
