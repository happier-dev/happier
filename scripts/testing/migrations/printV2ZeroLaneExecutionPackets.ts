import { pathToFileURL } from 'node:url';

import { collectV2ZeroSourceFiles, runV2ZeroInventory } from './lib/v2ZeroInventory.ts';
import {
  buildV2ZeroLaneRewriteBatchApplyPacket,
  buildV2ZeroLaneRewriteBatchDryRunPacket,
  buildV2ZeroLaneRewriteBatchExecutionPacket,
  buildV2ZeroLaneRewriteApplyPacket,
  buildV2ZeroLaneRewriteDryRunPacket,
  buildV2ZeroLaneRewriteExecutionPacket,
  collectV2ZeroLaneExtractReports,
  formatV2ZeroLaneExtractMarkdown,
  type V2ZeroLaneExtractReport,
  type V2ZeroLaneRewriteBatchApplyPacket,
  type V2ZeroLaneRewriteBatchDryRunPacket,
  type V2ZeroLaneRewriteBatchExecutionPacket,
  type V2ZeroLaneRewriteApplyPacket,
  type V2ZeroLaneRewriteDryRunPacket,
  type V2ZeroLaneRewriteExecutionPacket,
} from './lib/v2ZeroLaneExtracts.ts';
import { type RewriteRule } from './lib/migrationTypes.ts';

function parseRewriteRuleSpec(spec: string): RewriteRule {
  const separator = spec.includes('=>') ? '=>' : '=';
  const separatorIndex = spec.indexOf(separator);
  if (separatorIndex <= 0 || separatorIndex + separator.length >= spec.length) {
    throw new Error(`Invalid rewrite rule spec: ${spec}`);
  }

  const from = spec.slice(0, separatorIndex).trim();
  const to = spec.slice(separatorIndex + separator.length).trim();
  if (!from || !to) {
    throw new Error(`Invalid rewrite rule spec: ${spec}`);
  }

  return {
    id: `rewrite:${from}->${to}`,
    from,
    to,
  };
}

function parseArgs(argv: readonly string[]): {
  laneId: string | null;
  dryRun: boolean;
  apply: boolean;
  rootDir: string;
  format: 'markdown' | 'json';
  rewriteRules: readonly RewriteRule[];
} {
  let laneId: string | null = null;
  let dryRun = false;
  let apply = false;
  let rootDir = process.cwd();
  let format: 'markdown' | 'json' = 'markdown';
  const rewriteRules: RewriteRule[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lane') {
      const next = argv[i + 1];
      if (next) {
        laneId = next;
        i += 1;
      }
      continue;
    }

    if (arg === '--rewrite-rule') {
      const next = argv[i + 1];
      if (next) {
        rewriteRules.push(parseRewriteRuleSpec(next));
        i += 1;
      }
      continue;
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '--apply') {
      apply = true;
      continue;
    }

    if (arg === '--root-dir') {
      const next = argv[i + 1];
      if (next) {
        rootDir = next;
        i += 1;
      }
      continue;
    }

    if (arg === '--format') {
      const next = argv[i + 1];
      if (next === 'markdown' || next === 'json') {
        format = next;
        i += 1;
      }
    }
  }

  return { laneId, dryRun, apply, rootDir, format, rewriteRules };
}

function selectLaneReports(reports: readonly V2ZeroLaneExtractReport[], laneId: string | null): readonly V2ZeroLaneExtractReport[] {
  if (!laneId) {
    return reports;
  }

  return reports.filter((report) => report.laneId === laneId);
}

function formatLanePacketsMarkdown(reports: readonly V2ZeroLaneExtractReport[]): string {
  return reports.map((report) => formatV2ZeroLaneExtractMarkdown(report)).join('\n');
}

function buildRewriteExecutionPackets(
  reports: readonly V2ZeroLaneExtractReport[],
  files: readonly { filePath: string; content: string }[],
  rewriteRules: readonly RewriteRule[],
): readonly (V2ZeroLaneRewriteExecutionPacket | V2ZeroLaneRewriteBatchExecutionPacket)[] {
  if (rewriteRules.length === 0) {
    return [];
  }

  if (reports.length > 1) {
    return [buildV2ZeroLaneRewriteBatchExecutionPacket(reports, files, rewriteRules)];
  }

  return reports.map((report) => buildV2ZeroLaneRewriteExecutionPacket(report, files, rewriteRules));
}

function buildRewriteDryRunPackets(
  reports: readonly V2ZeroLaneExtractReport[],
  files: readonly { filePath: string; content: string }[],
  rewriteRules: readonly RewriteRule[],
): readonly (V2ZeroLaneRewriteDryRunPacket | V2ZeroLaneRewriteBatchDryRunPacket)[] {
  if (rewriteRules.length === 0) {
    return [];
  }

  if (reports.length > 1) {
    return [buildV2ZeroLaneRewriteBatchDryRunPacket(reports, files, rewriteRules)];
  }

  return reports.map((report) => buildV2ZeroLaneRewriteDryRunPacket(report, files, rewriteRules));
}

function buildRewriteApplyPackets(
  reports: readonly V2ZeroLaneExtractReport[],
  files: readonly { filePath: string; content: string }[],
  rewriteRules: readonly RewriteRule[],
  rootDir: string,
): readonly (V2ZeroLaneRewriteApplyPacket | V2ZeroLaneRewriteBatchApplyPacket)[] {
  if (rewriteRules.length === 0) {
    return [];
  }

  if (reports.length > 1) {
    return [buildV2ZeroLaneRewriteBatchApplyPacket(reports, files, rewriteRules, rootDir)];
  }

  return reports.map((report) => buildV2ZeroLaneRewriteApplyPacket(report, files, rewriteRules, rootDir));
}

function formatRewriteExecutionPacketMarkdown(
  packet: V2ZeroLaneRewriteExecutionPacket | V2ZeroLaneRewriteBatchExecutionPacket,
): string {
  const laneLabel = 'laneReport' in packet
    ? packet.laneReport.title
    : packet.laneReports.map((laneReport) => laneReport.title).join(', ');
  const laneIds = 'laneReport' in packet
    ? [packet.laneReport.laneId]
    : packet.laneReports.map((laneReport) => laneReport.laneId);
  return [
    `## Rewrite Execution Packet: ${laneLabel}`,
    '',
    `- lane ids: ${laneIds.join(', ')}`,
    `- target files: ${packet.targetFilePaths.join(', ')}`,
    `- rewrite rules: ${packet.rewriteRules.map((rule) => `${rule.from}=>${rule.to}`).join(', ')}`,
    `- rewrite edits: ${packet.rewritePlan.edits.length}`,
  ].join('\n');
}

function formatRewriteDryRunPacketMarkdown(
  packet: V2ZeroLaneRewriteDryRunPacket | V2ZeroLaneRewriteBatchDryRunPacket,
): string {
  const laneLabel = 'laneReport' in packet
    ? packet.laneReport.title
    : packet.laneReports.map((laneReport) => laneReport.title).join(', ');
  const laneIds = 'laneReport' in packet
    ? [packet.laneReport.laneId]
    : packet.laneReports.map((laneReport) => laneReport.laneId);
  return [
    `## Rewrite Dry Run Packet: ${laneLabel}`,
    '',
    `- lane ids: ${laneIds.join(', ')}`,
    `- can execute: ${packet.canExecute ? 'yes' : 'no'}`,
    `- target files: ${packet.targetFilePaths.join(', ')}`,
    `- missing target files: ${packet.missingTargetFilePaths.length > 0 ? packet.missingTargetFilePaths.join(', ') : 'none'}`,
    `- would change files: ${packet.wouldChangeFilePaths.length > 0 ? packet.wouldChangeFilePaths.join(', ') : 'none'}`,
    `- rewrite edits: ${packet.rewritePlan.edits.length}`,
    `- rewrite rules: ${packet.rewriteRules.map((rule) => `${rule.from}=>${rule.to}`).join(', ')}`,
  ].join('\n');
}

function formatRewriteApplyPacketMarkdown(
  packet: V2ZeroLaneRewriteApplyPacket | V2ZeroLaneRewriteBatchApplyPacket,
): string {
  const laneLabel = 'laneReport' in packet
    ? packet.laneReport.title
    : packet.laneReports.map((laneReport) => laneReport.title).join(', ');
  const laneIds = 'laneReport' in packet
    ? [packet.laneReport.laneId]
    : packet.laneReports.map((laneReport) => laneReport.laneId);
  return [
    `## Rewrite Apply Packet: ${laneLabel}`,
    '',
    `- lane ids: ${laneIds.join(', ')}`,
    `- root dir: ${packet.rootDir}`,
    `- can execute: ${packet.canExecute ? 'yes' : 'no'}`,
    `- applied edits: ${packet.applyResult?.appliedEdits.length ?? 0}`,
    `- skipped edits: ${packet.applyResult?.skippedEdits.length ?? 0}`,
    `- target files: ${packet.targetFilePaths.join(', ')}`,
    `- missing target files: ${packet.missingTargetFilePaths.length > 0 ? packet.missingTargetFilePaths.join(', ') : 'none'}`,
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { laneId, dryRun, apply, rootDir, format, rewriteRules } = parseArgs(argv);
  const files = collectV2ZeroSourceFiles(rootDir);
  const inventory = await runV2ZeroInventory({ rootDir, files });
  const selectedReports = selectLaneReports(collectV2ZeroLaneExtractReports(inventory), laneId);
  const rewritePackets = buildRewriteExecutionPackets(selectedReports, files, rewriteRules);
  const rewriteDryRunPackets = dryRun ? buildRewriteDryRunPackets(selectedReports, files, rewriteRules) : [];
  const rewriteApplyPackets = apply ? buildRewriteApplyPackets(selectedReports, files, rewriteRules, rootDir) : [];

  if (format === 'json') {
    console.log(
      JSON.stringify(
        {
          laneReports: selectedReports,
          rewriteExecutionPackets: rewritePackets,
          rewriteDryRunPackets,
          rewriteApplyPackets,
        },
        null,
        2,
      ),
    );
    return;
  }

  const markdown = [
    formatLanePacketsMarkdown(selectedReports),
    ...rewritePackets.map((packet) => formatRewriteExecutionPacketMarkdown(packet)),
    ...rewriteDryRunPackets.map((packet) => formatRewriteDryRunPacketMarkdown(packet)),
    ...rewriteApplyPackets.map((packet) => formatRewriteApplyPacketMarkdown(packet)),
  ]
    .filter((section) => section.length > 0)
    .join('\n');
  console.log(markdown);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
