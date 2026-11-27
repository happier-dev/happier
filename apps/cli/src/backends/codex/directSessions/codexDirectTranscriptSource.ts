import type { DirectSessionsSource } from '@happier-dev/protocol';
import { DirectSessionsProviderUnavailableError, type DirectSessionTranscriptPage } from '@/backends/directSessions/providerOps';
import { withCodexAppServerClient } from '../appServer/client/withCodexAppServerClient';
import { resolveCodexAppServerProcessEnv } from '../appServer/resolveCodexAppServerProcessEnv';
import { resolveConfiguredCodexSqliteHome } from '../connectedServices/codexStateFileNames';
import { readCodexSessionMetaFromRollout } from '../localControl/rolloutDiscovery';
import {
  canDecodeCompressedCodexRollouts,
  isCompressedCodexRollout,
  withCodexRolloutReadPaths,
  type CodexRolloutReadPathResolver,
} from '../rollout/openCompressedCodexRollout';
import { collectCodexSessionRolloutFiles, type CodexRolloutFile } from './collectCodexSessionRolloutFiles';
import { pageCodexRolloutStreams, readAfterCodexRolloutStreams } from './codexDirectTranscriptStreamPaging';
import { decodeCodexNativeTranscriptCursor, pageCodexNativeTranscript } from './pageCodexNativeTranscript';
import { resolveCodexHomesForDirectSessionsSource } from './resolveCodexHomesForDirectSessionsSource';

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
  resolveRolloutReadPath?: CodexRolloutReadPathResolver;
}>): Promise<DirectSessionTranscriptPage> {
  const env = params.env ?? process.env;
  const homes = await resolveCodexHomesForDirectSessionsSource({ ...params, env });
  const nativeCursor = decodeCodexNativeTranscriptCursor(params.cursor);
  if (nativeCursor && (!homes.includes(nativeCursor.home) || nativeCursor.threadId !== params.remoteSessionId)) {
    throw new DirectSessionsProviderUnavailableError('Codex transcript cursor does not match the selected source');
  }
  let selectedNativeHome: string | undefined;
  let hasPaginatedRollout = false;
  let requiresNativeCompressedRead = false;
  if (!nativeCursor) {
    const perHome = await Promise.all(homes.map(async home => ({ home,
      files: await collectCodexSessionRolloutFiles({ codexHome: home, remoteSessionId: params.remoteSessionId, includeCompressed: true }) })));
    const best = perHome.filter(entry => entry.files.length > 0).sort((left, right) =>
      Math.max(...right.files.map(file => file.mtimeMs)) - Math.max(...left.files.map(file => file.mtimeMs)))[0];
    // A paginated rollout can be only a local segment with an inherited history_base.
    // Codex owns replaying that lineage; the legacy JSONL projection cannot prove completeness.
    hasPaginatedRollout = Boolean(best && (await Promise.all(best.files.map(file => readCodexSessionMetaFromRollout(file.filePath))))
      .some(metadata => metadata?.history_mode === 'paginated'));
    selectedNativeHome = best?.home;
    requiresNativeCompressedRead = !canDecodeCompressedCodexRollouts
      && best?.files.some(file => isCompressedCodexRollout(file.filePath)) === true;
    if (best && !hasPaginatedRollout && !requiresNativeCompressedRead) {
      const readRollouts = async (resolve: CodexRolloutReadPathResolver) => {
        const prepare = async (files: readonly CodexRolloutFile[]) => {
          const readable: CodexRolloutFile[] = [];
          for (const file of files) {
            if (!canDecodeCompressedCodexRollouts && isCompressedCodexRollout(file.filePath)) {
              throw new DirectSessionsProviderUnavailableError('Compressed Codex sidechain requires a runtime with Zstandard support');
            }
            const source = await resolve(file.filePath).catch(() => {
              throw new DirectSessionsProviderUnavailableError('The compressed Codex rollout could not be read');
            });
            readable.push({ ...file, filePath: source.path, fileIdentity: source.fileIdentity });
          }
          return readable;
        };
        const collectFiles = async (threadId: string) => prepare(await collectCodexSessionRolloutFiles({
          codexHome: best.home, remoteSessionId: threadId, includeCompressed: true,
        }));
        const input = { ...params, collectFiles, initialRolloutFiles: await prepare(best.files) };
        if (params.follow) {
          const page = await readAfterCodexRolloutStreams({ ...input, cursor: params.cursor! });
          return { ...page, tailCursor: null, hasMore: page.truncationReason === 'page_limit' };
        }
        const page = await pageCodexRolloutStreams(input);
        return { ...page, truncated: page.truncated === true };
      };
      return params.resolveRolloutReadPath
        ? await readRollouts(params.resolveRolloutReadPath)
        : await withCodexRolloutReadPaths(readRollouts);
    }
  }
  let failure: unknown = new DirectSessionsProviderUnavailableError('Codex transcript source is unavailable');
  for (const home of nativeCursor ? [nativeCursor.home] : selectedNativeHome ? [selectedNativeHome] : homes) {
    try {
      const processEnv = await resolveCodexAppServerProcessEnv({ processEnv: { ...process.env, ...env },
        affinity: { home: params.source.kind === 'codexHome' ? params.source.home : 'user', homePath: home } });
      const reset = Boolean(params.cursor && params.cursor !== 'tail' && !nativeCursor);
      const page = await withCodexAppServerClient({ processEnv, run: client => pageCodexNativeTranscript({
        ...params, client, home, sqliteHome: resolveConfiguredCodexSqliteHome(processEnv), hasPaginatedRollout: hasPaginatedRollout || requiresNativeCompressedRead, cursor: nativeCursor ? params.cursor : undefined,
        tailOnly: params.follow && (!nativeCursor || params.cursor === 'tail'),
      }) });
      return reset ? { ...page, items: [], truncated: true, truncationReason: 'source_discontinuity' } : page;
    } catch (error) { failure = error; }
  }
  throw failure;
}
