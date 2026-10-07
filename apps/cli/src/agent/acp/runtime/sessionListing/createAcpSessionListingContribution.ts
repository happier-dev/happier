import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  AgentExternalSessionCandidate,
  AgentExternalSessionSource,
  AgentExternalSessionsContribution,
  AgentExternalSessionsInvocationBounds,
  AgentExternalSessionsResult,
} from '@happier-dev/plugin-sdk/sessions/external';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import {
  createAgentExternalSessionsProducerOverflowFailure,
  getAgentExternalSessionsInvocationFailure,
} from '@happier-dev/plugin-sdk/sessions/external';

import type { AcpBackend } from '@/agent/acp/AcpBackend';
import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import { createAcpTransportHandlerFromDefinition } from '@/agent/acp/runtime/definition/transport';
import type { NormalizedPluginDeclarativeAcpRuntime } from '@/agent/acp/runtime/definition/plugin';
import {
  createPublicAcpManagedDependencies,
  createPublicAcpSystemTools,
  resolveAcpTransportLaunch,
} from '@/agent/acp/runtime/launch/acpTransportLaunch';

const unsupported = () => Object.freeze({ ok: false as const, code: 'unsupported' as const });

/**
 * Owns the one ACP connection a listing call creates, so the process/socket is
 * released exactly once no matter which of success, provider error, deadline,
 * cancellation or contribution retirement ends the call — including when the
 * boundary fires while the launch is still resolving.
 */
function createOwnedAcpConnection() {
  let disposed = false;
  let backend: AcpBackend | null = null;
  let release: (() => void) | undefined;
  return Object.freeze({
    adoptRelease(next: (() => void) | undefined): void {
      if (!next) return;
      if (disposed) {
        next();
        return;
      }
      release = next;
    },
    adoptBackend(next: AcpBackend): AcpBackend {
      if (disposed) {
        void next.dispose().catch(() => undefined);
        return next;
      }
      backend = next;
      return next;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      const ownedBackend = backend;
      const ownedRelease = release;
      backend = null;
      release = undefined;
      await ownedBackend?.dispose().catch(() => undefined);
      ownedRelease?.();
    },
  });
}

/**
 * Settles as soon as the host's cancellation signal or absolute deadline ends
 * the invocation, so a provider that accepts `session/list` and never answers
 * cannot hold the connection open past its bounds.
 */
function watchInvocationBoundary(
  bounds: AgentExternalSessionsInvocationBounds,
): Readonly<{ expired: Promise<never>; dispose(): void }> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    const fail = (detail: string) => reject(new Error(detail));
    if (bounds.signal.aborted) {
      fail('ACP session/list was cancelled');
      return;
    }
    onAbort = () => fail('ACP session/list was cancelled');
    bounds.signal.addEventListener('abort', onAbort, { once: true });
    if (bounds.deadlineAtMs !== undefined) {
      timer = setTimeout(
        () => fail('ACP session/list exceeded its deadline'),
        Math.max(0, bounds.deadlineAtMs - Date.now()),
      );
    }
  });
  // The boundary rejection is a race participant; the losing branch must not
  // surface as an unhandled rejection.
  expired.catch(() => undefined);
  return Object.freeze({
    expired,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) bounds.signal.removeEventListener('abort', onAbort);
    },
  });
}

function readCandidateTitle(title: string | null | undefined): Readonly<{ title: string }> | undefined {
  return title ? Object.freeze({ title }) : undefined;
}

/**
 * The host-synthesized owner of a resume-only ACP source: the External Sessions
 * contribution it supplies to the plugin seam, plus the Agent session-lifecycle
 * controls that deliberately stay outside that seam. A plugin's External
 * Sessions contribution owns discovery and transcripts only, so destructive
 * control over an Agent's own session records is offered here — by the host —
 * or not at all.
 */
/**
 * The request-local capability cell one listing request writes. It exists only
 * for the duration of {@link AcpSessionListingOwner.runListingRequest}, so a
 * capability can never outlive, or be read by, a different request.
 */
type ListingCapabilityScope = {
  observed: boolean;
  deleteSupported: boolean;
};

export type AcpSessionListingOwner = Readonly<{
  contribution: AgentExternalSessionsContribution;
  /**
   * Runs one candidate-listing request and reports the ACP `session/delete`
   * support negotiated by the connection(s) that actually served it. Fail-closed
   * by construction: a request whose page came from anywhere other than a live
   * ACP listing — an indexed continuation, a failed listing, no listing at all —
   * observes nothing and reports `false`, and when a request lists more than
   * once every serving handshake must have negotiated it. The delete call
   * re-checks negotiation on its own connection anyway.
   */
  runListingRequest<T>(run: () => Promise<T>): Promise<Readonly<{
    value: T;
    negotiatedDeleteSupport: boolean;
  }>>;
  deleteCandidate(request: Readonly<{
    source: AgentExternalSessionSource;
    remoteSessionId: string;
    exec: ExecService;
  }> & AgentExternalSessionsInvocationBounds): Promise<AgentExternalSessionsResult<void>>;
}>;

/** Maps standard ACP session/list results only into resume-in-Happier candidates. */
export function createAcpSessionListingOwner(params: Readonly<{
  pluginId: string;
  agentId: string;
  runtime: NormalizedPluginDeclarativeAcpRuntime;
  sourceKinds: ReadonlySet<string>;
}>): AcpSessionListingOwner {
  const listingCapabilityScope = new AsyncLocalStorage<ListingCapabilityScope>();
  const openListingConnection = async (
    request: Readonly<{ exec: ExecService; signal: AbortSignal }>,
    owned: ReturnType<typeof createOwnedAcpConnection>,
  ): Promise<AcpBackend> => {
    const transport = params.runtime.transport;
    const launch = await resolveAcpTransportLaunch({
      transport,
      pluginId: params.pluginId,
      purpose: `agent-acp-session-list:${params.agentId}`,
      // `cwd` is deliberately absent: a listing request carries no workspace, so
      // executable resolution runs without a hint rather than borrowing the
      // daemon's own directory.
      systemTools: createPublicAcpSystemTools(request.exec, params.pluginId),
      managedDependencies: createPublicAcpManagedDependencies(request.exec, params.pluginId),
      signal: request.signal,
    });
    if (launch.kind === 'stdio') owned.adoptRelease(launch.release);
    const timeouts = launch.timeouts;
    return owned.adoptBackend(createAcpBackend({
      agentName: params.agentId,
      // Only the child process working directory. This connection issues
      // `session/list` alone, unfiltered, and never `session/new`, `session/load`
      // or ACP filesystem methods, so no workspace identity is implied here.
      cwd: process.cwd(),
      fsEnabled: false,
      ...(launch.kind === 'stdio'
        ? {
            command: launch.command,
            args: [...launch.args],
            env: { ...launch.env },
            unsetEnv: launch.unsetEnv,
          }
        : {
            networkTransport: launch.kind === 'webSocket'
              ? {
                  kind: 'webSocket' as const,
                  url: launch.url,
                  ...(launch.headers ? { headers: launch.headers } : {}),
                }
              : { kind: 'tcp' as const, host: launch.host, port: launch.port },
          }),
      transportHandler: createAcpTransportHandlerFromDefinition({
        backendId: params.agentId,
        timeouts: {
          ...(timeouts.initializeMs ? { initMs: timeouts.initializeMs } : {}),
          ...(timeouts.idleMs ? { idleMs: timeouts.idleMs } : {}),
          ...(timeouts.toolCallMs ? { toolCallMs: timeouts.toolCallMs } : {}),
          ...(params.runtime.definition?.timeouts ?? {}),
        },
        ...(params.runtime.definition?.stderrRules
          ? { stderrRules: params.runtime.definition.stderrRules }
          : {}),
      }),
    }));
  };

  /**
   * Writes into the calling request's scope only. Outside one — a listing the
   * host did not open a request scope for — the fact is simply not published,
   * which is the fail-closed answer.
   */
  const publishNegotiatedDeleteSupport = (negotiated: boolean): void => {
    const scope = listingCapabilityScope.getStore();
    if (!scope) return;
    scope.deleteSupported = scope.observed
      ? scope.deleteSupported && negotiated
      : negotiated;
    scope.observed = true;
  };

  const contribution: AgentExternalSessionsContribution = {
    async resolveSource(request) {
      return params.sourceKinds.has(request.source.kind)
        ? { ok: true, value: { source: request.source } }
        : { ok: false, code: 'source_invalid' };
    },
    async listCandidates(request) {
      if (!params.sourceKinds.has(request.source.kind)) return { ok: false, code: 'source_invalid' };
      const inadmissible = getAgentExternalSessionsInvocationFailure(request);
      if (inadmissible) return inadmissible;

      const owned = createOwnedAcpConnection();
      const boundary = watchInvocationBoundary(request);
      try {
        const listing = (async () => {
          const backend = await openListingConnection(request, owned);
          // The listing request owns no workspace, so the ACP `cwd` filter is
          // sent unset instead of narrowing the provider's sessions to whatever
          // directory the daemon happens to run from.
          const page = await backend.listSessions({
            cwd: null,
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          });
          // A capability read is only truthful for the connection that produced
          // the rows the caller is about to see, so it is published into this
          // request's own scope from that same handshake.
          publishNegotiatedDeleteSupport(
            backend.getNegotiatedSessionCapabilities().deleteSession,
          );
          return page;
        })();
        listing.catch(() => undefined);
        const listed = await Promise.race([listing, boundary.expired]);

        if (listed.sessions.length > request.maxItems) {
          // Slicing an oversized page silently drops sessions the provider's own
          // continuation cursor will never return. Refuse the page instead.
          return createAgentExternalSessionsProducerOverflowFailure(
            `ACP session/list returned ${listed.sessions.length} sessions for a ${request.maxItems}-candidate page`,
          );
        }

        const searchTerm = request.searchTerm?.trim().toLocaleLowerCase();
        const candidates: AgentExternalSessionCandidate[] = listed.sessions
          .filter((session) => !searchTerm || [session.title, session.cwd, session.sessionId]
            .some((value) => value?.toLocaleLowerCase().includes(searchTerm)))
          .map((session) => {
            const parsedUpdatedAt = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
            return Object.freeze({
              remoteSessionId: session.sessionId,
              updatedAtMs: Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : 0,
              ...readCandidateTitle(session.title),
            });
          });
        return {
          ok: true,
          value: {
            candidates: Object.freeze(candidates),
            nextCursor: listed.nextCursor ?? null,
            ...(searchTerm ? { searchIncomplete: true } : {}),
          },
        };
      } catch (error) {
        return getAgentExternalSessionsInvocationFailure(request)
          ?? ({
            ok: false,
            code: 'agent_error',
            message: error instanceof Error ? error.message : String(error),
          } satisfies AgentExternalSessionsResult<never>);
      } finally {
        boundary.dispose();
        await owned.dispose();
      }
    },
    resolveLinkIdentity: async () => unsupported(),
    resolveLinkedIdentity: async () => unsupported(),
    pageTranscript: async () => unsupported(),
    readAfterTranscript: async () => unsupported(),
  };
  return Object.freeze({
    contribution: Object.freeze(contribution),
    async runListingRequest(run) {
      const scope: ListingCapabilityScope = { observed: false, deleteSupported: false };
      const value = await listingCapabilityScope.run(scope, run);
      return Object.freeze({
        value,
        negotiatedDeleteSupport: scope.observed && scope.deleteSupported,
      });
    },
    async deleteCandidate(request) {
      if (!params.sourceKinds.has(request.source.kind)) return { ok: false, code: 'source_invalid' };
      const inadmissible = getAgentExternalSessionsInvocationFailure(request);
      if (inadmissible) return inadmissible;

      const owned = createOwnedAcpConnection();
      const boundary = watchInvocationBoundary(request);
      try {
        const deletion = (async () => {
          const backend = await openListingConnection(request, owned);
          // `deleteSession` fails closed against the capabilities this exact
          // connection negotiated, so a stale advertisement can never turn into
          // an unnegotiated call.
          await backend.deleteSession(request.remoteSessionId);
        })();
        deletion.catch(() => undefined);
        await Promise.race([deletion, boundary.expired]);
        return { ok: true, value: undefined };
      } catch (error) {
        return getAgentExternalSessionsInvocationFailure(request)
          ?? ({
            ok: false,
            code: 'agent_error',
            message: error instanceof Error ? error.message : String(error),
          } satisfies AgentExternalSessionsResult<never>);
      } finally {
        boundary.dispose();
        await owned.dispose();
      }
    },
  });
}
