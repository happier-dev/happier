import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { routeSessionCatalogControl as routeCatalogControl, unavailableSessionCatalog } from '@happier-dev/session-core/state';

import { resolveInactiveSessionCatalogControls } from '@/agent/catalog/sessionControlAdapters';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { StoredCredentials } from '@/persistence';
import {
  resolveMachineControlLocalityProof,
  resolveSessionMachineWorkspacePath,
} from '@/session/machineControlLocality';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type {
  ResolveSessionCatalogControlAdapter,
  SessionCatalogControlAdapterParams,
  SessionCatalogControlOperation,
} from './sessionCatalogControlTypes';

type RouteSessionCatalogControlParams = Readonly<{
  token: string;
  credentials?: StoredCredentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown> | null;
  currentMachineId: string | null;
  currentMachineHost?: string | null;
  currentMachineHomeDir?: string | null;
  operation: SessionCatalogControlOperation;
  cwd?: string;
  callLiveSessionRpc: () => Promise<unknown>;
  resolveAdapter?: ResolveSessionCatalogControlAdapter;
}> & SessionStoredContentCryptoContext;

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

function resolveAgentId(metadata: Record<string, unknown>): CatalogAgentId | null {
  return resolveAgentIdFromSessionMetadata(metadata);
}

function buildAdapterParams(
  params: RouteSessionCatalogControlParams,
  metadata: Record<string, unknown>,
  sessionMachineId: string,
): SessionCatalogControlAdapterParams {
  const base = {
    token: params.token,
    ...(params.credentials ? { credentials: params.credentials } : {}),
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    metadata,
    currentMachineId: params.currentMachineId,
    sessionMachineId,
    cwd: resolveSessionMachineWorkspacePath({
      metadata,
      currentMachineId: params.currentMachineId,
      candidatePath: readString(params.cwd)
        ?? resolveRawSessionString(params.rawSession, 'path')
        ?? readString(metadata.path),
    }),
  } as const;
  return params.mode === 'plain'
    ? { ...base, mode: params.mode, ctx: params.ctx }
    : { ...base, mode: params.mode, ctx: params.ctx };
}

export async function routeSessionCatalogControl(params: RouteSessionCatalogControlParams): Promise<unknown> {
  const metadata = params.metadata;
  return await routeCatalogControl({
    active: params.rawSession.active === true,
    metadataAvailable: metadata !== null,
    operation: params.operation,
    callLiveSessionRpc: params.callLiveSessionRpc,
    ...(metadata ? { callInactiveCatalog: () => readInactiveSessionCatalog(params, metadata) } : {}),
  });
}

async function readInactiveSessionCatalog(
  params: RouteSessionCatalogControlParams,
  metadata: Record<string, unknown>,
): Promise<unknown> {
  const currentMachineId = readString(params.currentMachineId);
  if (!currentMachineId) {
    return unavailableSessionCatalog(params.operation, 'session_catalog_control_current_machine_unknown');
  }

  const sessionMachineId = readString(metadata.machineId) ?? resolveRawSessionString(params.rawSession, 'machineId');
  if (!sessionMachineId) {
    return unavailableSessionCatalog(params.operation, 'session_catalog_control_session_machine_unknown');
  }
  if (
    !await resolveMachineControlLocalityProof({
      sessionMachineId,
      currentMachineId,
      sessionHost: resolveSessionMachineHost(metadata, params.rawSession),
      sessionHomeDir: resolveSessionMachineHomeDir(metadata, params.rawSession),
      currentMachineHost: params.currentMachineHost,
      currentMachineHomeDir: params.currentMachineHomeDir,
      credentials: { token: params.token },
    })
  ) {
    return unavailableSessionCatalog(params.operation, 'session_catalog_control_remote_unavailable');
  }

  const resolveAdapter = params.resolveAdapter ?? resolveInactiveSessionCatalogControls;
  const adapter = await resolveAdapter(resolveAgentId(metadata));
  if (!adapter) {
    return unavailableSessionCatalog(params.operation, 'session_catalog_control_unsupported');
  }

  const adapterParams = buildAdapterParams(params, metadata, sessionMachineId);
  if (params.operation === 'vendorPlugins') {
    return typeof adapter.listVendorPlugins === 'function'
      ? await adapter.listVendorPlugins(adapterParams)
      : unavailableSessionCatalog(params.operation, 'session_catalog_control_unsupported');
  }
  return typeof adapter.listSkills === 'function'
    ? await adapter.listSkills(adapterParams)
    : unavailableSessionCatalog(params.operation, 'session_catalog_control_unsupported');
}
