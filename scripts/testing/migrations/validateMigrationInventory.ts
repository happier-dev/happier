import { pathToFileURL } from 'node:url';

import { collectFileInventory } from './lib/collectFileInventory.ts';
import { collectDeprecatedImportInventory } from './lib/inventoryDeprecatedImports.ts';
import { DUPLICATE_PATTERN_RULES, collectDuplicatePatternInventory } from './lib/inventoryDuplicatePatterns.ts';
import { formatInventoryBuckets, formatSimpleSections } from './lib/formatGovernanceReport.ts';
import { GOVERNANCE_REPORT_PATHS } from './lib/reportPaths.ts';
import { writeGovernanceReports } from './writeGovernanceReports.ts';

export async function main(): Promise<void> {
  const sourceFiles = collectFileInventory({
    include: /\.[cm]?[jt]sx?$/,
  }).filter((file) => !file.filePath.startsWith('scripts/testing/'));
  const testFiles = sourceFiles.filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.filePath));
  const deprecatedImports = collectDeprecatedImportInventory(sourceFiles);
  const duplicatePatterns = collectDuplicatePatternInventory(testFiles, DUPLICATE_PATTERN_RULES);

  writeGovernanceReports({
    [GOVERNANCE_REPORT_PATHS.inventorySummaryMarkdown]: formatSimpleSections('Governance Inventory Summary', [
      `- files scanned: ${sourceFiles.length}`,
      `- deprecated import matches: ${deprecatedImports.totalMatches}`,
      `- duplicate pattern matches: ${duplicatePatterns.totalMatches}`,
    ]),
    [GOVERNANCE_REPORT_PATHS.inventorySummaryJson]: JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        filesScanned: sourceFiles.length,
        deprecatedImportMatches: deprecatedImports.totalMatches,
        duplicatePatternMatches: duplicatePatterns.totalMatches,
      },
      null,
      2,
    ),
    [GOVERNANCE_REPORT_PATHS.deprecatedImportsMarkdown]: formatInventoryBuckets('Deprecated Imports', deprecatedImports.buckets),
    [GOVERNANCE_REPORT_PATHS.deprecatedImportsJson]: JSON.stringify(deprecatedImports, null, 2),
    [GOVERNANCE_REPORT_PATHS.duplicatePatternsMarkdown]: formatInventoryBuckets('Duplicate Patterns', duplicatePatterns.buckets),
    [GOVERNANCE_REPORT_PATHS.duplicatePatternsJson]: JSON.stringify(duplicatePatterns, null, 2),
  });

  console.log(`Migration inventory scanned ${sourceFiles.length} source file(s).`);
  console.log(`Deprecated import matches: ${deprecatedImports.totalMatches}`);
  console.log(`Duplicate pattern matches: ${duplicatePatterns.totalMatches}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
