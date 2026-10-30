import { z } from 'zod';

export const BugReportLogSelectionSchema = z.object({
  daemon: z.boolean(),
  session: z.boolean(),
  provider: z.boolean(),
});

export type BugReportLogSelection = z.infer<typeof BugReportLogSelectionSchema>;

export const BUG_REPORT_LOG_SOURCE_KINDS = {
  daemon: 'daemon',
  session: 'session-log',
  provider: 'provider-transcript',
} as const;

export function resolveBugReportLogSelection(input?: Partial<BugReportLogSelection>): BugReportLogSelection {
  return { daemon: input?.daemon !== false, session: input?.session !== false, provider: input?.provider === true };
}

export const BugReportSessionDiagnosticsSchema = z.object({
  context: z.object({
    sessionId: z.string(),
    machineId: z.string().optional(),
    provider: z.string().optional(),
    metadataStatus: z.enum(['available', 'unavailable', 'wrong-machine']),
  }),
  logs: z.array(z.object({
    kind: z.enum(['daemon', 'session', 'provider']),
    status: z.enum(['collected', 'unavailable', 'disabled']),
    detail: z.string().optional(),
    artifact: z.object({
      filename: z.string(),
      sourceKind: z.string(),
      contentType: z.string(),
      content: z.string(),
    }).optional(),
  })),
});

export type BugReportSessionDiagnostics = z.infer<typeof BugReportSessionDiagnosticsSchema>;
