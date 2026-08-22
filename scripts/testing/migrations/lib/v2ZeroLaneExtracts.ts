import { type V2ZeroInventoryCategoryReport, type V2ZeroInventoryReport } from './v2ZeroInventory.ts';
import { applyRewritePlan, planImportRewritesForFilePaths, type RewritePlanApplyResult } from './rewriteImports.ts';
import { type InventoryFile, type RewritePlan, type RewriteRule } from './migrationTypes.ts';
import { formatSimpleSections } from './formatGovernanceReport.ts';
import { GOVERNANCE_REPORT_PATHS } from './reportPaths.ts';
import { writeGovernanceReports } from '../writeGovernanceReports.ts';

export interface V2ZeroLaneExtractSpec {
  laneId: string;
  title: string;
  description: string;
  categoryIds: readonly string[];
}

export interface V2ZeroLaneExtractReport {
  laneId: string;
  title: string;
  description: string;
  categoryIds: readonly string[];
  filesScanned: number;
  filesMatched: number;
  files: readonly string[];
  executionCommands: readonly V2ZeroLaneExecutionCommand[];
  totalMatches: number;
  categories: readonly V2ZeroInventoryCategoryReport[];
}

export interface V2ZeroLaneExecutionCommand {
  title: string;
  description: string;
  argv: readonly string[];
  targetFilePaths?: readonly string[];
}

export interface V2ZeroLaneRewriteExecutionPacket {
  laneReport: V2ZeroLaneExtractReport;
  targetFilePaths: readonly string[];
  rewriteRules: readonly RewriteRule[];
  rewritePlan: RewritePlan;
}

export interface V2ZeroLaneRewriteBatchExecutionPacket {
  laneReports: readonly V2ZeroLaneExtractReport[];
  targetFilePaths: readonly string[];
  rewriteRules: readonly RewriteRule[];
  rewritePlan: RewritePlan;
}

export interface V2ZeroLaneRewriteDryRunPacket {
  laneReport: V2ZeroLaneExtractReport;
  targetFilePaths: readonly string[];
  rewriteRules: readonly RewriteRule[];
  rewritePlan: RewritePlan;
  missingTargetFilePaths: readonly string[];
  wouldChangeFilePaths: readonly string[];
  canExecute: boolean;
}

export interface V2ZeroLaneRewriteApplyPacket extends V2ZeroLaneRewriteDryRunPacket {
  rootDir: string;
  applyResult: RewritePlanApplyResult | null;
}

export interface V2ZeroLaneRewriteBatchDryRunPacket extends V2ZeroLaneRewriteBatchExecutionPacket {
  missingTargetFilePaths: readonly string[];
  wouldChangeFilePaths: readonly string[];
  canExecute: boolean;
}

export interface V2ZeroLaneRewriteBatchApplyPacket extends V2ZeroLaneRewriteBatchDryRunPacket {
  rootDir: string;
  applyResult: RewritePlanApplyResult | null;
}

const V2_ZERO_LANE_EXTRACT_SPECS: readonly V2ZeroLaneExtractSpec[] = Object.freeze([
  {
    laneId: 'a1',
    title: 'Lane A1: CLI Registry Convergence',
    description: 'CLI registry convergence, command/help split ownership, capability dispatch, and the remaining registry-facing ABI seams.',
    categoryIds: [
      'builtin-cli-catalog-consumers',
      'implicit-abi-surfaces',
      'shared-core-provider-branching',
    ],
  },
  {
    laneId: 'a2-a3',
    title: 'Lane A2+A3: customAcp Exit And BackendTargetV2',
    description: 'Legacy customAcp removal, backend-target migration, and the compatibility seams that still leak through target identity.',
    categoryIds: [
      'customacp-sentinel-consumers',
      'implicit-abi-surfaces',
      'runtime-identity-publication-read',
      'shared-core-provider-branching',
    ],
  },
  {
    laneId: 'a4',
    title: 'Lane A4: Plugin Install, Provenance, And Runtime Hardening',
    description: 'Plugin install/provenance/runtime-loading hardening surfaces and the ABI seams that must stay narrow.',
    categoryIds: [
      'implicit-abi-surfaces',
    ],
  },
  {
    laneId: 'a5',
    title: 'Lane A5: Honest Supported Surface And Schema/Runtime Alignment',
    description: 'Unsupported-surface cleanup, schema/runtime honesty, and the explicit adapter split that the host now needs.',
    categoryIds: [
      'implicit-abi-surfaces',
      'runtime-identity-publication-read',
      'shared-core-provider-branching',
    ],
  },
  {
    laneId: 'v2-1',
    title: 'Lane V2-1: Static Definition Split, Engine Spec, And Runtime Foundation',
    description: 'Runtime identity publication seams that must stay visible to migration tooling.',
    categoryIds: [
      'runtime-identity-publication-read',
    ],
  },
  {
    laneId: 'v2-2',
    title: 'Lane V2-2: CLI Engine Registry',
    description: 'Built-in and plugin executable engine registry convergence, including the merged contribution shell and command/help split ownership.',
    categoryIds: [
      'builtin-cli-catalog-consumers',
      'implicit-abi-surfaces',
      'shared-core-provider-branching',
    ],
  },
  {
    laneId: 'v2-3',
    title: 'Lane V2-3: Execution-Run Host Bridge',
    description: 'Execution-run bridge extraction, intent-profile preservation, runtime lifecycle containment, the remaining provider-leaf execution-run semantic debt, and the voice/memory-hints constraints that must survive the bridge.',
    categoryIds: [
      'execution-run-permission-interaction-centralization',
      'execution-run-agentbackend-semantic-debt',
      'implicit-abi-surfaces',
      'runtime-identity-publication-read',
      'shared-core-provider-branching',
      'voice-runtime-entrypoints',
    ],
  },
  {
    laneId: 'v2-4',
    title: 'Lane V2-4: Session Host Bridge',
    description: 'Regular-session bridge extraction, session-target canonicalization, and the shared runtime identity and discovery seams that both bridges consume.',
    categoryIds: [
      'customacp-sentinel-consumers',
      'implicit-abi-surfaces',
      'runtime-identity-publication-read',
      'shared-core-provider-branching',
    ],
  },
  {
    laneId: 'v2-5',
    title: 'Lane V2-5: UI Merged Descriptor Projection',
    description: 'UI descriptor projection, provider settings/auth view-model splits, and the remaining registry-facing UI seams.',
    categoryIds: [
      'implicit-abi-surfaces',
      'runtime-identity-publication-read',
      'shared-core-provider-branching',
      'static-ui-registry-consumers',
    ],
  },
  {
    laneId: 'v2-6',
    title: 'Lane V2-6: Plugin-Defined Non-ACP Backend Pilot',
    description: 'Plugin backend pilot wiring, install/provenance/trust boundaries, and the narrow author contract that should survive the first non-ACP pilot.',
    categoryIds: [
      'implicit-abi-surfaces',
      'shared-core-provider-branching',
    ],
  },
  {
    laneId: 'v2-7',
    title: 'Lane V2-7: Hook Externalization On Unified Lifecycle Seams',
    description: 'Hook emission inventory, lifecycle-seam centralization, and the remaining ABI surfaces that must stay narrow before new hook families open.',
    categoryIds: [
      'hook-emission-sites',
      'implicit-abi-surfaces',
      'shared-core-provider-branching',
    ],
  },
  {
    laneId: 'b8',
    title: 'Lane B8: Voice, Action-Catalog, And MCP Closure',
    description: 'Voice entrypoints, closed action/MCP/provider-id surfaces, and the explicit adjacent closures that remain post-v2.',
    categoryIds: [
      'runtime-identity-publication-read',
      'voice-runtime-entrypoints',
      'voice-v3-f-v2-media-residue',
    ],
  },
] as const);

const V2_ZERO_LANE_EXTRACT_PATHS = Object.freeze({
  a1: {
    markdown: GOVERNANCE_REPORT_PATHS.v2ZeroLaneA1Markdown,
    json: GOVERNANCE_REPORT_PATHS.v2ZeroLaneA1Json,
  },
  a2a3: {
    markdown: GOVERNANCE_REPORT_PATHS.v2ZeroLaneA2A3Markdown,
    json: GOVERNANCE_REPORT_PATHS.v2ZeroLaneA2A3Json,
  },
  a4: {
    markdown: GOVERNANCE_REPORT_PATHS.v2ZeroLaneA4Markdown,
    json: GOVERNANCE_REPORT_PATHS.v2ZeroLaneA4Json,
  },
  a5: {
    markdown: GOVERNANCE_REPORT_PATHS.v2ZeroLaneA5Markdown,
    json: GOVERNANCE_REPORT_PATHS.v2ZeroLaneA5Json,
  },
  v21: {
    markdown: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV21Markdown,
    json: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV21Json,
  },
  v22: {
    markdown: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV22Markdown,
    json: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV22Json,
  },
  v23: {
    markdown: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV23Markdown,
    json: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV23Json,
  },
  v24: {
    markdown: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV24Markdown,
    json: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV24Json,
  },
  v25: {
    markdown: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV25Markdown,
    json: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV25Json,
  },
  v26: {
    markdown: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV26Markdown,
    json: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV26Json,
  },
  v27: {
    markdown: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV27Markdown,
    json: GOVERNANCE_REPORT_PATHS.v2ZeroLaneV27Json,
  },
  b8: {
    markdown: GOVERNANCE_REPORT_PATHS.v2ZeroLaneB8Markdown,
    json: GOVERNANCE_REPORT_PATHS.v2ZeroLaneB8Json,
  },
} as const);

function createLaneCategoryLookup(report: V2ZeroInventoryReport): Map<string, V2ZeroInventoryCategoryReport> {
  return new Map(report.categories.map((category) => [category.id, category] as const));
}

function collectLaneCategories(
  report: V2ZeroInventoryReport,
  categoryIds: readonly string[],
): readonly V2ZeroInventoryCategoryReport[] {
  const categoryLookup = createLaneCategoryLookup(report);
  return categoryIds
    .map((categoryId) => categoryLookup.get(categoryId))
    .filter((category): category is V2ZeroInventoryCategoryReport => category !== undefined);
}

function createLaneExecutionCommands(
  laneId: string,
  files: readonly string[],
): readonly V2ZeroLaneExecutionCommand[] {
  return [
    {
      title: 'Print this lane packet',
      description: 'Print the lane-specific live packet so a worker can execute directly from the current zero-inventory output.',
      argv: [
        'node',
        '--experimental-strip-types',
        'scripts/testing/migrations/printV2ZeroLaneExecutionPackets.ts',
        '--lane',
        laneId,
      ],
      targetFilePaths: files,
    },
    {
      title: 'Refresh the live V2-0 inventory',
      description: 'Re-run the live inventory before and after mechanical edits so the worker always re-anchors on current facts.',
      argv: [
        'node',
        '--experimental-strip-types',
        'scripts/testing/migrations/validateV2ZeroInventory.ts',
      ],
    },
    {
      title: 'Run the migration policy lane',
      description: 'Re-run the migration policy lane to catch stale fixtures, drift, or helper regressions after edits land.',
      argv: ['yarn', '-s', 'test:policy:self'],
    },
  ] as const;
}

export function collectV2ZeroLaneExtractFiles(report: V2ZeroLaneExtractReport): readonly string[] {
  return report.files;
}

export function planV2ZeroLaneImportRewrites(
  files: readonly InventoryFile[],
  laneReports: readonly V2ZeroLaneExtractReport[],
  rules: readonly RewriteRule[],
): RewritePlan {
  const targetFilePaths = [...new Set(laneReports.flatMap((laneReport) => laneReport.files))];
  return planImportRewritesForFilePaths(files, rules, targetFilePaths);
}

export function buildV2ZeroLaneRewriteExecutionPacket(
  laneReport: V2ZeroLaneExtractReport,
  files: readonly InventoryFile[],
  rules: readonly RewriteRule[],
): V2ZeroLaneRewriteExecutionPacket {
  const targetFilePaths = [...new Set(laneReport.files)];
  return {
    laneReport,
    targetFilePaths,
    rewriteRules: rules,
    rewritePlan: planImportRewritesForFilePaths(files, rules, targetFilePaths),
  };
}

function collectRewriteTargetFilePaths(laneReports: readonly V2ZeroLaneExtractReport[]): readonly string[] {
  return [...new Set(laneReports.flatMap((laneReport) => laneReport.files))];
}

export function buildV2ZeroLaneRewriteBatchExecutionPacket(
  laneReports: readonly V2ZeroLaneExtractReport[],
  files: readonly InventoryFile[],
  rules: readonly RewriteRule[],
): V2ZeroLaneRewriteBatchExecutionPacket {
  const targetFilePaths = collectRewriteTargetFilePaths(laneReports);
  return {
    laneReports,
    targetFilePaths,
    rewriteRules: rules,
    rewritePlan: planImportRewritesForFilePaths(files, rules, targetFilePaths),
  };
}

export function buildV2ZeroLaneRewriteDryRunPacket(
  laneReport: V2ZeroLaneExtractReport,
  files: readonly InventoryFile[],
  rules: readonly RewriteRule[],
): V2ZeroLaneRewriteDryRunPacket {
  const targetFilePaths = [...new Set(laneReport.files)];
  const rewritePlan = planImportRewritesForFilePaths(files, rules, targetFilePaths);
  const filePathLookup = new Set(files.map((file) => file.filePath));
  const missingTargetFilePaths = targetFilePaths.filter((filePath) => !filePathLookup.has(filePath));
  const wouldChangeFilePaths = [...new Set(rewritePlan.edits.map((edit) => edit.filePath))];

  return {
    laneReport,
    targetFilePaths,
    rewriteRules: rules,
    rewritePlan,
    missingTargetFilePaths,
    wouldChangeFilePaths,
    canExecute: missingTargetFilePaths.length === 0,
  };
}

export function buildV2ZeroLaneRewriteBatchDryRunPacket(
  laneReports: readonly V2ZeroLaneExtractReport[],
  files: readonly InventoryFile[],
  rules: readonly RewriteRule[],
): V2ZeroLaneRewriteBatchDryRunPacket {
  const batchPacket = buildV2ZeroLaneRewriteBatchExecutionPacket(laneReports, files, rules);
  const filePathLookup = new Set(files.map((file) => file.filePath));
  const missingTargetFilePaths = batchPacket.targetFilePaths.filter((filePath) => !filePathLookup.has(filePath));
  const wouldChangeFilePaths = [...new Set(batchPacket.rewritePlan.edits.map((edit) => edit.filePath))];

  return {
    ...batchPacket,
    missingTargetFilePaths,
    wouldChangeFilePaths,
    canExecute: missingTargetFilePaths.length === 0,
  };
}

export function buildV2ZeroLaneRewriteApplyPacket(
  laneReport: V2ZeroLaneExtractReport,
  files: readonly InventoryFile[],
  rules: readonly RewriteRule[],
  rootDir: string,
): V2ZeroLaneRewriteApplyPacket {
  const dryRunPacket = buildV2ZeroLaneRewriteDryRunPacket(laneReport, files, rules);
  return {
    ...dryRunPacket,
    rootDir,
    applyResult: dryRunPacket.canExecute ? applyRewritePlan(rootDir, dryRunPacket.rewritePlan) : null,
  };
}

export function buildV2ZeroLaneRewriteBatchApplyPacket(
  laneReports: readonly V2ZeroLaneExtractReport[],
  files: readonly InventoryFile[],
  rules: readonly RewriteRule[],
  rootDir: string,
): V2ZeroLaneRewriteBatchApplyPacket {
  const dryRunPacket = buildV2ZeroLaneRewriteBatchDryRunPacket(laneReports, files, rules);
  return {
    ...dryRunPacket,
    rootDir,
    applyResult: dryRunPacket.canExecute ? applyRewritePlan(rootDir, dryRunPacket.rewritePlan) : null,
  };
}

function getLaneReportPaths(laneId: string): { markdown: string; json: string } {
  switch (laneId) {
    case 'a1':
      return V2_ZERO_LANE_EXTRACT_PATHS.a1;
    case 'a2-a3':
      return V2_ZERO_LANE_EXTRACT_PATHS.a2a3;
    case 'a4':
      return V2_ZERO_LANE_EXTRACT_PATHS.a4;
    case 'a5':
      return V2_ZERO_LANE_EXTRACT_PATHS.a5;
    case 'v2-1':
      return V2_ZERO_LANE_EXTRACT_PATHS.v21;
    case 'v2-2':
      return V2_ZERO_LANE_EXTRACT_PATHS.v22;
    case 'v2-3':
      return V2_ZERO_LANE_EXTRACT_PATHS.v23;
    case 'v2-4':
      return V2_ZERO_LANE_EXTRACT_PATHS.v24;
    case 'v2-5':
      return V2_ZERO_LANE_EXTRACT_PATHS.v25;
    case 'v2-6':
      return V2_ZERO_LANE_EXTRACT_PATHS.v26;
    case 'v2-7':
      return V2_ZERO_LANE_EXTRACT_PATHS.v27;
    case 'b8':
      return V2_ZERO_LANE_EXTRACT_PATHS.b8;
    default:
      throw new Error(`Unknown V2-0 lane id: ${laneId}`);
  }
}

export function collectV2ZeroLaneExtractReports(report: V2ZeroInventoryReport): V2ZeroLaneExtractReport[] {
  return V2_ZERO_LANE_EXTRACT_SPECS.map((spec) => {
    const categories = collectLaneCategories(report, spec.categoryIds);
    const files = [...new Set(categories.flatMap((category) => category.files))].sort((left, right) => left.localeCompare(right));
    return {
      laneId: spec.laneId,
      title: spec.title,
      description: spec.description,
      categoryIds: spec.categoryIds,
      filesScanned: report.filesScanned,
      filesMatched: files.length,
      files,
      executionCommands: createLaneExecutionCommands(spec.laneId, files),
      totalMatches: categories.reduce((sum, category) => sum + category.count, 0),
      categories,
    } satisfies V2ZeroLaneExtractReport;
  });
}

export function formatV2ZeroLaneExtractMarkdown(report: V2ZeroLaneExtractReport): string {
  const sections = [
    `- lane id: ${report.laneId}`,
    `- description: ${report.description}`,
    `- files scanned: ${report.filesScanned}`,
    `- category matches: ${report.totalMatches}`,
    `- unique files matched: ${report.filesMatched}`,
    `- files: ${report.files.join(', ')}`,
    `- category ids: ${report.categoryIds.join(', ')}`,
  ];

  sections.push('', '## Execution Commands', '');
  for (const command of report.executionCommands) {
    sections.push(
      `- ${command.title}`,
      `  - description: ${command.description}`,
      `  - argv: ${command.argv.join(' ')}`,
      command.targetFilePaths ? `  - target files: ${command.targetFilePaths.join(', ')}` : '  - target files: none',
    );
  }

  for (const category of report.categories) {
    sections.push(
      '',
      `## ${category.title}`,
      '',
      `- id: ${category.id}`,
      `- matches: ${category.count}`,
      `- files: ${category.files.join(', ')}`,
    );
  }

  return formatSimpleSections(`V2-0 Lane Extract: ${report.title}`, sections);
}

export function writeV2ZeroLaneExtractReports(report: V2ZeroInventoryReport, rootDir: string = process.cwd()): void {
  const laneReports = collectV2ZeroLaneExtractReports(report);
  const entries: Record<string, string> = {};

  for (const laneReport of laneReports) {
    const paths = getLaneReportPaths(laneReport.laneId);
    entries[paths.markdown] = formatV2ZeroLaneExtractMarkdown(laneReport);
    entries[paths.json] = `${JSON.stringify(laneReport, null, 2)}\n`;
  }

  writeGovernanceReports(entries, rootDir);
}

export { V2_ZERO_LANE_EXTRACT_SPECS };
