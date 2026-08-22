import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { discoverTestFiles } from './lib/discoverTestFiles.ts';
import {
  discoverPluginWorkspaceTestPackageReport,
  isPluginWorkspaceTestPath,
  type PluginWorkspaceTestPackageReport,
} from './lib/pluginWorkspaceTestPackages.ts';
import { FEATURE_GATING_CONFIG_PATHS, collectWorkflowScriptParityReport, type WorkflowScriptParityInput } from './lib/workflowScriptParity.ts';
import {
  DECLARED_UNWIRED_TEST_FILES,
  buildTestLaneContext,
  classifyTestFile,
  collectLaneIssues,
  resolveFeatureTagIssue,
  type LaneId,
  type TestLaneContext,
} from './lib/testLaneMap.ts';
import { collectMockSpecifierIssues, type MockSpecifierFile } from './lib/unresolvedMockSpecifiers.ts';
import { discoverWorkspaceManifests } from './lib/workspaceManifests.ts';

export interface WiringIssue {
  filePath: string;
  message: string;
}

export interface WiringReport {
  laneCounts: Readonly<Record<string, number>>;
  featureTaggedFiles: number;
  packageLocalOnlyLaneIds: readonly LaneId[];
  /** Discovered files covered by a declared exclusion, with the reason each one is still unwired. */
  declaredUnwiredFiles: readonly WiringIssue[];
  /** Workspaces holding tests that only their own `test` script runs — no root lane, so no CI gate. */
  packageLocalWorkspaces: readonly string[];
  issues: readonly WiringIssue[];
}

export interface WiringReportOptions extends Partial<WorkflowScriptParityInput> {
  pluginWorkspaceTestPackageReport?: PluginWorkspaceTestPackageReport;
  testLaneContext?: TestLaneContext;
  /**
   * Test-file contents used to resolve every `vi.mock` specifier. A specifier that
   * resolves to nothing installs no mock at all, so the check belongs with the other
   * "this test does not actually gate" issues rather than in a separate lane.
   */
  mockSpecifierFiles?: readonly MockSpecifierFile[];
  mockSpecifierRootDir?: string;
}

function parseRootScripts(packageJsonText: string): Readonly<Record<string, string>> {
  try {
    const parsed = JSON.parse(packageJsonText) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

export async function discoverTestLaneContext(rootDir: string = process.cwd()): Promise<TestLaneContext> {
  const workspaceManifests = await discoverWorkspaceManifests(rootDir);
  const rootManifest = workspaceManifests.find((manifest) => manifest.workspaceDirectory === '');
  const rootScripts = rootManifest?.scripts ?? parseRootScripts(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  return buildTestLaneContext({ workspaceManifests, rootScripts });
}

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

export async function collectWiringReport(filePaths: readonly string[], options: WiringReportOptions = {}): Promise<WiringReport> {
  const laneCounts = new Map<LaneId, number>();
  const issues: WiringIssue[] = [];
  const declaredUnwiredFiles: WiringIssue[] = [];
  const packageLocalWorkspaces = new Set<string>();
  let featureTaggedFiles = 0;
  const pluginWorkspaceTestPackageReport = options.pluginWorkspaceTestPackageReport
    ?? await discoverPluginWorkspaceTestPackageReport();
  const testLaneContext = options.testLaneContext ?? await discoverTestLaneContext();

  for (const message of pluginWorkspaceTestPackageReport.issues) {
    issues.push({ filePath: '[plugin-workspaces]', message });
  }

  for (const filePath of filePaths) {
    const declaredUnwiredReason = DECLARED_UNWIRED_TEST_FILES[filePath];
    if (declaredUnwiredReason !== undefined) {
      declaredUnwiredFiles.push({ filePath, message: declaredUnwiredReason });
    }

    const lane = classifyTestFile(testLaneContext, filePath);
    if (lane) {
      laneCounts.set(lane, (laneCounts.get(lane) ?? 0) + 1);
    }
    if (lane === 'workspace:test') {
      const owner = testLaneContext.workspaces
        .filter((workspace) => filePath.startsWith(`${workspace.directory}/`))
        .sort((left, right) => right.directory.length - left.directory.length)[0];
      if (owner) {
        packageLocalWorkspaces.add(owner.directory);
      }
    }

    if (filePath.includes('.feat.')) {
      featureTaggedFiles += 1;
    }

    const featureTagIssue = resolveFeatureTagIssue(filePath);
    if (featureTagIssue) {
      issues.push({ filePath, message: featureTagIssue });
    }

    for (const message of collectLaneIssues(testLaneContext, filePath)) {
      issues.push({ filePath, message });
    }

    if (
      filePath.startsWith('packages/plugins/')
      && !isPluginWorkspaceTestPath(filePath, pluginWorkspaceTestPackageReport.packages)
    ) {
      issues.push({
        filePath,
        message: 'Plugin test is not inside a workspace package with an executable test script.',
      });
    }
  }

  if (options.mockSpecifierFiles) {
    for (const issue of collectMockSpecifierIssues(options.mockSpecifierFiles, { rootDir: options.mockSpecifierRootDir })) {
      issues.push(issue);
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
    declaredUnwiredFiles,
    packageLocalWorkspaces: [...packageLocalWorkspaces].sort(),
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

  if (report.packageLocalWorkspaces.length > 0) {
    console.log(`Workspaces tested only by their own test script (no root lane, no CI gate): ${report.packageLocalWorkspaces.join(', ')}`);
  }

  if (report.declaredUnwiredFiles.length > 0) {
    console.log(`Declared unwired test files: ${report.declaredUnwiredFiles.length}`);
    for (const declared of report.declaredUnwiredFiles) {
      console.log(`- ${declared.filePath}: ${declared.message}`);
    }
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
  const rootDir = process.cwd();
  const testFiles = discoverTestFiles();
  const mockSpecifierFiles = testFiles.map((filePath) => ({
    filePath,
    content: readFileSync(join(rootDir, filePath), 'utf8'),
  }));
  const report = await collectWiringReport(testFiles, {
    ...(loadDefaultParityInput() ?? {}),
    mockSpecifierFiles,
    mockSpecifierRootDir: rootDir,
  });
  printReport(report);
  if (report.issues.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
