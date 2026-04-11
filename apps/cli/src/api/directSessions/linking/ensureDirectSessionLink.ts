import { createHash } from 'node:crypto';
import os from 'node:os';

import {
  AGENTS_CORE,
  type CodexBackendMode,
} from '@happier-dev/agents';
import {
  resolveDirectSessionsSourceKey,
  type AgentRuntimeDescriptorV1,
  type DirectSessionsProviderId,
  type DirectSessionsSource,
} from '@happier-dev/protocol';

import { getDirectSessionProviderOps } from '@/backends/catalog';
import type { Credentials } from '@/persistence';
import { fetchSessionById, fetchSessionsPage, getOrCreateSessionByTag } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null) return null;
  const s = String(value ?? '').trim();
  return s.length > 0 ? s : null;
}

function asMetadataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveSessionSummaryTitle(metadata: Readonly<Record<string, unknown>>): string | null {
  const summary = asMetadataRecord(metadata.summary);
  return normalizeNullableString(summary?.text);
}

function resolveDirectRemoteSessionId(metadata: Readonly<Record<string, unknown>>): string | null {
  const directSession = asMetadataRecord(metadata.directSessionV1);
  return normalizeNullableString(directSession?.remoteSessionId);
}

function isMeaningfulSessionTitle(value: unknown, metadata?: Readonly<Record<string, unknown>>): boolean {
  const normalized = normalizeNullableString(value);
  if (!normalized) return false;
  if (normalized.toLowerCase() === 'unknown') return false;
  const remoteSessionId = metadata ? resolveDirectRemoteSessionId(metadata) : null;
  if (remoteSessionId && normalized === remoteSessionId) return false;
  return true;
}

function resolveRefreshedDirectSessionMetadata(params: Readonly<{
  currentMetadata: Readonly<Record<string, unknown>>;
  titleHint?: string | null;
  directoryHint?: string | null;
}>): Record<string, unknown> | null {
  const titleHint = normalizeNullableString(params.titleHint);
  const directoryHint = normalizeNullableString(params.directoryHint);

  let didChange = false;
  const nextMetadata: Record<string, unknown> = { ...params.currentMetadata };

  const currentTitle =
    (isMeaningfulSessionTitle(resolveSessionSummaryTitle(params.currentMetadata), params.currentMetadata)
      ? resolveSessionSummaryTitle(params.currentMetadata)
      : null) ??
    (isMeaningfulSessionTitle(params.currentMetadata.name, params.currentMetadata) ? normalizeNullableString(params.currentMetadata.name) : null);

  if (titleHint && !currentTitle) {
    nextMetadata.name = titleHint;
    didChange = true;
  }

  const currentPath = normalizeNullableString(params.currentMetadata.path);
  if (directoryHint && !currentPath) {
    nextMetadata.path = directoryHint;
    didChange = true;
  }

  return didChange ? nextMetadata : null;
}

async function refreshExistingDirectSessionMetadataIfNeeded(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  titleHint?: string | null;
  directoryHint?: string | null;
}>): Promise<void> {
  if (!normalizeNullableString(params.titleHint) && !normalizeNullableString(params.directoryHint)) {
    return;
  }

  const rawSession = await fetchSessionById({
    token: params.credentials.token,
    sessionId: params.sessionId,
  }).catch(() => null);
  if (!rawSession) return;

  const initialMetadata = tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession,
  });
  const initialMetadataRecord = asMetadataRecord(initialMetadata);
  if (!initialMetadataRecord) return;

  const nextMetadata = resolveRefreshedDirectSessionMetadata({
    currentMetadata: initialMetadataRecord,
    titleHint: params.titleHint,
    directoryHint: params.directoryHint,
  });
  if (!nextMetadata) return;

  await updateSessionMetadataWithRetry({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession,
    updater: (currentMetadata) =>
      resolveRefreshedDirectSessionMetadata({
        currentMetadata,
        titleHint: params.titleHint,
        directoryHint: params.directoryHint,
      }) ?? currentMetadata,
  }).catch(() => undefined);
}

function computeDirectSessionTag(params: Readonly<{
  machineId: string;
  providerId: DirectSessionsProviderId;
  remoteSessionId: string;
  source: DirectSessionsSource;
}>): string {
  const sourceKey = resolveDirectSessionsSourceKey(params.source);
  const fingerprint = `${params.machineId}|${params.providerId}|${params.remoteSessionId}|${sourceKey}`;
  return `direct:v1:${sha256Hex(fingerprint)}`;
}

function resolveMaxScanPages(): number {
  const maxPagesRaw = (process.env.HAPPIER_SESSION_ID_PREFIX_SCAN_MAX_PAGES ?? '').trim();
  const maxPagesParsed = maxPagesRaw ? Number.parseInt(maxPagesRaw, 10) : NaN;
  const maxPages = Number.isFinite(maxPagesParsed) && maxPagesParsed > 0 ? Math.min(50, maxPagesParsed) : 10;
  return Math.max(1, maxPages);
}

async function findExistingSessionIdByTag(params: Readonly<{ credentials: Credentials; tag: string }>): Promise<string | null> {
  const maxPages = resolveMaxScanPages();

  const scan = async (archivedOnly: boolean): Promise<string | null> => {
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await fetchSessionsPage({ token: params.credentials.token, cursor, limit: 200, archivedOnly });
      for (const row of page.sessions) {
        const meta = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: row });
        const rowTagRaw = meta?.['tag'];
        const rowTag = typeof rowTagRaw === 'string' ? rowTagRaw.trim() : '';
        if (rowTag && rowTag === params.tag) {
          return row.id;
        }
      }
      if (!page.hasNext || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return null;
  };

  const activeHit = await scan(false);
  if (activeHit) return activeHit;
  return await scan(true);
}

function buildDirectSessionMetadata(params: Readonly<{
  tag: string;
  machineId: string;
  providerId: DirectSessionsProviderId;
  remoteSessionId: string;
  source: DirectSessionsSource;
  codexBackendMode?: CodexBackendMode | null;
  runtimeDescriptor?: AgentRuntimeDescriptorV1 | null;
  vendorMetadata?: Record<string, unknown>;
  directSessionMetadata?: Record<string, unknown>;
  titleHint?: string | null;
  directoryHint?: string | null;
  nowMs: number;
}>): Record<string, unknown> {
  const titleHint = normalizeNullableString(params.titleHint);
  const directoryHint = normalizeNullableString(params.directoryHint) ?? '';
  const resume = AGENTS_CORE[params.providerId].resume;
  const vendorResumeIdField = 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
  const base: Record<string, unknown> = {
    tag: params.tag,
    path: directoryHint,
    host: os.hostname(),
    machineId: params.machineId,
    flavor: params.providerId,
    directSessionV1: {
      v: 1,
      providerId: params.providerId,
      machineId: params.machineId,
      remoteSessionId: params.remoteSessionId,
      source: params.source,
      linkedAtMs: params.nowMs,
      ...(params.codexBackendMode ? { codexBackendMode: params.codexBackendMode } : {}),
      ...(params.directSessionMetadata ?? {}),
      ...(params.runtimeDescriptor ? { agentRuntimeDescriptorV1: params.runtimeDescriptor } : {}),
    },
    ...(vendorResumeIdField ? { [vendorResumeIdField]: params.remoteSessionId } : {}),
    ...(params.vendorMetadata ?? {}),
  };
  if (titleHint) {
    base.name = titleHint;
  }
  if (params.runtimeDescriptor) {
    base.agentRuntimeDescriptorV1 = params.runtimeDescriptor;
  }

  return base;
}

export async function ensureDirectSessionLink(params: Readonly<{
  credentials: Credentials;
  machineId: string;
  providerId: DirectSessionsProviderId;
  remoteSessionId: string;
  source: DirectSessionsSource;
  codexBackendMode?: CodexBackendMode | null;
  runtimeDescriptor?: AgentRuntimeDescriptorV1 | null;
  titleHint?: string | null;
  directoryHint?: string | null;
  nowMs?: () => number;
}>): Promise<{ sessionId: string; created: boolean; tag: string }> {
  const nowMs = params.nowMs ?? (() => Date.now());
  const providerOps = await getDirectSessionProviderOps(params.providerId);
  const linkIdentity = providerOps.resolveLinkIdentity
    ? await providerOps.resolveLinkIdentity({
        remoteSessionId: params.remoteSessionId,
        source: params.source,
        runtimeDescriptor: params.runtimeDescriptor,
        metadata: params.codexBackendMode ? { codexBackendMode: params.codexBackendMode } : undefined,
      })
    : {
        remoteSessionId: params.remoteSessionId,
        source: params.source,
        runtimeDescriptor: params.runtimeDescriptor ?? null,
      };
  const remoteSessionId = linkIdentity.remoteSessionId;
  const source = linkIdentity.source;
  const codexBackendMode = typeof linkIdentity.vendorMetadata?.codexBackendMode === 'string'
    ? linkIdentity.vendorMetadata.codexBackendMode as CodexBackendMode
    : params.codexBackendMode ?? null;
  const runtimeDescriptor = linkIdentity.runtimeDescriptor ?? params.runtimeDescriptor ?? null;

  const tag = computeDirectSessionTag({
    machineId: params.machineId,
    providerId: params.providerId,
    remoteSessionId,
    source,
  });
  const existingSessionId = await findExistingSessionIdByTag({ credentials: params.credentials, tag });
  if (existingSessionId) {
    await refreshExistingDirectSessionMetadataIfNeeded({
      credentials: params.credentials,
      sessionId: existingSessionId,
      titleHint: params.titleHint,
      directoryHint: params.directoryHint,
    });
    return { sessionId: existingSessionId, created: false, tag };
  }

  const metadata = buildDirectSessionMetadata({
    tag,
    machineId: params.machineId,
    providerId: params.providerId,
    remoteSessionId,
    source,
    codexBackendMode,
    runtimeDescriptor,
    vendorMetadata: linkIdentity.vendorMetadata,
    directSessionMetadata: linkIdentity.directSessionMetadata,
    titleHint: params.titleHint,
    directoryHint: params.directoryHint,
    nowMs: nowMs(),
  });

  const { session } = await getOrCreateSessionByTag({
    credentials: params.credentials,
    tag,
    metadata,
    agentState: null,
  });

  return { sessionId: session.id, created: true, tag };
}
