import { ClaudeHandoffTargetImportDiagnosticV1Schema, type ClaudeHandoffTargetImportDiagnosticV1 } from '@happier-dev/protocol/sessions/control/handoff/handoffStatus';

/** Agent and retained-job boundaries share the producer's closed disclosure contract. */
export function readSessionHandoffImportDiagnostics(value: unknown): ClaudeHandoffTargetImportDiagnosticV1[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const parsed = ClaudeHandoffTargetImportDiagnosticV1Schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
