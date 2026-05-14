import { formatReleaseChannel } from '@/ui/format/releaseChannel';
import { bold, compactHomePath, compactVersion, muted, success } from '@/ui/format/styles';
import type { DoctorRepairReport } from '@/diagnostics/doctorRepair';

import {
  CLEAN_STATE_HEADER,
  CONFIGURED_NOT_RUNNING,
  MATCHES_THIS_CLI,
  SECTION_BACKGROUND_SERVICES,
  SECTION_CURRENT_CLI,
  SECTION_LOCAL_RELAYS,
} from './prompts/_copy';

function column1(label: string): string {
  return bold(label.padEnd(20));
}

function summarizeAutomaticStartupStatus(
  entry: DoctorRepairReport['automaticStartup'][number],
  cli: DoctorRepairReport['currentCli'],
): string {
  if (entry.running !== true) {
    return muted(CONFIGURED_NOT_RUNNING);
  }
  if (entry.ringId !== cli.ringId) {
    return `${muted('running')}, ${muted('different release channel')}`;
  }
  const runningVersion = entry.runningCliVersion ?? entry.configuredCliVersion;
  if (runningVersion !== null && runningVersion !== undefined && runningVersion !== cli.version) {
    return `${muted('running')}, ${muted('different CLI version')}`;
  }
  return `${muted('running')}, ${muted(MATCHES_THIS_CLI)}`;
}

/**
 * Three-line aligned "looks good" block. No prompts. No Currently running
 * section — when everything matches, the Automatic startup line already says so.
 */
export function renderCleanStateSummary(report: DoctorRepairReport): string[] {
  const lines: string[] = [];
  lines.push(success(CLEAN_STATE_HEADER));
  lines.push('');

  const cli = report.currentCli;
  const cliSummary = `${formatReleaseChannel(cli.releaseChannel)} • ${compactVersion(cli.version)}`;
  const compactedPath = compactHomePath(cli.binaryPath);
  const binarySuffix = cli.shim && compactedPath
    ? muted(`${cli.shim} → ${compactedPath}`)
    : muted(compactedPath ?? '');
  lines.push(`     ${column1(SECTION_CURRENT_CLI)}${cliSummary}   ${binarySuffix}`);

  // Automatic startup
  const aEntry = report.automaticStartup.find((e) => e.ringId === cli.ringId) ?? report.automaticStartup[0] ?? null;
  if (aEntry) {
    const version = compactVersion(aEntry.configuredCliVersion ?? aEntry.runningCliVersion ?? cli.version);
    const status = summarizeAutomaticStartupStatus(aEntry, cli);
    lines.push(`     ${column1(SECTION_BACKGROUND_SERVICES)}${formatReleaseChannel(aEntry.releaseChannel)} • ${version}   ${status}`);
  } else {
    lines.push(`     ${column1(SECTION_BACKGROUND_SERVICES)}${muted('none configured to auto-start')}`);
  }

  // Local relay line — only if a matching one is installed
  const matchingRelay = report.localRelays.find((r) => r.ringId === cli.ringId);
  if (matchingRelay) {
    const ver = compactVersion(matchingRelay.version ?? cli.version);
    const url = matchingRelay.relayUrl ?? '(no URL)';
    const status = matchingRelay.serviceActive && matchingRelay.healthy ? 'running' : 'stopped';
    lines.push(`     ${column1(SECTION_LOCAL_RELAYS)}${formatReleaseChannel(matchingRelay.releaseChannel)} • ${ver}   ${muted(`${status} on ${url}`)}`);
  }

  return lines;
}
