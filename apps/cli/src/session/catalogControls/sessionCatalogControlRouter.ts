import {
  inferAgentIdFromSessionMetadata,
  type AgentId,
} from '@happier-dev/agents';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { getSessionCatalogControlAdapter } from '@/backends/catalog';
import type { Credentials } from '@/persistence';
import { resolveMachineControlLocalityProof } from '@/session/machineControlLocality';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type {
  ResolveSessionCatalogControlAdapter,
  SessionCatalogControlAdapterParams,
  SessionCatalogControlOperation,
} from './sessionCatalogControlTypes';

type RouteSessionCatalogControlParams = Readonly<{
  token: string;
  credentials?: Credentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown> | null;
  currentMachineId: string | null;
  currentMachineHost?: string | null;
  currentMachineHomeDir?: string | null;
  ctx: SessionEncryptionContext;
  mode: SessionStoredContentEncryptionMode;
  operation: SessionCatalogControlOperation;
  cwd?: string;
  callLiveSessionRpc: () => Promise<unknown>;
  resolveAdapter?: ResolveSessionCatalogControlAdapter;
}>;

function unsupported(operation: SessionCatalogControlOperation, diagnostic: string): unknown {
  return operation === 'vendorPlugins'
    ? { unsupported: true, vendorPlugins: [], diagnostic }
    : { unsupported: true, skills: [], diagnostic };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveRawSessionString(rawSession: RawSessionRecord, key: 'path' | 'machineId' | 'host' | 'homeDir'): string | null {
  return readString((rawSession as Partial<Record<typeof key, unknown>>)[key]);
}

function resolveSessionMachineHost(
  metadata: Record<string, unknown>,
  rawSession: RawSessionRecord,
): string | null {
  return readString(metadata.host) ?? resolveRawSessionString(rawSession, 'host');
}

function resolveSessionMachineHomeDir(
  metadata: Record<string, unknown>,
  rawSession: RawSessionRecord,
): string | null {
  return readString(metadata.homeDir) ?? resolveRawSessionString(rawSession, 'homeDir');
}

function resolveAgentId(metadata: Record<string, unknown>): AgentId | null {
  return inferAgentIdFromSessionMetadata(metadata);
}

function shouldFallbackFromLiveSessionCatalogRpc(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const raw = result as Record<string, unknown>;
  const errorCode = typeof raw.errorCode === 'string' ? raw.errorCode : '';
  const error = typeof raw.error === 'string' ? raw.error : '';
  return errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
    || errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
    || errorCode === 'unsupported_session_runtime_method'
    || errorCode === 'session_rpc_failed'
    || error === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
    || error === RPC_ERROR_CODES.METHOD_NOT_FOUND
    || error === 'unsupported_session_runtime_method'
    || error === 'session_rpc_failed';
}

function buildAdapterParams(
  params: RouteSessionCatalogControlParams,
  metadata: Record<string, unknown>,
  sessionMachineId: string,
): SessionCatalogControlAdapterParams {
  return {
    token: params.token,
    ...(params.credentials ? { credentials: params.credentials } : {}),
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    metadata,
    currentMachineId: params.currentMachineId,
    sessionMachineId,
    cwd: readString(params.cwd) ?? resolveRawSessionString(params.rawSession, 'path') ?? readString(metadata.path),
    ctx: params.ctx,
    mode: params.mode,
  };
}

export async function routeSessionCatalogControl(params: RouteSessionCatalogControlParams): Promise<unknown> {
  if (params.rawSession.active === true) {
    const liveResult = await params.callLiveSessionRpc();
    if (!shouldFallbackFromLiveSessionCatalogRpc(liveResult)) {
      return liveResult;
    }
  }

  const metadata = params.metadata;
  if (!metadata) {
    return unsupported(params.operation, 'session_catalog_control_metadata_unavailable');
  }

  const currentMachineId = readString(params.currentMachineId);
  if (!currentMachineId) {
    return unsupported(params.operation, 'session_catalog_control_current_machine_unknown');
  }

  const sessionMachineId = readString(metadata.machineId) ?? resolveRawSessionString(params.rawSession, 'machineId');
  if (!sessionMachineId) {
    return unsupported(params.operation, 'session_catalog_control_session_machine_unknown');
  }
  if (
    sessionMachineId !== currentMachineId
    && !resolveMachineControlLocalityProof({
      sessionMachineId,
      currentMachineId,
      sessionHost: resolveSessionMachineHost(metadata, params.rawSession),
      sessionHomeDir: resolveSessionMachineHomeDir(metadata, params.rawSession),
      currentMachineHost: params.currentMachineHost,
      currentMachineHomeDir: params.currentMachineHomeDir,
    })
  ) {
    return unsupported(params.operation, 'session_catalog_control_remote_unavailable');
  }

  const resolveAdapter = params.resolveAdapter ?? getSessionCatalogControlAdapter;
  const adapter = await resolveAdapter(resolveAgentId(metadata));
  if (!adapter) {
    return unsupported(params.operation, 'session_catalog_control_unsupported');
  }

  const adapterParams = buildAdapterParams(params, metadata, sessionMachineId);
  if (params.operation === 'vendorPlugins') {
    return typeof adapter.listVendorPlugins === 'function'
      ? await adapter.listVendorPlugins(adapterParams)
      : unsupported(params.operation, 'session_catalog_control_unsupported');
  }
  return typeof adapter.listSkills === 'function'
    ? await adapter.listSkills(adapterParams)
    : unsupported(params.operation, 'session_catalog_control_unsupported');
}
