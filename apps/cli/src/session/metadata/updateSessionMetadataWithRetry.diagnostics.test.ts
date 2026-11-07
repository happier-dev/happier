import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { readSessionMetadataTupleWriterSnapshot, updateSessionMetadataEnvelopeTupleWithRetry } from './updateSessionMetadataWithRetry';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { reportSessionRunnerFailure } from '@/cli/resolveSessionRunnerFailureExitCode';
import { SessionActionConfirmationsV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';
import { SessionDetailInvalidResponseError } from '@/session/transport/http/sessionDetailInvalidResponse';
import { updateMetadataWithExternalSessionFollowStatus } from '@/api/session/external/backgroundFollow/externalSessionBackgroundFollowMetadata';
import { z } from 'zod/mini';

const credentials = { token: 'private-fixture-token', encryption: null };
const accountEncryptionCurrentness = { mode: 'plain' as const, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable' as const, reason: 'plain_account' as const } };

function createRequest() {
  const initialSnapshot = readSessionMetadataTupleWriterSnapshot({ credentials, accountEncryptionCurrentness, rawSession: {
    metadataLayoutVersion: 0, encryptionMode: 'plain', metadata: JSON.stringify({ path: '/private/workspace', host: 'host' }), metadataVersion: 4, ownerMetadata: null, agentState: null, agentStateVersion: 2,
  } });
  if (initialSnapshot.mode !== 'legacy_owner') throw new Error('Expected legacy owner fixture');
  return { token: credentials.token, sessionId: 'diagnostic-session', authority: { kind: 'owner' as const, credentials, accountEncryptionCurrentness }, mode: 'plain' as const, ctx: null, initialSnapshot,
    mutation: { kind: 'metadata' as const, update: (metadata: typeof initialSnapshot.value.metadata) => ({ ...metadata, name: 'private-title' }) } };
}

describe('metadata tuple terminal diagnostics', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(['unchanged', 'committed', 'retired', 'unavailable'] as const)('reconciles an HTTP 500 tuple publication with a %s source through the real transport', async disposition => {
    const request = createRequest();
    let raw = V2SessionByIdResponseSchema.parse({ session: {
      id: request.sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      encryptionMode: 'plain', metadataLayoutVersion: 0,
      metadata: request.initialSnapshot.metadataCiphertext,
      agentState: null, metadataVersion: 4, agentStateVersion: 2, dataEncryptionKey: null,
    } }).session;
    let current = true;
    const patch = vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
      const submitted = SessionMetadataTuplePatchV1Schema.parse(body);
      if (submitted.mode === 'owner') {
        raw = V2SessionByIdResponseSchema.parse({ session: { ...raw,
          metadata: submitted.sharedMetadata.ciphertext, ownerMetadata: submitted.ownerMetadata,
          agentState: submitted.agentState.ciphertext, metadataVersion: 6, agentStateVersion: 3,
          displayProjectionV1: submitted.displayProjectionV1 ?? null,
        } }).session;
        return { status: 200, data: { success: true, metadataLayoutVersion: 1,
          sharedMetadata: { version: 6 }, agentState: { version: 3 } } };
      }
      if (submitted.mode !== 'owner_migration') throw new Error('Expected owner migration');
      if (disposition === 'committed' || (disposition !== 'unavailable' && patch.mock.calls.length > 1)) {
        raw = V2SessionByIdResponseSchema.parse({ session: { ...raw,
          metadataLayoutVersion: 1, metadata: submitted.target.sharedMetadata.ciphertext,
          ownerMetadata: submitted.target.ownerMetadata, agentState: submitted.target.agentState.ciphertext,
          ...(submitted.target.displayProjectionV1 ? { displayProjectionV1: submitted.target.displayProjectionV1 } : {}),
          metadataVersion: 5, agentStateVersion: 3, share: null,
        } }).session;
      }
      if (patch.mock.calls.length === 1 || disposition === 'unavailable') return { status: 500, data: { code: 'internal_error' } };
      return { status: 200, data: { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: 5 }, agentState: { version: 3 } } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).includes('/v1/account/encryption/currentness')) return { status: 200, data: accountEncryptionCurrentness };
      if (disposition === 'unavailable') throw new Error('authoritative Session read unavailable');
      if (disposition === 'retired') current = false;
      return { status: 200, data: { session: raw } };
    });
    const run = updateSessionMetadataEnvelopeTupleWithRetry({ ...request,
      currentness: { verifyCurrent: async () => current } });
    if (disposition === 'unavailable') {
      const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
      const failure: unknown = await run.catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'metadata_tuple_ambiguous', retryable: false });
      const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure }));
      expect(issue).toMatchObject({ code: 'preparation_pending', source: 'dependency_failure' });
      expect(reportSessionRunnerFailure(failure)).toBe(1);
      expect(fatal).not.toHaveBeenCalled();
      expect(patch).toHaveBeenCalledOnce();
    } else if (disposition === 'retired') {
      await expect(run).rejects.toMatchObject({ code: 'session_publisher_authority_lost' });
      expect(patch).toHaveBeenCalledOnce();
    } else {
      await expect(run).resolves.toMatchObject({ metadataVersion: 6, agentStateVersion: 3,
        value: { metadata: { name: 'private-title' } } });
      expect(patch).toHaveBeenCalledTimes(disposition === 'committed' ? 2 : 3);
    }
  });

  it('logs the real follow-status admission failure with safe owner details once', async () => {
    const request = createRequest();
    const patch = vi.spyOn(axios, 'patch');
    const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const failure: unknown = await updateSessionMetadataEnvelopeTupleWithRetry({
      ...request,
      mutation: { kind: 'metadata', update: metadata => updateMetadataWithExternalSessionFollowStatus(metadata, {
        expectedLinkGeneration: '1', sessionId: request.sessionId,
        followStatusV1: { v: 1, status: 'active', reason: 'viewer_attached', updatedAtMs: 100 },
      }) },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'external_session_follow_linked_metadata_mismatch' });
    expect(patch).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledExactlyOnceWith('[API] session_metadata_update_failed', {
      phase: 'terminal_failure', operation: 'update-metadata', sessionId: request.sessionId,
      code: 'session_metadata_update_failed', errorClass: 'Error',
      classification: { kind: 'protocol_error', retryable: false },
      causeCode: 'external_session_follow_linked_metadata_mismatch',
      causeDetails: { sessionId: request.sessionId, expectedLinkGeneration: 1, actualLinkGeneration: null },
    });
    const diagnostic = JSON.stringify(info.mock.calls);
    for (const content of ['private-title', '/private/workspace', 'message', credentials.token]) {
      expect(diagnostic).not.toContain(content);
    }
  });

  it.each([
    { failure: new TypeError('private-transport-response'), errorClass: 'TypeError', code: 'session_metadata_update_failed' },
    { failure: Object.assign(new Error('private-transport-response'), { code: 'metadata_privacy_upgrade_required' }), errorClass: 'Error', code: 'metadata_privacy_upgrade_required' },
  ])('reports $errorClass terminal failure once without logging secrets or changing the snapshot', async ({ failure, errorClass, code }) => {
    const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    const patch = vi.spyOn(axios, 'patch').mockRejectedValue(failure);
    const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const request = createRequest();
    const before = JSON.stringify(request.initialSnapshot);
    await expect(updateSessionMetadataEnvelopeTupleWithRetry(request)).rejects.toBe(failure);
    expect(patch).toHaveBeenCalledOnce();
    expect(JSON.stringify(request.initialSnapshot)).toBe(before);
    expect(info).toHaveBeenCalledExactlyOnceWith('[API] session_metadata_update_failed', {
      phase: 'terminal_failure', operation: 'update-metadata', sessionId: 'diagnostic-session',
      code, errorClass, classification: { kind: 'protocol_error', retryable: false },
    });
    const diagnostic = JSON.stringify(info.mock.calls);
    expect(diagnostic).not.toContain('private-transport-response');
    expect(diagnostic).not.toContain('private-title');
    expect(diagnostic).not.toContain(credentials.token);
    expect(diagnostic).not.toContain('/private/workspace');
    expect(reportSessionRunnerFailure(failure)).toBe(1);
    expect(fatal).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('reports schema issue paths and codes without issue messages or input values', async () => {
    const parsed = SessionActionConfirmationsV1Schema.safeParse({
      v: 1, requests: { 'private-request-id': 'private-request-value' }, completedRequests: 'private-completed-value',
    });
    if (parsed.success) throw new Error('Expected invalid confirmation fixture');
    const failure = parsed.error;
    const patch = vi.spyOn(axios, 'patch').mockRejectedValue(failure);
    const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    await expect(updateSessionMetadataEnvelopeTupleWithRetry(createRequest())).rejects.toBe(failure);
    expect(patch).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledExactlyOnceWith('[API] session_metadata_update_failed', {
      phase: 'terminal_failure', operation: 'update-metadata', sessionId: 'diagnostic-session',
      code: 'session_metadata_update_failed', errorClass: '$ZodError',
      classification: { kind: 'protocol_error', retryable: false },
      schemaIssues: [
        { path: ['[redacted]', '[redacted]'], code: 'invalid_type' },
        { path: ['[redacted]'], code: 'invalid_type' },
      ],
    });
    const diagnostic = JSON.stringify(info.mock.calls);
    expect(diagnostic).not.toContain('private-request-value');
    expect(diagnostic).not.toContain('private-request-id');
    expect(diagnostic).not.toContain('private-completed-value');
    expect(diagnostic).not.toContain('message');
    expect(diagnostic).not.toContain('expected');
    expect(diagnostic).not.toContain('received');
    expect(diagnostic).not.toContain(credentials.token);
  });

  it('preserves schema-owned sanitized paths from Session detail failures', async () => {
    const parsed = z.object({ metadata: z.record(z.string(), z.number()) }).safeParse({
      metadata: { 'private-schema-key': 'private-schema-value' },
    });
    if (parsed.success) throw new Error('Expected invalid Session detail fixture');
    const failure = new SessionDetailInvalidResponseError('current_access_projection_v1', parsed.error.issues);
    const patch = vi.spyOn(axios, 'patch').mockRejectedValue(failure);
    const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    await expect(updateSessionMetadataEnvelopeTupleWithRetry(createRequest())).rejects.toBe(failure);
    expect(patch).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledExactlyOnceWith('[API] session_metadata_update_failed', {
      phase: 'terminal_failure', operation: 'update-metadata', sessionId: 'diagnostic-session',
      code: 'session_metadata_update_failed', errorClass: 'Error',
      classification: { kind: 'protocol_error', retryable: false },
      schema: 'current_access_projection_v1',
      schemaIssues: [{ path: ['metadata'], code: 'invalid_type' }],
    });
    const diagnostic = JSON.stringify(info.mock.calls);
    expect(diagnostic).not.toContain('private-schema-key');
    expect(diagnostic).not.toContain('private-schema-value');
    expect(diagnostic).not.toContain('message');
    expect(diagnostic).not.toContain('expected');
    expect(diagnostic).not.toContain('received');
  });

  it.each([
    { status: 200, schema: 'session_metadata_tuple_patch_success_v1', discriminator: { success: true } },
    { status: 409, schema: 'session_metadata_version_conflict_v1', discriminator: { code: 'session_metadata_version_conflict' } },
  ])('identifies malformed tuple $status response schema through the real HTTP boundary', async ({ status, schema, discriminator }) => {
    const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status, data: {
      ...discriminator, metadataLayoutVersion: 1,
      sharedMetadata: { version: 'private-version-value', 'private-record-key': 'private-record-value' },
      agentState: { version: 3 },
    } });
    const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const failure: unknown = await updateSessionMetadataEnvelopeTupleWithRetry(createRequest()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionDetailInvalidResponseError);
    expect(patch).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledExactlyOnceWith('[API] session_metadata_update_failed', {
      phase: 'terminal_failure', operation: 'update-metadata', sessionId: 'diagnostic-session',
      code: 'session_metadata_update_failed', errorClass: 'Error',
      classification: { kind: 'protocol_error', retryable: false },
      schema,
      schemaIssues: [
        { path: ['sharedMetadata'], code: 'invalid_type' },
        { path: ['sharedMetadata'], code: 'unrecognized_keys' },
      ],
    });
    const diagnostic = JSON.stringify(info.mock.calls);
    for (const content of ['private-version-value', 'private-record-key', 'private-record-value', 'message', 'expected', 'received', credentials.token]) {
      expect(diagnostic).not.toContain(content);
    }
  });

  it('keeps cancellation and superseded-publisher outcomes quiet and preserves their original result', async () => {
    const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 409, data: { code: 'session_publisher_authority_lost' } });
    await expect(updateSessionMetadataEnvelopeTupleWithRetry(createRequest())).rejects.toMatchObject({ code: 'session_publisher_authority_lost' });
    const controller = new AbortController();
    const cancelled = new Error('fixture-cancelled');
    controller.abort(cancelled);
    await expect(updateSessionMetadataEnvelopeTupleWithRetry({ ...createRequest(), currentness: { signal: controller.signal } })).rejects.toBe(cancelled);
    expect(patch).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalled();
  });
});
