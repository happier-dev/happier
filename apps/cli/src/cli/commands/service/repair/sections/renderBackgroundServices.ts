import { formatReleaseChannel } from '@/ui/format/releaseChannel';
import {
  compactVersion,
  friendlyServerId,
  glyph,
  sectionHeader,
  severity,
} from '@/ui/format/styles';
import type {
  AutomaticStartupEntry,
  RepairFinding,
  RunningDaemonEntry,
} from '@/diagnostics/doctorRepair';

import { SECTION_BACKGROUND_SERVICES } from '../prompts/_copy';

type Row = Readonly<{
  sortKey: 0 | 1 | 2;              // auto+running → 0, auto+stopped → 1, manual → 2
  name: string;
  displayChannel: string | null;
  displayVersion: string | null;
  relayUrl: string | null;
  running: boolean;
  startsAt: 'auto' | 'manual' | 'unknown';
  pid: number | null;
  kind: 'automatic' | 'manual';
  entry: AutomaticStartupEntry | RunningDaemonEntry;
  /**
   * When an automatic-startup row has absorbed a running daemon (the
   * service is actively managing that daemon), we keep a reference to it
   * so findings targeted at the daemon surface on the merged row too.
   */
  mergedDaemon: RunningDaemonEntry | null;
}>;

function rowFromAutomaticStartup(
  entry: AutomaticStartupEntry,
  matchedDaemon: RunningDaemonEntry | null,
): Row {
  // Prefer the live daemon's data when one is present — `runningCliVersion`
  // from the inventory can lag (it's read from the plist; a fresh takeover
  // doesn't rewrite the plist, but the daemon's `startedWithCliVersion`
  // IS up to date). pid/running are also authoritative from the daemon.
  const raw = matchedDaemon?.startedWithCliVersion
    ?? entry.runningCliVersion
    ?? entry.configuredCliVersion
    ?? null;
  const isRunning = matchedDaemon !== null || entry.running === true;
  return {
    sortKey: isRunning ? 0 : 1,
    name: entry.name,
    displayChannel: entry.releaseChannel,
    displayVersion: raw ? compactVersion(raw) : null,
    relayUrl: entry.relayUrl ?? matchedDaemon?.relayUrl ?? null,
    running: isRunning,
    startsAt: 'auto',
    pid: matchedDaemon?.pid ?? null,
    kind: 'automatic',
    entry,
    mergedDaemon: matchedDaemon,
  };
}

function rowFromRunningDaemon(entry: RunningDaemonEntry): Row {
  const channel = entry.startedWithReleaseChannel;
  return {
    sortKey: 2,
    name: friendlyServerId(entry.serverId),
    displayChannel: channel,
    displayVersion: entry.startedWithCliVersion ? compactVersion(entry.startedWithCliVersion) : null,
    // Show the relay URL the daemon is connected to right on the header
    // line — answers "which relay is this daemon talking to?" without
    // chasing through serverIds.
    relayUrl: entry.relayUrl ?? null,
    running: true,
    startsAt: entry.startedBy === 'automatic-startup'
      ? 'auto'
      : entry.startedBy === 'manual'
        ? 'manual'
        : 'unknown',
    pid: entry.pid,
    kind: 'manual',
    entry,
    mergedDaemon: null,
  };
}

function buildRows(
  automatic: readonly AutomaticStartupEntry[],
  running: readonly RunningDaemonEntry[],
): Row[] {
  // Fold running-daemon info into the managing-service row when they
  // represent the same physical slot (service's `managedServerIds`
  // includes the daemon's real serverId). Otherwise the user sees two
  // rows for what is actually one daemon: the service entry AND the
  // running daemon that the service is managing.
  const consumed = new Set<number>(); // indexes of running daemons folded into a service row
  const rows: Row[] = automatic.map((e) => {
    const managed = e.managedServerIds ?? [e.serverId];
    const matchIdx = running.findIndex((d) => managed.includes(d.serverId));
    if (matchIdx >= 0) consumed.add(matchIdx);
    return rowFromAutomaticStartup(e, matchIdx >= 0 ? running[matchIdx] : null);
  });
  for (let i = 0; i < running.length; i += 1) {
    if (consumed.has(i)) continue;
    rows.push(rowFromRunningDaemon(running[i]));
  }
  rows.sort((a, b) => a.sortKey - b.sortKey);
  return rows;
}

function findingTargetsAutomaticEntry(finding: RepairFinding, entry: AutomaticStartupEntry): boolean {
  switch (finding.kind) {
    case 'automatic_startup_version_stale':
    case 'automatic_startup_stale_definition':
    case 'automatic_startup_legacy_channel_scoped':
    case 'automatic_startup_legacy_pinned_current_server':
      return finding.entry.path === entry.path;
    case 'automatic_startup_duplicate_default_following':
    case 'automatic_startup_duplicate_pinned_same_server':
      return [finding.keeper, ...finding.duplicates].some((e) => e.path === entry.path);
    case 'automatic_startup_lane_mismatch':
      return finding.existing.some((e) => e.path === entry.path);
    case 'automatic_startup_foreign_home':
      return finding.entries.some((e) => e.path === entry.path);
    default:
      return false;
  }
}

function findingTargetsDaemon(finding: RepairFinding, daemon: RunningDaemonEntry): boolean {
  if (finding.kind === 'running_daemon_cli_mismatch') return finding.daemon.pid === daemon.pid;
  if (finding.kind === 'running_daemon_duplicate_profile') return finding.daemons.some((d) => d.pid === daemon.pid);
  return false;
}

function findingsForRow(row: Row, findings: readonly RepairFinding[]): readonly RepairFinding[] {
  if (row.kind === 'automatic') {
    // Include findings that target the MERGED daemon (if any) on this row —
    // otherwise a running-daemon-cli-mismatch on a service-managed daemon
    // would lose its card sub-line after we folded the two rows together.
    const entry = row.entry as AutomaticStartupEntry;
    return findings.filter((f) => {
      if (findingTargetsAutomaticEntry(f, entry)) return true;
      if (row.mergedDaemon && findingTargetsDaemon(f, row.mergedDaemon)) return true;
      return false;
    });
  }
  return findings.filter((f) => findingTargetsDaemon(f, row.entry as RunningDaemonEntry));
}

function startsAtLabel(row: Row): string {
  if (row.startsAt === 'auto') return 'auto-starts on boot';
  if (row.startsAt === 'manual') return 'started manually';
  return 'startup source unknown';
}

function statusToken(running: boolean): string {
  const word = running ? 'running' : 'stopped';
  return running ? severity.success(word) : severity.info(word);
}

/**
 * Assemble the secondary detail line for an entry: relay URL, scope, how
 * the service is launched, and pid. Kept on a second row so the primary
 * line stays compact (glyph + name + channel/version + status).
 */
function detailLine(row: Row): string | null {
  const parts: string[] = [];
  if (row.relayUrl) parts.push(row.relayUrl);
  if (row.kind === 'automatic') {
    const entry = row.entry as AutomaticStartupEntry;
    parts.push(`${entry.mode} scope`);
  }
  parts.push(startsAtLabel(row));
  if (row.pid != null) parts.push(`pid ${row.pid}`);
  if (parts.length === 0) return null;
  return `    ${severity.info(parts.join(' · '))}`;
}

/**
 * Diagnostic sub-line shown under a row — ONLY when a finding targets it.
 * Scope / startup-mode / pid already live on the detail line; this line
 * carries the actual "what's wrong + what to do" text so it reads as a
 * distinct tier, not a restatement of metadata.
 */
function subLine(row: Row, findings: readonly RepairFinding[]): string | null {
  const primary = findings[0];
  if (!primary) return null;

  if (row.kind === 'automatic') {
    const entry = row.entry as AutomaticStartupEntry;
    switch (primary.kind) {
      case 'automatic_startup_version_stale': {
        const current = compactVersion(primary.currentCliVersion);
        const configured = entry.configuredCliVersion ? compactVersion(entry.configuredCliVersion) : '(unknown)';
        return `configured CLI ${configured} — newer CLI ${current} installed, restart to pick it up`;
      }
      case 'automatic_startup_stale_definition':
        return 'service definition drifted — reinstalling brings it back in sync';
      case 'automatic_startup_legacy_channel_scoped':
        return 'older per-channel service name — updating to the canonical name';
      case 'automatic_startup_legacy_pinned_current_server': {
        const where = entry.relayUrl
          ? `details for ${entry.relayUrl} baked into its config`
          : 'your current server\'s details baked into its config';
        return `${where} (legacy setup — can be replaced with the dynamic default-following setup)`;
      }
      case 'automatic_startup_lane_mismatch':
        return 'different release channel from the CLI you just installed';
      case 'automatic_startup_duplicate_default_following':
      case 'automatic_startup_duplicate_pinned_same_server':
        return 'duplicate — only one should run';
      case 'automatic_startup_foreign_home':
        return 'from another Happier home — manual cleanup required';
    }
  }

  if (row.kind === 'manual') {
    const daemon = row.entry as RunningDaemonEntry;
    if (primary.kind === 'running_daemon_cli_mismatch') {
      const target = compactVersion(primary.currentCliVersion);
      if (primary.driftKind === 'cross-channel') {
        const fromChannel = daemon.startedWithReleaseChannel ?? 'another channel';
        return `${fromChannel} daemon on this CLI's profile — take over and run on ${primary.currentCliReleaseChannel} · ${target}`;
      }
      return `older than this CLI — restart to pick up ${target}`;
    }
    if (primary.kind === 'running_daemon_duplicate_profile') {
      return `duplicate — two daemons own the same relay profile (pid ${daemon.pid})`;
    }
  }

  // Merged automatic-startup row with a running-daemon finding on its
  // absorbed daemon (see `findingsForRow`). Use the same copy as the
  // manual-row branch above.
  if (row.kind === 'automatic' && row.mergedDaemon && primary.kind === 'running_daemon_cli_mismatch') {
    const target = compactVersion(primary.currentCliVersion);
    if (primary.driftKind === 'cross-channel') {
      const fromChannel = row.mergedDaemon.startedWithReleaseChannel ?? 'another channel';
      return `${fromChannel} daemon on this CLI's profile — take over and run on ${primary.currentCliReleaseChannel} · ${target}`;
    }
    return `older than this CLI — restart to pick up ${target}`;
  }

  return null;
}

function renderRow(row: Row, findings: readonly RepairFinding[]): string[] {
  const hit = findingsForRow(row, findings);
  const g = hit.length > 0
    ? glyph.action()
    : row.running
      ? glyph.success()
      : glyph.info();

  const channel = row.displayChannel
    ? formatReleaseChannel(row.displayChannel)
    : severity.info('unknown');
  const versionPart = row.displayVersion ? ` · ${row.displayVersion}` : '';
  const nameRendered = hit.length > 0 ? severity.action(row.name) : row.name;
  // Two-line card:
  //   Line 1 — glyph + name + channel/version + status word
  //   Line 2 — relay URL + scope + startup mode + pid
  //   Line 3 (findings only) — → diagnostic hint
  const head = `  ${g} ${nameRendered}  ${severity.info('—')}  ${channel}${versionPart}  ${severity.info('—')}  ${statusToken(row.running)}`;

  const lines: string[] = [head];
  const detail = detailLine(row);
  if (detail) lines.push(detail);
  const sub = subLine(row, hit);
  if (sub) lines.push(`    ${glyph.arrow()} ${severity.info(sub)}`);
  return lines;
}

export function renderBackgroundServices(
  automaticStartup: readonly AutomaticStartupEntry[],
  currentlyRunning: readonly RunningDaemonEntry[],
  findings: readonly RepairFinding[],
): string[] {
  const rows = buildRows(automaticStartup, currentlyRunning);
  if (rows.length === 0) {
    return [`${sectionHeader(SECTION_BACKGROUND_SERVICES)}  ${severity.info('—')}  ${severity.info('none running or configured')}`];
  }
  const out: string[] = [sectionHeader(SECTION_BACKGROUND_SERVICES)];
  // Blank line between entries so each card reads as its own thing instead
  // of merging into a dense block.
  for (let i = 0; i < rows.length; i += 1) {
    if (i > 0) out.push('');
    out.push(...renderRow(rows[i], findings));
  }
  return out;
}
