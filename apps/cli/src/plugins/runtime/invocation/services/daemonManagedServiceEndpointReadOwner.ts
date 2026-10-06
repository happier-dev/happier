import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import {
  MANAGED_SERVICE_ENDPOINT_READ_NEXT_RPC_TIMEOUT_MS,
  MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS,
  ManagedServiceEndpointReadCancelResultV1Schema,
  ManagedServiceEndpointReadNextResultV1Schema,
  ManagedServiceEndpointReadOpenResultV1Schema,
} from '@/agent/runtime/session/process/managedServiceEndpointReadProtocol';
import {
  serializeManagedServiceEndpointReadRequestHeaders,
} from '@/agent/runtime/session/process/managedServiceEndpointReadHeaders';
import type {
  AgentExternalSessionsManagedEndpointReadRequest,
  AgentExternalSessionsManagedEndpointReadResponse,
} from '@happier-dev/plugin-sdk/sessions/external';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type {
  AgentExternalSessionsManagedEndpointReadHost,
} from '@/session/external/agentExternalSessionsInvocation';
import type {
    ManagedServiceEndpointProjectionV1,
  ManagedServiceEndpointProjectionResolveQuery,
  ManagedServiceSessionClientAccessResolver,
} from './managedServiceEndpointProjection';

type ResolveProjection = (
  query: ManagedServiceEndpointProjectionResolveQuery,
) => Promise<ManagedServiceEndpointProjectionV1 | null>;

type SessionTransport = Extract<
  Awaited<ReturnType<typeof resolveSessionTransportContext>>,
  { ok: true }
>;

type PendingClaim = {
  projection: ManagedServiceEndpointProjectionV1;
  claimed: boolean;
};

type RunnerEndpointReadRpc = Readonly<{
  sessionId: string;
  call(input: Readonly<{
    method: string;
    request: unknown;
    timeoutMs: number;
  }>): Promise<unknown>;
}>;

const MAX_ACTIVE_READS = 128;

async function callResolvedSessionRpc(input: Readonly<{
  credentials: StoredCredentials;
  transport: SessionTransport;
  method: string;
  request: unknown;
  timeoutMs: number;
}>): Promise<unknown> {
  const common = {
    token: input.credentials.token,
    sessionId: input.transport.sessionId,
    method: `${input.transport.sessionId}:${input.method}`,
    request: input.request,
    timeoutMs: input.timeoutMs,
  };
  return input.transport.mode === 'plain'
    ? await callSessionRpc({
        ...common,
        mode: 'plain',
        ctx: null,
      })
    : await callSessionRpc({
        ...common,
        mode: 'e2ee',
        ctx: input.transport.ctx,
      });
}

export function createDaemonManagedServiceEndpointReadOwner(input: Readonly<{
  credentials: StoredCredentials;
  resolveProjection: ResolveProjection;
  resolveRunnerEndpointReadRpc?: (
    sessionId: string,
  ) => Promise<RunnerEndpointReadRpc | null>;
}>): Readonly<{
  claim(request: Readonly<{
    requestId: string;
    projectionToken: string;
    sessionId: string;
    pluginId: string;
  }>): boolean;
  bindHost: AgentExternalSessionsManagedEndpointReadHost;
  resolveSessionClientAccess: ManagedServiceSessionClientAccessResolver;
  dispose(): Promise<void>;
}> {
  const pendingClaims = new Map<string, PendingClaim>();
  const activeCancels = new Map<string, () => Promise<void>>();
  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  const readProjection = async (readInput: Readonly<{
    projection: ManagedServiceEndpointProjectionV1;
    resolveCurrentContribution(): Promise<ManagedServiceEndpointProjectionV1>;
    request: AgentExternalSessionsManagedEndpointReadRequest;
    signal: AbortSignal;
  }>): Promise<AgentExternalSessionsManagedEndpointReadResponse> => {
    if (disposed) {
        throw new Error('Managed server endpoint read owner is unavailable');
      }
      const pathAndQuery = readInput.request.pathAndQuery;
      if (
        typeof pathAndQuery !== 'string'
        || !pathAndQuery.startsWith('/')
        || pathAndQuery.startsWith('//')
        || pathAndQuery.includes('#')
      ) {
        throw new Error('Managed server endpoint read target is invalid');
      }
      if (readInput.signal.aborted) throw readInput.signal.reason;
      const requestHeaders = serializeManagedServiceEndpointReadRequestHeaders(
        readInput.request.headers,
      );
      const projection = readInput.projection;
      if (activeCancels.size >= MAX_ACTIVE_READS) {
        throw new Error('Managed server endpoint read capacity is exhausted');
      }
      let rpc: RunnerEndpointReadRpc | null;
      if (input.resolveRunnerEndpointReadRpc) {
        rpc = await input.resolveRunnerEndpointReadRpc(
          projection.sessionId,
        );
      } else {
        const transport = await resolveSessionTransportContext({
          credentials: input.credentials,
          idOrPrefix: projection.sessionId,
        });
        rpc = (
          transport.ok
          && transport.sessionId === projection.sessionId
            ? Object.freeze({
                sessionId: transport.sessionId,
                call: async (rpcInput: Readonly<{
                  method: string;
                  request: unknown;
                  timeoutMs: number;
                }>) => await callResolvedSessionRpc({
                  credentials: input.credentials,
                  transport,
                  ...rpcInput,
                }),
              })
            : null
        );
      }
      if (!rpc || rpc.sessionId !== projection.sessionId) {
        throw new Error('Managed server endpoint runner transport is unavailable');
      }
      const currentProjection = await readInput.resolveCurrentContribution();
      if (currentProjection.projectionToken !== projection.projectionToken) {
        throw new Error('Managed server endpoint read owner is unavailable');
      }
      const runnerRpc = rpc;
      if (disposed) {
        throw new Error('Managed server endpoint read owner is unavailable');
      }
      if (activeCancels.size >= MAX_ACTIVE_READS) {
        throw new Error('Managed server endpoint read capacity is exhausted');
      }
      const requestId = randomUUID();
      const pending: PendingClaim = { projection, claimed: false };
      pendingClaims.set(requestId, pending);
      let openDispatched = false;
      let cancelPromise: Promise<void> | null = null;
      let abortListener: (() => void) | null = null;
      const cancelRemote = async (): Promise<void> => {
        pendingClaims.delete(requestId);
        if (abortListener) {
          readInput.signal.removeEventListener('abort', abortListener);
        }
        if (!openDispatched) {
          activeCancels.delete(requestId);
          return;
        }
        cancelPromise ??= (async () => {
          try {
            const raw = await runnerRpc.call({
              method: MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.CANCEL,
              timeoutMs: 5_000,
              request: {
                v: 1,
                requestId,
                route: {
                  kind: 'endpointProjection',
                  projectionToken: projection.projectionToken,
                },
              },
            });
            ManagedServiceEndpointReadCancelResultV1Schema.parse(raw);
          } catch {
            // Runner retirement and exact-handle currentness bound failed cancellation.
          }
        })();
        try {
          await cancelPromise;
        } finally {
          activeCancels.delete(requestId);
        }
      };
      activeCancels.set(requestId, cancelRemote);
      abortListener = () => {
        void cancelRemote();
      };
      if (readInput.signal.aborted) {
        await cancelRemote();
        throw readInput.signal.reason;
      }
      readInput.signal.addEventListener('abort', abortListener, {
        once: true,
      });
      try {
        openDispatched = true;
        const rawOpen = await runnerRpc.call({
          method: MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.OPEN,
          timeoutMs: 20_000,
          request: {
            v: 1,
            requestId,
            route: {
              kind: 'endpointProjection',
              projection,
            },
            pathAndQuery,
            headers: requestHeaders,
          },
        });
        const opened = ManagedServiceEndpointReadOpenResultV1Schema.parse(
          rawOpen,
        );
        if (readInput.signal.aborted) throw readInput.signal.reason;
        if (
          disposed
          || opened.status !== 'opened'
          || pendingClaims.get(requestId) !== pending
          || !pending.claimed
        ) {
          throw new Error(
            'Managed server endpoint read was unavailable before effect',
          );
        }
        pendingClaims.delete(requestId);
        const headers: Record<string, string> = {};
        for (const [name, value] of opened.response.headers) {
          headers[name] = value;
        }
        if (!opened.response.hasBody) {
          await cancelRemote();
          return Object.freeze({
            ok: opened.response.status >= 200
              && opened.response.status <= 299,
            status: opened.response.status,
            statusText: opened.response.statusText,
            headers: Object.freeze(headers),
            body: null,
          });
        }
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const rawNext = await runnerRpc.call({
                method: MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.NEXT,
                timeoutMs:
                  MANAGED_SERVICE_ENDPOINT_READ_NEXT_RPC_TIMEOUT_MS,
                request: {
                  v: 1,
                  requestId,
                  route: {
                    kind: 'endpointProjection',
                    projectionToken: projection.projectionToken,
                  },
                },
              });
              const next = ManagedServiceEndpointReadNextResultV1Schema
                .parse(rawNext);
              if (next.status === 'chunk') {
                controller.enqueue(Buffer.from(next.dataBase64, 'base64'));
                return;
              }
              if (next.status === 'end') {
                activeCancels.delete(requestId);
                if (abortListener) {
                  readInput.signal.removeEventListener(
                    'abort',
                    abortListener,
                  );
                }
                controller.close();
                return;
              }
              throw new Error(
                'Managed server endpoint read became unavailable',
              );
            } catch (error) {
              await cancelRemote();
              controller.error(error);
            }
          },
          async cancel() {
            await cancelRemote();
          },
        });
        return Object.freeze({
          ok: opened.response.status >= 200
            && opened.response.status <= 299,
          status: opened.response.status,
          statusText: opened.response.statusText,
          headers: Object.freeze(headers),
          body,
        });
      } catch (error) {
        await cancelRemote();
        throw error;
      } finally {
        pendingClaims.delete(requestId);
    }
  };

  const bindHost:
    AgentExternalSessionsManagedEndpointReadHost = async (bindingInput) => {
      if (
        disposed
        || bindingInput.signal.aborted
        || bindingInput.source.managedEndpoint !== true
        || Object.prototype.hasOwnProperty.call(
          bindingInput.source,
          'baseUrl',
        )
      ) {
        throw new Error('Managed server endpoint read owner is unavailable');
      }
      const currentContributionQuery:
        ManagedServiceEndpointProjectionResolveQuery = Object.freeze({
          pluginId: bindingInput.identity.pluginId,
          contributionId: bindingInput.identity.contributionQualifiedId,
          sourceCustody: bindingInput.identity.sourceCustody,
          selector: Object.freeze({ kind: 'currentContribution' }),
        });
      const resolveCurrentContribution = async () => {
        const projection = await input.resolveProjection(
          currentContributionQuery,
        );
        if (
          !projection
          || disposed
          || bindingInput.signal.aborted
          || projection.custodyOwner !== 'sessionRunner'
          || projection.pluginId !== bindingInput.identity.pluginId
          || projection.contributionId
            !== bindingInput.identity.contributionQualifiedId
          || !pluginSourceCustodyV1Equal(
            projection.sourceCustody,
            bindingInput.identity.sourceCustody,
          )
        ) {
          throw new Error('Managed server endpoint read owner is unavailable');
        }
        return projection;
      };
      await resolveCurrentContribution();
      return Object.freeze(async (request) => {
        if (disposed) {
          throw new Error('Managed server endpoint read owner is unavailable');
        }
        if (bindingInput.signal.aborted) throw bindingInput.signal.reason;
        const projection = await resolveCurrentContribution();
        return await readProjection({
          projection,
          resolveCurrentContribution,
          request,
          signal: bindingInput.signal,
        });
      });
    };

  const resolveSessionClientAccess:
    ManagedServiceSessionClientAccessResolver = async (accessInput) => {
      if (disposed) return null;
      const query: ManagedServiceEndpointProjectionResolveQuery = Object.freeze({
        pluginId: accessInput.pluginId,
        sessionId: accessInput.sessionId,
        contributionId: accessInput.contributionId,
        selector: Object.freeze({
          kind: 'baseUrl' as const,
          baseUrl: accessInput.targetBaseUrl,
        }),
      });
      const resolveCurrent = async () => {
        const projection = await input.resolveProjection(query);
        return projection
          && projection.custodyOwner === 'sessionRunner'
          && projection.sessionId === accessInput.sessionId
          && projection.pluginId === accessInput.pluginId
          && projection.contributionId === accessInput.contributionId
          ? projection
          : null;
      };
      const projection = await resolveCurrent();
      if (!projection) return null;
      let rpc: RunnerEndpointReadRpc | null;
      if (input.resolveRunnerEndpointReadRpc) {
        rpc = await input.resolveRunnerEndpointReadRpc(projection.sessionId);
      } else {
        const transport = await resolveSessionTransportContext({
          credentials: input.credentials,
          idOrPrefix: projection.sessionId,
        });
        // Unlike authenticated endpoint reads, this acknowledgement contains
        // a raw child credential. Never expose it to the relay in plain mode.
        if (transport.ok && transport.mode === 'plain') return null;
        rpc = transport.ok && transport.sessionId === projection.sessionId
          ? Object.freeze({
              sessionId: transport.sessionId,
              call: async (rpcInput: Readonly<{
                method: string;
                request: unknown;
                timeoutMs: number;
              }>) => await callResolvedSessionRpc({
                credentials: input.credentials,
                transport,
                ...rpcInput,
              }),
            })
          : null;
      }
      if (!rpc || rpc.sessionId !== projection.sessionId || disposed) return null;
      const requestId = randomUUID();
      const pending: PendingClaim = { projection, claimed: false };
      pendingClaims.set(requestId, pending);
      try {
        const raw = await rpc.call({
          method: MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.OPEN,
          timeoutMs: 20_000,
          request: {
            v: 1,
            requestId,
            route: {
              kind: 'endpointClientEnvironment',
              projection,
              environmentKey: accessInput.environmentKey,
            },
          },
        });
        const materialized = ManagedServiceEndpointReadOpenResultV1Schema
          .parse(raw);
        const environmentKeys = materialized.status === 'clientEnvironment'
          ? Object.keys(materialized.environment)
          : [];
        const current = await resolveCurrent();
        if (
          disposed
          || materialized.status !== 'clientEnvironment'
          || (
            environmentKeys.length > 0
            && (
              environmentKeys.length !== 1
              || environmentKeys[0] !== accessInput.environmentKey
            )
          )
          || pendingClaims.get(requestId) !== pending
          || !pending.claimed
          || current?.projectionToken !== projection.projectionToken
        ) return null;
        return Object.freeze({
          baseUrl: projection.endpoint.baseUrl,
          childEnvironment: Object.freeze(materialized.environment),
          request: async (request) => {
            const latest = await resolveCurrent();
            if (latest?.projectionToken !== projection.projectionToken) {
              throw new Error('Managed server endpoint read owner is unavailable');
            }
            const controller = request.signal
              ? null
              : new AbortController();
            return await readProjection({
              projection,
              resolveCurrentContribution: async () => {
                const candidate = await resolveCurrent();
                if (!candidate) {
                  throw new Error('Managed server endpoint read owner is unavailable');
                }
                return candidate;
              },
              request: { pathAndQuery: request.pathAndQuery },
              signal: request.signal ?? controller!.signal,
            });
          },
        });
      } finally {
        pendingClaims.delete(requestId);
      }
    };

  return Object.freeze({
    bindHost,
    resolveSessionClientAccess,
    claim(request) {
      if (disposed) return false;
      const pending = pendingClaims.get(request.requestId);
      if (
        !pending
        || pending.claimed
        || pending.projection.projectionToken !== request.projectionToken
        || pending.projection.sessionId !== request.sessionId
        || pending.projection.pluginId !== request.pluginId
      ) return false;
      pending.claimed = true;
      return true;
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      pendingClaims.clear();
      const cancels = [...activeCancels.values()];
      disposePromise = Promise.allSettled(
        cancels.map((cancel) => Promise.resolve().then(cancel)),
      ).then(() => undefined);
      return disposePromise;
    },
  });
}
