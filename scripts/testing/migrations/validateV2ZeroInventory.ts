import { pathToFileURL } from 'node:url';

import { collectV2ZeroSourceFiles, formatV2ZeroInventoryMarkdown, runV2ZeroInventory } from './lib/v2ZeroInventory.ts';
import {
  enforceAcpSharedSessionCompatibilityAllowlist,
  enforceRetiredRuntimeAdapterAliasAbsence,
  enforceExecutionRunIntentProfileOwnerFence,
  enforceExecutionRunBackendRegistryImportAllowlist,
  enforceTrackedV2ZeroReportFreshness,
  enforceRuntimeCoreSessionCommandRoutingNoLoadRun,
  enforceSharedSessionCanonicalPlanBoundary,
  enforceSharedSessionRetirementSurfaceAllowlist,
  enforceSharedRuntimeForLoopCompatibilityRetirement,
  enforceV2ZeroInventoryBaseline,
  loadV2ZeroInventoryEnforcementBaseline,
} from './lib/v2ZeroInventoryEnforcement.ts';

export interface V2ZeroInventoryGateResult {
  ok: boolean;
  errors: readonly string[];
}

export function enforceV2ZeroInventoryReport(params: Readonly<{
  report: Awaited<ReturnType<typeof runV2ZeroInventory>>;
  files: ReturnType<typeof collectV2ZeroSourceFiles>;
  rootDir: string;
  baselinePath?: string;
}>): V2ZeroInventoryGateResult {
  const errors: string[] = [];
  const baselinePath = params.baselinePath
    ?? process.env.HAPPIER_V2_ZERO_INVENTORY_BASELINE
    ?? 'scripts/testing/migrations/baselines/v2ZeroInventoryBaseline.json';

  try {
    const baseline = loadV2ZeroInventoryEnforcementBaseline({
      rootDir: params.rootDir,
      baselinePath,
    });
    errors.push(...enforceV2ZeroInventoryBaseline(params.report, baseline).errors);
  } catch (error) {
    errors.push(`- v2-zero-baseline: ${error instanceof Error ? error.message : String(error)}`);
  }

  errors.push(
    ...enforceRetiredRuntimeAdapterAliasAbsence(params.files).errors,
    ...enforceExecutionRunBackendRegistryImportAllowlist(params.files).errors,
    ...enforceRuntimeCoreSessionCommandRoutingNoLoadRun(params.files).errors,
    ...enforceSharedRuntimeForLoopCompatibilityRetirement(params.files).errors,
    ...enforceSharedSessionCanonicalPlanBoundary(params.files).errors,
    ...enforceAcpSharedSessionCompatibilityAllowlist(params.files).errors,
    ...enforceSharedSessionRetirementSurfaceAllowlist(params.files).errors,
    ...enforceExecutionRunIntentProfileOwnerFence(params.files).errors,
    ...enforceTrackedV2ZeroReportFreshness(params.report, { rootDir: params.rootDir }).errors,
  );

  return { ok: errors.length === 0, errors };
}

export async function runV2ZeroInventoryGate(params: Readonly<{
  rootDir?: string;
  writeReports?: boolean;
}> = {}): Promise<V2ZeroInventoryGateResult & { report: Awaited<ReturnType<typeof runV2ZeroInventory>> }> {
  const rootDir = params.rootDir ?? process.cwd();
  const files = collectV2ZeroSourceFiles(rootDir);
  const report = await runV2ZeroInventory({
    files,
    rootDir,
    writeReports: params.writeReports,
  });
  return {
    ...enforceV2ZeroInventoryReport({ report, files, rootDir }),
    report,
  };
}

export async function main(): Promise<void> {
  const rootDir = process.cwd();
  const files = collectV2ZeroSourceFiles(rootDir);
  const shouldWriteReports =
    process.argv.includes('--write-reports') ||
    process.env.HAPPIER_V2_ZERO_INVENTORY_WRITE_REPORTS === '1';
  const report = await runV2ZeroInventory({
    files,
    rootDir,
    writeReports: shouldWriteReports,
  });

  console.log(`V2-0 inventory scanned ${report.filesScanned} source file(s).`);
  console.log(`Unique files matched by migration categories: ${report.filesMatched}`);
  for (const category of report.categories) {
    console.log(`- ${category.id}: ${category.count}`);
  }
  console.log(formatV2ZeroInventoryMarkdown(report));

  const shouldEnforce =
    process.argv.includes('--enforce') ||
    process.env.HAPPIER_V2_ZERO_INVENTORY_ENFORCE === '1' ||
    process.env.CI === '1' ||
    process.env.CI === 'true';
  if (!shouldEnforce) {
    return;
  }

  const gateResult = enforceV2ZeroInventoryReport({ report, files, rootDir });
  if (gateResult.errors.length > 0) {
    console.error('V2-0 inventory enforcement failed:');
    for (const error of gateResult.errors) {
      console.error(error);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
