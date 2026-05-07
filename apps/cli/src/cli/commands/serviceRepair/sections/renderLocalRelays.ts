import { formatReleaseChannel } from '@/ui/format/releaseChannel';
import { cleanRelayRuntimeVersion, code, glyph, sectionHeader, severity } from '@/ui/format/styles';
import type {
  LocalRelayEntry,
  RepairFinding,
} from '@/diagnostics/doctorRepair';

import {
  HEALTHY_WORD,
  SECTION_LOCAL_RELAYS,
  UNHEALTHY_WORD,
} from '../prompts/_copy';

function findingTargetsRelay(finding: RepairFinding, entry: LocalRelayEntry): boolean {
  if (finding.kind === 'local_relay_version_stale') {
    return finding.entry.releaseChannel === entry.releaseChannel
      && finding.entry.mode === entry.mode;
  }
  if (finding.kind === 'local_relay_lane_missing') {
    return finding.installed.some((e) => e.releaseChannel === entry.releaseChannel && e.mode === entry.mode);
  }
  return false;
}

function cardFor(entry: LocalRelayEntry, findings: readonly RepairFinding[], invoker: string): string[] {
  const hit = findings.filter((f) => findingTargetsRelay(f, entry));
  const running = entry.serviceActive === true;
  const unhealthy = entry.healthy === false;
  const hasFinding = hit.length > 0;

  const g = hasFinding
    ? glyph.action()
    : running && !unhealthy
      ? glyph.success()
      : glyph.info();

  const channel = formatReleaseChannel(entry.releaseChannel);
  const version = cleanRelayRuntimeVersion(entry.version);
  const url = entry.relayUrl ?? '(no URL)';
  const scope = `${entry.mode} scope`;
  const statusWord = running && !unhealthy
    ? HEALTHY_WORD
    : running && unhealthy
      ? UNHEALTHY_WORD
      : 'stopped';
  const statusRendered = running && !unhealthy
    ? severity.success(statusWord)
    : severity.info(statusWord);

  const head = `  ${g} ${channel}   ${version} on ${url}   ${severity.info(scope)}   ${statusRendered}`;
  const card: string[] = [head];

  const stale = hit.find((f) => f.kind === 'local_relay_version_stale');
  if (stale && stale.kind === 'local_relay_version_stale') {
    const latest = cleanRelayRuntimeVersion(stale.latestVersion);
    card.push(`    ${glyph.arrow()} ${severity.info(`version ${version} behind latest ${latest}`)} · ${code(`${invoker} relay host install`)}`);
  }
  const missing = hit.find((f) => f.kind === 'local_relay_lane_missing');
  if (missing && missing.kind === 'local_relay_lane_missing') {
    card.push(`    ${glyph.arrow()} ${severity.info(`different release channel from current CLI (${missing.targetReleaseChannel})`)}`);
  }
  return card;
}

export function renderLocalRelays(
  entries: readonly LocalRelayEntry[],
  findings: readonly RepairFinding[],
  invoker: string = 'happier',
): string[] {
  if (entries.length === 0) return [];
  const lines: string[] = [sectionHeader(SECTION_LOCAL_RELAYS)];
  // Only separate entries with a blank line when at least one of the two
  // neighbours is a multi-line card. For one-line rows (the common case),
  // stack them directly — the user called out that blanks between single
  // lines make the list feel disconnected.
  const blocks = entries.map((e) => cardFor(e, findings, invoker));
  for (let i = 0; i < blocks.length; i += 1) {
    const prev = blocks[i - 1];
    const curr = blocks[i];
    if (i > 0 && ((prev?.length ?? 0) > 1 || curr.length > 1)) {
      lines.push('');
    }
    lines.push(...curr);
  }
  return lines;
}
