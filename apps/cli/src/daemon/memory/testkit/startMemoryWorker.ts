import { startMemoryWorker as startDaemonMemoryWorker } from '../memoryWorker';
import { connectInProcessMemoryIndexer } from './inProcessMemoryIndexer';

/** Replace only the OS process placement; exercise the real daemon and indexer. */
export function startMemoryWorker(params: Parameters<typeof startDaemonMemoryWorker>[0]) {
  return startDaemonMemoryWorker({ ...params, deps: { ...params.deps,
    connectIndexer: params.deps?.connectIndexer ?? (host => connectInProcessMemoryIndexer({
      credentials: params.credentials, machineId: params.machineId, host,
      fetchDecryptedTranscriptPageAfterSeq: params.deps?.fetchDecryptedTranscriptPageAfterSeq,
    })),
  } });
}

/** Preserve the same HTTP fixture for the separate id-only visibility reader. */
export async function fetchMemorySessionListVisibilityFixture(params: Readonly<{
  token: string;
  cursor?: string;
  limit?: number;
  archivedOnly?: boolean;
  activeOnly?: boolean;
  signal?: AbortSignal;
}>) {
  const { fetchSessionsPage } = await import('@/session/transport/http/sessionsHttp');
  const page = await fetchSessionsPage(params);
  return { ...page, sessions: page.sessions.map(({ id }) => ({ id })) };
}
