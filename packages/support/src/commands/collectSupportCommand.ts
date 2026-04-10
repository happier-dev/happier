import * as cliOutput from '@happier-dev/cli-common/output';

import { buildSupportReport } from '../report/buildSupportReport.js';
import { renderSupportReport } from '../report/renderSupportReport.js';
import type { SupportReport, SupportRuntimeInventory } from '../types.js';

export type CollectSupportCommandDeps = Readonly<{
  collectRuntimeInventory: () => Promise<SupportRuntimeInventory> | SupportRuntimeInventory;
}>;

export type CollectSupportCommandResult = Readonly<{
  report: SupportReport;
  output: string;
}>;

export async function runCollectSupportCommand(
  input: Readonly<{
    json: boolean;
    presentation?: cliOutput.OutputPresentation;
  }>,
  deps: CollectSupportCommandDeps,
): Promise<CollectSupportCommandResult> {
  const inventory = await deps.collectRuntimeInventory();
  const report = buildSupportReport(inventory);
  const output = input.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderSupportReport(report, { presentation: input.presentation })}\n`;
  return { report, output };
}
