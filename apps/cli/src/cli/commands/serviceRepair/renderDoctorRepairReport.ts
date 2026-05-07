import type { DoctorRepairReport } from '@/diagnostics/doctorRepair';
import { code, muted, severity } from '@/ui/format/styles';

import { findingHeadline, MISMATCHED_STATE_HEADER } from './prompts/_copy';
import { renderCleanStateSummary } from './renderCleanStateSummary';
import { renderAuthentication } from './sections/renderAuthentication';
import { renderBackgroundServices } from './sections/renderBackgroundServices';
import { renderCurrentCli } from './sections/renderCurrentCli';
import { renderLocalRelays } from './sections/renderLocalRelays';

/**
 * Canonical report renderer. Returns a `string[]` so tests can assert on
 * substrings without worrying about terminal wrapping.
 *
 * - If `report.findings.length === 0`, renders the compact "looks good" block.
 * - Otherwise renders the mismatched header + relevant sections (a section is
 *   only shown when it has content OR there is a finding that targets it).
 *
 * Options:
 *  - `includeInteractiveFooter`: append a call-to-action line explaining how
 *    to apply the findings interactively. Installer's `--report-only` path
 *    sets this to `true` so users see a clear next step when they can't
 *    answer prompts (e.g. `curl | bash` with no TTY).
 */
export function renderDoctorRepairReport(
  report: DoctorRepairReport,
  opts: { includeInteractiveFooter?: boolean } = {},
): string[] {
  if (report.findings.length === 0) {
    return renderCleanStateSummary(report);
  }

  // Leading blank line — callers like the installer stream this report directly
  // after their own progress output, and without a visible gap the mismatch
  // header gets lost. Rendering the blank line at the top keeps the first
  // *visible* line of this function the attention-grabbing yellow+bold header.
  const out: string[] = ['', MISMATCHED_STATE_HEADER];

  // Dedupe + preserve canonical order (findings are already ordered by build).
  // Marker is muted so it recedes; headline itself reads at full weight — these
  // are the primary takeaway the user is supposed to scan.
  const seen = new Set<string>();
  for (const finding of report.findings) {
    const headline = findingHeadline(finding);
    if (seen.has(headline)) continue;
    seen.add(headline);
    out.push(`${muted('  •')} ${headline}`);
  }
  out.push('');

  const currentCliLines = renderCurrentCli(report.currentCli);
  out.push(...currentCliLines, '');

  const backgroundLines = renderBackgroundServices(
    report.automaticStartup,
    report.currentlyRunning,
    report.findings,
  );
  if (backgroundLines.length > 0) out.push(...backgroundLines, '');

  const relayLines = renderLocalRelays(report.localRelays, report.findings, report.currentCli.invoker);
  if (relayLines.length > 0) out.push(...relayLines, '');

  const authLines = renderAuthentication(report.authProfiles, report.hasAnyServerProfile, report.currentCli.invoker);
  if (authLines.length > 0) out.push(...authLines, '');

  while (out.length > 0 && out[out.length - 1] === '') out.pop();

  if (opts.includeInteractiveFooter) {
    out.push('');
    out.push(`${severity.info('To handle these interactively:')} ${code(`${report.currentCli.invoker} doctor repair`)}`);
  }

  return out;
}
