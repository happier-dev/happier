import { collectBugReportMachineDiagnosticsSnapshot } from '@/diagnostics/bugReportMachineDiagnostics';

import type { BugReportMachineDiagnosticsSnapshot } from '@happier-dev/protocol';

export const BUG_REPORT_MACHINE_DIAGNOSTICS_RECIPE = {
  daemonLogLimit: 5,
  stackLogLimit: 3,
  stackRuntimeMaxChars: 400_000,
} as const;

export async function collectBugReportMachineDiagnosticsSnapshotForBugReport(): Promise<BugReportMachineDiagnosticsSnapshot> {
  return await collectBugReportMachineDiagnosticsSnapshot(BUG_REPORT_MACHINE_DIAGNOSTICS_RECIPE);
}
