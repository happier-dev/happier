import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { discoverTestFiles } from './lib/discoverTestFiles.ts';
import { FEATURE_GATING_CONFIG_PATHS, collectWorkflowScriptParityReport, type WorkflowScriptParityInput } from './lib/workflowScriptParity.ts';
import { classifyTestFile, collectLaneIssues, resolveFeatureTagIssue, type LaneId } from './lib/testLaneMap.ts';

export interface WiringIssue {
  filePath: string;
  message: string;
}

export interface WiringReport {
  laneCounts: Readonly<Record<string, number>>;
  featureTaggedFiles: number;
  packageLocalOnlyLaneIds: readonly LaneId[];
  issues: readonly WiringIssue[];
}

export interface WiringReportOptions extends Partial<WorkflowScriptParityInput> {}

export function loadDefaultParityInput(rootDir: string = process.cwd()): WorkflowScriptParityInput | null {
  try {
    const configTexts = Object.fromEntries(
      FEATURE_GATING_CONFIG_PATHS.map((configPath) => [configPath, readFileSync(join(rootDir, configPath), 'utf8')]),
    );

    return {
      packageJsonText: readFileSync(join(rootDir, 'package.json'), 'utf8'),
      workflowText: readFileSync(join(rootDir, '.github/workflows/tests.yml'), 'utf8'),
      docsText: readFileSync(join(rootDir, 'apps/docs/content/docs/development/testing.mdx'), 'utf8'),
      configTexts,
    };
  } catch {
    return null;
  }
}

export function collectWiringReport(filePaths: readonly string[], options: WiringReportOptions = {}): WiringReport {
  const laneCounts = new Map<LaneId, number>();
  const issues: WiringIssue[] = [];
  let featureTaggedFiles = 0;

  for (const filePath of filePaths) {
    const lane = classifyTestFile(filePath);
    if (lane) {
      laneCounts.set(lane, (laneCounts.get(lane) ?? 0) + 1);
    }

    if (filePath.includes('.feat.')) {
      featureTaggedFiles += 1;
    }

    const featureTagIssue = resolveFeatureTagIssue(filePath);
    if (featureTagIssue) {
      issues.push({ filePath, message: featureTagIssue });
    }

    for (const message of collectLaneIssues(filePath)) {
      issues.push({ filePath, message });
    }
  }

  const hasExplicitParityInput = options.packageJsonText !== undefined || options.workflowText !== undefined || options.docsText !== undefined || options.configTexts !== undefined;
  const parityInput = hasExplicitParityInput
    ? {
        packageJsonText: options.packageJsonText ?? '',
        workflowText: options.workflowText ?? '',
        docsText: options.docsText ?? '',
        configTexts: options.configTexts ?? {},
      }
    : null;
  const parityReport = parityInput ? collectWorkflowScriptParityReport(parityInput) : null;
  if (parityReport) {
    for (const issue of parityReport.issues) {
      issues.push({ filePath: '[parity]', message: issue.message });
    }
  }

  return {
    laneCounts: Object.fromEntries([...laneCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    featureTaggedFiles,
    packageLocalOnlyLaneIds: parityReport?.packageLocalOnlyLaneIds ?? [],
    issues,
  };
}

function printReport(report: WiringReport): void {
  const laneLines = Object.entries(report.laneCounts).map(([lane, count]) => `- ${lane}: ${count}`);
  console.log('Test wiring lane counts:');
  console.log(laneLines.length > 0 ? laneLines.join('\n') : '- none found');
  console.log(`Feature-tagged tests: ${report.featureTaggedFiles}`);
  if (report.packageLocalOnlyLaneIds.length > 0) {
    console.log(`Package-local-only lanes: ${report.packageLocalOnlyLaneIds.join(', ')}`);
  }

  if (report.issues.length === 0) {
    console.log('test:wiring passed: no invalid lane wiring detected.');
    return;
  }

  console.error(`test:wiring found ${report.issues.length} issue(s):`);
  for (const issue of report.issues) {
    console.error(`- ${issue.filePath}: ${issue.message}`);
  }
}

export async function main(): Promise<void> {
  const report = collectWiringReport(discoverTestFiles(), loadDefaultParityInput() ?? {});
  printReport(report);
  if (report.issues.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
