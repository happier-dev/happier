import { createHash, createHmac } from 'node:crypto';
import {
  createSessionSubagentCustodyKeyV1,
  createSessionSubagentCustodyPlainContentFingerprintV1,
  serializeSessionSubagentCustodyEncryptedFingerprintInputV1,
  SessionIndexedIdentifierMaxLengthV1,
  SessionSubagentCustodyMutationRequestV1Schema,
  type SessionSubagentCustodyContentFingerprintV1,
  type SessionSubagentCustodyContentV1,
  type SessionSubagentCustodyRecordV1,
} from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import type { StoredCredentials } from '@/persistence';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import {
  encryptStoredSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type {
  PluginSubagentDurableCustody,
  PluginSubagentDurableSummary,
  PluginSubagentHostIdentity,
} from './pluginSubagentsService';
import {
  listSessionSubagentCustody,
  mutateSessionSubagentCustody,
  probeSessionSubagentCustody,
  retireSessionSubagentCustodyGeneration,
  SessionSubagentCustodyHttpError,
} from '@/session/transport/http/sessionSubagentCustodyHttp';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function encryptedContentFingerprint(params: Readonly<{
  key: Uint8Array;
  sessionId: string;
  custodyKey: string;
  detail: JsonValue;
}>): `hmac-sha256:${string}` {
  const value = createHmac('sha256', params.key)
    .update(serializeSessionSubagentCustodyEncryptedFingerprintInputV1({
      sessionId: params.sessionId,
      custodyKey: params.custodyKey,
      detail: params.detail,
    }), 'utf8')
    .digest('hex');
  return `hmac-sha256:${value}`;
}

function boundedOperationId(value: string): string {
  const prefix = 'plugin-operation-v1:sha256:';
  return value.length <= SessionIndexedIdentifierMaxLengthV1 && !value.startsWith(prefix)
    ? value
    : `${prefix}${digest(value)}`;
}

function boundedGroupId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const prefix = 'plugin-group-v1:sha256:';
  const probe = SessionSubagentCustodyMutationRequestV1Schema.safeParse({
    operationId: 'probe', scope: { pluginId: 'acme.probe', contributionId: 'probe', immutableGenerationId: 'probe' },
    custodyKey: `sha256:${'0'.repeat(64)}`, subagentId: 'probe', groupId: value,
    expectedRevision: null, status: 'running', content: { t: 'plain', v: null },
    contentFingerprint: createSessionSubagentCustodyPlainContentFingerprintV1(null),
  });
  return probe.success && !value.startsWith(prefix) ? value : `${prefix}${digest(value)}`;
}

function project(record: SessionSubagentCustodyRecordV1, parentSessionId: string): PluginSubagentDurableSummary {
  return Object.freeze({
    id: record.subagentId,
    parentSessionId,
    ...(record.groupId === null ? {} : { groupId: record.groupId }),
    status: record.status === 'pending' ? 'starting' : record.status,
    revision: String(record.revision),
    updatedAtMs: record.updatedAt,
  });
}

function fail(error: unknown): never {
  const code = error instanceof SessionSubagentCustodyHttpError
    ? error.code
    : 'plugin_subagent_durable_custody_unavailable';
  throw new PluginError({ code, message: code });
}

function aborted(): SessionSubagentCustodyHttpError {
  return new SessionSubagentCustodyHttpError('plugin_operation_aborted');
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw aborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function createServerPluginSubagentDurableCustody(params: Readonly<{
  credentials: StoredCredentials;
  readCredentials?: () => Promise<StoredCredentials | null>;
  identity: PluginSubagentHostIdentity;
}>): PluginSubagentDurableCustody {
  const scope = Object.freeze({
    pluginId: params.identity.pluginId,
    contributionId: params.identity.contributionId,
    immutableGenerationId: params.identity.immutableGenerationId,
  });
  const key = createSessionSubagentCustodyKeyV1({ ...scope, sessionId: params.identity.parentSessionId });
  let capability: 'unknown' | 'available' = 'unknown';
  let capabilityPromise: Promise<void> | null = null;

  const readCurrentCredentials = async (signal?: AbortSignal): Promise<StoredCredentials> => {
    if (signal?.aborted) throw aborted();
    const credentials = params.readCredentials ? await params.readCredentials() : params.credentials;
    if (signal?.aborted) throw aborted();
    if (!credentials) {
      throw new PluginError({
        code: 'plugin_subagent_credentials_unavailable',
        message: 'Plugin subagent credentials are unavailable',
      });
    }
    return credentials;
  };

  const ensureCapability = async (credentials: StoredCredentials, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw new PluginError({ code: 'plugin_operation_aborted', message: 'plugin_operation_aborted' });
    if (capability === 'available') return;
    if (!capabilityPromise) {
      let pending!: Promise<void>;
      pending = probeSessionSubagentCustody({
        token: credentials.token,
        sessionId: params.identity.parentSessionId,
      }).then(() => {
        capability = 'available';
      }).catch((error: unknown) => {
        capability = 'unknown';
        throw error;
      }).finally(() => {
        if (capabilityPromise === pending) capabilityPromise = null;
      });
      capabilityPromise = pending;
    }
    try {
      await awaitWithAbort(capabilityPromise, signal);
    } catch (error) {
      fail(error);
    }
  };

  const buildContent = async (
    credentials: StoredCredentials,
    detail: JsonValue | undefined,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    content: SessionSubagentCustodyContentV1;
    contentFingerprint: SessionSubagentCustodyContentFingerprintV1;
  }>> => {
    const payload = detail ?? null;
    const rawSession = await awaitWithAbort(fetchSessionById({
      token: credentials.token,
      sessionId: params.identity.parentSessionId,
    }), signal);
    if (signal?.aborted) throw aborted();
    if (!rawSession) fail(new SessionSubagentCustodyHttpError('plugin_subagent_durable_custody_unavailable'));
    if (rawSession.id !== params.identity.parentSessionId) {
      throw new SessionSubagentCustodyHttpError('plugin_subagent_server_response_invalid');
    }
    const mode = resolveSessionStoredContentEncryptionMode(rawSession);
    if (mode === 'plain') {
      return {
        content: { t: 'plain', v: payload },
        contentFingerprint: createSessionSubagentCustodyPlainContentFingerprintV1(payload),
      };
    }
    const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
    if (!ctx) {
      throw new SessionSubagentCustodyHttpError('encryption_material_unavailable');
    }
    return {
      content: {
        t: 'encrypted',
        c: encryptStoredSessionPayload({ mode, ctx, payload }),
      },
      contentFingerprint: encryptedContentFingerprint({
        key: ctx.encryptionKey,
        sessionId: params.identity.parentSessionId,
        custodyKey: key,
        detail: payload,
      }),
    };
  };

  return Object.freeze({
    normalizeGroupId(groupId) {
      return boundedGroupId(groupId)!;
    },
    availability() {
      return capability === 'available'
        ? Object.freeze({ status: 'available' as const })
        : Object.freeze({ status: 'unavailable' as const, code: 'plugin_subagent_durable_custody_unverified' });
    },
    async list(options) {
      const credentials = await readCurrentCredentials(options.signal);
      await ensureCapability(credentials, options.signal);
      try {
        const records = await listSessionSubagentCustody({
          token: credentials.token,
          sessionId: params.identity.parentSessionId,
          scope,
          custodyKey: key,
          signal: options.signal,
        });
        return Object.freeze(records.map((record) => project(record, params.identity.parentSessionId)));
      } catch (error) {
        fail(error);
      }
    },
    async mutate(input) {
      const credentials = await readCurrentCredentials(input.signal);
      await ensureCapability(credentials, input.signal);
      try {
        const { content, contentFingerprint } = await buildContent(credentials, input.detail, input.signal);
        if (input.signal?.aborted) throw aborted();
        let expectedRevision: number | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const result = await mutateSessionSubagentCustody({
              token: credentials.token,
              sessionId: params.identity.parentSessionId,
              request: {
                operationId: boundedOperationId(input.operationId),
                scope,
                custodyKey: key,
                subagentId: input.subagentId,
                groupId: boundedGroupId(input.groupId),
                expectedRevision,
                status: input.status === 'starting' ? 'pending' : input.status,
                contentFingerprint,
                content,
              },
              signal: input.signal,
            });
            if (
              result.record.subagentId !== input.subagentId
              || result.record.groupId !== boundedGroupId(input.groupId)
              || result.record.status !== (input.status === 'starting' ? 'pending' : input.status)
              || (!result.replayed && result.record.revision !== (expectedRevision === null ? 0 : expectedRevision + 1))
            ) {
              throw new SessionSubagentCustodyHttpError('plugin_subagent_server_response_invalid');
            }
            return project(result.record, params.identity.parentSessionId);
          } catch (error) {
            if (
              attempt !== 0
              || !(error instanceof SessionSubagentCustodyHttpError)
              || error.code !== 'plugin_subagent_revision_conflict'
            ) throw error;
            const records = await listSessionSubagentCustody({
              token: credentials.token,
              sessionId: params.identity.parentSessionId,
              scope,
              custodyKey: key,
              signal: input.signal,
            });
            const current = records.find((record) => record.subagentId === input.subagentId);
            expectedRevision = current?.revision ?? null;
          }
        }
        throw new SessionSubagentCustodyHttpError('plugin_subagent_revision_conflict');
      } catch (error) {
        fail(error);
      }
    },
    async retire(options = {}) {
      const credentials = await readCurrentCredentials(options.signal);
      await ensureCapability(credentials, options.signal);
      try {
        await retireSessionSubagentCustodyGeneration({
          token: credentials.token,
          pluginId: scope.pluginId,
          immutableGenerationId: scope.immutableGenerationId,
          signal: options.signal,
        });
      } catch (error) {
        fail(error);
      }
    },
  });
}
