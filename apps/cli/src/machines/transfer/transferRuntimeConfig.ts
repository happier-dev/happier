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
const DEFAULT_DIRECT_PEER_IDLE_STOP_MS = 30_000;
const DIRECT_PEER_IDLE_STOP_HARD_MAX_MS = 10 * 60_000;
const DEFAULT_DIRECT_PEER_OPEN_BODY_MAX_BYTES = 64 * 1024;
const DIRECT_PEER_OPEN_BODY_HARD_MAX_BYTES = 1024 * 1024;
const DEFAULT_DIRECT_PEER_BIND_HOST = '127.0.0.1';
const DEFAULT_DIRECT_PEER_BIND_PORT = 46001;
const DEFAULT_DIRECT_PEER_EXPIRY_SKEW_MS = 2_000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TRANSFER_MAX_ACTIVE_TRANSFERS = 128;
const TRANSFER_MAX_ACTIVE_TRANSFERS_HARD_MAX = 10_000;
const DEFAULT_TRANSFER_CHUNK_BYTES = 256 * 1024;
const DEFAULT_TRANSFER_OPEN_PAYLOAD_MAX_BYTES = 64 * 1024;
const TRANSFER_OPEN_PAYLOAD_HARD_MAX_BYTES = 64 * 1024;
const DEFAULT_TRANSFER_TAILSCALE_SERVE_ENABLED = false;
const DEFAULT_TRANSFER_TAILSCALE_SERVE_PATH = '/__happier/transfer';
const DEFAULT_TRANSFER_TAILSCALE_SERVE_HTTPS_PORT = 443;

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

function normalizeServePath(value: string | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '/') {
    return '/';
  }
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  return prefixed.replace(/\/+$/, '') || '/';
}

export function resolveDirectPeerFeatureEnabled(): boolean {
  return parseBooleanEnv(process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED, true);
}

export function resolveDirectPeerServerEnabled(): boolean {
  return resolveDirectPeerFeatureEnabled()
    && parseBooleanEnv(process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED, true);
}

export function resolveDirectPeerAdvertisedHosts(_networkInterfacesFn: typeof networkInterfaces = networkInterfaces): string[] {
  // Plain HTTP transfer is loopback-only. Legacy LAN advertisement inputs remain accepted by
  // callers but cannot alter the current listener/advertisement posture.
  return [DEFAULT_DIRECT_PEER_BIND_HOST];
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
  return readPositiveIntEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT', DEFAULT_DIRECT_PEER_BIND_PORT) ?? DEFAULT_DIRECT_PEER_BIND_PORT;
}

export function resolveDirectPeerTransferIdleStopMs(): number {
  return Math.min(
    readPositiveIntEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_IDLE_STOP_MS', DEFAULT_DIRECT_PEER_IDLE_STOP_MS),
    DIRECT_PEER_IDLE_STOP_HARD_MAX_MS,
  );
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

export function resolveDirectPeerTransferBindHost(_configuredHost?: string): string {
  // Keep one exact loopback upstream so Tailscale Serve and the HTTP listener cannot diverge.
  return DEFAULT_DIRECT_PEER_BIND_HOST;
}

export function resolveTransferTailscaleServeEnabled(): boolean {
  return parseBooleanEnv(
    process.env.HAPPIER_MACHINE_TRANSFER_TAILSCALE_SERVE_ENABLED,
    DEFAULT_TRANSFER_TAILSCALE_SERVE_ENABLED,
  );
}

export function resolveTransferTailscaleServePath(): string {
  return normalizeServePath(process.env.HAPPIER_MACHINE_TRANSFER_TAILSCALE_SERVE_PATH ?? DEFAULT_TRANSFER_TAILSCALE_SERVE_PATH);
}

export function resolveTransferTailscaleServeHttpsPort(): number {
  return readPositiveIntEnv(
    'HAPPIER_MACHINE_TRANSFER_TAILSCALE_SERVE_HTTPS_PORT',
    DEFAULT_TRANSFER_TAILSCALE_SERVE_HTTPS_PORT,
  ) ?? DEFAULT_TRANSFER_TAILSCALE_SERVE_HTTPS_PORT;
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
    idleStopMs: number;
    chunkBytes: number;
    expirySkewMs: number;
    openBodyMaxBytes: number;
    maxTotalChunks: number;
    publishedTransferRegistryMaxEntries: number;
    bindHost: string;
    featureEnabled: boolean;
    serverEnabled: boolean;
  }>;
  tailscaleServe: Readonly<{
    enabled: boolean;
    servePath: string;
    httpsPort: number;
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
      idleStopMs: resolveDirectPeerTransferIdleStopMs(),
      chunkBytes: resolveDirectPeerTransferChunkBytes(),
      expirySkewMs: resolveDirectPeerTransferExpirySkewMs(),
      openBodyMaxBytes: resolveDirectPeerTransferOpenBodyMaxBytes(),
      maxTotalChunks: resolveDirectPeerTransferMaxTotalChunks(),
      publishedTransferRegistryMaxEntries: resolveDirectPeerTransferPublishedTransferRegistryMaxEntries(),
      bindHost: resolveDirectPeerTransferBindHost(),
      featureEnabled: resolveDirectPeerFeatureEnabled(),
      serverEnabled: resolveDirectPeerServerEnabled(),
    },
    tailscaleServe: {
      enabled: resolveTransferTailscaleServeEnabled(),
      servePath: resolveTransferTailscaleServePath(),
      httpsPort: resolveTransferTailscaleServeHttpsPort(),
    },
    serverRouted: {
      timeoutMs: resolveServerRoutedTransferTimeoutMs(),
      maxActiveTransfers: resolveServerRoutedTransferMaxActiveTransfers(),
      chunkBytes: resolveServerRoutedTransferChunkBytes(),
      openPayloadMaxBytes: resolveServerRoutedTransferOpenPayloadMaxBytes(),
    },
  };
}
