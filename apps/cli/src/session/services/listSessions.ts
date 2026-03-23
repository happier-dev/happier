import type { VendorResumeEligibilityReasonCode } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { summarizeSessionRow, type SessionSummary } from '@/cli/output/session/sessionSummary';
import { buildCliSessionRowModel, type CliSessionRowModel } from '@/cli/output/session/buildCliSessionRowModel';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { fetchSessionsPage } from '@/session/transport/http/sessionsHttp';

export type ListSessionsJsonSession = SessionSummary & Readonly<{
  agentId: CliSessionRowModel['agentId'];
  vendorResumeEligible: boolean;
  vendorResumeReasonCode?: VendorResumeEligibilityReasonCode;
}>;

export type ListSessionsResult = Readonly<{
  rows: readonly CliSessionRowModel[];
  sessions: readonly ListSessionsJsonSession[];
  nextCursor: string | null;
  hasNext: boolean;
}>;

export async function listSessions(params: Readonly<{
  credentials: Credentials;
  activeOnly: boolean;
  archivedOnly: boolean;
  includeSystem: boolean;
  resumableOnly: boolean;
  limit?: number;
  cursor?: string;
}>): Promise<ListSessionsResult> {
  const page = await fetchSessionsPage({
    token: params.credentials.token,
    ...(params.cursor ? { cursor: params.cursor } : {}),
    ...(params.limit ? { limit: params.limit } : {}),
    activeOnly: params.activeOnly,
    archivedOnly: params.archivedOnly,
  });

  const accountSettingsContext = await bootstrapAccountSettingsContext({
    credentials: params.credentials,
    mode: 'fast',
  });
  const rowModels = page.sessions
    .map((row) =>
      buildCliSessionRowModel({
        credentials: params.credentials,
        rawSession: row,
        accountSettings: accountSettingsContext.settings,
      }))
    .filter((row) => params.includeSystem || row.isSystem !== true);

  const filteredRows = params.resumableOnly
    ? rowModels.filter((row) => row.vendorResume.eligible === true && row.archivedAt === null && row.active !== true)
    : rowModels;

  const allowedSessionIds = params.resumableOnly ? new Set(filteredRows.map((row) => row.id)) : null;
  const rowById = new Map(filteredRows.map((row) => [row.id, row] as const));
  const sessions = page.sessions
    .map((row) => summarizeSessionRow({ credentials: params.credentials, row }))
    .filter((session) => params.includeSystem || session.isSystem !== true)
    .filter((session) => !allowedSessionIds || allowedSessionIds.has(session.id))
    .map((session) => {
      const row = rowById.get(session.id);
      if (!row) {
        throw new Error(`Missing CLI row model for session ${session.id}`);
      }
      return {
        ...session,
        agentId: row.agentId,
        vendorResumeEligible: row.vendorResume.eligible,
        ...(row.vendorResume.eligible ? {} : { vendorResumeReasonCode: row.vendorResume.reasonCode }),
      };
    });

  return {
    rows: filteredRows,
    sessions,
    nextCursor: page.nextCursor,
    hasNext: page.hasNext,
  };
}
