import { output as cliOutput } from '@happier-dev/cli-common';

import type { SupportReport } from '../types.js';

export function renderSupportReport(report: SupportReport, options: Readonly<{ presentation?: cliOutput.OutputPresentation }> = {}): string {
  const builder = cliOutput.createOutputBuilder({ presentation: options.presentation });
  builder.line(
    options.presentation?.banner
      ? options.presentation.banner('Support diagnostics', { subtitle: `Captured at ${report.capturedAt}` })
      : `Support diagnostics\nCaptured at ${report.capturedAt}`,
  );
  builder.blank();
  builder.section('Runtime', (section) => {
    section.definitionList([
      { label: 'Binary', value: report.inventory.invokedBinaryPath },
      { label: 'Version', value: report.inventory.invokedVersion ?? 'unknown' },
      { label: 'Node', value: report.inventory.nodeVersion },
      { label: 'Platform', value: report.inventory.platform },
    ]);
  });
  builder.section('Installations', (section) => {
    section.bullets(report.inventory.installations.map((entry) => `${entry.label} (${entry.version ?? 'unknown'})`));
  });
  builder.section('Services', (section) => {
    section.bullets(report.inventory.services.map((entry) => `${entry.label} (${entry.status ?? 'unknown'})`));
  });
  builder.section('Warnings', (section) => {
    section.bullets(report.inventory.warnings.map((warning) => `${warning.code}: ${warning.title}`));
  });
  if (report.inventory.note?.trim()) {
    builder.section('Note', (section) => {
      section.line(report.inventory.note!.trim());
    });
  }
  return builder.render();
}
