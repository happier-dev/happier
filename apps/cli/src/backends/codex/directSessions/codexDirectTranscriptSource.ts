import type { DirectSessionsSource } from '@happier-dev/protocol';
import { DirectSessionsProviderUnavailableError, type DirectSessionTranscriptPage } from '@/backends/directSessions/providerOps';
import { withCodexAppServerClient } from '../appServer/client/withCodexAppServerClient';
import { resolveCodexAppServerProcessEnv } from '../appServer/resolveCodexAppServerProcessEnv';
import { resolveConfiguredCodexSqliteHome } from '../connectedServices/codexStateFileNames';
import { readCodexSessionMetaFromRollout } from '../localControl/rolloutDiscovery';
import { collectCodexSessionRolloutFiles } from './collectCodexSessionRolloutFiles';
import { pageCodexRolloutStreams, readAfterCodexRolloutStreams } from './codexDirectTranscriptStreamPaging';
import { decodeCodexNativeTranscriptCursor, pageCodexNativeTranscript } from './pageCodexNativeTranscript';
import { resolveCodexHomesForDirectSessionsSource } from './resolveCodexHomesForDirectSessionsSource';
import { logger } from '@/utils/logger';

/** One source decision for browse, import and follow. Native cursors retain their selected home. */
export async function readCodexDirectTranscript(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
  follow?: boolean;
}>): Promise<DirectSessionTranscriptPage> {
  const env = params.env ?? process.env;
  const homes = await resolveCodexHomesForDirectSessionsSource({ ...params, env });
  const nativeCursor = decodeCodexNativeTranscriptCursor(params.cursor);
  if (nativeCursor && (!homes.includes(nativeCursor.home) || nativeCursor.threadId !== params.remoteSessionId)) {
    throw new DirectSessionsProviderUnavailableError('Codex transcript cursor does not match the selected source');
  }
  let selectedNativeHome: string | undefined;
  let hasPaginatedRollout = false;
  let readLocalRollout: (() => Promise<DirectSessionTranscriptPage>) | null = null;
  let localRolloutIsComplete = false;
  if (!nativeCursor) {
    const perHome = await Promise.all(homes.map(async home => ({ home,
      files: await collectCodexSessionRolloutFiles({ codexHome: home, remoteSessionId: params.remoteSessionId }) })));
    const best = perHome.filter(entry => entry.files.length > 0).sort((left, right) =>
      Math.max(...right.files.map(file => file.mtimeMs)) - Math.max(...left.files.map(file => file.mtimeMs)))[0];
    // A paginated rollout can be only a local segment with an inherited history_base.
    // Codex owns replaying that lineage; the legacy JSONL projection cannot prove completeness.
    const metadata = best ? await Promise.all(best.files.map(file => readCodexSessionMetaFromRollout(file.filePath))) : [];
    hasPaginatedRollout = metadata.some(entry => entry?.history_mode === 'paginated');
    localRolloutIsComplete = metadata.every(entry => entry?.history_base == null);
    selectedNativeHome = best?.home;
    if (best) {
      const input = { ...params, codexHome: best.home, initialRolloutFiles: best.files };
      readLocalRollout = async () => {
        if (params.follow) {
          const page = await readAfterCodexRolloutStreams({ ...input, cursor: params.cursor! });
          return { ...page, tailCursor: null, hasMore: page.truncationReason === 'page_limit' };
        }
        const page = await pageCodexRolloutStreams(input);
        return { ...page, truncated: page.truncated === true };
      };
    }
    if (readLocalRollout && !hasPaginatedRollout) return await readLocalRollout();
  }
  let failure: unknown = new DirectSessionsProviderUnavailableError('Codex transcript source is unavailable');
  for (const home of nativeCursor ? [nativeCursor.home] : selectedNativeHome ? [selectedNativeHome] : homes) {
    try {
      const processEnv = await resolveCodexAppServerProcessEnv({ processEnv: { ...process.env, ...env },
        affinity: { home: params.source.kind === 'codexHome' ? params.source.home : 'user', homePath: home } });
      const reset = Boolean(params.cursor && params.cursor !== 'tail' && !nativeCursor);
      const page = await withCodexAppServerClient({ processEnv, run: client => pageCodexNativeTranscript({
        ...params, client, home, sqliteHome: resolveConfiguredCodexSqliteHome(processEnv), hasPaginatedRollout, cursor: nativeCursor ? params.cursor : undefined,
        tailOnly: params.follow && (!nativeCursor || params.cursor === 'tail'),
      }) });
      return reset ? { ...page, items: [], truncated: true, truncationReason: 'source_discontinuity' } : page;
    } catch (error) { failure = error; }
  }
  // Codex refuses to replay a thread whose state row names a rollout path that no longer exists
  // (e.g. history copied from Windows). A paginated rollout with no inherited history_base holds
  // its whole history, so the local file is complete without Codex's lineage replay.
  if (readLocalRollout && localRolloutIsComplete) {
    logger.warn('[codex.directTranscript] native history unavailable; reading the self-contained local rollout', {
      remoteSessionId: params.remoteSessionId,
      error: failure instanceof Error ? failure.message : String(failure),
    });
    return await readLocalRollout();
  }
  throw failure;
}
