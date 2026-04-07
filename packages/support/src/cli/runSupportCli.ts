import { parseArgs } from 'node:util';

import { output as cliOutput } from '@happier-dev/cli-common';
import type { BugReportFormPayload } from '@happier-dev/protocol';
import { defaultSupportRuntimeInventory } from '../runtime/defaultSupportRuntimeInventory.js';
import { runCollectSupportCommand } from '../commands/collectSupportCommand.js';
import { runSubmitSupportCommand } from '../commands/submitSupportCommand.js';
import { submitSupportReport as submitSupportReportImpl } from '../bugReports/submitSupportReport.js';
import type { SupportRuntimeInventory } from '../types.js';

export type RunSupportCliResult = Readonly<{
  exitCode: number;
  stdout: string;
}>;

function buildDefaultForm(input: Readonly<{ title: string; summary: string; appVersion: string | null }>): BugReportFormPayload {
  return {
    title: input.title.trim() || 'Support report',
    summary: input.summary.trim() || 'Collected diagnostic support report',
    environment: {
      appVersion: input.appVersion?.trim() || '0.0.0',
      platform: process.platform,
      deploymentType: 'self-hosted',
      serverUrl: '',
    },
    consent: {
      includeDiagnostics: true,
      acceptedPrivacyNotice: true,
    },
  };
}

export async function runSupportCli(
  argv: readonly string[],
  deps: Readonly<{
    collectRuntimeInventory?: () => Promise<SupportRuntimeInventory> | SupportRuntimeInventory;
    submitSupportReport?: typeof submitSupportReportImpl;
    stdout?: { write: (text: string) => void };
    stderr?: { write: (text: string) => void };
    presentation?: cliOutput.OutputPresentation;
  }> = {},
): Promise<RunSupportCliResult> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      json: { type: 'boolean', default: false },
      'provider-url': { type: 'string', default: '' },
      'issue-owner': { type: 'string', default: 'happier-dev' },
      'issue-repo': { type: 'string', default: 'happier' },
      'title': { type: 'string', default: 'Support report' },
      'summary': { type: 'string', default: 'Collected diagnostic support report' },
      'note': { type: 'string', default: '' },
    },
    allowPositionals: true,
  });

  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const collectRuntimeInventory = deps.collectRuntimeInventory ?? defaultSupportRuntimeInventory;

  const command = String(positionals[0] ?? 'collect').trim() || 'collect';
  if (command !== 'collect' && command !== 'submit') {
    stderr.write(`Unknown command: ${command}\n`);
    return { exitCode: 1, stdout: '' };
  }

  if (command === 'collect') {
    const result = await runCollectSupportCommand(
      { json: values.json === true, presentation: deps.presentation ?? cliOutput.terminalPresentation },
      { collectRuntimeInventory },
    );
    stdout.write(result.output);
    return { exitCode: 0, stdout: result.output };
  }

  const title = String(values.title ?? '').trim();
  const summary = String(values.summary ?? '').trim();
  const note = String(values.note ?? '').trim();
  const inventory = await collectRuntimeInventory();
  const baseForm = buildDefaultForm({ title, summary, appVersion: inventory.invokedVersion });
  const result = await runSubmitSupportCommand(
    {
      providerUrl: String(values['provider-url'] ?? '').trim(),
      timeoutMs: 120_000,
      form: baseForm,
      issueOwner: String(values['issue-owner'] ?? '').trim() || 'happier-dev',
      issueRepo: String(values['issue-repo'] ?? '').trim() || 'happier',
      maxArtifactBytes: 10 * 1024 * 1024,
      acceptedKinds: ['cli', 'daemon', 'stack-service', 'user-note'],
      ...(note ? { note } : {}),
    },
    {
      collectRuntimeInventory: () => inventory,
      submitSupportReport: deps.submitSupportReport,
    },
  );
  const output = values.json === true
    ? `${JSON.stringify(result, null, 2)}\n`
    : `Submitted support report ${result.reportId}\n`;
  stdout.write(output);
  return { exitCode: 0, stdout: output };
}
