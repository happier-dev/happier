import { archiveSession, unarchiveSession } from '@/session/transport/http/sessionsHttp';

export function isSessionActiveArchiveError(error: unknown): error is Error & { code: 'session_active' } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'session_active';
}

export async function setSessionArchivedStateById(params: Readonly<{
  token: string;
  sessionId: string;
  archived: boolean;
}>): Promise<Readonly<{ archivedAt: number | null }>> {
  const result = params.archived
    ? await archiveSession({
        token: params.token,
        sessionId: params.sessionId,
      })
    : await unarchiveSession({
        token: params.token,
        sessionId: params.sessionId,
      });

  return {
    archivedAt: result.archivedAt,
  };
}
