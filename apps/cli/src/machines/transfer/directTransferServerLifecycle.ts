import type { TransferEndpointCandidate } from '@happier-dev/protocol';

import {
  buildDirectTransferImportSessionEndpointCandidates,
  createDirectPeerTransferRegistry,
  requestDirectPeerTransferToFile,
  startDirectPeerTransferServer,
  type DirectPeerOnDemandTransferScope,
  type PublishedDirectPeerTransfer,
} from './directPeerTransport';
import type { DirectTransferImportOpenRequest } from './directTransferImportSession';
import type { TransferPayloadFileResult } from './transferPayloadFileSink';
import type { TransferPayloadSource } from './transferPayloadSource';

export type DirectTransferListenerClass =
  | 'loopback_http'
  | 'lan_http'
  | 'tailscale_serve_https';

type DirectTransferPublishInput = Readonly<{
  transferId: string;
  payload?: Buffer;
  payloadSource?: TransferPayloadSource;
  onDemandScope?: DirectPeerOnDemandTransferScope;
}>;

export type DirectTransferServerLifecycleState = Readonly<{
  status: 'stopped' | 'starting' | 'running';
  listenerClasses: readonly DirectTransferListenerClass[];
  port?: number;
  publishedTransferCount: number;
}>;

export type DirectTransferServerLifecycle = Readonly<{
  publishTransfer: (input: DirectTransferPublishInput) => PublishedDirectPeerTransfer;
  publishTransferWhenReady: (input: DirectTransferPublishInput) => Promise<PublishedDirectPeerTransfer>;
  prepareImportSession: (input: DirectTransferImportOpenRequest) => Promise<Readonly<{
    uploadId: string;
    destDisplayPath: string;
    expectedSizeBytes: number;
    chunkSizeBytes: number;
    recipientPublicKeyBase64: string;
    expiresAt: number;
    endpointCandidates: readonly TransferEndpointCandidate[];
  }>>;
  requestPayloadFile: (input: Readonly<{
    transferId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
    destinationPath: string;
    openBody?: unknown;
    fetchFn?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
  }>) => Promise<TransferPayloadFileResult>;
  clearPublishedTransfer: (transferId: string) => void;
  stop: () => Promise<void>;
  getState: () => DirectTransferServerLifecycleState;
}>;

type StartDirectPeerTransferServer = typeof startDirectPeerTransferServer;
type CreateDirectPeerTransferRegistry = typeof createDirectPeerTransferRegistry;
type RequestDirectPeerTransferToFile = typeof requestDirectPeerTransferToFile;

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeTailscaleServeHttpsBaseUrl(raw: string): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return stripTrailingSlashes(parsed.toString());
  } catch {
    return null;
  }
}

function joinBaseUrlWithPathPrefix(baseUrl: string, pathname: string): string {
  const normalizedBase = stripTrailingSlashes(baseUrl);
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${normalizedBase}${normalizedPath}`;
}

function appendTailscaleServeEndpointCandidates(params: Readonly<{
  listenerClasses: readonly DirectTransferListenerClass[];
  endpointCandidates: readonly TransferEndpointCandidate[];
  resolveTailscaleServeHttpsBaseUrl?: (() => string | null) | null;
}>): readonly TransferEndpointCandidate[] {
  if (!params.listenerClasses.includes('tailscale_serve_https')) {
    return params.endpointCandidates;
  }
  const baseUrl = normalizeTailscaleServeHttpsBaseUrl(params.resolveTailscaleServeHttpsBaseUrl?.() ?? '');
  if (!baseUrl) {
    return params.endpointCandidates;
  }

  const merged: TransferEndpointCandidate[] = [...params.endpointCandidates];
  for (const candidate of params.endpointCandidates) {
    if (candidate.kind !== 'http') {
      continue;
    }
    let pathname = '';
    try {
      pathname = new URL(candidate.url).pathname;
    } catch {
      continue;
    }
    if (!pathname.startsWith('/machine-transfers/')) {
      continue;
    }
    merged.push({
      ...candidate,
      kind: 'https',
      url: joinBaseUrlWithPathPrefix(baseUrl, pathname),
    });
  }

  // Dedupe exact candidates.
  const seen = new Set<string>();
  return merged.filter((entry) => {
    const key = `${entry.kind}:${entry.url}:${entry.authorizationToken ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createDirectTransferServerLifecycle(params: Readonly<{
  bindPort: number;
  bindHost?: string;
  listenerClasses: readonly DirectTransferListenerClass[];
  advertisedHosts?: readonly string[];
  idleStopMs?: number;
  now?: () => number;
  createRegistry?: CreateDirectPeerTransferRegistry;
  startServer?: StartDirectPeerTransferServer;
  requestPayloadFile?: RequestDirectPeerTransferToFile;
  onStateChange?: (state: DirectTransferServerLifecycleState) => void;
  resolveTailscaleServeHttpsBaseUrl?: (() => string | null) | null;
  promptAssetUpload?: Parameters<StartDirectPeerTransferServer>[0] extends infer T
    ? T extends Readonly<object>
      ? T extends { promptAssetUpload?: infer P }
        ? P
        : never
      : never
    : never;
}>): DirectTransferServerLifecycle {
  const now = params.now ?? Date.now;
  const idleStopMs = Math.max(0, Math.floor(params.idleStopMs ?? 30_000));
  const createRegistry = params.createRegistry ?? createDirectPeerTransferRegistry;
  const startServer = params.startServer ?? startDirectPeerTransferServer;
  const requestPayloadFile = params.requestPayloadFile ?? requestDirectPeerTransferToFile;

  let server: Awaited<ReturnType<StartDirectPeerTransferServer>> | null = null;
  let startPromise: Promise<Awaited<ReturnType<StartDirectPeerTransferServer>>> | null = null;
  let registry: ReturnType<CreateDirectPeerTransferRegistry> = createRegistry({
    advertisedPort: params.bindPort,
    now,
  });
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let shouldStopWhenStarted = false;
  let activeImportSessionCount = 0;

  const hasActivity = (): boolean =>
    registry.hasPublishedTransfers() || activeImportSessionCount > 0;

  const emitState = (status: DirectTransferServerLifecycleState['status']): void => {
    if (!params.onStateChange) {
      return;
    }
    try {
      params.onStateChange({
        status,
        listenerClasses: params.listenerClasses,
        ...(server ? { port: server.port } : {}),
        publishedTransferCount: registry?.countPublishedTransfers?.() ?? 0,
      });
    } catch {
      // Best-effort only; lifecycle observers must never break transfer request handling.
    }
  };

  const clearIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const stopServerBestEffort = async (): Promise<void> => {
    clearIdleTimer();
    shouldStopWhenStarted = false;
    const currentServer = server;
    server = null;
    emitState('stopped');
    if (!currentServer) {
      return;
    }
    await currentServer.stop();
  };

  const maybeScheduleIdleStop = (): void => {
    if (hasActivity()) {
      return;
    }
    clearIdleTimer();
    if (!server) {
      shouldStopWhenStarted = true;
      void ensureServerStarted().catch(() => undefined);
      return;
    }
    if (idleStopMs === 0) {
      void stopServerBestEffort();
      return;
    }
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void stopServerBestEffort();
    }, idleStopMs);
  };

  const ensureServerStarted = async (): Promise<Awaited<ReturnType<StartDirectPeerTransferServer>>> => {
    if (server) {
      return server;
    }
    if (startPromise) {
      return await startPromise;
    }
    startPromise = (async () => {
      emitState('starting');
      const started = await startServer({
        readPublishedTransfer: (input) => registry?.readPublishedTransfer(input) ?? null,
        ...(typeof params.bindPort === 'number' && params.bindPort > 0
          ? { bindPort: params.bindPort }
          : {}),
        ...(typeof params.bindHost === 'string' && params.bindHost.length > 0
          ? { bindHost: params.bindHost }
          : {}),
        resolveOnDemandTransfer: async (input) => registry?.resolveOnDemandTransferOnOpen(input) ?? null,
        ...(params.promptAssetUpload ? { promptAssetUpload: params.promptAssetUpload } : {}),
        onImportSessionCountChanged: (count) => {
          activeImportSessionCount = count;
          if (count > 0) {
            clearIdleTimer();
          } else {
            maybeScheduleIdleStop();
          }
          emitState(server ? 'running' : 'starting');
        },
      });
      server = started;
      if (!registry) {
        registry = createRegistry({
          advertisedPort: started.port,
          now,
        });
      }
      emitState('running');
      if (shouldStopWhenStarted && !registry.hasPublishedTransfers()) {
        shouldStopWhenStarted = false;
        await started.stop().catch(() => undefined);
        server = null;
        emitState('stopped');
      }
      return started;
    })();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  };

  return {
    publishTransfer(input) {
      clearIdleTimer();
      if (!server && !startPromise) {
        void ensureServerStarted().catch(() => undefined);
      }
      const published = registry.publishTransfer(input);
      emitState('running');
      return {
        ...published,
        endpointCandidates: appendTailscaleServeEndpointCandidates({
          listenerClasses: params.listenerClasses,
          endpointCandidates: published.endpointCandidates,
          resolveTailscaleServeHttpsBaseUrl: params.resolveTailscaleServeHttpsBaseUrl,
        }),
      };
    },
    publishTransferWhenReady: async (input) => {
      clearIdleTimer();
      await ensureServerStarted();
      const published = registry.publishTransfer(input);
      emitState('running');
      return {
        ...published,
        endpointCandidates: appendTailscaleServeEndpointCandidates({
          listenerClasses: params.listenerClasses,
          endpointCandidates: published.endpointCandidates,
          resolveTailscaleServeHttpsBaseUrl: params.resolveTailscaleServeHttpsBaseUrl,
        }),
      };
    },
    prepareImportSession: async (input) => {
      clearIdleTimer();
      const started = await ensureServerStarted();
      const prepared = await started.openTrustedImportSession(input);
      if (!prepared.success) {
        throw new Error(prepared.error);
      }
      emitState('running');
      const endpointCandidates = appendTailscaleServeEndpointCandidates({
        listenerClasses: params.listenerClasses,
        endpointCandidates: buildDirectTransferImportSessionEndpointCandidates({
          advertisedPort: started.port,
          uploadId: prepared.response.uploadId,
          expiresAt: prepared.response.expiresAt,
          advertisedHosts: params.advertisedHosts,
        }),
        resolveTailscaleServeHttpsBaseUrl: params.resolveTailscaleServeHttpsBaseUrl,
      });
      return {
        ...prepared.response,
        endpointCandidates,
      };
    },
    requestPayloadFile: async (input) => await requestPayloadFile(input),
    clearPublishedTransfer: (transferId) => {
      registry?.clearPublishedTransfer(transferId);
      maybeScheduleIdleStop();
      emitState(server ? 'running' : 'stopped');
    },
    stop: stopServerBestEffort,
    getState: () => ({
      status: startPromise ? 'starting' : server ? 'running' : 'stopped',
      listenerClasses: params.listenerClasses,
      ...(server ? { port: server.port } : {}),
      publishedTransferCount: registry?.countPublishedTransfers?.() ?? 0,
    }),
  };
}
