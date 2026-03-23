import { pathToFileURL } from 'node:url';

import { collectFileInventory } from './migrations/lib/collectFileInventory.ts';
import { collectPolicyFindings, type PolicyFinding } from './lib/testPolicyRules.ts';
import { type InventoryFile } from './migrations/lib/migrationTypes.ts';

export interface PolicyReport {
  enforcedFindings: readonly PolicyFinding[];
  reportOnlyFindings: readonly PolicyFinding[];
}

export function collectPolicyReport(files: readonly InventoryFile[]): PolicyReport {
  const findings = collectPolicyFindings(files).findings;
  return {
    enforcedFindings: findings.filter((finding) => finding.mode === 'enforce'),
    reportOnlyFindings: findings.filter((finding) => finding.mode === 'report-only'),
  };
}

export function resolvePolicyExitCode(report: PolicyReport): number {
  return report.enforcedFindings.length > 0 ? 1 : 0;
}

function printPolicyReport(report: PolicyReport): void {
  if (report.enforcedFindings.length === 0 && report.reportOnlyFindings.length === 0) {
    console.log('test:policy passed: no policy findings detected.');
    return;
  }

  if (report.enforcedFindings.length > 0) {
    console.error(`test:policy found ${report.enforcedFindings.length} enforced issue(s):`);
    for (const finding of report.enforcedFindings) {
      console.error(`- ${finding.filePath}: ${finding.message}`);
    }
  }

  if (report.reportOnlyFindings.length > 0) {
    console.log(`test:policy report-only findings: ${report.reportOnlyFindings.length}`);
    for (const finding of report.reportOnlyFindings) {
      console.log(`- ${finding.filePath}: ${finding.message}`);
    }
  }
}

export async function main(): Promise<void> {
  const files = collectFileInventory({
    include: /\.[cm]?[jt]sx?$/,
  });
  const report = collectPolicyReport(files);
  printPolicyReport(report);
  process.exitCode = resolvePolicyExitCode(report);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
