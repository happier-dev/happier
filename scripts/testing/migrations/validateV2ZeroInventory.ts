import { pathToFileURL } from 'node:url';

import { collectV2ZeroSourceFiles, formatV2ZeroInventoryMarkdown, runV2ZeroInventory } from './lib/v2ZeroInventory.ts';
import {
  enforceAcpSharedSessionCompatibilityAllowlist,
  enforceAgentBackendOperationSetParity,
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

export async function main(): Promise<void> {
  const files = collectV2ZeroSourceFiles();
  const shouldWriteReports =
    process.argv.includes('--write-reports') ||
    process.env.HAPPIER_V2_ZERO_INVENTORY_WRITE_REPORTS === '1';
  const report = await runV2ZeroInventory({
    files,
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

  const baselinePath = process.env.HAPPIER_V2_ZERO_INVENTORY_BASELINE ?? 'scripts/testing/migrations/baselines/v2ZeroInventoryBaseline.json';
  const baseline = loadV2ZeroInventoryEnforcementBaseline({
    rootDir: process.cwd(),
    baselinePath,
  });
  const baselineResult = enforceV2ZeroInventoryBaseline(report, baseline);
  const agentBackendParityResult = enforceAgentBackendOperationSetParity(files);
  const registryImportResult = enforceExecutionRunBackendRegistryImportAllowlist(files);
  const sessionRoutingResult = enforceRuntimeCoreSessionCommandRoutingNoLoadRun(files);
  const sharedD3RetirementResult = enforceSharedRuntimeForLoopCompatibilityRetirement(files);
  const sharedSessionCanonicalBoundaryResult = enforceSharedSessionCanonicalPlanBoundary(files);
  const acpSharedSessionCompatibilityResult = enforceAcpSharedSessionCompatibilityAllowlist(files);
  const sharedSessionRetirementSurfaceResult = enforceSharedSessionRetirementSurfaceAllowlist(files);
  const executionRunIntentOwnerFenceResult = enforceExecutionRunIntentProfileOwnerFence(files);
  const trackedReportFreshnessResult = enforceTrackedV2ZeroReportFreshness(report, { rootDir: process.cwd() });

  const errors = [
    ...baselineResult.errors,
    ...agentBackendParityResult.errors,
    ...registryImportResult.errors,
    ...sessionRoutingResult.errors,
    ...sharedD3RetirementResult.errors,
    ...sharedSessionCanonicalBoundaryResult.errors,
    ...acpSharedSessionCompatibilityResult.errors,
    ...sharedSessionRetirementSurfaceResult.errors,
    ...executionRunIntentOwnerFenceResult.errors,
    ...trackedReportFreshnessResult.errors,
  ];
  if (errors.length > 0) {
    console.error('V2-0 inventory enforcement failed:');
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
