import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import * as fsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { LiveWorkProducerV1, LiveWorkInventoryV1, LiveWorkItemV1 } from '@/daemon/lifecycle/managedActivity';
import type { TransferPayloadFileResult } from './transferPayloadFileSink';

import fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { DIRECT_TRANSFER_SESSION_EXPIRES_AT_HEADER, isSafeDirectTransferEndpointCandidate } from '@happier-dev/protocol/machines/transfer/directPeerUrls';
import { TransferChunkEnvelopeSchema } from '@happier-dev/protocol/machines/transfer/transferStream';
import type { TransferEndpointCandidate } from '@happier-dev/protocol';
import { z } from 'zod';
import {
  createEncryptedTransferChunkEnvelope,
  createTransferManifestHash,
  parseTransferRecipientPublicKeyBase64,
  resolveEncryptedTransferChunkJsonBodyMaxBytes,
} from '@happier-dev/transfers/node';
import {
  resolveDirectPeerAdvertisedHosts,
  resolveDirectPeerTransferBindHost,
  resolveDirectPeerTransferBindPort,
  resolveDirectPeerTransferChunkBytes,
  resolveDirectPeerTransferOpenBodyMaxBytes,
  resolveDirectPeerTransferPublishedTransferRegistryMaxEntries,
  resolveDirectPeerTransferTtlMs,
} from './transferRuntimeConfig';
import {
  createBufferTransferPayloadSource,
  readTransferPayloadChunk,
  resolveTransferPayloadManifestHash,
  resolveTransferPayloadSizeBytes,
  disposeTransferPayloadSource,
  type TransferPayloadSource,
} from './transferPayloadSource';
import { IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR, resolveInMemoryTransferMaxBytes } from './inMemoryTransferSizeLimit';
import { clampTransferChunkBytes } from '@happier-dev/transfers/node';
import {
  decodeDirectPeerTransferPathKey,
  DIRECT_PEER_AUTH_TOKEN_HARD_MAX_CHARS,
  DIRECT_PEER_RECIPIENT_PUBLIC_KEY_BASE64_HARD_MAX_CHARS,
  DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER,
  encodeDirectPeerTransferPathKey,
  formatCandidateHost,
  hashTransferToken,
  readDirectPeerAuthorizationToken,
} from './directPeerTransport/protocol';
export {
  isDirectPeerTransferProtocolError,
  requestDirectPeerTransferToFile,
} from './directPeerTransport/requestTransfer';

import {
  createDirectTransferImportSessionManager,
  type DirectTransferImportOpenRequest,
  type DirectTransferImportOpenResponse,
  type DirectTransferImportSessionManager,
  type PreparedImportTransferSettlement,
} from './directTransferImportSession';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { DirectTransferImportOpenRequestSchema } from './directTransferImportOpenRequest';
import type { ComposerMediaStageUploadTargetDeps } from '@/transfers/targets/resolveComposerMediaStageUploadTarget';
import type { TransferUploadInitAttachmentDeps } from '@/transfers/targets/resolveTransferUploadInitTarget';
import type { WorkspaceFinalizeFileOperationsFactory } from '@/transfers/targets/resolveWorkspaceFileUploadTarget';
import { TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE } from '@happier-dev/transfers/node';
import { assertPreparedFilesystemTransferScope, type PreparedFilesystemTransferScope } from './preparedFilesystemTransferScope';

// Direct-peer transfers are used for session handoff and finite workspace transfers, which can take
// significantly longer than 30s on large repos/slow disks/VMs (host <-> Lima). Keep the default
// TTL long enough that long-running transfers don't fail mid-flight. Still configurable via env.
const DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_FULL_ERROR = 'Direct peer published transfer registry is full';
// /open responses should be tiny (transferId + sha256 + totalChunks). Hard-cap to keep JSON buffering
// bounded even if a hostile peer sends a huge body with a misleading content-length.
const DIRECT_TRANSFER_CORS_ALLOW_METHODS = 'GET,POST,PUT,OPTIONS';
const DIRECT_TRANSFER_CORS_ALLOW_HEADERS = [
  'authorization',
  'content-type',
  DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER,
].join(',');

function readAdvertisedHosts(networkInterfacesFn: typeof networkInterfaces): string[] {
  return resolveDirectPeerAdvertisedHosts(networkInterfacesFn);
}

function readDirectPeerTtlMs(): number {
  return resolveDirectPeerTransferTtlMs();
}

function readDirectPeerBindPort(): number {
  return resolveDirectPeerTransferBindPort();
}

function readDirectPeerChunkBytes(): number {
  return resolveDirectPeerTransferChunkBytes();
}

function readDirectPeerOpenBodyMaxBytes(): number {
  return resolveDirectPeerTransferOpenBodyMaxBytes();
}

function readDirectPeerPublishedTransferRegistryMaxEntries(): number {
  return resolveDirectPeerTransferPublishedTransferRegistryMaxEntries();
}

export type PublishedDirectPeerTransfer = Readonly<{
  transferId: string;
  transferToken: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  expiresAt: number;
}>;

type PublishDirectPeerTransferInput = Readonly<{
  transferId: string;
  payload?: Buffer;
  payloadSource?: TransferPayloadSource;
  onDemandScope?: DirectPeerOnDemandTransferScope;
  filesystemScope?: PreparedFilesystemTransferScope;
}>;

type StoredPublishedTransfer = Readonly<{
  transferToken: string;
  transferTokenDigest: Buffer;
  expiresAt: number;
  payloadSource: TransferPayloadSource;
  filesystemScope?: PreparedFilesystemTransferScope;
  filesystemSettlement?: Readonly<{
    result: Promise<PreparedFilesystemExportSettlement>;
    settle: (result: PreparedFilesystemExportSettlement) => void;
  }>;
}>;

export type PreparedFilesystemExportSettlement = Readonly<
  | { success: true; sizeBytes: number; manifestHash: string }
  | { success: false; error: string; errorCode?: string }
>;

export type PreparedFilesystemExportOutcome = Readonly<{ destinationId: string }> & Readonly<
  | { success: true; sizeBytes: number; manifestHash: string }
  | { success: false; error: string; errorCode?: string }
>;

export type DirectPeerOnDemandTransferScope = Readonly<{
  allowTransferId: (transferId: string) => boolean;
  resolvePayloadSourceOnOpen: (input: Readonly<{
    transferId: string;
    requestBody: unknown;
  }>) => Promise<TransferPayloadSource>;
  maxResolvedTransfers?: number;
}>;

export function filterDirectTransferEndpointCandidatesForAdvertisement(
  endpointCandidates: readonly TransferEndpointCandidate[],
): readonly TransferEndpointCandidate[] {
  return endpointCandidates.filter(isSafeDirectTransferEndpointCandidate);
}

export function buildDirectPeerTransferEndpointPath(transferId: string): string {
  return `/machine-transfers/direct/${encodeDirectPeerTransferPathKey(transferId)}`;
}

export function buildDirectTransferImportSessionEndpointPath(uploadId: string): string {
  return `/machine-transfers/direct/imports/${encodeURIComponent(uploadId)}`;
}

export function buildDirectTransferImportOpenEndpointCandidates(params: Readonly<{
  advertisedPort: number;
  authorizationToken: string;
  expiresAt: number;
  advertisedHosts?: readonly string[];
}>): readonly TransferEndpointCandidate[] {
  const resolvedHosts = params.advertisedHosts && params.advertisedHosts.length > 0
    ? [...params.advertisedHosts]
    : readAdvertisedHosts(networkInterfaces);

  return filterDirectTransferEndpointCandidatesForAdvertisement(resolvedHosts
    .map((host) => ({
      kind: 'http' as const,
      url: `http://${formatCandidateHost(host)}:${params.advertisedPort}/machine-transfers/direct/imports/open`,
      authorizationToken: params.authorizationToken,
      expiresAt: params.expiresAt,
    }))
    .filter(
      (candidate, index, all) =>
        all.findIndex(
          (entry) =>
            entry.url === candidate.url
            && entry.authorizationToken === candidate.authorizationToken,
        ) === index,
    ));
}

export function buildDirectTransferImportSessionEndpointCandidates(params: Readonly<{
  advertisedPort: number;
  uploadId: string;
  expiresAt: number;
  advertisedHosts?: readonly string[];
}>): readonly TransferEndpointCandidate[] {
  const resolvedHosts = params.advertisedHosts && params.advertisedHosts.length > 0
    ? [...params.advertisedHosts]
    : readAdvertisedHosts(networkInterfaces);
  const endpointPath = buildDirectTransferImportSessionEndpointPath(params.uploadId);

  return filterDirectTransferEndpointCandidatesForAdvertisement(resolvedHosts
    .map((host) => ({
      kind: 'http' as const,
      url: `http://${formatCandidateHost(host)}:${params.advertisedPort}${endpointPath}`,
      expiresAt: params.expiresAt,
    }))
    .filter(
      (candidate, index, all) =>
        all.findIndex((entry) => entry.url === candidate.url) === index,
    ));
}

type StoredOnDemandScope = Readonly<{
  expiresAt: number;
  allowTransferId: (transferId: string) => boolean;
  resolvePayloadSourceOnOpen: DirectPeerOnDemandTransferScope['resolvePayloadSourceOnOpen'];
  maxResolvedTransfers: number;
  resolvedTransferIds: Set<string>;
}>;

export function createDirectPeerTransferRegistry(params: Readonly<{
  advertisedPort: number;
  now?: () => number;
  networkInterfacesFn?: typeof networkInterfaces;
  onPublishedTransfersChanged?: () => void;
  beforeDisposePayloadSource?: (transferToken: string) => Promise<void>;
}>) {
  const now = params.now ?? Date.now;
  const networkInterfacesFn = params.networkInterfacesFn ?? networkInterfaces;
  const publishedTransfers = new Map<string, StoredPublishedTransfer>();
  const onDemandScopesByToken = new Map<string, StoredOnDemandScope>();
  const inFlightOnDemandTransfers = new Map<string | Promise<TransferPayloadFileResult>,
    Readonly<{ kind: 'source'; request: Promise<TransferPayloadSource | null> }>
    | Readonly<{ kind: 'download'; request: Promise<TransferPayloadFileResult> }>>();
  const activityListeners = new Set<() => void>();
  const disposedPayloadSources = new WeakSet<object>();
  const pendingPayloadDisposals = new Set<Promise<void>>();
  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  const disposePayloadSourceOnce = (source: TransferPayloadSource, transferToken?: string): Promise<void> => {
    if (disposedPayloadSources.has(source)) {
      return Promise.resolve();
    }
    disposedPayloadSources.add(source);
    const disposal = (async () => {
      if (transferToken) await params.beforeDisposePayloadSource?.(transferToken);
      await disposeTransferPayloadSource(source);
    })()
      .catch(() => undefined)
      .finally(() => {
        pendingPayloadDisposals.delete(disposal);
        emitPublishedTransfersChanged();
      });
    pendingPayloadDisposals.add(disposal);
    emitPublishedTransfersChanged();
    return disposal;
  };

  const disposePayloadSourceBestEffort = (source: TransferPayloadSource, transferToken?: string): void => {
    void disposePayloadSourceOnce(source, transferToken);
  };

  const emitPublishedTransfersChanged = (): void => {
    for (const listener of activityListeners) {
      try { listener(); } catch { /* Observation cannot alter transfer custody. */ }
    }
    try {
      params.onPublishedTransfersChanged?.();
    } catch {
      // Registry cleanup must not be disrupted by lifecycle observers.
    }
  };

  const clearPublishedTransfersForToken = (token: string): boolean => {
    let changed = onDemandScopesByToken.delete(token);

    for (const [candidateId, entry] of publishedTransfers.entries()) {
      if (entry.transferToken !== token) {
        continue;
      }
      publishedTransfers.delete(candidateId);
      entry.filesystemSettlement?.settle({ success: false, error: 'Prepared filesystem export ended without destination completion', errorCode: 'indeterminate' });
      changed = true;
      disposePayloadSourceBestEffort(entry.payloadSource, token);
    }
    return changed;
  };

  function getNextPublishedTransferExpiryAt(): number | null {
    if (disposed) return null;

    let nextExpiryAt: number | null = null;
    for (const scope of onDemandScopesByToken.values()) {
      nextExpiryAt = nextExpiryAt === null ? scope.expiresAt : Math.min(nextExpiryAt, scope.expiresAt);
    }
    for (const entry of publishedTransfers.values()) {
      nextExpiryAt = nextExpiryAt === null ? entry.expiresAt : Math.min(nextExpiryAt, entry.expiresAt);
    }
    return nextExpiryAt;
  }

  function cleanupExpiredPublishedTransfers(nowMs = now()): void {
    if (disposed) {
      return;
    }
    let changed = false;

    const expiredTokens: string[] = [];
    for (const [token, scope] of onDemandScopesByToken.entries()) {
      if (scope.expiresAt <= nowMs) {
        expiredTokens.push(token);
      }
    }
    for (const token of expiredTokens) {
      changed = clearPublishedTransfersForToken(token) || changed;
    }

    const expiredPublishedTokens: string[] = [];
    for (const entry of publishedTransfers.values()) {
      if (entry.expiresAt <= nowMs) {
        expiredPublishedTokens.push(entry.transferToken);
      }
    }
    for (const token of new Set(expiredPublishedTokens)) {
      changed = clearPublishedTransfersForToken(token) || changed;
    }
    if (changed) {
      emitPublishedTransfersChanged();
    }
  }

  const assertRegistryHasCapacityForTransferId = (transferId: string): void => {
    if (publishedTransfers.has(transferId)) {
      return;
    }
    const maxEntries = readDirectPeerPublishedTransferRegistryMaxEntries();
    if (publishedTransfers.size >= maxEntries) {
      throw new Error(DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_FULL_ERROR);
    }
  };

  function publishTransfer(input: PublishDirectPeerTransferInput): PublishedDirectPeerTransfer {
    if (disposed) {
      throw new Error('Direct peer transfer registry is disposed');
    }
    cleanupExpiredPublishedTransfers();
    assertRegistryHasCapacityForTransferId(input.transferId);

    // Re-publishing should clean up any prior payload sources/scope to avoid leaks and drift.
    clearPublishedTransfer(input.transferId);

    const payloadSource = input.payloadSource ?? (input.payload ? createBufferTransferPayloadSource(input.payload) : null);
    if (!payloadSource) {
      throw new Error(`Direct peer transfer ${input.transferId} is missing a payload source`);
    }
    const inMemoryMaxBytes = resolveInMemoryTransferMaxBytes();
    if (payloadSource.kind === 'buffer' && payloadSource.payload.length > inMemoryMaxBytes) {
      throw new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${inMemoryMaxBytes}`);
    }
    const transferToken = randomBytes(24).toString('base64url');
    const expiresAt = now() + readDirectPeerTtlMs();
    const endpointPath = buildDirectPeerTransferEndpointPath(input.transferId);
    const httpEndpointCandidates = filterDirectTransferEndpointCandidatesForAdvertisement(readAdvertisedHosts(networkInterfacesFn)
      .map((host) => ({
        kind: 'http' as const,
        url: `http://${formatCandidateHost(host)}:${params.advertisedPort}${endpointPath}`,
        authorizationToken: transferToken,
        expiresAt,
      }))
      .filter(
        (candidate, index, all) =>
          all.findIndex(
            (entry) =>
              entry.url === candidate.url
              && entry.authorizationToken === candidate.authorizationToken,
          ) === index,
      ));
    const endpointCandidates: TransferEndpointCandidate[] = [...httpEndpointCandidates];

    let settleFilesystemExport!: (result: PreparedFilesystemExportSettlement) => void;
    const filesystemSettlement = input.filesystemScope
      ? new Promise<PreparedFilesystemExportSettlement>((resolve) => { settleFilesystemExport = resolve; })
      : null;
    publishedTransfers.set(input.transferId, {
      transferToken,
      transferTokenDigest: hashTransferToken(transferToken),
      expiresAt,
      payloadSource,
      ...(input.filesystemScope ? { filesystemScope: input.filesystemScope } : {}),
      ...(filesystemSettlement ? { filesystemSettlement: { result: filesystemSettlement, settle: settleFilesystemExport } } : {}),
    });

    if (input.onDemandScope) {
      onDemandScopesByToken.set(transferToken, {
        expiresAt,
        allowTransferId: input.onDemandScope.allowTransferId,
        resolvePayloadSourceOnOpen: input.onDemandScope.resolvePayloadSourceOnOpen,
        maxResolvedTransfers: input.onDemandScope.maxResolvedTransfers ?? 10_000,
        resolvedTransferIds: new Set<string>(),
      });
    }

    emitPublishedTransfersChanged();

    return {
      transferId: input.transferId,
      transferToken,
      endpointCandidates,
      expiresAt,
    };
  }

  function readPublishedTransfer(input: Readonly<{
    transferId: string;
    transferToken: string;
    transferTokenDigest?: Buffer;
  }>): TransferPayloadSource | null {
    const stored = publishedTransfers.get(input.transferId);
    if (!stored) return null;
    // `expiresAt` is generated locally; do not apply requester clock-skew tolerance to auth TTL.
    if (stored.expiresAt <= now()) {
      const changed = clearPublishedTransfersForToken(stored.transferToken);
      if (changed) emitPublishedTransfersChanged();
      return null;
    }
    // Hash only the untrusted inbound token. Stored tokens are already pre-hashed at publish time
    // so repeated auth failures can't force 2x hashing work per request.
    const inboundDigest = input.transferTokenDigest ?? hashTransferToken(input.transferToken);
    if (!timingSafeEqual(inboundDigest, stored.transferTokenDigest)) {
      return null;
    }
    return stored.payloadSource;
  }

  async function resolveOnDemandTransferOnOpen(input: Readonly<{
    transferId: string;
    transferToken: string;
    requestBody: unknown;
  }>): Promise<TransferPayloadSource | null> {
    if (disposed) {
      return null;
    }
    cleanupExpiredPublishedTransfers();
    const scope = onDemandScopesByToken.get(input.transferToken);
    if (!scope) {
      return null;
    }
    if (scope.expiresAt < now()) {
      onDemandScopesByToken.delete(input.transferToken);
      return null;
    }
    if (!scope.allowTransferId(input.transferId)) {
      return null;
    }

    const existing = publishedTransfers.get(input.transferId);
    if (existing?.transferToken === input.transferToken) {
      return existing.payloadSource;
    }
    if (scope.resolvedTransferIds.size >= scope.maxResolvedTransfers) {
      throw new Error('Direct peer on-demand transfer scope exceeded max resolved transfers');
    }
    const inFlightKey = `${input.transferToken}\0${input.transferId}`;
    const existingResolution = inFlightOnDemandTransfers.get(inFlightKey);
    if (existingResolution?.kind === 'source') {
      return await existingResolution.request;
    }

    const resolution = (async (): Promise<TransferPayloadSource | null> => {
      const payloadSource = await scope.resolvePayloadSourceOnOpen({
        transferId: input.transferId,
        requestBody: input.requestBody,
      });
      const currentScope = onDemandScopesByToken.get(input.transferToken);
      if (currentScope !== scope || scope.expiresAt <= now()) {
        disposePayloadSourceBestEffort(payloadSource);
        return null;
      }
      const inMemoryMaxBytes = resolveInMemoryTransferMaxBytes();
      if (payloadSource.kind === 'buffer' && payloadSource.payload.length > inMemoryMaxBytes) {
        disposePayloadSourceBestEffort(payloadSource);
        throw new Error(`${IN_MEMORY_TRANSFER_SIZE_LIMIT_ERROR}:${inMemoryMaxBytes}`);
      }

      if (!scope.resolvedTransferIds.has(input.transferId) && scope.resolvedTransferIds.size >= scope.maxResolvedTransfers) {
        disposePayloadSourceBestEffort(payloadSource);
        throw new Error('Direct peer on-demand transfer scope exceeded max resolved transfers');
      }

      try {
        assertRegistryHasCapacityForTransferId(input.transferId);
      } catch (error) {
        disposePayloadSourceBestEffort(payloadSource);
        throw error;
      }
      publishedTransfers.set(input.transferId, {
        transferToken: input.transferToken,
        transferTokenDigest: hashTransferToken(input.transferToken),
        expiresAt: scope.expiresAt,
        payloadSource,
      });
      scope.resolvedTransferIds.add(input.transferId);
      emitPublishedTransfersChanged();
      return payloadSource;
    })();
    const retained = { kind: 'source' as const, request: resolution };
    inFlightOnDemandTransfers.set(inFlightKey, retained);
    emitPublishedTransfersChanged();
    try {
      return await resolution;
    } finally {
      if (inFlightOnDemandTransfers.get(inFlightKey) === retained) {
        inFlightOnDemandTransfers.delete(inFlightKey);
        emitPublishedTransfersChanged();
      }
    }
  }

  function clearPublishedTransfer(transferId: string, filesystemScope?: PreparedFilesystemTransferScope | null): boolean {
    const stored = publishedTransfers.get(transferId);
    if (!stored) {
      return false;
    }
    assertPreparedFilesystemTransferScope(stored.filesystemScope, filesystemScope);
    if (filesystemScope) stored.filesystemSettlement?.settle({ success: false, error: 'Download cancelled', errorCode: 'cancelled' });

    // Clearing a token carrier should also clear any on-demand transfers resolved under the same token.
    const changed = clearPublishedTransfersForToken(stored.transferToken);
    if (changed) emitPublishedTransfersChanged();
    return changed;
  }

  function dispose(): Promise<void> {
    if (disposePromise) {
      return disposePromise;
    }

    disposed = true;
    for (const entry of publishedTransfers.values()) {
      entry.filesystemSettlement?.settle({ success: false, error: 'Prepared filesystem export owner stopped', errorCode: 'indeterminate' });
    }
    onDemandScopesByToken.clear();
    const retainedPayloadSources = [...publishedTransfers.values()];
    const inFlightResolutions = [...inFlightOnDemandTransfers.values()].map(entry => entry.request);
    publishedTransfers.clear();
    // Transfer the source's real lifetime into existing disposal custody
    // before publishing removal; readers must not observe an idle gap.
    const payloadDisposals = retainedPayloadSources.map(entry => disposePayloadSourceOnce(entry.payloadSource, entry.transferToken));
    emitPublishedTransfersChanged();

    disposePromise = (async () => {
      await Promise.allSettled(payloadDisposals);
      await Promise.allSettled(inFlightResolutions);
      await Promise.allSettled([...pendingPayloadDisposals]);
    })();
    return disposePromise;
  }

  const activity: LiveWorkProducerV1 = Object.freeze({
    read(): Omit<LiveWorkInventoryV1, 'idleSince'> {
      const references: unknown[] = [...publishedTransfers.keys(), ...onDemandScopesByToken.values(),
        ...[...inFlightOnDemandTransfers.values()].map(entry => entry.request), ...pendingPayloadDisposals];
      const items: LiveWorkItemV1[] = references.map(ownerRef => ({
        category: 'transfer', ownerRef, attribution: { kind: 'unknown' }, state: 'active',
      }));
      return { items, coverage: 'complete' };
    },
    subscribe(listener: () => void): () => void {
      activityListeners.add(listener);
      return () => { activityListeners.delete(listener); };
    },
  });
  return {
    activity,
    async retainPayloadFileRequest(request: Promise<TransferPayloadFileResult>): Promise<TransferPayloadFileResult> {
      if (disposed) throw new Error('Direct peer transfer registry is disposed');
      const retained = { kind: 'download' as const, request };
      inFlightOnDemandTransfers.set(request, retained);
      emitPublishedTransfersChanged();
      try { return await request; }
      finally { if (inFlightOnDemandTransfers.get(request) === retained) inFlightOnDemandTransfers.delete(request); emitPublishedTransfersChanged(); }
    },
    publishTransfer,
    readPublishedTransfer,
    resolveOnDemandTransferOnOpen,
    clearPublishedTransfer,
    async completeFilesystemExport(input: Readonly<{
      transferId: string;
      transferToken: string;
      outcome: PreparedFilesystemExportOutcome;
    }>): Promise<Readonly<{ success: true } | { success: false; error: string }>> {
      const stored = publishedTransfers.get(input.transferId);
      if (!stored?.filesystemScope?.destinationId || !stored.filesystemSettlement
        || stored.filesystemScope.destinationId !== input.outcome.destinationId
        || !readPublishedTransfer(input)) return { success: false, error: 'Prepared filesystem export is unavailable' };
      if (input.outcome.success) {
        const [sizeBytes, manifestHash] = await Promise.all([
          resolveTransferPayloadSizeBytes(stored.payloadSource),
          resolveTransferPayloadManifestHash(stored.payloadSource),
        ]);
        if (input.outcome.sizeBytes !== sizeBytes || input.outcome.manifestHash !== manifestHash) {
          return { success: false, error: 'Prepared filesystem destination bytes do not match the source' };
        }
        if (publishedTransfers.get(input.transferId) !== stored) return { success: false, error: 'Prepared filesystem export is unavailable' };
        stored.filesystemSettlement.settle({ success: true, sizeBytes, manifestHash });
      } else {
        stored.filesystemSettlement.settle({ success: false, error: input.outcome.error,
          ...(input.outcome.errorCode ? { errorCode: input.outcome.errorCode } : {}) });
      }
      clearPublishedTransfer(input.transferId);
      return { success: true };
    },
    async waitForFilesystemExportSettlement(transferId: string, filesystemScope: PreparedFilesystemTransferScope): Promise<PreparedFilesystemExportSettlement> {
      const stored = publishedTransfers.get(transferId);
      if (!stored?.filesystemSettlement) return { success: false, error: 'Prepared filesystem export is unavailable', errorCode: 'indeterminate' };
      assertPreparedFilesystemTransferScope(stored.filesystemScope, filesystemScope);
      return await stored.filesystemSettlement.result;
    },
    cleanupExpiredPublishedTransfers,
    getNextPublishedTransferExpiryAt,
    dispose,
    hasPublishedTransfers: () => {
      cleanupExpiredPublishedTransfers();
      return publishedTransfers.size > 0;
    },
    countPublishedTransfers: () => {
      cleanupExpiredPublishedTransfers();
      return publishedTransfers.size;
    },
  };
}

const DirectPeerTransferResponseSchema = z
  .object({
    transferId: z.string().min(1),
    manifestHash: z.string().min(1),
    totalChunks: z.number().int().positive(),
    sizeBytes: z.number().int().nonnegative().optional(),
    name: z.string().min(1).optional(),
  })
  .strict();

const DirectTransferImportOpenResponseSchema = z
  .object({
    uploadId: z.string().min(1),
    destDisplayPath: z.string().min(1),
    expectedSizeBytes: z.number().int().nonnegative(),
    chunkSizeBytes: z.number().int().positive(),
    recipientPublicKeyBase64: z.string().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();

const DirectTransferImportChunkRequestSchema = z
  .object({
    contentBase64: z.string().min(1).optional(),
    payloadBase64: z.string().min(1).optional(),
    encryptedDataKeyEnvelopeBase64: z.string().min(1).optional(),
  })
  .strict();

const DirectTransferImportChunkResponseSchema = z
  .object({
    success: z.literal(true),
  })
  .strict()
  .or(z.object({ success: z.literal(false), error: z.string() }).strict());

const DirectTransferImportFinalizeOrdinaryFailureResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string(),
    keepSession: z.boolean().optional(),
  })
  .strict();

const DirectTransferImportFinalizeRecoveryFailureResponseSchema = z
  .object({
    success: z.literal(false),
    error: z.string(),
    errorCode: z.literal(TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE),
    keepSession: z.literal(true),
  })
  .strict();

const DirectTransferImportFinalizeResponseSchema = z
  .object({
    success: z.literal(true),
    finalized: z.object({
      success: z.literal(true),
      path: z.string().min(1),
      sizeBytes: z.number().int().nonnegative(),
      result: z.unknown().optional(),
    }).strict(),
    sha256: z.string().min(1),
  })
  .strict()
  .or(DirectTransferImportFinalizeOrdinaryFailureResponseSchema)
  .or(DirectTransferImportFinalizeRecoveryFailureResponseSchema);

const DirectTransferImportAbortResponseSchema = z
  .object({ success: z.literal(true) }).strict()
  .or(z.object({ success: z.literal(false), error: z.string() }).strict());

function isDirectTransferRoutePath(url: string | undefined): boolean {
  const normalizedUrl = String(url ?? '').trim();
  if (!normalizedUrl) {
    return false;
  }
  return normalizedUrl === '/machine-transfers/direct'
    || normalizedUrl.startsWith('/machine-transfers/direct/');
}

function applyDirectTransferCorsHeaders(params: Readonly<{
  reply: FastifyReply;
  origin: string;
}>): void {
  params.reply.header('access-control-allow-origin', params.origin);
  params.reply.header('access-control-allow-methods', DIRECT_TRANSFER_CORS_ALLOW_METHODS);
  params.reply.header('access-control-allow-headers', DIRECT_TRANSFER_CORS_ALLOW_HEADERS);
  params.reply.header('vary', 'Origin');
}

export function createDirectPeerTransferApp(params: Readonly<{
  admissionDrain?: NonNullable<Parameters<typeof createDirectTransferImportSessionManager>[0]>['admissionDrain'];
  readPublishedTransfer: (input: Readonly<{
    transferId: string;
    transferToken: string;
    transferTokenDigest?: Buffer;
  }>) => TransferPayloadSource | null;
  resolveOnDemandTransfer?: (input: Readonly<{
    transferId: string;
    transferToken: string;
    requestBody: unknown;
  }>) => Promise<TransferPayloadSource | null>;
  importSessionManager?: DirectTransferImportSessionManager;
  completeFilesystemExport?: (input: Readonly<{ transferId: string; transferToken: string;
    outcome: PreparedFilesystemExportOutcome }>) => Promise<Readonly<{ success: true } | { success: false; error: string }>>;
  onPublishedTransferCacheReady?: (releaseHandles: (transferToken: string) => Promise<void>) => void;
}>): FastifyInstance {
  const OPEN_METADATA_CACHE_MAX_ENTRIES = 256;
  const OPEN_FILE_HANDLE_CACHE_MAX_ENTRIES = 64;
  const OPEN_TRANSFER_TOKEN_DIGEST_CACHE_MAX_ENTRIES = 256;
  const openSizeBytesCache = new Map<string, Promise<number>>();
  const openManifestHashCache = new Map<string, Promise<string>>();
  const openFileHandleCache = new Map<string, Promise<FileHandle>>();
  const openTransferTokenDigestCache = new Map<string, Buffer>();
  const importSessionManager = params.importSessionManager ?? createDirectTransferImportSessionManager({ admissionDrain: params.admissionDrain });

  const readOpenCacheKeyFromDigest = (transferId: string, transferTokenDigest: Buffer): string =>
    `${transferId}:${transferTokenDigest.toString('base64url')}`;

  const cachePromise = <TValue>(
    cache: Map<string, Promise<TValue>>,
    key: string,
    factory: () => Promise<TValue>,
  ): Promise<TValue> => {
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    const created = factory();
    cache.set(key, created);

    // If the work fails, don't pin a rejected promise indefinitely.
    created.catch(() => {
      if (cache.get(key) === created) {
        cache.delete(key);
      }
    });

    while (cache.size > OPEN_METADATA_CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      cache.delete(oldestKey);
    }

    return created;
  };

  const resolveOpenTransferTokenDigest = (transferToken: string): Buffer => {
    const cached = openTransferTokenDigestCache.get(transferToken);
    if (cached) {
      return cached;
    }

    const digest = hashTransferToken(transferToken);
    openTransferTokenDigestCache.set(transferToken, digest);

    while (openTransferTokenDigestCache.size > OPEN_TRANSFER_TOKEN_DIGEST_CACHE_MAX_ENTRIES) {
      const oldestKey = openTransferTokenDigestCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      openTransferTokenDigestCache.delete(oldestKey);
    }

    return digest;
  };

  const validateRecipientPublicKey = (recipientPublicKeyBase64: string): void => {
    if (recipientPublicKeyBase64.length > DIRECT_PEER_RECIPIENT_PUBLIC_KEY_BASE64_HARD_MAX_CHARS) {
      throw new Error('Oversized recipient public key');
    }
    parseTransferRecipientPublicKeyBase64(recipientPublicKeyBase64);
  };

  const closeCachedFileHandle = async (key: string, handlePromise: Promise<FileHandle>): Promise<void> => {
    let handle: FileHandle;
    try { handle = await handlePromise; }
    catch {
      if (openFileHandleCache.get(key) === handlePromise) openFileHandleCache.delete(key);
      return; // Failed opens own no OS handle.
    }
    await handle.close();
    if (openFileHandleCache.get(key) === handlePromise) openFileHandleCache.delete(key);
  };

  const releasePublishedTransferHandles = async (transferToken: string): Promise<void> => {
    const suffix = `:${hashTransferToken(transferToken).toString('base64url')}`;
    await Promise.all([...openFileHandleCache.entries()]
      .filter(([key]) => key.endsWith(suffix))
      .map(([key, handle]) => closeCachedFileHandle(key, handle)));
    for (const cache of [openSizeBytesCache, openManifestHashCache]) {
      for (const key of cache.keys()) if (key.endsWith(suffix)) cache.delete(key);
    }
    openTransferTokenDigestCache.delete(transferToken);
  };
  params.onPublishedTransferCacheReady?.(releasePublishedTransferHandles);

  const cacheFileHandle = (key: string, filePath: string): Promise<FileHandle> => {
    const cached = openFileHandleCache.get(key);
    if (cached) {
      return cached;
    }

    // Keep an evicted handle in the same cache until close completes. Publication
    // disposal can then await it, including while its replacement is still opening.
    const created = (async () => {
      while (openFileHandleCache.size >= OPEN_FILE_HANDLE_CACHE_MAX_ENTRIES) {
        const oldestKey = openFileHandleCache.keys().next().value;
        if (!oldestKey || oldestKey === key) break;
        const evicted = openFileHandleCache.get(oldestKey);
        if (!evicted) continue;
        await closeCachedFileHandle(oldestKey, evicted);
      }
      return await fsPromises.open(filePath, 'r');
    })();
    openFileHandleCache.set(key, created);

    // If open fails, don't pin a rejected promise indefinitely.
    created.catch(() => {
      if (openFileHandleCache.get(key) === created) {
        openFileHandleCache.delete(key);
      }
    });

    return created;
  };

  const readTransferPayloadChunkForRequest = async (input: Readonly<{
    payloadSource: TransferPayloadSource;
    cacheKey: string;
    offset: number;
    length: number;
  }>): Promise<Buffer> => {
    if (input.payloadSource.kind !== 'file') {
      return await readTransferPayloadChunk({
        source: input.payloadSource,
        offset: input.offset,
        length: input.length,
      });
    }

    const handle = await cacheFileHandle(input.cacheKey, input.payloadSource.filePath);
    const chunkBuffer = Buffer.allocUnsafe(input.length);
    const { bytesRead } = await handle.read(chunkBuffer, 0, input.length, input.offset);
    return chunkBuffer.subarray(0, bytesRead);
  };

  const app = fastify({
    logger: false,
    bodyLimit: readDirectPeerOpenBodyMaxBytes(),
    routerOptions: {
      maxParamLength: 4 * 1024,
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const typed = app.withTypeProvider<ZodTypeProvider>();

  app.addHook('onClose', async () => {
    try {
      await Promise.all([...openFileHandleCache.entries()].map(([key, handle]) => closeCachedFileHandle(key, handle)));
    } finally {
      await importSessionManager.close();
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin.trim() : '';
    if (!origin || !isDirectTransferRoutePath(request.url)) {
      return;
    }

    applyDirectTransferCorsHeaders({ reply, origin });
    if (request.method === 'OPTIONS') {
      reply.code(204).send();
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin.trim() : '';
    if (origin && isDirectTransferRoutePath(request.url)) {
      applyDirectTransferCorsHeaders({ reply, origin });
    }
    return payload;
  });

  typed.post('/machine-transfers/direct/imports/open', {
    schema: {
      body: DirectTransferImportOpenRequestSchema,
      headers: z.object({
        authorization: z.string().min(1).optional(),
      }).passthrough(),
      response: {
        200: DirectTransferImportOpenResponseSchema,
        400: z.object({ ok: z.literal(false), error: z.string() }).strict(),
        401: z.object({ ok: z.literal(false), error: z.string() }).strict(),
      },
    },
  }, async (request, reply) => {
    const authorizationToken = (readDirectPeerAuthorizationToken(request.headers.authorization) ?? '').trim();
    if (authorizationToken.length === 0 || authorizationToken.length > DIRECT_PEER_AUTH_TOKEN_HARD_MAX_CHARS) {
      reply.code(401);
      return { ok: false as const, error: 'Import session open authorization required' };
    }
    const opened = await importSessionManager.openImportSession({
      ...request.body,
      authorizationToken,
    });
    if (!opened.success) {
      reply.code(opened.error === 'Import session open authorization required' ? 401 : 400);
      return { ok: false as const, error: opened.error };
    }
    return opened.response;
  });

  typed.put('/machine-transfers/direct/imports/:uploadId/chunks/:sequence', {
    bodyLimit: resolveEncryptedTransferChunkJsonBodyMaxBytes(),
    schema: {
      params: z.object({
        uploadId: z.string().min(1),
        sequence: z.coerce.number().int().nonnegative(),
      }),
      body: DirectTransferImportChunkRequestSchema,
      response: {
        200: DirectTransferImportChunkResponseSchema,
        400: z.object({ success: z.literal(false), error: z.string() }).strict(),
        404: z.object({ success: z.literal(false), error: z.string() }).strict(),
      },
    },
  }, async (request, reply) => {
    const result = await importSessionManager.writeImportTransferChunk({
      uploadId: request.params.uploadId,
      index: request.params.sequence,
      contentBase64: request.body.contentBase64,
      payloadBase64: request.body.payloadBase64,
      encryptedDataKeyEnvelopeBase64: request.body.encryptedDataKeyEnvelopeBase64,
    });
    if (!result.success) {
      reply.code(result.error === 'Upload session not found' ? 404 : 400);
      return result;
    }
    return result;
  });

  typed.post('/machine-transfers/direct/imports/:uploadId/finalize', {
    schema: {
      params: z.object({ uploadId: z.string().min(1) }),
      response: {
        200: DirectTransferImportFinalizeResponseSchema,
        400: DirectTransferImportFinalizeOrdinaryFailureResponseSchema,
        404: DirectTransferImportFinalizeOrdinaryFailureResponseSchema,
        409: DirectTransferImportFinalizeOrdinaryFailureResponseSchema,
        500: DirectTransferImportFinalizeRecoveryFailureResponseSchema,
      },
    },
  }, async (request, reply) => {
    const result = await importSessionManager.finalizeImportTransferSession({
      uploadId: request.params.uploadId,
    });
    if (!result.success) {
      const { expiresAt, ...response } = result;
      const error = result.error;
      if (result.errorCode === TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE) {
        reply.code(500);
        if (typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) && expiresAt > 0) {
          reply.header(DIRECT_TRANSFER_SESSION_EXPIRES_AT_HEADER, String(expiresAt));
          reply.header('access-control-expose-headers', DIRECT_TRANSFER_SESSION_EXPIRES_AT_HEADER);
        }
      } else if (error === 'Upload session not found') {
        reply.code(404);
      } else if (error === 'Upload is incomplete' || error === 'Upload hash mismatch') {
        reply.code(409);
      } else {
        reply.code(400);
      }
      return response;
    }
    return result;
  });

  typed.post('/machine-transfers/direct/imports/:uploadId/abort', {
    schema: {
      params: z.object({ uploadId: z.string().min(1) }),
      response: {
        200: DirectTransferImportAbortResponseSchema,
        400: z.object({ success: z.literal(false), error: z.string() }).strict(),
      },
    },
  }, async (request, reply) => {
    if (!request.params.uploadId) {
      reply.code(400);
      return { success: false as const, error: 'Missing uploadId' };
    }
    // Like chunk/finalize, this incumbent data-plane route consumes the opaque
    // prepared uploadId as a bearer capability. It does not derive requester
    // identity from the finite carrier grant. Raw RPC retains null scope.
    await importSessionManager.abortImportTransferSession({ uploadId: request.params.uploadId });
    return { success: true as const };
  });

  typed.post('/machine-transfers/direct/:transferId/open', {
    schema: {
      params: z.object({ transferId: z.string().min(1) }),
      querystring: z.object({}).passthrough(),
      headers: z.object({
        authorization: z.string().min(1).optional(),
        [DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER]: z.string().min(1),
      }).passthrough(),
      body: z.unknown().optional(),
      response: {
        200: DirectPeerTransferResponseSchema,
        400: z.object({ ok: z.literal(false), error: z.string() }).strict(),
        401: z.object({ ok: z.literal(false), error: z.string() }).strict(),
        503: z.object({ ok: z.literal(false), error: z.string() }).strict(),
        404: z.object({ ok: z.literal(false), error: z.string() }).strict(),
      },
    },
  }, async (request, reply) => {
    const transferId = decodeDirectPeerTransferPathKey(request.params.transferId);
    if (!transferId) {
      reply.code(404);
      return { ok: false as const, error: 'Direct peer transfer not available' };
    }
    const transferToken = (readDirectPeerAuthorizationToken(request.headers.authorization) ?? '').trim();
    if (transferToken.length === 0) {
      reply.code(404);
      return { ok: false as const, error: 'Direct peer transfer not available' };
    }
    if (transferToken.length > DIRECT_PEER_AUTH_TOKEN_HARD_MAX_CHARS) {
      reply.code(401);
      return { ok: false as const, error: 'Direct peer transfer not available' };
    }
    try {
      validateRecipientPublicKey(
        request.headers[DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER],
      );
    } catch {
      reply.code(400);
      return { ok: false as const, error: 'Invalid direct peer transfer request' };
    }
    const transferTokenDigest = resolveOpenTransferTokenDigest(transferToken);
    let payloadSource = params.readPublishedTransfer({
      transferId,
      transferToken,
      transferTokenDigest,
    });
    if (!payloadSource && params.resolveOnDemandTransfer) {
      try {
        payloadSource = await params.resolveOnDemandTransfer({
          transferId,
          transferToken,
          requestBody: request.body,
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'Direct peer transfer not ready') {
          reply.code(503);
          return { ok: false as const, error: error.message };
        }
        reply.code(400);
        return { ok: false as const, error: 'Invalid direct peer transfer request' };
      }
    }
    if (!payloadSource) {
      reply.code(401);
      return { ok: false as const, error: 'Direct peer transfer not available' };
    }
    const cacheKey = readOpenCacheKeyFromDigest(transferId, transferTokenDigest);
    const sizeBytes = await cachePromise(
      openSizeBytesCache,
      cacheKey,
      async () => await resolveTransferPayloadSizeBytes(payloadSource),
    );
    return {
      transferId,
      manifestHash: await cachePromise(
        openManifestHashCache,
        cacheKey,
        async () => await resolveTransferPayloadManifestHash(payloadSource),
      ),
      totalChunks: Math.max(1, Math.ceil(sizeBytes / readDirectPeerChunkBytes())),
      sizeBytes,
      ...(typeof payloadSource.name === 'string' && payloadSource.name.length > 0
        ? { name: payloadSource.name }
        : {}),
    };
  });

  typed.post('/machine-transfers/direct/:transferId/complete', {
    schema: {
      params: z.object({ transferId: z.string().min(1) }).strict(),
      headers: z.object({ authorization: z.string().min(1) }).passthrough(),
      body: z.union([
        z.object({ destinationId: z.string().min(1), success: z.literal(true), sizeBytes: z.number().int().nonnegative(),
          manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/i) }).strict(),
        z.object({ destinationId: z.string().min(1), success: z.literal(false), error: z.string(), errorCode: z.string().optional() }).strict(),
      ]),
      response: { 200: DirectTransferImportAbortResponseSchema, 400: z.object({ success: z.literal(false), error: z.string() }).strict() },
    },
  }, async (request, reply) => {
    const transferId = decodeDirectPeerTransferPathKey(request.params.transferId);
    const transferToken = readDirectPeerAuthorizationToken(request.headers.authorization);
    if (!transferId || !transferToken || transferToken.length > DIRECT_PEER_AUTH_TOKEN_HARD_MAX_CHARS
      || !params.completeFilesystemExport) {
      reply.code(400);
      return { success: false as const, error: 'Prepared filesystem export is unavailable' };
    }
    const result = await params.completeFilesystemExport({ transferId, transferToken, outcome: request.body });
    if (!result.success) reply.code(400);
    return result;
  });

  typed.get('/machine-transfers/direct/:transferId/chunks/:sequence', {
    schema: {
      params: z.object({
        transferId: z.string().min(1),
        sequence: z.coerce.number().int().nonnegative(),
      }),
      querystring: z.object({}).passthrough(),
      headers: z.object({
        authorization: z.string().min(1).optional(),
        [DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER]: z.string().min(1),
      }).passthrough(),
      response: {
        200: TransferChunkEnvelopeSchema,
        400: z.object({ ok: z.literal(false), error: z.string() }).strict(),
        401: z.object({ ok: z.literal(false), error: z.string() }).strict(),
        404: z.object({ ok: z.literal(false), error: z.string() }).strict(),
      },
    },
  }, async (request, reply) => {
    const transferId = decodeDirectPeerTransferPathKey(request.params.transferId);
    if (!transferId) {
      reply.code(404);
      return { ok: false as const, error: 'Direct peer transfer not available' };
    }
    const transferToken = (readDirectPeerAuthorizationToken(request.headers.authorization) ?? '').trim();
    if (transferToken.length === 0) {
      reply.code(404);
      return { ok: false as const, error: 'Direct peer transfer not available' };
    }
    if (transferToken.length > DIRECT_PEER_AUTH_TOKEN_HARD_MAX_CHARS) {
      reply.code(401);
      return { ok: false as const, error: 'Direct peer transfer not available' };
    }
    try {
      validateRecipientPublicKey(
        request.headers[DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER],
      );
    } catch {
      reply.code(400);
      return { ok: false as const, error: 'Invalid direct peer transfer request' };
    }
    const transferTokenDigest = resolveOpenTransferTokenDigest(transferToken);
    const payloadSource = params.readPublishedTransfer({
      transferId,
      transferToken,
      transferTokenDigest,
    });
    if (!payloadSource) {
      reply.code(401);
      return { ok: false as const, error: 'Direct peer transfer not available' };
    }
    const chunkBytes = readDirectPeerChunkBytes();
    const cacheKey = readOpenCacheKeyFromDigest(transferId, transferTokenDigest);
    const sizeBytes = await cachePromise(
      openSizeBytesCache,
      cacheKey,
      async () => await resolveTransferPayloadSizeBytes(payloadSource),
    );
    const totalChunks = Math.max(1, Math.ceil(sizeBytes / chunkBytes));
    if (request.params.sequence >= totalChunks) {
      reply.code(404);
      return { ok: false as const, error: 'Direct peer transfer chunk not available' };
    }

    try {
      const offset = request.params.sequence * chunkBytes;
      const encryptedChunk = createEncryptedTransferChunkEnvelope({
        transferId,
        sequence: request.params.sequence,
        payload: await readTransferPayloadChunkForRequest({
          payloadSource,
          cacheKey,
          offset,
          length: chunkBytes,
        }),
        recipientPublicKeyBase64: request.headers[DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER],
      });
      return {
        transferId,
        kind: 'chunk' as const,
        sequence: request.params.sequence,
        payloadBase64: encryptedChunk.payloadBase64,
        encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
      };
    } catch {
      reply.code(400);
      return { ok: false as const, error: 'Invalid direct peer transfer request' };
    }
  });

  return app;
}

export async function startDirectPeerTransferServer(params: Readonly<{
  admissionDrain?: NonNullable<Parameters<typeof createDirectTransferImportSessionManager>[0]>['admissionDrain'];
  attachmentUpload?: TransferUploadInitAttachmentDeps;
  readPublishedTransfer: (input: Readonly<{
    transferId: string;
    transferToken: string;
    transferTokenDigest?: Buffer;
  }>) => TransferPayloadSource | null;
  resolveOnDemandTransfer?: Parameters<typeof createDirectPeerTransferApp>[0]['resolveOnDemandTransfer'];
  completeFilesystemExport?: Parameters<typeof createDirectPeerTransferApp>[0]['completeFilesystemExport'];
  accessPolicy?: FilesystemAccessPolicy;
  bindPort?: number;
  bindHost?: string;
  onImportSessionCountChanged?: (count: number) => void;
  onImportSessionActivity?: () => void;
  composerMediaStage?: ComposerMediaStageUploadTargetDeps;
  promptAssetUpload?: Parameters<typeof createDirectTransferImportSessionManager>[0] extends infer T
    ? T extends Readonly<object>
      ? T extends { promptAssetUpload?: infer P }
        ? P
        : never
      : never
    : never;
  finalizeFileOperations?: WorkspaceFinalizeFileOperationsFactory;
}>): Promise<Readonly<{
  activity: LiveWorkProducerV1;
  port: number;
  stop: () => Promise<void>;
  releasePublishedTransferHandles: (transferToken: string) => Promise<void>;
  issueImportOpenAuthorizationToken: (input: DirectTransferImportOpenRequest) => Readonly<{
    authorizationToken: string;
    expiresAt: number;
  }>;
  openTrustedImportSession: (input: DirectTransferImportOpenRequest, filesystemScope?: PreparedFilesystemTransferScope, privateStagingDirectory?: string) => Promise<
    | Readonly<{ success: true; response: DirectTransferImportOpenResponse }>
    | Readonly<{ success: false; error: string }>
  >;
  abortImportTransferSession: (
    input: Readonly<{ uploadId: string }>,
    filesystemScope?: PreparedFilesystemTransferScope | null,
  ) => Promise<void | Readonly<{ aborted: boolean }>>;
  waitForImportTransferSettlement: (uploadId: string, filesystemScope: PreparedFilesystemTransferScope) => Promise<PreparedImportTransferSettlement>;
  cleanupExpiredImportSessions: (now?: number) => void;
  getNextImportSessionExpiryAt: () => number | null;
}>> {
  const importSessionManager = createDirectTransferImportSessionManager({
    admissionDrain: params.admissionDrain,
    ...(params.attachmentUpload ? { attachmentUpload: params.attachmentUpload } : {}),
    onActiveSessionCountChanged: params.onImportSessionCountChanged,
    onActivity: params.onImportSessionActivity,
    accessPolicy: params.accessPolicy,
    ...(params.composerMediaStage ? { composerMediaStage: params.composerMediaStage } : {}),
    ...(params.promptAssetUpload ? { promptAssetUpload: params.promptAssetUpload } : {}),
    ...(params.finalizeFileOperations
      ? { finalizeFileOperations: params.finalizeFileOperations }
      : {}),
  });
  let releasePublishedTransferHandles!: (transferToken: string) => Promise<void>;
  const app = createDirectPeerTransferApp({
    ...params,
    importSessionManager,
    onPublishedTransferCacheReady: release => { releasePublishedTransferHandles = release; },
  });
  await app.ready();
  // bindHost is local listener configuration. Clamp it independently from any advertised remote
  // candidates so a direct caller cannot restore plaintext nonloopback exposure.
  const address = await app.listen({
    port: typeof params.bindPort === 'number' && params.bindPort > 0 ? Math.floor(params.bindPort) : readDirectPeerBindPort(),
    host: resolveDirectPeerTransferBindHost(params.bindHost),
  });
  const port = Number.parseInt(String(address).split(':').pop() ?? '', 10);
  if (!Number.isFinite(port) || port <= 0) {
    await app.close();
    throw new Error('Failed to resolve direct peer transfer port');
  }
  return {
    port,
    activity: importSessionManager.activity,
    releasePublishedTransferHandles,
    issueImportOpenAuthorizationToken: (input) => importSessionManager.issueImportOpenAuthorizationToken(input),
    openTrustedImportSession: async (input, filesystemScope, privateStagingDirectory) => await importSessionManager.openTrustedImportSession(input, filesystemScope, privateStagingDirectory),
    abortImportTransferSession: async (input, filesystemScope) =>
      await importSessionManager.abortImportTransferSession(input, filesystemScope),
    waitForImportTransferSettlement: (uploadId, filesystemScope) => importSessionManager.waitForImportTransferSettlement(uploadId, filesystemScope),
    cleanupExpiredImportSessions: (now) => importSessionManager.cleanupExpiredImportSessions(now),
    getNextImportSessionExpiryAt: () => importSessionManager.getNextImportSessionExpiryAt(),
    stop: async () => {
      await app.close();
    },
  };
}
