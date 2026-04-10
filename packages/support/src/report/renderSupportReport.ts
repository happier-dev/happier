import * as cliOutput from '@happier-dev/cli-common/output';
import { describeBackgroundServiceTargetMode } from '@happier-dev/cli-common/happierRuntime';

import type {
  SupportInstallationEntry,
  SupportReport,
  SupportRuntimeTargetEntry,
  SupportServiceEntry,
} from '../types.js';

function renderInstallationTitle(entry: SupportInstallationEntry): string {
  return `${entry.label} (${entry.version ?? 'unknown'})`;
}

function renderServiceTitle(entry: SupportServiceEntry): string {
  return `${entry.label} (${entry.status ?? 'unknown'})`;
}

function buildInstallationRows(entry: SupportInstallationEntry): cliOutput.DefinitionListRow[] {
  return [
    entry.ring ? { label: 'Ring', value: entry.ring } : null,
    entry.path ? { label: 'Location', value: entry.path } : null,
    entry.realPath && entry.realPath !== entry.path ? { label: 'Resolved', value: entry.realPath } : null,
    { label: 'PATH', value: entry.status === 'on-path' ? (entry.shimName || 'yes') : 'no' },
  ].filter((row): row is cliOutput.DefinitionListRow => row !== null);
}

function buildServiceRows(entry: SupportServiceEntry): cliOutput.DefinitionListRow[] {
  return [
    entry.targetMode ? { label: 'Mode', value: describeBackgroundServiceTargetMode(entry.targetMode) } : null,
    entry.ring ? { label: 'Ring', value: entry.ring } : null,
    (entry.publicServerUrl ?? entry.serverUrl) ? { label: 'Relay', value: entry.publicServerUrl ?? entry.serverUrl ?? '' } : null,
    entry.path ? { label: 'Definition', value: entry.path } : null,
    entry.executablePath ? { label: 'Executable', value: entry.executablePath } : null,
    entry.linkedInstallationPath
      ? { label: 'Installation', value: entry.linkedInstallationPath }
      : null,
    entry.linkedRuntimeTargetLabel ? { label: 'Runtime', value: entry.linkedRuntimeTargetLabel } : null,
    entry.linkedRuntimeTargetPath ? { label: 'Target', value: entry.linkedRuntimeTargetPath } : null,
  ].filter((row): row is cliOutput.DefinitionListRow => row !== null);
}

function buildRuntimeTargetRows(entry: SupportRuntimeTargetEntry): cliOutput.DefinitionListRow[] {
  return [
    { label: 'Type', value: entry.category },
    entry.path ? { label: 'Location', value: entry.path } : null,
    entry.executablePath && entry.executablePath !== entry.path ? { label: 'Executable', value: entry.executablePath } : null,
    entry.linkedServiceLabels.length > 0 ? { label: 'Services', value: entry.linkedServiceLabels.join(', ') } : null,
  ].filter((row): row is cliOutput.DefinitionListRow => row !== null);
}

export function renderSupportReport(report: SupportReport, options: Readonly<{ presentation?: cliOutput.OutputPresentation }> = {}): string {
  const builder = cliOutput.createOutputBuilder({ presentation: options.presentation });
  let hasRenderedSection = false;
  const appendSection = (title: string, build: (section: cliOutput.OutputBuilder) => void): void => {
    if (hasRenderedSection) {
      builder.blank();
    }
    builder.section(title, build);
    hasRenderedSection = true;
  };

  builder.line(
    options.presentation?.banner
      ? options.presentation.banner('Support diagnostics', { subtitle: `Captured at ${report.capturedAt}` })
      : `Support diagnostics\nCaptured at ${report.capturedAt}`,
  );
  builder.blank();
  appendSection('Runtime', (section) => {
    section.definitionList([
      { label: 'Binary', value: report.inventory.invokedBinaryPath },
      { label: 'Version', value: report.inventory.invokedVersion ?? 'unknown' },
      { label: 'Node', value: report.inventory.nodeVersion },
      { label: 'Platform', value: report.inventory.platform },
    ]);
  });
  appendSection('Installations', (section) => {
    for (const [index, entry] of report.inventory.installations.entries()) {
      section.line(renderInstallationTitle(entry));
      section.definitionList(buildInstallationRows(entry), { indent: '  ' });
      if (index < report.inventory.installations.length - 1) {
        section.blank();
      }
    }
  });
  appendSection('Services', (section) => {
    for (const [index, entry] of report.inventory.services.entries()) {
      section.line(renderServiceTitle(entry));
      section.definitionList(buildServiceRows(entry), { indent: '  ' });
      if (index < report.inventory.services.length - 1) {
        section.blank();
      }
    }
  });
  appendSection('Additional Runtimes', (section) => {
    for (const [index, entry] of report.inventory.runtimeTargets.entries()) {
      section.line(entry.label);
      section.definitionList(buildRuntimeTargetRows(entry), { indent: '  ' });
      if (index < report.inventory.runtimeTargets.length - 1) {
        section.blank();
      }
    }
  });
  appendSection('Warnings', (section) => {
    section.bullets(report.inventory.warnings.map((warning) => `${warning.code}: ${warning.title}`));
  });
  if (report.inventory.note?.trim()) {
    appendSection('Note', (section) => {
      section.line(report.inventory.note!.trim());
    });
  }
  return builder.render();
}
