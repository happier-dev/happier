import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type {
  SessionHandle,
} from '@happier-dev/plugin-sdk/sessions';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { SessionSystemRecordDeleteRequestSchema, SessionSystemRecordListQuerySchema, SessionSystemRecordReadRequestSchema, SessionSystemRecordUpsertRequestSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import type { SessionSystemRecordStored } from '@happier-dev/protocol';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext, type ResolveSessionTransportContextResult } from '@/session/services/resolveSessionTransportContext';
import {
  deleteSessionSystemRecordV1,
  listSessionSystemRecordsV1,
  readSessionSystemRecordV1,
  upsertSessionSystemRecordV1,
} from '@/session/transport/http/sessionSystemRecordsHttp';
import {
  openSessionSystemRecord,
  sealSessionSystemRecordContent,
  validateSessionSystemRecordOpenedContent,
} from './sessionSystemRecordCodec';

type PluginSessionSystemRecordsService = Pick<
  SessionHandle,
  'listSystemRecords' | 'upsertSystemRecord' | 'readSystemRecord' | 'deleteSystemRecord'
>;

type ResolvedSessionTransportContext = Extract<ResolveSessionTransportContextResult, { ok: true }>;

type CreatePluginSessionSystemRecordsServiceParams = Readonly<{
  credentials: StoredCredentials;
  readCredentials?: () => Promise<StoredCredentials | null>;
  pluginId: string;
  sessionId: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}>;

function pluginError(
  code: string,
  message: string,
  options?: Readonly<{ retryable?: boolean; details?: Record<string, string> }>,
): PluginError {
  return new PluginError({
    code,
    message,
    ...(options?.retryable === undefined ? {} : { retryable: options.retryable }),
    ...(options?.details === undefined ? {} : { details: options.details }),
  });
}

function isCurrent(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

function combineSignals(lifetimeSignal: AbortSignal, callerSignal?: AbortSignal): AbortSignal {
  if (!callerSignal || callerSignal === lifetimeSignal) return lifetimeSignal;
  return AbortSignal.any([lifetimeSignal, callerSignal]);
}

function assertCurrent(params: CreatePluginSessionSystemRecordsServiceParams, signal: AbortSignal): void {
  if (signal.aborted) {
    throw pluginError('plugin_operation_aborted', 'Session system record operation was aborted');
  }
  if (!isCurrent(params.isCurrent)) {
    throw pluginError('plugin_generation_retired', 'Session system record operation belongs to a retired plugin generation');
  }
}

function assertMutationOutcomeCurrent(
  params: CreatePluginSessionSystemRecordsServiceParams,
  signal: AbortSignal,
): void {
  if (signal.aborted || !isCurrent(params.isCurrent)) {
    throw pluginError(
      'plugin_session_record_outcome_unknown',
      'Session system record mutation may have committed before its invocation retired',
    );
  }
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function mapTransportFailure(error: unknown): PluginError {
  if (isPluginError(error)) return error;
  const code = readStringField(error, 'code');
  const currentRevision = readStringField(error, 'currentRevision');
  const knownCode = code && new Set([
    'plugin_session_records_unavailable',
    'plugin_session_record_invalid_query',
    'plugin_session_record_forbidden',
    'plugin_session_not_found',
    'plugin_session_record_address_collision',
    'plugin_session_record_kind_conflict',
    'plugin_session_record_revision_conflict',
    'plugin_session_record_revision_exhausted',
    'plugin_session_record_outcome_unknown',
    'plugin_session_record_invalid_response',
  ]).has(code)
    ? code
    : 'plugin_session_records_unavailable';
  return pluginError(
    knownCode,
    'Session system record request failed',
    {
      retryable: knownCode === 'plugin_session_records_unavailable',
      ...(currentRevision ? { details: { currentRevision } } : {}),
    },
  );
}

async function readCredentials(
  params: CreatePluginSessionSystemRecordsServiceParams,
  signal: AbortSignal,
): Promise<StoredCredentials> {
  assertCurrent(params, signal);
  let credentials: StoredCredentials | null;
  try {
    credentials = params.readCredentials
      ? await params.readCredentials()
      : params.credentials;
  } catch (error) {
    assertCurrent(params, signal);
    throw mapTransportFailure(error);
  }
  assertCurrent(params, signal);
  if (!credentials) {
    throw pluginError(
      'plugin_session_records_not_authenticated',
      'Session system records require current account credentials',
    );
  }
  return credentials;
}

async function assertProtocolV1(
  params: CreatePluginSessionSystemRecordsServiceParams,
  signal: AbortSignal,
): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof fetchServerFeaturesSnapshot>>;
  try {
    snapshot = await fetchServerFeaturesSnapshot({
      serverUrl: resolveServerHttpBaseUrl(),
      signal,
    });
  } catch (error) {
    assertCurrent(params, signal);
    throw mapTransportFailure(error);
  }
  assertCurrent(params, signal);
  const versions = snapshot.status === 'ready'
    ? snapshot.features.capabilities.session.systemRecords?.protocolVersions
    : undefined;
  if (!versions || versions.length !== 1 || versions[0] !== 1) {
    throw pluginError(
      'plugin_session_records_unavailable',
      'Session system records protocol version 1 is unavailable on this server',
    );
  }
}

async function resolveContext(
  params: CreatePluginSessionSystemRecordsServiceParams,
  credentials: StoredCredentials,
  signal: AbortSignal,
): Promise<ResolvedSessionTransportContext> {
  let result: ResolveSessionTransportContextResult;
  try {
    result = await resolveSessionTransportContext({
      credentials,
      idOrPrefix: params.sessionId,
      signal,
    });
  } catch (error) {
    assertCurrent(params, signal);
    throw mapTransportFailure(error);
  }
  assertCurrent(params, signal);
  if (!result.ok) {
    if (result.code === 'encryption_material_unavailable') {
      throw pluginError(
        'plugin_session_record_encryption_unavailable',
        'Session system records require current Session encryption material',
      );
    }
    if (result.code === 'session_not_found') {
      throw pluginError('plugin_session_not_found', 'Session is not available to this account');
    }
    throw pluginError('plugin_session_record_invalid_request', 'Session system record handle is no longer bound to one Session');
  }
  if (result.sessionId !== params.sessionId) {
    throw pluginError('plugin_session_record_invalid_response', 'Session record resolution changed the bound Session identity');
  }
  return result;
}

function parseRequest<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  request: unknown,
): T {
  const parsed = schema.safeParse(request);
  if (!parsed.success || parsed.data === undefined) {
    throw pluginError('plugin_session_record_invalid_request', 'Invalid Session system record request');
  }
  return parsed.data;
}

export function createPluginSessionSystemRecordsService(
  params: CreatePluginSessionSystemRecordsServiceParams,
): PluginSessionSystemRecordsService {
  if (!PluginIdSchema.safeParse(params.pluginId).success) {
    throw pluginError('plugin_session_records_unavailable', 'Session system records require a host-stamped plugin identity');
  }

  const prepare = async (options?: PluginCancellationOptions): Promise<Readonly<{
    credentials: StoredCredentials;
    context: ResolvedSessionTransportContext;
    signal: AbortSignal;
  }>> => {
    const signal = combineSignals(params.signal, options?.signal);
    const credentials = await readCredentials(params, signal);
    await assertProtocolV1(params, signal);
    const context = await resolveContext(params, credentials, signal);
    return Object.freeze({ credentials, context, signal });
  };

  return Object.freeze({
    async listSystemRecords(query, options) {
      const parsedQuery = parseRequest(SessionSystemRecordListQuerySchema, query);
      const prepared = await prepare(options);
      let page: Awaited<ReturnType<typeof listSessionSystemRecordsV1>>;
      try {
        page = await listSessionSystemRecordsV1({
          token: prepared.credentials.token,
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          query: parsedQuery,
          signal: prepared.signal,
        });
      } catch (error) {
        assertCurrent(params, prepared.signal);
        throw mapTransportFailure(error);
      }
      assertCurrent(params, prepared.signal);
      const records = page.records.map((stored) => openSessionSystemRecord(prepared.context, stored));
      assertCurrent(params, prepared.signal);
      return Object.freeze({
        records,
        nextCursor: page.nextCursor,
        hasNext: page.hasNext,
      });
    },

    async upsertSystemRecord(request, options) {
      const parsedRequest = parseRequest(SessionSystemRecordUpsertRequestSchema, request);
      const prepared = await prepare(options);
      const content = sealSessionSystemRecordContent(
        prepared.context,
        validateSessionSystemRecordOpenedContent(
          parsedRequest.address,
          parsedRequest.content,
          'plugin_session_record_invalid_request',
        ),
      );
      let stored: SessionSystemRecordStored;
      try {
        stored = await upsertSessionSystemRecordV1({
          token: prepared.credentials.token,
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          request: {
            address: parsedRequest.address,
            content,
            ...(parsedRequest.expectedRevision === undefined ? {} : { expectedRevision: parsedRequest.expectedRevision }),
          },
          signal: prepared.signal,
        });
      } catch (error) {
        assertMutationOutcomeCurrent(params, prepared.signal);
        throw mapTransportFailure(error);
      }
      assertMutationOutcomeCurrent(params, prepared.signal);
      const record = openSessionSystemRecord(prepared.context, stored);
      assertMutationOutcomeCurrent(params, prepared.signal);
      return record;
    },

    async readSystemRecord(request, options) {
      const parsedRequest = parseRequest(SessionSystemRecordReadRequestSchema, request);
      const prepared = await prepare(options);
      let stored: SessionSystemRecordStored | null;
      try {
        stored = await readSessionSystemRecordV1({
          token: prepared.credentials.token,
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          address: parsedRequest.address,
          signal: prepared.signal,
        });
      } catch (error) {
        assertCurrent(params, prepared.signal);
        throw mapTransportFailure(error);
      }
      assertCurrent(params, prepared.signal);
      if (!stored) return null;
      const record = openSessionSystemRecord(prepared.context, stored);
      assertCurrent(params, prepared.signal);
      return record;
    },

    async deleteSystemRecord(request, options) {
      const parsedRequest = parseRequest(SessionSystemRecordDeleteRequestSchema, request);
      const prepared = await prepare(options);
      try {
        await deleteSessionSystemRecordV1({
          token: prepared.credentials.token,
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          request: parsedRequest,
          signal: prepared.signal,
        });
      } catch (error) {
        assertMutationOutcomeCurrent(params, prepared.signal);
        throw mapTransportFailure(error);
      }
      assertMutationOutcomeCurrent(params, prepared.signal);
    },
  });
}
