import type { BugReportFormPayload } from '@happier-dev/protocol';

import { submitSupportReport, type SubmitSupportReportInput } from '../bugReports/submitSupportReport.js';
import type { SupportRuntimeInventory } from '../types.js';

export type SubmitSupportCommandDeps = Readonly<{
  collectRuntimeInventory: () => Promise<SupportRuntimeInventory> | SupportRuntimeInventory;
  submitSupportReport?: typeof submitSupportReport;
}>;

export type SubmitSupportCommandResult = Readonly<{
  reportId: string;
  issueNumber: number;
  issueUrl: string;
}>;

export async function runSubmitSupportCommand(
  input: Readonly<{
    providerUrl: string;
    timeoutMs: number;
    form: BugReportFormPayload;
    issueOwner: string;
    issueRepo: string;
    maxArtifactBytes: number;
    acceptedKinds: readonly string[];
    existingIssueNumber?: number;
    note?: string;
  }>,
  deps: SubmitSupportCommandDeps,
): Promise<SubmitSupportCommandResult> {
  const inventory = await deps.collectRuntimeInventory();
  const submit = deps.submitSupportReport ?? submitSupportReport;
  return await submit({
    providerUrl: input.providerUrl,
    timeoutMs: input.timeoutMs,
    form: input.form,
    report: {
      capturedAt: new Date().toISOString(),
      inventory: input.note?.trim()
        ? { ...inventory, note: input.note.trim() }
        : inventory,
    },
    maxArtifactBytes: input.maxArtifactBytes,
    acceptedKinds: input.acceptedKinds,
    issueOwner: input.issueOwner,
    issueRepo: input.issueRepo,
    existingIssueNumber: input.existingIssueNumber,
  } satisfies SubmitSupportReportInput);
}
