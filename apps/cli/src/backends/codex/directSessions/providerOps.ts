import { configuration } from '@/configuration';
import { AGENTS_CORE, buildCodexSpawnRuntimeAffinityCompatFields } from '@happier-dev/agents';
import {
  ConnectedServiceIdSchema,
  type ConnectedServiceBindingsV1,
  type DirectSessionsSource,
} from '@happier-dev/protocol';

import { createPollingDirectSessionFollowLease } from '@/api/directSessions/backgroundFollow/createPollingDirectSessionFollowLease';
import {
  mergeDirectSessionEnvironmentVariables,
  type DirectSessionProviderOps,
} from '@/backends/directSessions/providerOps';
import { bareNameMatches, pathContains, pathEndsWith, processTokens } from '@/backends/directSessions/processMatch';

import { getCodexDirectSessionActivity } from './getCodexDirectSessionActivity';
import { getCodexDirectSessionWorkingDirectory } from './getCodexDirectSessionWorkingDirectory';
import { listCodexSessionCandidates } from './listCodexSessionCandidates';
import { pageCodexTranscript } from './pageCodexTranscript';
import { readAfterCodexTranscript } from './readAfterCodexTranscript';
import { resolveCodexHomeEntriesForDirectSessionsSource } from './resolveCodexHomeEntriesForDirectSessionsSource';
import { resolveCodexAppServerProcessEnv } from '../appServer/resolveCodexAppServerProcessEnv';
import {
  CODEX_APP_SERVER_DAEMON_PROXY_TRANSPORT,
  CODEX_APP_SERVER_TRANSPORT_ENV_KEY,
  isCodexThreadLoadedInAppServerDaemon,
} from '../appServer/daemon/codexAppServerDaemonTransport';

function resolveCodexTakeoverSourceAuth(params: Readonly<{
  source: DirectSessionsSource;
  adoptExistingDaemon: boolean;
}>): ConnectedServiceBindingsV1 | null {
  if (params.source.kind === 'codexHome' && params.source.home === 'connectedService') {
    const parsedServiceId = ConnectedServiceIdSchema.safeParse(params.source.connectedServiceId);
    if (!parsedServiceId.success) return null;
    const binding = params.source.connectedServiceGroupId
      ? {
        source: 'connected' as const,
        selection: 'group' as const,
        groupId: params.source.connectedServiceGroupId,
        ...(params.source.connectedServiceProfileId
          ? { profileId: params.source.connectedServiceProfileId }
          : {}),
      }
      : params.source.connectedServiceProfileId
        ? {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: params.source.connectedServiceProfileId,
        }
        : null;
    return binding
      ? { v: 1, bindingsByServiceId: { [parsedServiceId.data]: binding } }
      : null;
  }

  if (!params.adoptExistingDaemon) return null;
  return {
    v: 1,
    bindingsByServiceId: Object.fromEntries(
      (AGENTS_CORE.codex.connectedServices?.supportedServiceIds ?? []).map((serviceId) => [
        serviceId,
        { source: 'native' as const },
      ]),
    ),
  };
}

// Patterns from AgentMonitor's Codex adapter (MIT, see processMatch.ts): the CLI in any install
// layout plus the macOS Codex desktop app bundle.
function isCodexProcessToken(token: string): boolean {
  return pathEndsWith(token, '/bin/codex')
    || bareNameMatches(token, 'codex')
    || pathContains(token, '/@openai/codex-')
    || pathContains(token, '/codex-cli/')
    || token.endsWith('/Codex.app/Contents/MacOS/Codex')
    || token.endsWith('/Codex.app/Contents/Resources/codex');
}

export const codexDirectSessionProviderOps: DirectSessionProviderOps = {
  getWorkingDirectory: async ({ source, remoteSessionId }) => await getCodexDirectSessionWorkingDirectory({
    source,
    activeServerDir: configuration.activeServerDir,
    remoteSessionId,
    env: process.env,
  }),
  matchesProviderProcess: (observed) => processTokens(observed).some(isCodexProcessToken),
  // Listing reads the user's Codex home rollout files only (CLI and desktop app share it).
  passiveObservationSource: () => ({ kind: 'codexHome', home: 'user' }),
  listCandidates: async ({ source, cursor, limit, searchTerm, searchMode }) => {
    const res = await listCodexSessionCandidates({ source, activeServerDir: configuration.activeServerDir, cursor, limit, searchTerm, searchMode });
    return { candidates: res.candidates, nextCursor: res.nextCursor ?? null, ...(res.searchIncomplete ? { searchIncomplete: true } : {}) };
  },
  getActivity: async ({ source, remoteSessionId }) => {
    const res = await getCodexDirectSessionActivity({ source, activeServerDir: configuration.activeServerDir, remoteSessionId });
    return {
      lastActivityAtMs: typeof res.lastActivityAtMs === 'number' && Number.isFinite(res.lastActivityAtMs) ? res.lastActivityAtMs : null,
      isRunning: false,
    };
  },
  pageTranscript: async ({ source, remoteSessionId, direction, cursor, maxBytes, maxItems }) => {
    const res = await pageCodexTranscript({
      source,
      activeServerDir: configuration.activeServerDir,
      remoteSessionId,
      direction,
      cursor,
      maxBytes,
      maxItems,
    });
    return {
      items: res.items,
      nextCursor: res.nextCursor ?? null,
      tailCursor: res.tailCursor ?? null,
      hasMore: res.hasMore,
      truncated: res.truncated === true,
      ...(res.truncationReason ? { truncationReason: res.truncationReason } : {}),
    };
  },
  readAfterTranscript: async ({ source, remoteSessionId, cursor, maxBytes, maxItems }) => {
    const res = await readAfterCodexTranscript({
      source,
      activeServerDir: configuration.activeServerDir,
      remoteSessionId,
      cursor,
      maxBytes,
      maxItems,
    });
    return { ...res, nextCursor: res.nextCursor ?? null, truncated: res.truncated === true };
  },
  acquireFollowLease: async ({ source, remoteSessionId }) => createPollingDirectSessionFollowLease({
    readAfterTranscript: ({ cursor, maxBytes, maxItems }) =>
      readAfterCodexTranscript({
        source,
        activeServerDir: configuration.activeServerDir,
        remoteSessionId,
        cursor,
        maxBytes,
        maxItems,
      }),
  }),
  resolveTakeoverSpawnOptions: async ({ linked, sessionId, transcriptStorage }) => {
    const homeEntries = await resolveCodexHomeEntriesForDirectSessionsSource({
      source: linked.source,
      activeServerDir: configuration.activeServerDir,
      env: process.env,
    });
    const codexHome = homeEntries.length === 1 ? homeEntries[0]?.codexHome ?? null : null;
    const directory =
      linked.sessionPath ??
      (await getCodexDirectSessionWorkingDirectory({
        source: linked.source,
        activeServerDir: configuration.activeServerDir,
        remoteSessionId: linked.remoteSessionId,
        env: process.env,
      }));
    if (!directory || !codexHome) return null;
    const runtimeEnv = await resolveCodexAppServerProcessEnv({
      processEnv: process.env,
      affinity: {
        home: homeEntries[0]?.source.kind === 'codexHome' ? homeEntries[0].source.home : 'user',
        homePath: codexHome,
      },
    });
    const adoptExistingDaemon = await isCodexThreadLoadedInAppServerDaemon({
        cwd: directory,
        processEnv: runtimeEnv,
        threadId: linked.remoteSessionId,
      });
    const sourceAuth = resolveCodexTakeoverSourceAuth({
      source: homeEntries[0]?.source ?? linked.source,
      adoptExistingDaemon,
    });
    return {
      directory,
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      existingSessionId: sessionId,
      resume: linked.remoteSessionId,
      approvedNewDirectoryCreation: true,
      transcriptStorage,
      ...(sourceAuth ? { connectedServices: sourceAuth } : {}),
      ...(adoptExistingDaemon ? { codexBackendMode: 'appServer' as const } : {}),
      ...buildCodexSpawnRuntimeAffinityCompatFields(
        !adoptExistingDaemon && linked.codexBackendMode ? { backendMode: linked.codexBackendMode } : null,
      ),
      environmentVariables: mergeDirectSessionEnvironmentVariables([{
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: runtimeEnv.CODEX_SQLITE_HOME ?? codexHome,
        ...(adoptExistingDaemon
          ? { [CODEX_APP_SERVER_TRANSPORT_ENV_KEY]: CODEX_APP_SERVER_DAEMON_PROXY_TRANSPORT }
          : {}),
      }]),
    };
  },
};
