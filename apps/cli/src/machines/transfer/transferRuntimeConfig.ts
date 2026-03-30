import { networkInterfaces } from 'node:os';

import { parseBooleanEnv } from '@happier-dev/protocol';

import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';
import { clampTransferChunkBytes } from './transferChunkSizeLimit';
import { resolveInMemoryTransferMaxBytes } from './inMemoryTransferSizeLimit';

const DEFAULT_DIRECT_PEER_TTL_MS = 10 * 60_000;
const DEFAULT_DIRECT_PEER_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_DIRECT_PEER_CHUNK_BYTES = 256 * 1024;
const DIRECT_PEER_CHUNK_HARD_MAX_BYTES = 512 * 1024;
const DEFAULT_DIRECT_PEER_MAX_TOTAL_CHUNKS = 1_000_000;
const DIRECT_PEER_MAX_TOTAL_CHUNKS_HARD_MAX = 10_000_000;
const DEFAULT_DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_MAX_ENTRIES = 2048;
const DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_HARD_MAX_ENTRIES = 100_000;
const DEFAULT_DIRECT_PEER_OPEN_BODY_MAX_BYTES = 64 * 1024;
const DIRECT_PEER_OPEN_BODY_HARD_MAX_BYTES = 1024 * 1024;
const DEFAULT_DIRECT_PEER_BIND_HOST = '0.0.0.0';
const DEFAULT_DIRECT_PEER_EXPIRY_SKEW_MS = 2_000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TRANSFER_MAX_ACTIVE_TRANSFERS = 128;
const TRANSFER_MAX_ACTIVE_TRANSFERS_HARD_MAX = 10_000;
const DEFAULT_TRANSFER_CHUNK_BYTES = 256 * 1024;
const DEFAULT_TRANSFER_OPEN_PAYLOAD_MAX_BYTES = 64 * 1024;
const TRANSFER_OPEN_PAYLOAD_HARD_MAX_BYTES = 64 * 1024;

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeInt(rawValue: string | undefined, fallback: number): number {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function resolveDirectPeerFeatureEnabled(): boolean {
  return parseBooleanEnv(process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED, true);
}

export function resolveDirectPeerServerEnabled(): boolean {
  return resolveDirectPeerFeatureEnabled()
    && parseBooleanEnv(process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED, true);
}

export function resolveDirectPeerAdvertisedHosts(networkInterfacesFn: typeof networkInterfaces = networkInterfaces): string[] {
  const configuredHosts = String(process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const hosts = new Set<string>(configuredHosts);
  for (const entries of Object.values(networkInterfacesFn())) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal) continue;
      const family = String(entry.family);
      if (family !== 'IPv4' && family !== 'IPv6') continue;
      const address = typeof entry.address === 'string' ? entry.address.trim() : '';
      if (!address) continue;
      if (family === 'IPv6' && address.includes('%')) continue;
      hosts.add(address);
    }
  }
  return Array.from(hosts);
}

export function resolveDirectPeerTransferTtlMs(): number {
  return parsePositiveInt(process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_TTL_MS, DEFAULT_DIRECT_PEER_TTL_MS);
}

export function resolveDirectPeerTransferRequestTimeoutMs(): number {
  return parsePositiveInt(
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_REQUEST_TIMEOUT_MS,
    DEFAULT_DIRECT_PEER_REQUEST_TIMEOUT_MS,
  );
}

export function resolveDirectPeerTransferRequestTimeoutOverrideMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return resolveDirectPeerTransferRequestTimeoutMs();
  }
  const normalizedTimeoutMs = Math.trunc(timeoutMs);
  return normalizedTimeoutMs > 0
    ? normalizedTimeoutMs
    : resolveDirectPeerTransferRequestTimeoutMs();
}

export function resolveDirectPeerTransferBindPort(): number {
  return readPositiveIntEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT', 0) ?? 0;
}

export function resolveDirectPeerTransferChunkBytes(): number {
  return Math.min(clampTransferChunkBytes(parsePositiveInt(
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_CHUNK_BYTES,
    DEFAULT_DIRECT_PEER_CHUNK_BYTES,
  )), DIRECT_PEER_CHUNK_HARD_MAX_BYTES);
}

export function resolveDirectPeerTransferExpirySkewMs(): number {
  return parseNonNegativeInt(
    process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_EXPIRY_SKEW_MS,
    DEFAULT_DIRECT_PEER_EXPIRY_SKEW_MS,
  );
}

export function resolveDirectPeerTransferOpenBodyMaxBytes(): number {
  return Math.min(
    parsePositiveInt(process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_OPEN_BODY_MAX_BYTES, DEFAULT_DIRECT_PEER_OPEN_BODY_MAX_BYTES),
    DIRECT_PEER_OPEN_BODY_HARD_MAX_BYTES,
  );
}

export function resolveDirectPeerTransferMaxTotalChunks(): number {
  return Math.min(
    parsePositiveInt(process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_MAX_TOTAL_CHUNKS, DEFAULT_DIRECT_PEER_MAX_TOTAL_CHUNKS),
    DIRECT_PEER_MAX_TOTAL_CHUNKS_HARD_MAX,
  );
}

export function resolveDirectPeerTransferPublishedTransferRegistryMaxEntries(): number {
  return Math.min(
    parsePositiveInt(
      process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_MAX_ENTRIES,
      DEFAULT_DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_MAX_ENTRIES,
    ),
    DIRECT_PEER_PUBLISHED_TRANSFER_REGISTRY_HARD_MAX_ENTRIES,
  );
}

export function resolveDirectPeerTransferBindHost(): string {
  return process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_HOST ?? DEFAULT_DIRECT_PEER_BIND_HOST;
}

export function resolveServerRoutedTransferTimeoutMs(): number {
  return Math.min(
    readPositiveIntEnv('HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_TIMEOUT_MS', DEFAULT_TRANSFER_TIMEOUT_MS),
    30 * 60_000,
  );
}

export function resolveServerRoutedTransferMaxActiveTransfers(): number {
  return Math.min(
    readPositiveIntEnv(
      'HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_MAX_ACTIVE_TRANSFERS',
      DEFAULT_TRANSFER_MAX_ACTIVE_TRANSFERS,
    ),
    TRANSFER_MAX_ACTIVE_TRANSFERS_HARD_MAX,
  );
}

export function resolveServerRoutedTransferChunkBytes(): number {
  return clampTransferChunkBytes(readPositiveIntEnv(
    'HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_CHUNK_BYTES',
    DEFAULT_TRANSFER_CHUNK_BYTES,
  ));
}

export function resolveServerRoutedTransferOpenPayloadMaxBytes(): number {
  const configured = readPositiveIntEnv(
    'HAPPIER_MACHINE_TRANSFER_SERVER_ROUTED_OPEN_PAYLOAD_MAX_BYTES',
    DEFAULT_TRANSFER_OPEN_PAYLOAD_MAX_BYTES,
  );
  return Math.min(configured, resolveInMemoryTransferMaxBytes(), TRANSFER_OPEN_PAYLOAD_HARD_MAX_BYTES);
}

export function resolveMachineTransferRuntimeConfig(options?: Readonly<{
  networkInterfacesFn?: typeof networkInterfaces;
}>): Readonly<{
  directPeer: Readonly<{
    advertisedHosts: string[];
    ttlMs: number;
    requestTimeoutMs: number;
    bindPort: number;
    chunkBytes: number;
    expirySkewMs: number;
    openBodyMaxBytes: number;
    maxTotalChunks: number;
    publishedTransferRegistryMaxEntries: number;
    bindHost: string;
    featureEnabled: boolean;
    serverEnabled: boolean;
  }>;
  serverRouted: Readonly<{
    timeoutMs: number;
    maxActiveTransfers: number;
    chunkBytes: number;
    openPayloadMaxBytes: number;
  }>;
}> {
  const networkInterfacesFn = options?.networkInterfacesFn ?? networkInterfaces;
  return {
    directPeer: {
      advertisedHosts: resolveDirectPeerAdvertisedHosts(networkInterfacesFn),
      ttlMs: resolveDirectPeerTransferTtlMs(),
      requestTimeoutMs: resolveDirectPeerTransferRequestTimeoutMs(),
      bindPort: resolveDirectPeerTransferBindPort(),
      chunkBytes: resolveDirectPeerTransferChunkBytes(),
      expirySkewMs: resolveDirectPeerTransferExpirySkewMs(),
      openBodyMaxBytes: resolveDirectPeerTransferOpenBodyMaxBytes(),
      maxTotalChunks: resolveDirectPeerTransferMaxTotalChunks(),
      publishedTransferRegistryMaxEntries: resolveDirectPeerTransferPublishedTransferRegistryMaxEntries(),
      bindHost: resolveDirectPeerTransferBindHost(),
      featureEnabled: resolveDirectPeerFeatureEnabled(),
      serverEnabled: resolveDirectPeerServerEnabled(),
    },
    serverRouted: {
      timeoutMs: resolveServerRoutedTransferTimeoutMs(),
      maxActiveTransfers: resolveServerRoutedTransferMaxActiveTransfers(),
      chunkBytes: resolveServerRoutedTransferChunkBytes(),
      openPayloadMaxBytes: resolveServerRoutedTransferOpenPayloadMaxBytes(),
    },
  };
}
