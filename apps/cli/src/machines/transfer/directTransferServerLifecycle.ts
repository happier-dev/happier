import type { TransferEndpointCandidate } from '@happier-dev/protocol';

import {
  buildDirectPeerTransferEndpointPath,
  buildDirectTransferImportSessionEndpointCandidates,
  buildDirectTransferImportSessionEndpointPath,
  createDirectPeerTransferRegistry,
  filterDirectTransferEndpointCandidatesForAdvertisement,
  requestDirectPeerTransferToFile,
  startDirectPeerTransferServer,
  type DirectPeerOnDemandTransferScope,
  type PublishedDirectPeerTransfer,
  type PreparedFilesystemExportSettlement,
} from './directPeerTransport';
import type { DirectTransferImportOpenRequest, PreparedImportTransferSettlement } from './directTransferImportSession';
import type { PreparedFilesystemTransferScope } from './preparedFilesystemTransferScope';
import type { TransferPayloadFileResult } from './transferPayloadFileSink';
import type { TransferPayloadSource } from './transferPayloadSource';
import { resolveDirectPeerTransferBindHost } from './transferRuntimeConfig';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { ComposerMediaStageUploadTargetDeps } from '@/transfers/targets/resolveComposerMediaStageUploadTarget';
import type { TransferUploadInitAttachmentDeps } from '@/transfers/targets/resolveTransferUploadInitTarget';
import type { LiveWorkProducerV1, LiveWorkInventoryV1, LiveWorkItemV1 } from '@/daemon/lifecycle/managedActivity';

export type DirectTransferListenerClass =
  | 'loopback_http'
  | 'tailscale_serve_https';

type DirectTransferPublishInput = Readonly<{
  transferId: string;
  payload?: Buffer;
  payloadSource?: TransferPayloadSource;
  onDemandScope?: DirectPeerOnDemandTransferScope;
  filesystemScope?: PreparedFilesystemTransferScope;
}>;

export type DirectTransferServerLifecycleState = Readonly<{
  status: 'stopped' | 'starting' | 'running';
  listenerClasses: readonly DirectTransferListenerClass[];
  port?: number;
  publishedTransferCount: number;
}>;

export type DirectTransferServerLifecycle = Readonly<{
  activity: LiveWorkProducerV1;
  /** Starts/reuses the canonical loopback listener and returns its actual bound port. */
  ensureListening: () => Promise<number>;
  publishTransfer: (input: DirectTransferPublishInput) => PublishedDirectPeerTransfer;
  publishTransferWhenReady: (input: DirectTransferPublishInput) => Promise<PublishedDirectPeerTransfer>;
  prepareImportSession: (input: DirectTransferImportOpenRequest, filesystemScope?: PreparedFilesystemTransferScope, privateStagingDirectory?: string) => Promise<Readonly<{
    uploadId: string;
    destDisplayPath: string;
    expectedSizeBytes: number;
    chunkSizeBytes: number;
    recipientPublicKeyBase64: string;
    expiresAt: number;
    endpointCandidates: readonly TransferEndpointCandidate[];
  }>>;
  abortImportSession: (
    input: Readonly<{ uploadId: string }>,
    filesystemScope?: PreparedFilesystemTransferScope | null,
  ) => Promise<void | Readonly<{ aborted: boolean }>>;
  waitForImportTransferSettlement: (uploadId: string, filesystemScope: PreparedFilesystemTransferScope) => Promise<PreparedImportTransferSettlement>;
  requestPayloadFile: (input: Readonly<{
    transferId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
    destinationPath: string;
    expectedSizeBytes?: number;
    expectedManifestHash?: string;
    openBody?: unknown;
    fetchFn?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }>) => Promise<TransferPayloadFileResult>;
  clearPublishedTransfer: (transferId: string, filesystemScope?: PreparedFilesystemTransferScope | null) => boolean;
  waitForFilesystemExportSettlement: (transferId: string, filesystemScope: PreparedFilesystemTransferScope) => Promise<PreparedFilesystemExportSettlement>;
  stop: () => Promise<void>;
  getState: () => DirectTransferServerLifecycleState;
}>;

type RunningDirectPeerTransferServer = Awaited<ReturnType<typeof startDirectPeerTransferServer>>;
type StartDirectPeerTransferServer = (
  params: Parameters<typeof startDirectPeerTransferServer>[0],
) => Promise<
  Omit<RunningDirectPeerTransferServer, 'cleanupExpiredImportSessions' | 'getNextImportSessionExpiryAt' | 'activity' | 'releasePublishedTransferHandles'>
  & Partial<Pick<RunningDirectPeerTransferServer, 'cleanupExpiredImportSessions' | 'getNextImportSessionExpiryAt' | 'activity' | 'releasePublishedTransferHandles'>>
>;
type DirectPeerTransferRegistry = ReturnType<typeof createDirectPeerTransferRegistry>;
type CreateDirectPeerTransferRegistry = (
  params: Parameters<typeof createDirectPeerTransferRegistry>[0],
) =>
  Omit<DirectPeerTransferRegistry, 'cleanupExpiredPublishedTransfers' | 'getNextPublishedTransferExpiryAt' | 'activity' | 'retainPayloadFileRequest'>
  & Partial<Pick<DirectPeerTransferRegistry, 'cleanupExpiredPublishedTransfers' | 'getNextPublishedTransferExpiryAt' | 'activity' | 'retainPayloadFileRequest'>>;
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

function resolveAdvertisedEndpointCandidates(params: Readonly<{
  listenerClasses: readonly DirectTransferListenerClass[];
  endpointCandidates: readonly TransferEndpointCandidate[];
  canonicalPathname: string;
  expiresAt: number;
  authorizationToken?: string;
  resolveTailscaleServeHttpsBaseUrl?: (() => string | null) | null;
}>): readonly TransferEndpointCandidate[] {
  const merged: TransferEndpointCandidate[] = [...params.endpointCandidates];
  const baseUrl = params.listenerClasses.includes('tailscale_serve_https')
    ? normalizeTailscaleServeHttpsBaseUrl(params.resolveTailscaleServeHttpsBaseUrl?.() ?? '')
    : null;
  if (baseUrl && params.canonicalPathname.startsWith('/machine-transfers/')) {
    merged.push({
      kind: 'https',
      url: joinBaseUrlWithPathPrefix(baseUrl, params.canonicalPathname),
      ...(params.authorizationToken ? { authorizationToken: params.authorizationToken } : {}),
      expiresAt: params.expiresAt,
    });
  }

  // Dedupe exact candidates.
  const seen = new Set<string>();
  return filterDirectTransferEndpointCandidatesForAdvertisement(merged.filter((entry) => {
    const key = `${entry.kind}:${entry.url}:${entry.authorizationToken ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

export function createDirectTransferServerLifecycle(params: Readonly<{
  admissionDrain?: Parameters<StartDirectPeerTransferServer>[0]['admissionDrain'];
  attachmentUpload?: TransferUploadInitAttachmentDeps;
  bindPort: number;
  bindHost?: string;
  accessPolicy?: FilesystemAccessPolicy;
  listenerClasses: readonly DirectTransferListenerClass[];
  advertisedHosts?: readonly string[];
  idleStopMs?: number;
  now?: () => number;
  createRegistry?: CreateDirectPeerTransferRegistry;
  startServer?: StartDirectPeerTransferServer;
  requestPayloadFile?: RequestDirectPeerTransferToFile;
  onStateChange?: (state: DirectTransferServerLifecycleState) => void | Promise<void>;
  resolveTailscaleServeHttpsBaseUrl?: (() => string | null) | null;
  composerMediaStage?: ComposerMediaStageUploadTargetDeps;
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
  const bindHost = resolveDirectPeerTransferBindHost(params.bindHost);
  // These hosts are endpoint-candidate inputs, not listener-bind configuration. Preserve an
  // explicit list so the candidate safety owner rejects nonloopback HTTP instead of silently
  // rewriting a remote candidate to this process's loopback listener.
  const advertisedHosts = params.advertisedHosts && params.advertisedHosts.length > 0
    ? params.advertisedHosts
    : [bindHost];
  const listenerClasses: readonly DirectTransferListenerClass[] = [
    'loopback_http',
    ...(params.listenerClasses.includes('tailscale_serve_https')
      ? ['tailscale_serve_https' as const]
      : []),
  ];

  let server: Awaited<ReturnType<StartDirectPeerTransferServer>> | null = null;
  let startPromise: Promise<Awaited<ReturnType<StartDirectPeerTransferServer>>> | null = null;
  let registry!: ReturnType<CreateDirectPeerTransferRegistry>;
  let lifecycleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleDeadlineAt: number | null = null;
  let shouldStopWhenStarted = false;
  let activeImportSessionCount = 0;
  let serverStopInProgress = false;
  let terminalStopped = false;
  let terminalStopPromise: Promise<void> | null = null;
  const stoppedServers = new WeakSet<object>();
  const inFlightServerStops = new WeakMap<object, Promise<void>>();
  const pendingServerStops = new Set<Promise<void>>();
  const activityListeners = new Set<() => void>();
  const notifyActivity = (): void => {
    for (const listener of activityListeners) {
      try { listener(); } catch { /* Observation cannot change listener custody. */ }
    }
  };

  const hasActivity = (): boolean =>
    registry.hasPublishedTransfers() || activeImportSessionCount > 0;

  const emitState = async (status: DirectTransferServerLifecycleState['status']): Promise<void> => {
    notifyActivity();
    if (!params.onStateChange) {
      return;
    }
    try {
      await params.onStateChange({
        status,
        listenerClasses,
        ...(server ? { port: server.port } : {}),
        publishedTransferCount: registry?.countPublishedTransfers?.() ?? 0,
      });
    } catch {
      // Best-effort only; lifecycle observers must never break transfer request handling.
    }
  };

  const clearLifecycleTimer = (): void => {
    if (lifecycleTimer) {
      clearTimeout(lifecycleTimer);
      lifecycleTimer = null;
    }
  };

  const stopServerOnce = (
    target: Awaited<ReturnType<StartDirectPeerTransferServer>>,
  ): Promise<void> => {
    if (stoppedServers.has(target)) {
      return Promise.resolve();
    }
    // Concurrent cleanup shares one attempt, but the stopped marker is only
    // written after the listener actually stopped: a rejected stop leaves the
    // listener owned here so a later idle stop or disposal retries it.
    const inFlight = inFlightServerStops.get(target);
    if (inFlight) {
      return inFlight;
    }
    const stopping = target.stop().then(() => {
      stoppedServers.add(target);
    }).finally(() => {
      inFlightServerStops.delete(target);
      pendingServerStops.delete(stopping);
      notifyActivity();
    });
    inFlightServerStops.set(target, stopping);
    pendingServerStops.add(stopping);
    notifyActivity();
    return stopping;
  };

  const stopServerBestEffort = async (): Promise<void> => {
    clearLifecycleTimer();
    idleDeadlineAt = null;
    shouldStopWhenStarted = false;
    const currentServer = server;
    if (!currentServer) {
      void emitState('stopped');
      return;
    }
    serverStopInProgress = true;
    try {
      await stopServerOnce(currentServer);
      if (server === currentServer) {
        server = null;
      }
      void emitState('stopped');
    } catch {
      // The listener is still live. Keep owning it so the next idle stop or
      // terminal disposal retries instead of leaking a second owner.
    } finally {
      serverStopInProgress = false;
      if (!terminalStopped && hasActivity()) {
        scheduleLifecycleTimer();
      }
    }
  };

  const scheduleLifecycleTimer = (): void => {
    clearLifecycleTimer();
    if (terminalStopped || serverStopInProgress) {
      return;
    }

    const nowMs = now();
    const currentlyActive = hasActivity();
    if (currentlyActive) {
      idleDeadlineAt = null;
      shouldStopWhenStarted = false;
    } else if (idleDeadlineAt === null) {
      idleDeadlineAt = nowMs + idleStopMs;
    }

    if (!currentlyActive && !server) {
      // Outgoing custody is observable without an incoming listener. Only
      // dispose a listener whose startup is already owned by a publication.
      shouldStopWhenStarted = startPromise !== null;
      return;
    }

    const publicationExpiryAt = registry.getNextPublishedTransferExpiryAt?.() ?? null;
    const importExpiryAt = server?.getNextImportSessionExpiryAt?.() ?? null;
    let nextDeadlineAt = publicationExpiryAt;
    if (importExpiryAt !== null) {
      nextDeadlineAt = nextDeadlineAt === null
        ? importExpiryAt
        : Math.min(nextDeadlineAt, importExpiryAt);
    }
    if (idleDeadlineAt !== null) {
      nextDeadlineAt = nextDeadlineAt === null
        ? idleDeadlineAt
        : Math.min(nextDeadlineAt, idleDeadlineAt);
    }
    if (nextDeadlineAt === null) {
      return;
    }

    const delayMs = Math.min(2_147_483_647, Math.max(0, nextDeadlineAt - nowMs));
    // Activity inspection may synchronously publish an expiry change and re-enter this scheduler.
    // Clear the nested timer before this scheduling pass installs the authoritative handle.
    clearLifecycleTimer();
    lifecycleTimer = setTimeout(() => {
      lifecycleTimer = null;
      const deadlineNow = now();
      registry.cleanupExpiredPublishedTransfers?.(deadlineNow);
      server?.cleanupExpiredImportSessions?.(deadlineNow);
      if (!hasActivity() && idleDeadlineAt !== null && idleDeadlineAt <= deadlineNow) {
        void stopServerBestEffort();
        return;
      }
      scheduleLifecycleTimer();
    }, delayMs);
    lifecycleTimer.unref?.();
  };

  registry = createRegistry({
    advertisedPort: params.bindPort,
    now,
    beforeDisposePayloadSource: async transferToken => { await server?.releasePublishedTransferHandles?.(transferToken); },
    onPublishedTransfersChanged: () => {
      scheduleLifecycleTimer();
      void emitState(server ? 'running' : startPromise ? 'starting' : 'stopped');
    },
  });

  const ensureServerStarted = async (): Promise<Awaited<ReturnType<StartDirectPeerTransferServer>>> => {
    if (terminalStopped) {
      throw new Error('Direct transfer server lifecycle is stopped');
    }
    if (startPromise) {
      return await startPromise;
    }
    if (server) {
      return server;
    }
    startPromise = (async () => {
      void emitState('starting');
      const started = await startServer({
        admissionDrain: params.admissionDrain,
        ...(params.attachmentUpload ? { attachmentUpload: params.attachmentUpload } : {}),
        readPublishedTransfer: (input) => registry?.readPublishedTransfer(input) ?? null,
        completeFilesystemExport: (input) => registry.completeFilesystemExport(input),
        ...(typeof params.bindPort === 'number' && params.bindPort > 0
          ? { bindPort: params.bindPort }
          : {}),
        bindHost,
        resolveOnDemandTransfer: async (input) => registry?.resolveOnDemandTransferOnOpen(input) ?? null,
        accessPolicy: params.accessPolicy,
        ...(params.composerMediaStage ? { composerMediaStage: params.composerMediaStage } : {}),
        ...(params.promptAssetUpload ? { promptAssetUpload: params.promptAssetUpload } : {}),
        onImportSessionCountChanged: (count) => {
          activeImportSessionCount = count;
          scheduleLifecycleTimer();
          void emitState(server ? 'running' : 'starting');
        },
        onImportSessionActivity: () => { scheduleLifecycleTimer(); notifyActivity(); },
      });
      if (terminalStopped) {
        return started;
      }
      server = started;
      if (!registry) {
        registry = createRegistry({
          advertisedPort: started.port,
          now,
        });
      }
      await emitState('running');
      scheduleLifecycleTimer();
      if (shouldStopWhenStarted && !registry.hasPublishedTransfers()) {
        shouldStopWhenStarted = false;
        try {
          await stopServerOnce(started);
          if (server === started) {
            server = null;
          }
          void emitState('stopped');
        } catch {
          // Retain the started listener so a later stop can retry it.
        }
      }
      return started;
    })();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
      notifyActivity();
    }
  };

  const activity: LiveWorkProducerV1 = Object.freeze({
    async read(): Promise<Omit<LiveWorkInventoryV1, 'idleSince'>> {
      const published = registry.activity ? await registry.activity.read() : { items: [], coverage: 'unknown' as const };
      const receiving = server?.activity ? await server.activity.read()
        : { items: [], coverage: server ? 'unknown' as const : 'complete' as const };
      const items: LiveWorkItemV1[] = [...published.items, ...receiving.items,
        ...[...(startPromise ? [startPromise] : []), ...pendingServerStops].map(ownerRef => ({
          category: 'transfer' as const, ownerRef, attribution: { kind: 'unknown' as const }, state: 'active' as const,
        }))];
      return { items, coverage: published.coverage === 'unknown' || receiving.coverage === 'unknown' ? 'unknown' : 'complete' };
    },
    subscribe(listener: () => void): () => void {
      activityListeners.add(listener);
      return () => { activityListeners.delete(listener); };
    },
  });
  return {
    activity,
    ensureListening: async () => (await ensureServerStarted()).port,
    publishTransfer(input) {
      if (terminalStopped) {
        throw new Error('Direct transfer server lifecycle is stopped');
      }
      clearLifecycleTimer();
      idleDeadlineAt = null;
      if (!server && !startPromise) {
        void ensureServerStarted().catch(() => undefined);
      }
      const published = registry.publishTransfer(input);
      scheduleLifecycleTimer();
      void emitState('running');
      return {
        ...published,
        endpointCandidates: resolveAdvertisedEndpointCandidates({
          listenerClasses,
          endpointCandidates: published.endpointCandidates,
          canonicalPathname: buildDirectPeerTransferEndpointPath(published.transferId),
          authorizationToken: published.transferToken,
          expiresAt: published.expiresAt,
          resolveTailscaleServeHttpsBaseUrl: params.resolveTailscaleServeHttpsBaseUrl,
        }),
      };
    },
    publishTransferWhenReady: async (input) => {
      if (terminalStopped) {
        throw new Error('Direct transfer server lifecycle is stopped');
      }
      clearLifecycleTimer();
      idleDeadlineAt = null;
      await ensureServerStarted();
      if (terminalStopped) {
        throw new Error('Direct transfer server lifecycle is stopped');
      }
      const published = registry.publishTransfer(input);
      scheduleLifecycleTimer();
      void emitState('running');
      return {
        ...published,
        endpointCandidates: resolveAdvertisedEndpointCandidates({
          listenerClasses,
          endpointCandidates: published.endpointCandidates,
          canonicalPathname: buildDirectPeerTransferEndpointPath(published.transferId),
          authorizationToken: published.transferToken,
          expiresAt: published.expiresAt,
          resolveTailscaleServeHttpsBaseUrl: params.resolveTailscaleServeHttpsBaseUrl,
        }),
      };
    },
    prepareImportSession: async (input, filesystemScope, privateStagingDirectory) => {
      if (terminalStopped) {
        throw new Error('Direct transfer server lifecycle is stopped');
      }
      clearLifecycleTimer();
      idleDeadlineAt = null;
      const started = await ensureServerStarted();
      if (terminalStopped) {
        throw new Error('Direct transfer server lifecycle is stopped');
      }
      const prepared = await started.openTrustedImportSession(input, filesystemScope, privateStagingDirectory);
      if (!prepared.success) {
        throw new Error(prepared.error);
      }
      void emitState('running');
      scheduleLifecycleTimer();
      const endpointCandidates = resolveAdvertisedEndpointCandidates({
        listenerClasses,
        endpointCandidates: buildDirectTransferImportSessionEndpointCandidates({
          advertisedPort: started.port,
          uploadId: prepared.response.uploadId,
          expiresAt: prepared.response.expiresAt,
          advertisedHosts,
        }),
        canonicalPathname: buildDirectTransferImportSessionEndpointPath(prepared.response.uploadId),
        expiresAt: prepared.response.expiresAt,
        resolveTailscaleServeHttpsBaseUrl: params.resolveTailscaleServeHttpsBaseUrl,
      });
      return {
        ...prepared.response,
        endpointCandidates,
      };
    },
    abortImportSession: async (input, filesystemScope) => {
      if (terminalStopped) {
        return { aborted: false };
      }
      const started = server ?? (startPromise ? await startPromise : null);
      if (!started) {
        return { aborted: false };
      }
      const result = await started.abortImportTransferSession(input, filesystemScope);
      scheduleLifecycleTimer();
      void emitState(server ? 'running' : 'stopped');
      return result;
    },
    requestPayloadFile: async (input) => {
      if (terminalStopped) throw new Error('Direct transfer server lifecycle is stopped');
      const request = requestPayloadFile(input);
      return registry.retainPayloadFileRequest ? await registry.retainPayloadFileRequest(request) : await request;
    },
    waitForImportTransferSettlement: async (uploadId, filesystemScope) => {
      const started = server ?? (startPromise ? await startPromise : null);
      if (!started) return { success: false, error: 'Prepared import transfer owner is unavailable', errorCode: 'indeterminate' };
      return await started.waitForImportTransferSettlement(uploadId, filesystemScope);
    },
    clearPublishedTransfer: (transferId, filesystemScope) => {
      const changed = registry.clearPublishedTransfer(transferId, filesystemScope);
      scheduleLifecycleTimer();
      void emitState(server ? 'running' : 'stopped');
      return changed;
    },
    waitForFilesystemExportSettlement: (transferId, filesystemScope) => registry.waitForFilesystemExportSettlement(transferId, filesystemScope),
    stop: () => {
      if (terminalStopPromise) {
        return terminalStopPromise;
      }

      terminalStopped = true;
      clearLifecycleTimer();
      idleDeadlineAt = null;
      shouldStopWhenStarted = false;
      const pendingStart = startPromise;

      const running = (async () => {
        const registryDisposal = registry.dispose();
        const serversToStop = new Set<Awaited<ReturnType<StartDirectPeerTransferServer>>>();
        const currentServer = server;
        if (currentServer) {
          serversToStop.add(currentServer);
        }
        if (pendingStart) {
          try {
            serversToStop.add(await pendingStart);
          } catch {
            // A failed listener start owns no live server resource.
          }
        }
        let listenerStopError: unknown = null;
        for (const started of serversToStop) {
          try {
            await stopServerOnce(started);
          } catch (error) {
            listenerStopError ??= error;
          }
        }
        const settledServerStops = await Promise.allSettled([...pendingServerStops]);
        for (const result of settledServerStops) {
          if (result.status === 'rejected') {
            listenerStopError ??= result.reason;
          }
        }
        await registryDisposal;
        if (listenerStopError) {
          // Ownership of the still-live listener stays here; only the disposal
          // attempt failed, and `terminalStopped` keeps refusing new work.
          throw listenerStopError;
        }
        if (server && stoppedServers.has(server)) {
          server = null;
        }
        void emitState('stopped');
      })();

      terminalStopPromise = running.catch((error: unknown) => {
        // A failed disposal remains retryable through a later stop; new work
        // stays refused because the lifecycle is already terminal.
        terminalStopPromise = null;
        throw error;
      });
      return terminalStopPromise;
    },
    getState: () => ({
      status: terminalStopped ? 'stopped' : startPromise ? 'starting' : server ? 'running' : 'stopped',
      listenerClasses,
      ...(server ? { port: server.port } : {}),
      publishedTransferCount: registry?.countPublishedTransfers?.() ?? 0,
    }),
  };
}
