import type { SupportReport, SupportReportContext, SupportRuntimeInventory } from '../types.js';

export function buildSupportReport(
  inventory: SupportRuntimeInventory,
  context: SupportReportContext = {},
): SupportReport {
  const now = context.now?.() ?? new Date();
  return {
    capturedAt: now.toISOString(),
    inventory,
  };
}
