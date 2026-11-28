import type { DirectSessionsSource } from '@happier-dev/protocol';
import { DirectSessionsProviderUnavailableError, type DirectSessionTranscriptPage } from '@/backends/directSessions/providerOps';
import { withCodexAppServerClient } from '../appServer/client/withCodexAppServerClient';
import { resolveCodexAppServerProcessEnv } from '../appServer/resolveCodexAppServerProcessEnv';
import { readCodexRolloutHistoryLineage } from '../localControl/readCodexRolloutHistoryLineage';
import { readCodexRolloutHead } from '../localControl/rolloutDiscovery';
import {
  canDecodeCompressedCodexRollouts,
  isCompressedCodexRollout,
  withCodexRolloutReadPaths,
  type CodexRolloutReadPathResolver,
} from '../rollout/openCompressedCodexRollout';
import { isMatchingCodexRolloutIdentity } from '../utils/codexSessionFiles';
import { decodeCodexDirectForwardCursor } from './codexDirectForwardCursor';
import { decodeCodexDirectBackwardCursor } from './codexDirectTranscriptBackwardCursor';
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
  let readLocalRollout: (() => Promise<DirectSessionTranscriptPage>) | null = null;
  let localRolloutIsComplete = false;
  if (!nativeCursor) {
    const perHome = await Promise.all(homes.map(async home => ({ home,
      files: await collectCodexSessionRolloutFiles({ codexHome: home, remoteSessionId: params.remoteSessionId, includeCompressed: true }) })));
    const best = perHome.filter(entry => entry.files.length > 0).sort((left, right) =>
      Math.max(...right.files.map(file => file.mtimeMs)) - Math.max(...left.files.map(file => file.mtimeMs)))[0];
    if (best) {
      selectedNativeHome = best.home;
      const forward = params.follow && params.cursor ? decodeCodexDirectForwardCursor(params.cursor) : null;
      const backward = params.follow ? null : decodeCodexDirectBackwardCursor(params.cursor);
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
          const page = await readAfterCodexRolloutStreams({ ...input, cursor: params.cursor === 'tail' ? 'tail' : forward });
          return { ...page, tailCursor: null, hasMore: page.truncationReason === 'page_limit' };
        }
        const page = await pageCodexRolloutStreams({
          ...input, cursor: backward ?? (params.cursor?.trim() ? 'unrecognized' : undefined),
        });
        return { ...page, truncated: page.truncated === true };
      };
      readLocalRollout = async () => params.resolveRolloutReadPath
        ? await readRollouts(params.resolveRolloutReadPath)
        : await withCodexRolloutReadPaths(readRollouts);

      // Both pagers keep their own cursor identity and replacement behavior.
      if (backward || forward?.kind === 'codexForwardStreamVector' || forward?.kind === 'codexForward') {
        return await readLocalRollout();
      }

      const lineage = await Promise.all(best.files.map(async file => {
        const head = await readCodexRolloutHead(file.filePath);
        if (!head) return 'unverified';
        if (head.kind === 'legacy-prefix') return head.kind;
        const { metadata } = head;
        const id = typeof metadata.id === 'string' ? metadata.id : undefined;
        return isMatchingCodexRolloutIdentity(id, params.remoteSessionId)
          ? readCodexRolloutHistoryLineage(metadata).kind
          : 'unverified';
      }));
      if (lineage.every(kind => kind === 'legacy' || kind === 'legacy-prefix')) return await readLocalRollout();
      localRolloutIsComplete = lineage.every(kind => kind === 'legacy' || kind === 'self-contained');
    }
  }
  let failure: unknown = new DirectSessionsProviderUnavailableError('Codex transcript source is unavailable');
  for (const home of nativeCursor ? [nativeCursor.home] : selectedNativeHome ? [selectedNativeHome] : homes) {
    try {
      const processEnv = await resolveCodexAppServerProcessEnv({ processEnv: { ...process.env, ...env },
        affinity: { home: params.source.kind === 'codexHome' ? params.source.home : 'user', homePath: home } });
      const cwd = process.cwd();
      const reset = Boolean(params.cursor && params.cursor !== 'tail' && !nativeCursor);
      const page = await withCodexAppServerClient({ processEnv, cwd, run: async client => {
        const sqliteHome = await client.readRuntimeSqliteHome?.() ?? null;
        return pageCodexNativeTranscript({
          ...params, client, home, sqliteHome, hasLocalRollout: selectedNativeHome !== undefined, cursor: nativeCursor ? params.cursor : undefined,
          tailOnly: params.follow && (!nativeCursor || params.cursor === 'tail'),
        });
      } });
      return reset ? { ...page, items: [], truncated: true, truncationReason: 'source_discontinuity' } : page;
    } catch (error) { failure = error; }
  }
  // A copied thread can name an unavailable path in Codex's state even when its local rollout is intact.
  if (readLocalRollout && localRolloutIsComplete) return await readLocalRollout();
  throw failure;
}
