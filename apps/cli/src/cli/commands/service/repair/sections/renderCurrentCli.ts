import { formatReleaseChannel } from '@/ui/format/releaseChannel';
import { code, compactHomePath, glyph, sectionHeader, severity } from '@/ui/format/styles';
import type { CurrentCliInfo } from '@/diagnostics/doctorRepair';

import { SECTION_CURRENT_CLI } from '../prompts/_copy';

/** Render the `Current CLI` card. */
export function renderCurrentCli(cli: CurrentCliInfo): string[] {
  const lines: string[] = [sectionHeader(SECTION_CURRENT_CLI)];
  const summary = [
    formatReleaseChannel(cli.releaseChannel),
    cli.version ? `· ${cli.version}` : null,
  ].filter(Boolean).join(' ');
  const compactedPath = compactHomePath(cli.binaryPath);
  const shimHint = cli.shim && compactedPath
    ? `${cli.shim} → ${compactedPath}`
    : compactedPath ?? '';
  lines.push(`  ${summary}   ${severity.info(shimHint)}`);

  if (cli.pathWinnerResolvesToThisBinary === false && cli.pathWinnerShim) {
    lines.push(`  ${glyph.action()} ${severity.action('`happier` on your PATH resolves to a different install')}`);
    lines.push(`    ${glyph.arrow()} run this install with ${code(cli.shim ?? 'hdev')} until PATH is fixed`);
  }
  return lines;
}
