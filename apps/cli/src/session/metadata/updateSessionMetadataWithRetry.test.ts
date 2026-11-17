import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as canonicalBase64 from '../../../../../packages/protocol/src/crypto/base64';

import {
  buildSessionMetadataEnvelopeFields,
} from './buildSessionMetadataEnvelopeCreateFields';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionDisplayProjectionV1Schema, openSessionSharedDisplayEnvelopeV1Sync,
  openSessionOwnerDisplayEnvelopeV1 } from '@happier-dev/protocol';
import { SessionTeamCredentialBindingMetadataPatchV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingV1';
import { SessionModelSelectionV2Schema, sessionModelSelectionV2TeamBindingIntent } from '@happier-dev/protocol/providers/selection/v2';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { applyStartupMetadataUpdateToSession, buildModelOverride } from '@/agent/runtime/startupMetadataUpdate';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { readSessionModelSelectionV2FromMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  openSessionOwnerMetadataEnvelopeV1,
  projectSessionAccessCapabilitiesV1,
  projectSessionOwnerCompatibilityViewV1,
  readExternalHistoryImportV1FromMetadata,
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  removeLinkedExternalSessionMetadataV1,
  sealSessionOwnerMetadataEnvelopeV1,
  SessionEffectiveAccessV1Schema,
} from '@happier-dev/protocol';
import {
  decryptStoredSessionPayload,
  encryptStoredSessionPayload,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  applySessionStateUpdatesToMetadata,
  createModelIntentMetadataCasCandidate,
  clearSessionStateFieldFromMetadata,
  writeSessionStateFieldToMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';
import {
  prepareSessionMetadataTuplePatchForTransaction,
  readSessionMetadataSharedEditorTupleSnapshot,
  readSessionMetadataTupleWriterSnapshot,
  updateSessionMetadataEnvelopeTupleWithRetry,
  updateSessionMetadataWithRetry,
} from './updateSessionMetadataWithRetry';

const {
  fetchSessionByIdCompatMock,
  patchSessionMetadataEnvelopeTupleMock,
  patchSessionMetadataMock,
  fetchAccountEncryptionCurrentnessMock,
} = vi.hoisted(() => ({
  fetchSessionByIdCompatMock: vi.fn(),
  patchSessionMetadataEnvelopeTupleMock: vi.fn(),
  patchSessionMetadataMock: vi.fn(),
  fetchAccountEncryptionCurrentnessMock: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: fetchSessionByIdCompatMock,
  patchSessionMetadataEnvelopeTuple: patchSessionMetadataEnvelopeTupleMock,
  patchSessionMetadata: patchSessionMetadataMock,
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: fetchAccountEncryptionCurrentnessMock,
}));

const plainCurrentness = {
  mode: 'plain' as const,
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
  recipientEnvelopeReadiness: { status: 'unavailable' as const, reason: 'plain_account' as const },
};

const ownerEffectiveAccess = SessionEffectiveAccessV1Schema.parse({
  v: 1,
  level: 'owner',
  sources: [{ kind: 'owner' }],
  capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }),
});

function e2eeCurrentness(credentials: Readonly<{
  encryption: Readonly<{ type: 'legacy'; secret: Uint8Array }>;
}>) {
  const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
    accountEncryptionMode: 'e2ee',
    material: {
      type: 'legacy',
      secret: credentials.encryption.secret,
    },
  });
  return {
    mode: 'e2ee' as const,
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint:
      convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        snapshot.contentPublicKeyFingerprint,
      ),
    updatedAt: 1,
    recipientEnvelopeReadiness: { status: 'available' as const },
  };
}

describe('updateSessionMetadataWithRetry', () => {
  it('admits the owner envelope once while opening a real encrypted tuple snapshot', () => {
    const credentials = { token: 'tuple-scan-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'e2ee',
      storedContentMode: 'plain', metadata: { path: '/repo', host: 'host' }, agentState: null });
    if (fields.ownerMetadata.t !== 'encrypted') throw new Error('Expected encrypted owner fixture');
    const ciphertext = fields.ownerMetadata.c;
    const scan = vi.spyOn(canonicalBase64, 'readCanonicalPaddedBase64DecodedLength');
    try {
      const snapshot = readSessionMetadataTupleWriterSnapshot({ credentials,
        accountEncryptionCurrentness: e2eeCurrentness(credentials), rawSession: {
          metadataLayoutVersion: 1, encryptionMode: 'plain', metadataVersion: 1, agentStateVersion: 0,
          metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, agentState: null,
        } });
      expect(snapshot.value.metadata).toMatchObject({ path: '/repo', host: 'host' });
      // Observe structural admission without replacing the genuine crypto decoder.
      expect(scan.mock.calls.filter(([value]) => value === ciphertext)).toHaveLength(1);
    } finally { scan.mockRestore(); }
  });
  it.each([
    { sessionMode: 'plain' as const, accountMode: 'e2ee' as const },
    { sessionMode: 'e2ee' as const, accountMode: 'plain' as const },
  ])('atomically produces display with independent Session $sessionMode and Account $accountMode crypto', async ({ sessionMode, accountMode }) => {
    const credentials = { token: 'display-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };
    const metadata = { path: '/private/repo', host: 'private-host', summary: { text: 'before', updatedAt: 1 } };
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: accountMode, metadata, agentState: null,
      ...(sessionMode === 'plain' ? { storedContentMode: 'plain' as const }
        : { storedContentMode: 'e2ee' as const, encryptionKey: credentials.encryption.secret, encryptionVariant: 'legacy' as const }),
    });
    const rawSession = { id: 'c123456789012345678901234', encryptionMode: sessionMode, metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
      metadataVersion: 4, agentState: null, agentStateVersion: 7, dataEncryptionKey: null, effectiveAccess: ownerEffectiveAccess };
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: 5 }, agentState: { version: 7 } });
    await updateSessionMetadataWithRetry({ token: credentials.token, credentials, sessionId: rawSession.id, rawSession,
      accountEncryptionCurrentness: accountMode === 'plain' ? plainCurrentness : e2eeCurrentness(credentials),
      updater: current => ({ ...current, name: 'Private rename', summary: { text: 'shared after', updatedAt: 2 } }),
    });
    const patch: unknown = patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0]?.patch;
    if (!patch || typeof patch !== 'object') throw new Error('Expected metadata tuple patch');
    const projection = SessionDisplayProjectionV1Schema.parse(Reflect.get(patch, 'displayProjectionV1'));
    expect(projection).toMatchObject({ sourceMetadataVersion: 5, metadataLayoutVersion: 1,
      shared: { t: sessionMode === 'plain' ? 'plain' : 'encrypted' }, owner: { t: accountMode === 'plain' ? 'plain' : 'encrypted' } });
    expect(openSessionSharedDisplayEnvelopeV1Sync({ sessionMode, envelope: projection.shared,
      decryptPayload: value => decryptStoredSessionPayload({ value, ...(sessionMode === 'plain' ? { mode: 'plain', ctx: null }
        : { mode: 'e2ee', ctx: { encryptionKey: credentials.encryption.secret, encryptionVariant: 'legacy' } }) }),
    })).toEqual({ ok: true, display: { v: 1, summaryText: 'shared after' } });
    expect(openSessionOwnerDisplayEnvelopeV1({ accountMode, envelope: projection.owner,
      material: { type: 'legacy', secret: credentials.encryption.secret } })).toMatchObject({ ok: true,
      display: { name: 'Private rename', path: '/private/repo', host: 'private-host' } });
    const firstPatch = SessionMetadataTuplePatchV1Schema.parse(patch);
    if (firstPatch.mode !== 'owner') throw new Error('Expected owner patch');
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValueOnce({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: 6 }, agentState: { version: 7 } });
    await updateSessionMetadataWithRetry({ token: credentials.token, credentials, sessionId: rawSession.id,
      rawSession: { ...rawSession, metadataVersion: 5, metadata: firstPatch.sharedMetadata.ciphertext,
        ownerMetadata: firstPatch.ownerMetadata, displayProjectionV1: projection },
      accountEncryptionCurrentness: accountMode === 'plain' ? plainCurrentness : e2eeCurrentness(credentials),
      updater: current => ({ ...current, version: '0.3.1-display-test' }),
    });
    const secondPatch: unknown = patchSessionMetadataEnvelopeTupleMock.mock.calls[1]?.[0]?.patch;
    if (!secondPatch || typeof secondPatch !== 'object') throw new Error('Expected second metadata tuple patch');
    const secondDisplay = SessionDisplayProjectionV1Schema.parse(Reflect.get(secondPatch, 'displayProjectionV1'));
    expect(secondDisplay).toEqual({ ...projection, sourceMetadataVersion: 6 });
  });

  it('stops Project publication at an unsupported legacy owner migration without a legacy write fallback', async () => {
    const credentials = { token: 'project-token', encryption: null };
    const rawSession = { id: 'older-home-project-session', encryptionMode: 'plain',
      metadata: JSON.stringify({ path: '/repo', host: 'host' }), ownerMetadata: null,
      metadataVersion: 4, agentState: null, agentStateVersion: 7, dataEncryptionKey: null };
    patchSessionMetadataEnvelopeTupleMock.mockRejectedValueOnce(Object.assign(new Error('unsupported owner migration'), {
      code: 'metadata_privacy_upgrade_required', retryable: false,
    }));
    await expect(updateSessionMetadataWithRetry({ token: credentials.token, credentials, accountEncryptionCurrentness: plainCurrentness,
      sessionId: rawSession.id, rawSession, projectKey: 'accepted-project', updater: metadata => metadata }))
      .rejects.toMatchObject({ code: 'metadata_privacy_upgrade_required', retryable: false });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    expect(patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch).toMatchObject({ mode: 'owner_migration' });
    expect(patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch).not.toHaveProperty('metadata');
    expect(patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch).not.toHaveProperty('agentState');
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });
  it('migrates a retained legacy Session before publishing its accepted Project relationship', async () => {
    const credentials = { token: 'project-token', encryption: null };
    const rawSession = { id: 'legacy-project-session', encryptionMode: 'plain', metadataLayoutVersion: 0,
      metadata: JSON.stringify({ path: '/repo', host: 'host' }), ownerMetadata: null,
      metadataVersion: 4, agentState: null, agentStateVersion: 7, dataEncryptionKey: null };
    patchSessionMetadataEnvelopeTupleMock
      .mockResolvedValueOnce({ success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 5 }, agentState: { version: 8 } })
      .mockResolvedValueOnce({ success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 6 }, agentState: { version: 9 } });
    await updateSessionMetadataWithRetry({ token: credentials.token, credentials, accountEncryptionCurrentness: plainCurrentness,
      sessionId: rawSession.id, rawSession, projectKey: 'accepted-project', updater: metadata => metadata });
    const patches = patchSessionMetadataEnvelopeTupleMock.mock.calls.map(([request]) => SessionMetadataTuplePatchV1Schema.parse(request.patch));
    expect(patches).toHaveLength(2);
    expect(patches[0]).toMatchObject({ mode: 'owner_migration' });
    expect(patches[0]).not.toHaveProperty('projectKey');
    expect(patches[1]).toMatchObject({ mode: 'owner', projectKey: 'accepted-project' });
  });
  it.each(['plain', 'e2ee'] as const)('publishes a Project key through the owner tuple without changing the %s envelope', async mode => {
    const credentials = mode === 'plain' ? { token: 'project-token', encryption: null }
      : { token: 'project-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) } };
    const currentness = credentials.encryption ? e2eeCurrentness({ encryption: credentials.encryption }) : plainCurrentness;
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: mode,
      storedContentMode: 'plain', metadata: { path: '/private/checkout', host: 'host', workspaceId: 'checkout', projectId: 'accepted-project' }, agentState: null });
    const rawSession = { id: 'project-session', encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
      metadataVersion: 4, agentState: null, agentStateVersion: 7, dataEncryptionKey: null };
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: 5 }, agentState: { version: 8 } });
    await updateSessionMetadataWithRetry({ token: credentials.token, credentials, accountEncryptionCurrentness: currentness,
      sessionId: rawSession.id, rawSession, projectKey: 'accepted-project', updater: metadata => metadata });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    expect(patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch).toMatchObject({ mode: 'owner',
      projectKey: 'accepted-project', ownerMetadata: fields.ownerMetadata });
    expect(patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch.sharedMetadata.ciphertext).not.toContain('/private/checkout');
  });
  it('drops persisted extras recursively while applying a real Bot field mutation to an owner tuple', async () => {
    const credentials = { token: 'token-1', encryption: null };
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
      metadata: { path: '/repo', host: 'host', summary: { text: 'Keep', updatedAt: 1 },
        work: { viewPreferences: { showToolCalls: false } } }, agentState: null });
    if (fields.ownerMetadata.t !== 'plain') throw new Error('Expected plain owner fixture');
    const rawSession = { id: 'sess_extras', encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: JSON.stringify({ ...JSON.parse(fields.sharedMetadata.ciphertext), futureShared: { ignored: true } }),
      ownerMetadata: { ...fields.ownerMetadata, futureEnvelope: true, v: { ...fields.ownerMetadata.v, futureOwner: true,
        work: { ...fields.ownerMetadata.v.work, futureWork: true, viewPreferences: { showToolCalls: false, futureView: true } } } },
      metadataVersion: 4, agentState: null, agentStateVersion: 7, dataEncryptionKey: null, effectiveAccess: ownerEffectiveAccess };
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: 5 }, agentState: { version: 8 } });
    const result = await updateSessionMetadataWithRetry({ token: credentials.token, credentials, sessionId: rawSession.id,
      accountEncryptionCurrentness: plainCurrentness, rawSession,
      updater: metadata => writeSessionStateFieldToMetadata(metadata, 'display.bot', { kind: 'bot' }) });
    expect(result.metadata).toMatchObject({ bot: { kind: 'bot' }, summary: { text: 'Keep', updatedAt: 1 },
      work: { viewPreferences: { showToolCalls: false } } });
    const patch: unknown = patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch;
    expect(patch).toMatchObject({ mode: 'owner', ownerMetadata: { t: 'plain', v: {
      work: { bot: { kind: 'bot' }, viewPreferences: { showToolCalls: false } },
    } } });
    expect(JSON.stringify(patch)).not.toMatch(/futureShared|futureEnvelope|futureOwner|futureWork|futureView/);
  });
  it('normalizes additive legacy host metadata at the real tuple-reader boundary before an owner mutation', () => {
    const snapshot = readSessionMetadataTupleWriterSnapshot({
      credentials: { token: 'token-1', encryption: null }, accountEncryptionCurrentness: plainCurrentness,
      rawSession: { encryptionMode: 'plain', metadataLayoutVersion: 0, metadataVersion: 1, agentStateVersion: 0, agentState: null, ownerMetadata: null, metadata: JSON.stringify({
        path: '/repo', host: 'machine', providerExtension: { retained: true },
        terminal: { mode: 'plain', hostKind: 'herdr', requested: 'plain', requestedHostKind: 'herdr', herdr: { sessionName: 'work', socketPath: '/tmp/herdr.sock', terminalId: 'term_1' } },
      }) },
    });
    expect(snapshot.value.metadata).toMatchObject({ terminal: { mode: 'herdr', requested: 'herdr' }, providerExtension: { retained: true } });
    expect(snapshot.value.metadata.terminal).not.toHaveProperty('hostKind');
  });

  beforeEach(() => {
    fetchSessionByIdCompatMock.mockReset();
    patchSessionMetadataEnvelopeTupleMock.mockReset();
    patchSessionMetadataMock.mockReset();
    fetchAccountEncryptionCurrentnessMock.mockReset();
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue(plainCurrentness);
  });

  it('recomputes pending summaries from the refreshed Agent-state mutation after a tuple conflict', async () => {
    const credentials = { token: 'token-1', encryption: null };
    const initial = buildSessionMetadataEnvelopeFields({
      credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
      metadata: { path: '/repo', host: 'owner' }, agentState: { requests: {} },
    });
    const refreshed = buildSessionMetadataEnvelopeFields({
      credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
      metadata: { path: '/repo', host: 'owner' },
      agentState: { requests: { remote: { tool: 'Write', kind: 'permission', arguments: {}, createdAt: 750 } } },
    });
    const raw = {
      id: 'sess_pending_retry', encryptionMode: 'plain' as const, metadataLayoutVersion: 1,
      metadata: initial.sharedMetadata.ciphertext, ownerMetadata: initial.ownerMetadata,
      agentState: initial.agentState, metadataVersion: 0, agentStateVersion: 0, dataEncryptionKey: null,
    };
    fetchSessionByIdCompatMock.mockResolvedValue({
      ...raw, metadata: refreshed.sharedMetadata.ciphertext, ownerMetadata: refreshed.ownerMetadata,
      agentState: refreshed.agentState, metadataVersion: 1, agentStateVersion: 1,
    });
    patchSessionMetadataEnvelopeTupleMock
      .mockResolvedValueOnce({ success: false, error: 'session_metadata_version_conflict' })
      .mockResolvedValueOnce({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: 2 }, agentState: { version: 2 } });

    const updated = await updateSessionMetadataEnvelopeTupleWithRetry({
      token: credentials.token, sessionId: raw.id, mode: 'plain', ctx: null,
      authority: { kind: 'owner', credentials, accountEncryptionCurrentness: plainCurrentness },
      initialSnapshot: readSessionMetadataTupleWriterSnapshot({
        credentials, accountEncryptionCurrentness: plainCurrentness, rawSession: raw,
      }),
      mutation: { kind: 'agentState', update: state => ({
        ...state, requests: { ...state?.requests,
          local: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 250, turnId: 'turn-local' },
        },
      }) },
    });

    expect(updated.value.agentState?.requests).toMatchObject({
      remote: { createdAt: 750 }, local: { createdAt: 250 },
    });
    expect(patchSessionMetadataEnvelopeTupleMock.mock.calls.map(([request]) => request.patch.activitySummaryV1)).toEqual([
      { pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1, pendingRequestNewestCreatedAt: 250,
        newUserActionRequiredOccurrences: [{ requestId: 'local', sourceTurnId: 'turn-local', requestKind: 'user_action',
          occurredAt: 250, followEvent: { kind: 'needs_you', type: 'decision' } }] },
      { pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 1, pendingRequestNewestCreatedAt: 750,
        newUserActionRequiredOccurrences: [{ requestId: 'local', sourceTurnId: 'turn-local', requestKind: 'user_action',
          occurredAt: 250, followEvent: { kind: 'needs_you', type: 'decision' } }] },
    ]);
  });

  it.each(['agentState', 'metadata'] as const)('publishes %s edit summaries only with the ordinary CAS after preserving legacy values', async kind => {
    const credentials = { token: 'token-1', encryption: null };
    const metadata = { path: '/repo', host: 'owner' };
    const agentState = { requests: {} };
    const rawSession = { metadataLayoutVersion: 0, metadata: JSON.stringify(metadata), metadataVersion: 2,
      ownerMetadata: null, agentState: JSON.stringify(agentState), agentStateVersion: 4,
      encryptionMode: 'plain' as const, dataEncryptionKey: null };
    const initialSnapshot = readSessionMetadataTupleWriterSnapshot({ credentials,
      accountEncryptionCurrentness: plainCurrentness, rawSession });
    const editFailure = new Error('ordinary edit transport unavailable');
    const mutation = kind === 'agentState'
      ? { kind: 'agentState' as const, update: () => ({ requests: {
          local: { tool: 'AskUserQuestion', kind: 'user_action' as const, arguments: {}, createdAt: 250, turnId: 'turn-local' },
        } }) }
      : { kind: 'metadata' as const, update: (current: Metadata) => ({ ...current,
          actionConfirmationsV1: { v: 1 as const, requests: {}, completedRequests: {} },
        }) };
    const run = () => updateSessionMetadataEnvelopeTupleWithRetry({ token: credentials.token,
      sessionId: 'legacy-summary', mode: 'plain', ctx: null,
      authority: { kind: 'owner', credentials, accountEncryptionCurrentness: plainCurrentness },
      initialSnapshot, mutation });
    patchSessionMetadataEnvelopeTupleMock
      .mockResolvedValueOnce({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: 3 }, agentState: { version: 5 } })
      .mockRejectedValueOnce(editFailure);
    await expect(run()).rejects.toBe(editFailure);
    const migration = patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch;
    expect(migration).toMatchObject({ mode: 'owner_migration',
      target: { agentState: { ciphertext: JSON.stringify(agentState) } } });
    expect(migration).not.toHaveProperty('activitySummaryV1');
    expect(migration).not.toHaveProperty('sharedActionConfirmationSummaryV1');
    patchSessionMetadataEnvelopeTupleMock.mockReset();
    patchSessionMetadataEnvelopeTupleMock
      .mockResolvedValueOnce({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: 3 }, agentState: { version: 5 } })
      .mockResolvedValueOnce({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: 4 }, agentState: { version: kind === 'agentState' ? 6 : 5 } });
    await run();
    expect(patchSessionMetadataEnvelopeTupleMock.mock.calls[1]?.[0].patch).toMatchObject(kind === 'agentState'
      ? { mode: 'owner', activitySummaryV1: { pendingPermissionRequestCount: 0,
          pendingUserActionRequestCount: 1, pendingRequestNewestCreatedAt: 250 } }
      : { mode: 'owner', sharedActionConfirmationSummaryV1: { pendingPermissionRequestCount: 0 } });
  });

  it('exposes layout-1 owner state through the canonical discriminated tuple value', () => {
    const credentials = {
      token: 'token-1',
      encryption: null,
    };
    const metadata = {
      path: '/private/layout-1',
      host: 'owner-host',
      summary: { text: 'Shared title', updatedAt: 1 },
    };
    const agentState = { requests: { pending: { createdAt: 1 } } };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'plain',
      metadata,
      agentState,
      storedContentMode: 'plain',
    });

    const snapshot = readSessionMetadataTupleWriterSnapshot({
      credentials,
      accountEncryptionCurrentness: plainCurrentness,
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 7,
        ownerMetadata: fields.ownerMetadata,
        agentState: fields.agentState,
        agentStateVersion: 3,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
    });

    expect(snapshot).toMatchObject({
      mode: 'owner',
      metadataLayoutVersion: 1,
      metadataVersion: 7,
      agentStateVersion: 3,
      value: {
        metadata,
        sharedMetadata: expect.objectContaining({
          summary: metadata.summary,
        }),
        ownerMetadata: expect.objectContaining({
          workspace: {
            path: metadata.path,
            host: metadata.host,
          },
        }),
        agentState,
      },
    });
    expect(snapshot).not.toHaveProperty('metadata');
    expect(snapshot).not.toHaveProperty('sharedMetadata');
    expect(snapshot).not.toHaveProperty('ownerMetadata');
    expect(snapshot).not.toHaveProperty('agentState');
  });

  it('prepares a plaintext owner tuple replacement with token-only credentials without committing it', async () => {
    const credentials = {
      token: 'token-1',
      encryption: null,
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'plain',
      metadata: {
        path: '/private/external',
        host: 'owner-host',
        externalSessionV1: {
          v: 1,
          agentId: 'example',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          linkedAtMs: 10,
          source: { kind: 'jsonl' },
        },
        directSessionV1: {
          v: 1,
          providerId: 'example',
          machineId: 'machine-1',
          remoteSessionId: 'remote-1',
          linkedAtMs: 10,
          source: { kind: 'jsonl' },
        },
      },
      agentState: null,
      storedContentMode: 'plain',
    });

    const patch = await prepareSessionMetadataTuplePatchForTransaction({
      credentials,
      accountEncryptionCurrentness: plainCurrentness,
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 7,
        ownerMetadata: fields.ownerMetadata,
        agentState: fields.agentState,
        agentStateVersion: 3,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({
        ...removeLinkedExternalSessionMetadataV1(metadata),
        externalHistoryImportV1: {
          v: 1,
          agentId: 'example',
          remoteSessionId: 'remote-1',
          importedAtMs: 100,
          source: { kind: 'jsonl' },
        },
      }),
    });

    expect(patch).toMatchObject({
      mode: 'owner',
      expectedOwnerMetadata: fields.ownerMetadata,
      ownerMetadata: { t: 'plain' },
      sharedMetadata: { expectedVersion: 7 },
      agentState: { expectedVersion: 3, ciphertext: null },
    });
    if (patch.mode !== 'owner') {
      throw new Error('expected owner tuple replacement');
    }
    const opened = openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'plain',
      envelope: patch.ownerMetadata,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('expected plain owner metadata');
    const compatibility = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: JSON.parse(patch.sharedMetadata.ciphertext),
      ownerMetadata: opened.ownerMetadata,
    });
    expect(readNonAuthoritativeLinkedExternalSessionV1FromMetadata(compatibility)).toBeNull();
    expect(readExternalHistoryImportV1FromMetadata(compatibility)).toEqual({
      v: 1,
      agentId: 'example',
      remoteSessionId: 'remote-1',
      importedAtMs: 100,
      source: { kind: 'jsonl' },
    });
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('prepares an encrypted owner replacement for an E2EE Session from the persisted owner branch', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(25),
      },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: {
        path: '/private/encrypted-transcript',
        host: 'private-host',
        summary: { text: 'Before', updatedAt: 1 },
      },
      agentState: null,
      storedContentMode: 'e2ee',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });
    const rawSession = {
      metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext,
      metadataVersion: 7,
      ownerMetadata: fields.ownerMetadata,
      agentState: fields.agentState,
      agentStateVersion: 3,
      encryptionMode: 'e2ee',
      dataEncryptionKey: null,
      effectiveAccess: ownerEffectiveAccess,
    };
    const patch = await prepareSessionMetadataTuplePatchForTransaction({
      credentials,
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession,
      updater: (current) => ({
        ...current,
        path: '/private/encrypted-transcript-after',
      }),
    });
    expect(patch).toMatchObject({
      mode: 'owner',
      expectedOwnerMetadata: fields.ownerMetadata,
      ownerMetadata: { t: 'encrypted' },
    });
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('migrates an ordinary layout-0 metadata mutation through one owner tuple', async () => {
    const credentials = {
      token: 'token-1',
      encryption: null,
    };
    const sourceMetadata = {
      path: '/legacy',
      host: 'owner',
      summary: { text: 'Before', updatedAt: 1 },
    };
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValueOnce({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 5 },
      agentState: { version: 8 },
    }).mockResolvedValueOnce({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 6 },
      agentState: { version: 8 },
    });

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_ordinary',
      accountEncryptionCurrentness: plainCurrentness,
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: JSON.stringify(sourceMetadata),
        metadataVersion: 4,
        ownerMetadata: null,
        agentState: null,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (current) => ({
        ...current,
        summary: { text: 'After', updatedAt: 2 },
      }),
    });

    expect(result).toMatchObject({
      version: 6,
      metadata: {
        ...sourceMetadata,
        summary: { text: 'After', updatedAt: 2 },
      },
    });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledWith({
      token: 'token-1',
      sessionId: 'sess_layout0_ordinary',
      patch: expect.objectContaining({
        mode: 'owner_migration',
        expectedAccountEncryptionMode: 'plain',
        expectedAccountContentPublicKeyFingerprint: null,
        source: expect.objectContaining({
          metadata: {
            version: 4,
            ciphertext: JSON.stringify(sourceMetadata),
          },
        }),
      }),
    });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenLastCalledWith({
      token: 'token-1', sessionId: 'sess_layout0_ordinary', patch: expect.objectContaining({
        mode: 'owner', sharedMetadata: { expectedVersion: 5, ciphertext: expect.stringContaining('After') },
      }),
    });
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it('projects canonical Agent identity while migrating layout-0 without changing local truth', async () => {
    const credentials = {
      token: 'token-1',
      encryption: null,
    };
    const sourceMetadata = {
      path: '/legacy',
      host: 'owner',
      sessionModelsV1: {
        v: 1 as const,
        agentId: 'opencode',
        updatedAt: 1,
        currentModelId: 'model-1',
        availableModels: [{ id: 'model-1', name: 'Model 1' }],
      },
      runtimeDescriptorV1: {
        v: 1 as const,
        agentId: 'opencode',
        agent: {
          backendMode: 'server',
          providerSessionId: 'opencode-private',
        },
      },
      forkV1: {
        v: 1 as const,
        parentSessionId: 'parent-session',
        parentCutoffSeqInclusive: 42,
        createdAtMs: 2,
        strategy: 'provider_native',
        agentHint: {
          agentId: 'opencode',
          backendMode: 'server',
          agentSessionId: 'opencode-private',
        },
      },
    };
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 5 },
      agentState: { version: 8 },
    });

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_predecessor_compat',
      accountEncryptionCurrentness: plainCurrentness,
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: JSON.stringify(sourceMetadata),
        metadataVersion: 4,
        ownerMetadata: null,
        agentState: null,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (current) => ({
        ...current,
        summary: { text: 'Unrelated update', updatedAt: 3 },
      }),
    });

    expect(result.metadata.sessionModelsV1).toMatchObject({
      agentId: 'opencode',
    });
    expect(result.metadata.sessionModelsV1).toHaveProperty(
      'provider',
      'opencode',
    );
    expect(result.metadata).toHaveProperty('agentRuntimeDescriptorV1');
    expect(result.metadata.forkV1).toHaveProperty('providerHint');
    expect(
      patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch,
    ).toMatchObject({
      mode: 'owner_migration',
      target: {
        ownerMetadata: {
          t: 'plain',
          v: expect.objectContaining({
            runtime: expect.any(Object),
          }),
        },
      },
    });
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('fails closed when a layout-0 migration cannot preserve an inactive-model-intent fence', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(33),
      },
    };
    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_conditioned',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: JSON.stringify({
          path: '/legacy',
          host: 'owner',
          summary: { text: 'Before', updatedAt: 1 },
        }),
        metadataVersion: 4,
        ownerMetadata: null,
        agentState: null,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      sessionExpectation: {
        kind: 'inactive_model_intent',
      },
      updater: (current) => ({
        ...current,
        summary: { text: 'After', updatedAt: 2 },
      }),
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      retryable: false,
    });

    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it('returns an ordinary layout-0 metadata no-op without invoking either writer', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(32),
      },
    };
    const sourceMetadata = {
      host: 'owner',
      path: '/legacy',
    };

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_ordinary_noop',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: JSON.stringify(sourceMetadata),
        metadataVersion: 4,
        ownerMetadata: null,
        agentState: null,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: () => ({
        path: '/legacy',
        host: 'owner',
      }),
    });

    expect(result).toMatchObject({
      version: 4,
      metadata: sourceMetadata,
    });
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it.each([
    { newerOrdinaryChoice: false, includesTeam: true, capturedAt: 10 },
    { newerOrdinaryChoice: true, includesTeam: true, capturedAt: 10 },
    { newerOrdinaryChoice: false, includesTeam: false, capturedAt: 10 },
    { newerOrdinaryChoice: false, includesTeam: true, capturedAt: 0 },
    { newerOrdinaryChoice: true, includesTeam: true, capturedAt: 0 },
    { newerOrdinaryChoice: false, includesTeam: false, capturedAt: 0 },
  ])('retains committed Team source when startup carries its model projection (newer timestamp: $newerOrdinaryChoice, Team supplied: $includesTeam, capture: $capturedAt)', async ({ newerOrdinaryChoice, includesTeam, capturedAt }) => {
    const credentials = { token: 'token-1', encryption: null };
    const teamIntent = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: capturedAt, ref: {
      source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
      expectedResourceRevision: 7, deliveryMode: 'brokered',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'same-model',
    } });
    const acceptedTeamCredentialBinding = sessionModelSelectionV2TeamBindingIntent(teamIntent);
    const modelSelection = { v: 1 as const, updatedAt: teamIntent.updatedAt, ref: {
      agentTargetKey: teamIntent.ref.agentTargetKey, providerConnectionId: null, modelId: teamIntent.ref.modelId,
    } };
    const metadata = createTestMetadata(buildCommittedLaunchMetadata({ directory: '/repo', options: {
      modelSelection, teamCredentialBindings: [includesTeam ? acceptedTeamCredentialBinding
        : { v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 7, deliveryMode: 'brokered' }],
    } }));
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
      metadata, agentState: null, storedContentMode: 'plain' });
    const rawSession = { metadataLayoutVersion: 1, metadata: fields.sharedMetadata.ciphertext, metadataVersion: 3,
      ownerMetadata: fields.ownerMetadata, agentState: fields.agentState, agentStateVersion: 7,
      encryptionMode: 'plain' as const, dataEncryptionKey: null, acceptedTeamCredentialBinding };
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: 4 }, agentState: { version: 8 } });
    let publishedMetadata: Metadata | undefined;
    await applyStartupMetadataUpdateToSession({
      session: { updateMetadata: async updater => {
        publishedMetadata = createTestMetadata((await updateSessionMetadataWithRetry({ token: credentials.token, credentials,
          sessionId: 'sess_team_birth', rawSession, accountEncryptionCurrentness: plainCurrentness,
          updater: (current, context) => updater(createTestMetadata(current), context) })).metadata);
      } },
      next: createTestMetadata({ flavor: 'codex', hostPid: 42 }), nowMs: 20, permissionModeOverride: null,
      modelOverride: buildModelOverride({ modelSelection: { ...modelSelection,
        updatedAt: newerOrdinaryChoice ? capturedAt + 1 : modelSelection.updatedAt } }), mode: 'attach',
      capturedTeamCredentialBinding: acceptedTeamCredentialBinding,
    });
    expect(publishedMetadata).toBeDefined();
    const patch = patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch;
    expect(patch).not.toHaveProperty('teamCredentialBindings');
    expect(readSessionModelSelectionV2FromMetadata(publishedMetadata)).toEqual(teamIntent);
    expect(publishedMetadata).not.toHaveProperty('modelSelectionIntentV1');
  });

  it.each(['cleared', 'replaced', 'revision_changed'] as const)('keeps captured Team identity current when the binding is %s during tuple CAS', async kind => {
    const credentials = { token: 'token-1', encryption: null };
    const binding = { v: 1 as const, slot: { kind: 'provider_model' as const }, teamId: 'team-1',
      resourceId: 'resource-1', expectedResourceRevision: 7, deliveryMode: 'brokered' as const };
    const modelSelection = { v: 1 as const, updatedAt: 10, ref: {
      agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'same-model',
    } };
    const { teamId: _teamId, ...launchBinding } = binding;
    const metadata = createTestMetadata(buildCommittedLaunchMetadata({ directory: '/repo', options: {
      modelSelection, teamCredentialBindings: [launchBinding],
    } }));
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
      metadata, agentState: null, storedContentMode: 'plain' });
    const rawSession = { metadataLayoutVersion: 1, metadata: fields.sharedMetadata.ciphertext, metadataVersion: 3,
      ownerMetadata: fields.ownerMetadata, agentState: fields.agentState, agentStateVersion: 7,
      encryptionMode: 'plain' as const, dataEncryptionKey: null, acceptedTeamCredentialBinding: binding };
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValueOnce({ success: false, error: 'session_metadata_version_conflict',
      metadataLayoutVersion: 1, sharedMetadata: { version: 4 }, agentState: { version: 8 } })
      .mockResolvedValueOnce({ success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 5 }, agentState: { version: 9 } });
    fetchSessionByIdCompatMock.mockResolvedValue({ ...rawSession, metadataVersion: 4, agentStateVersion: 8,
      acceptedTeamCredentialBinding: kind === 'cleared' ? null : kind === 'replaced'
        ? { ...binding, resourceId: 'resource-2' } : { ...binding, expectedResourceRevision: 8 } });
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue(plainCurrentness);
    let publishedMetadata: Metadata | undefined;
    await applyStartupMetadataUpdateToSession({
      session: { updateMetadata: async updater => {
        publishedMetadata = createTestMetadata((await updateSessionMetadataWithRetry({ token: credentials.token, credentials,
          sessionId: 'sess_team_cas', rawSession, accountEncryptionCurrentness: plainCurrentness,
          updater: (current, context) => updater(createTestMetadata(current), context) })).metadata);
      } }, next: createTestMetadata({ flavor: 'codex', hostPid: 42 }), nowMs: 20, permissionModeOverride: null,
      modelOverride: buildModelOverride({ modelSelection }), capturedTeamCredentialBinding: binding, mode: 'attach',
    });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(2);
    // The first attempt is a valid birth normalization; only the current binding
    // distinguishes the retry, since the legacy model tuple is still identical.
    expect(patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch.ownerMetadata).toMatchObject({ t: 'plain', v: {
      runtime: { modelSelectionIntentV2: { ref: { source: 'team_resource', resourceId: 'resource-1' } } },
    } });
    if (kind === 'revision_changed') {
      expect(readSessionModelSelectionV2FromMetadata(publishedMetadata)).toMatchObject({ updatedAt: 10,
        ref: { source: 'team_resource', resourceId: 'resource-1', expectedResourceRevision: 8 } });
      expect(publishedMetadata).not.toHaveProperty('modelSelectionIntentV1');
    } else {
      expect(publishedMetadata?.modelSelectionIntentV1).toEqual({ v: 1, updatedAt: 10, selection: modelSelection.ref });
      expect(publishedMetadata).not.toHaveProperty('modelSelectionIntentV2');
    }
    expect(patchSessionMetadataEnvelopeTupleMock.mock.calls[1]?.[0].patch).not.toHaveProperty('teamCredentialBindings');
  });

  it.each([
    {
      name: 'plain current externalSessionV1',
      mode: 'plain' as const,
      metadata: {
        externalSessionV1: {
          v: 1 as const,
          agentId: 'codex',
          machineId: 'machine-private-current',
          remoteSessionId: 'native-private-current',
          source: { kind: 'codexHome' as const, home: 'user' as const },
        },
      },
      privateSentinel: 'machine-private-current',
    },
    {
      name: 'E2EE released cli-v0.2.1 directSessionV1',
      mode: 'e2ee' as const,
      metadata: {
        directSessionV1: {
          v: 1 as const,
          providerId: 'claude',
          machineId: 'machine-private-v0.2.1',
          remoteSessionId: 'native-private-v0.2.1',
          source: {
            kind: 'claudeConfig' as const,
            configDir: '/private/v0.2.1-claude',
          },
        },
      },
      privateSentinel: 'machine-private-v0.2.1',
    },
  ])('migrates $name metadata through the strict owner tuple', async ({
    mode,
    metadata,
    privateSentinel,
  }) => {
    const secret = new Uint8Array(32).fill(21);
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret,
      },
    };
    const ctx = {
      encryptionKey: secret,
      encryptionVariant: 'legacy' as const,
    };
    const cryptoContext = mode === 'plain'
      ? { mode: 'plain' as const, ctx: null }
      : { mode: 'e2ee' as const, ctx };
    const sourceMetadata = {
      ...metadata,
      summary: { text: 'Before', updatedAt: 1 },
    };
    const sourceAgentState = {
      controlledByUser: true,
      privateAgentSentinel: `${privateSentinel}-agent`,
    };
    const sourceMetadataCiphertext = encryptStoredSessionPayload({
      ...cryptoContext,
      payload: sourceMetadata,
    });
    const sourceAgentStateCiphertext = encryptStoredSessionPayload({
      ...cryptoContext,
      payload: sourceAgentState,
    });
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValueOnce({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 5 },
      agentState: { version: 8 },
    }).mockResolvedValueOnce({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 6 },
      agentState: { version: 8 },
    });

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_migration',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: sourceMetadataCiphertext,
        metadataVersion: 4,
        ownerMetadata: null,
        agentState: sourceAgentStateCiphertext,
        agentStateVersion: 7,
        encryptionMode: mode,
        dataEncryptionKey: null,
      },
      updater: async (current) => ({
        ...current,
        summary: { text: 'After', updatedAt: 2 },
      }),
    });

    expect(result).toMatchObject({
      version: 6,
      metadata: {
        summary: { text: 'After', updatedAt: 2 },
      },
    });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(2);
    const request =
      patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0];
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret },
    });
    expect(request).toMatchObject({
      token: 'token-1',
      sessionId: 'sess_layout0_migration',
      patch: {
        mode: 'owner_migration',
        expectedAccountEncryptionMode: 'e2ee',
        expectedAccountContentPublicKeyFingerprint:
          snapshot.contentPublicKeyFingerprint,
        source: {
          metadata: {
            version: 4,
            ciphertext: sourceMetadataCiphertext,
          },
          agentState: {
            version: 7,
            ciphertext: sourceAgentStateCiphertext,
          },
        },
      },
    });
    expect(JSON.stringify(result.metadata)).toContain(privateSentinel);
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it('fails typed before HTTP when layout-0 migration currentness names different E2EE material', async () => {
    const secret = new Uint8Array(32).fill(27);
    const credentials = {
      token: 'token-1',
      encryption: { type: 'legacy' as const, secret },
    };
    const sourceMetadataCiphertext = encryptStoredSessionPayload({
      mode: 'e2ee',
      ctx: { encryptionKey: secret, encryptionVariant: 'legacy' },
      payload: { path: '/private/mismatched', host: 'private-host' },
    });
    const differentCredentials = {
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(28),
      },
    };

    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_mismatched_currentness',
      accountEncryptionCurrentness: e2eeCurrentness(differentCredentials),
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: sourceMetadataCiphertext,
        metadataVersion: 4,
        ownerMetadata: null,
        agentState: null,
        agentStateVersion: 7,
        encryptionMode: 'e2ee',
        dataEncryptionKey: null,
      },
      updater: (current) => ({ ...current, path: '/private/after' }),
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      retryable: false,
    });
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('retries a linked layout-0 owner migration after an exact conflict refresh', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(22),
      },
    };
    const linkedMetadata = {
      externalSessionV1: {
        v: 1 as const,
        agentId: 'codex',
        machineId: 'machine-private-current',
        remoteSessionId: 'native-private-current',
        source: { kind: 'codexHome' as const, home: 'user' as const },
      },
      summary: { text: 'Before', updatedAt: 1 },
    };
    const concurrentMetadata = {
      ...linkedMetadata,
      summary: { text: 'Concurrent', updatedAt: 2 },
    };
    patchSessionMetadataEnvelopeTupleMock
      .mockResolvedValueOnce({
        success: false,
        error: 'session_metadata_version_conflict',
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 5 },
        agentState: { version: 8 },
      })
      .mockResolvedValueOnce({
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 6 },
        agentState: { version: 8 },
      })
      .mockResolvedValueOnce({
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 7 },
        agentState: { version: 8 },
      });
    fetchSessionByIdCompatMock.mockResolvedValue({
      metadataLayoutVersion: 0,
      metadata: JSON.stringify(concurrentMetadata),
      metadataVersion: 5,
      ownerMetadata: null,
      agentState: null,
      agentStateVersion: 7,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue(
      e2eeCurrentness(credentials),
    );

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout0_linked_conflict',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 0,
        metadata: JSON.stringify(linkedMetadata),
        metadataVersion: 4,
        ownerMetadata: null,
        agentState: null,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: async (current) => ({
        ...current,
        summary: { text: 'After', updatedAt: 3 },
      }),
    });

    expect(result).toMatchObject({
      version: 7,
      metadata: {
        ...concurrentMetadata,
        summary: { text: 'After', updatedAt: 3 },
      },
    });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(3);
    expect(patchSessionMetadataEnvelopeTupleMock.mock.calls.filter(([request]) => request.patch.mode === 'owner_migration').map(
      ([request]) => request.patch.source.metadata.version,
    )).toEqual([4, 5]);
    expect(fetchSessionByIdCompatMock).toHaveBeenCalledOnce();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('preserves an encrypted layout-1 owner envelope for an E2EE Session update', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(7),
      },
    };
    const currentMetadata = {
      path: '/private/before',
      host: 'private-host',
      summary: { text: 'Before', updatedAt: 1 },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: currentMetadata,
      agentState: { requests: {} },
      storedContentMode: 'e2ee',
      encryptionKey: credentials.encryption.secret,
      encryptionVariant: 'legacy',
    });
    const encryptedOwnerMetadata = sealSessionOwnerMetadataEnvelopeV1({
      material: {
        type: 'legacy',
        secret: credentials.encryption.secret,
      },
      ownerMetadata: fields.ownerMetadataValue,
      randomBytes: (length) => new Uint8Array(length).fill(41),
    });
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 4 },
      ownerMetadata: { version: 4 },
      agentState: { version: 8 },
    });

    const rawSession = {
      metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext,
      metadataVersion: 3,
      ownerMetadata: encryptedOwnerMetadata,
      agentState: fields.agentState,
      agentStateVersion: 7,
      encryptionMode: 'e2ee',
      dataEncryptionKey: null,
      effectiveAccess: ownerEffectiveAccess,
    };
    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout_1',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession,
      updater: (metadata) => ({
        ...metadata,
        path: '/private/after',
        summary: { text: 'After', updatedAt: 2 },
      }),
    });

    expect(result).toEqual({
      version: 4,
      metadata: expect.objectContaining({
        path: '/private/after',
        summary: { text: 'After', updatedAt: 2 },
      }),
    });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    const request = patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0];
    expect(request.patch).toMatchObject({
      mode: 'owner',
      metadataLayoutVersion: 1,
      expectedOwnerMetadata: encryptedOwnerMetadata,
      ownerMetadata: { t: 'encrypted' },
      sharedMetadata: { expectedVersion: 3 },
      agentState: { expectedVersion: 7 },
    });
    expect(request).toMatchObject({
      token: 'token-1',
      sessionId: 'sess_layout_1',
    });
    expect(decryptStoredSessionPayload({
      mode: 'e2ee',
      ctx: {
        encryptionKey: credentials.encryption.secret,
        encryptionVariant: 'legacy',
      },
      value: request.patch.sharedMetadata.ciphertext,
    })).toMatchObject({
      summary: { text: 'After', updatedAt: 2 },
    });
    const openedOwner = openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      material: {
        type: 'legacy',
        secret: credentials.encryption.secret,
      },
      envelope: request.patch.ownerMetadata,
    });
    expect(openedOwner.ok).toBe(true);
    if (!openedOwner.ok) throw new Error('expected encrypted owner metadata');
    expect(openedOwner.ownerMetadata.workspace?.path).toBe('/private/after');
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('fails typed before HTTP when token-only credentials cannot open the encrypted owner branch', async () => {
    const keyedCredentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(43),
      },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials: keyedCredentials,
      accountEncryptionMode: 'e2ee',
      metadata: {
        path: '/private/encrypted-owner',
        host: 'private-host',
      },
      agentState: null,
      storedContentMode: 'plain',
    });
    const encryptedOwnerMetadata = sealSessionOwnerMetadataEnvelopeV1({
      material: {
        type: 'legacy',
        secret: keyedCredentials.encryption.secret,
      },
      ownerMetadata: fields.ownerMetadataValue,
      randomBytes: (length) => new Uint8Array(length).fill(44),
    });

    await expect(updateSessionMetadataWithRetry({
      token: 'token-1',
      credentials: { token: 'token-1', encryption: null },
      sessionId: 'sess_locked_owner',
      accountEncryptionCurrentness: e2eeCurrentness(keyedCredentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: encryptedOwnerMetadata,
        agentState: fields.agentState,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({
        ...metadata,
        path: '/private/after',
      }),
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
      retryable: false,
    });

    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('propagates the inactive-model-intent expectation through layout 1 and does not retry an active conflict', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(34),
      },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: {
        path: '/private/before',
        host: 'private-host',
      },
      agentState: null,
      storedContentMode: 'plain',
    });
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({
      success: false,
      error: 'session_active',
    });

    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout1_conditioned',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: fields.ownerMetadata,
        agentState: fields.agentState,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      sessionExpectation: {
        kind: 'inactive_model_intent',
      },
      updater: (metadata) => ({
        ...metadata,
        path: '/private/after',
      }),
    })).rejects.toMatchObject({
      code: 'session_active',
      retryable: false,
    });

    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    expect(
      patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch,
    ).toMatchObject({
      mode: 'owner_inactive_model_intent',
      sessionExpectation: {
        kind: 'inactive_model_intent',
      },
    });
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it.each([
    { publisher: false, hasTeamIntent: true, changeModel: true }, { publisher: true, hasTeamIntent: true, changeModel: true },
    { publisher: false, hasTeamIntent: false, changeModel: true }, { publisher: true, hasTeamIntent: false, changeModel: true },
    { publisher: false, hasTeamIntent: false, changeModel: false },
    { publisher: false, hasTeamIntent: 'native', changeModel: true },
  ])('contracts the Team model witness only for ordinary model-intent changes (publisher: $publisher, V2 intent: $hasTeamIntent, change: $changeModel)', async ({ publisher, hasTeamIntent, changeModel }) => {
    const credentials = { token: 'token-1', encryption: null };
    const teamIntent = { v: 2, updatedAt: 10, ref: {
      source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
      expectedResourceRevision: 7, deliveryMode: 'brokered',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'same-model',
    } };
    const selection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'same-model' } as const;
    const acceptedTeamCredentialBinding = hasTeamIntent === 'native' ? null
      : sessionModelSelectionV2TeamBindingIntent(SessionModelSelectionV2Schema.parse(teamIntent));
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
      metadata: { flavor: 'codex', ...(hasTeamIntent ? { modelSelectionIntentV2: hasTeamIntent === 'native'
        ? SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 10,
            ref: { source: 'native', agentTargetKey: selection.agentTargetKey, modelId: selection.modelId } }) : teamIntent }
        : { modelSelectionIntentV1: { v: 1, updatedAt: 10, selection } }) }, agentState: null, storedContentMode: 'plain' });
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: 4 }, agentState: { version: 8 } });
    const candidate = createModelIntentMetadataCasCandidate({ nowMs: () => 20, selection });
    const update = changeModel ? candidate.update : (metadata: Metadata) => ({ ...metadata, path: '/unrelated-change' });
    const rawSession = { metadataLayoutVersion: 1, metadata: fields.sharedMetadata.ciphertext, metadataVersion: 3,
        ownerMetadata: fields.ownerMetadata, agentState: fields.agentState, agentStateVersion: 7,
        encryptionMode: 'plain' as const, dataEncryptionKey: null, acceptedTeamCredentialBinding };
    const publisherPrecondition = { machineId: 'machine-1', committedFenceMs: 1234, publisherGeneration: '7' };
    const tupleInput = { token: credentials.token,
      sessionId: 'sess_team_native', mode: 'plain', ctx: null,
      authority: { kind: 'owner' as const, credentials, accountEncryptionCurrentness: plainCurrentness },
      initialSnapshot: readSessionMetadataTupleWriterSnapshot({ credentials,
        accountEncryptionCurrentness: plainCurrentness, rawSession }),
      ...(publisher ? { publisherPrecondition } : { sessionExpectation: { kind: 'inactive_model_intent' as const } }),
      mutation: { kind: 'metadata' as const, update }, acceptedTeamCredentialBinding,
    } as const;
    const resultMetadata = publisher
      ? (await updateSessionMetadataEnvelopeTupleWithRetry(tupleInput)).value.metadata
      : (await updateSessionMetadataWithRetry({ token: credentials.token, credentials,
          sessionId: 'sess_team_native', rawSession, accountEncryptionCurrentness: plainCurrentness,
          sessionExpectation: { kind: 'inactive_model_intent' }, updater: metadata => update(createTestMetadata(metadata)) })).metadata;
    expect(resultMetadata).not.toHaveProperty('modelSelectionIntentV2');
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    if (!changeModel || hasTeamIntent === 'native') {
      const patch = patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch;
      expect(patch).toMatchObject({ mode: 'owner_inactive_model_intent' });
      expect(patch).not.toHaveProperty('teamCredentialBindings');
      expect(resultMetadata.modelSelectionIntentV1).toMatchObject({ updatedAt: changeModel ? 20 : 10 });
      return;
    }
    expect(patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch).toMatchObject({
      mode: 'owner_team_credential_binding', operation: 'session.model.set',
      ...(publisher ? { publisherPrecondition } : { sessionExpectation: { kind: 'inactive_model_intent' } }),
      teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: null }],
    });
    expect(() => SessionTeamCredentialBindingMetadataPatchV1Schema.parse(
      patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch,
    )).not.toThrow();
  });

  it.each(['team', 'revision', 'native', 'account', 'same', 'unrelated', 'explicit'] as const)(
    'admits only changed V2 model sources in the metadata tuple (%s)', async (transition) => {
      const credentials = { token: 'token-1', encryption: null };
      const previousIntent = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 10, ref: {
        source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1',
        expectedResourceRevision: 0, deliveryMode: 'brokered',
        agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'same-model',
      } });
      const nextIntent = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 20,
        ref: transition === 'native' || transition === 'team'
          ? { source: 'native', agentTargetKey: previousIntent.ref.agentTargetKey, modelId: 'same-model' }
          : transition === 'account'
            ? { source: 'account_provider_connection', agentTargetKey: previousIntent.ref.agentTargetKey,
                providerConnectionId: 'connection-1', modelId: 'same-model' }
            : { ...previousIntent.ref, expectedResourceRevision: transition === 'same' || transition === 'unrelated' ? 0 : 2 },
      });
      const initialIntent = transition === 'team' ? { ...nextIntent, updatedAt: 10 } : previousIntent;
      const publishedIntent = transition === 'team' ? { ...previousIntent, updatedAt: 20 } : nextIntent;
      const acceptedTeamCredentialBinding = sessionModelSelectionV2TeamBindingIntent(initialIntent);
      const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
        metadata: { flavor: 'codex', modelSelectionIntentV2: initialIntent }, agentState: null, storedContentMode: 'plain' });
      const rawSession = { metadataLayoutVersion: 1, metadata: fields.sharedMetadata.ciphertext, metadataVersion: 3,
        ownerMetadata: fields.ownerMetadata, agentState: fields.agentState, agentStateVersion: 7,
        encryptionMode: 'plain' as const, dataEncryptionKey: null, acceptedTeamCredentialBinding };
      patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: 4 }, agentState: { version: 8 } });
      const explicitBinding = { v: 1 as const, slot: { kind: 'provider_model' as const }, resourceId: null };
      const publisherPrecondition = { machineId: 'machine-1', committedFenceMs: 1234, publisherGeneration: '7' };
      const result = await updateSessionMetadataEnvelopeTupleWithRetry({ token: credentials.token,
        sessionId: 'sess_team_restore', mode: 'plain', ctx: null,
        authority: { kind: 'owner', credentials, accountEncryptionCurrentness: plainCurrentness },
        initialSnapshot: readSessionMetadataTupleWriterSnapshot({ credentials,
          accountEncryptionCurrentness: plainCurrentness, rawSession }),
        acceptedTeamCredentialBinding, publisherPrecondition,
        ...(transition === 'explicit' ? { teamCredentialBindings: [explicitBinding] } : {}),
        mutation: { kind: 'metadata', update: metadata => ({ ...metadata,
          ...(transition === 'unrelated' ? { path: '/unrelated-change' } : { modelSelectionIntentV2: publishedIntent }),
        }) },
      });
      expect(result.value.metadata.modelSelectionIntentV2).toEqual(transition === 'unrelated' ? initialIntent : publishedIntent);
      expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
      const patch = patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch;
      if (transition === 'same' || transition === 'unrelated') {
        expect(patch).toMatchObject({ mode: 'owner', publisherPrecondition });
        expect(patch).not.toHaveProperty('teamCredentialBindings');
      } else {
        expect(patch).toMatchObject({ mode: 'owner_team_credential_binding', operation: 'session.model.set', publisherPrecondition,
          teamCredentialBindings: [transition === 'explicit' ? explicitBinding
            : sessionModelSelectionV2TeamBindingIntent(publishedIntent)],
        });
        expect(() => SessionTeamCredentialBindingMetadataPatchV1Schema.parse(patch)).not.toThrow();
      }
    },
  );

  it('atomically carries a Team model binding through the inactive model CAS', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(35),
      },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: { path: '/private/before', host: 'private-host' },
      agentState: null,
      storedContentMode: 'plain',
    });
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 4 },
      agentState: { version: 8 },
    });

    await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_team_model',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: fields.ownerMetadata,
        agentState: fields.agentState,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      sessionExpectation: { kind: 'inactive_model_intent' },
      teamCredentialBindings: [{
        v: 1,
        slot: { kind: 'provider_model' },
        resourceId: 'resource-1',
        expectedResourceRevision: 9,
        deliveryMode: 'brokered',
      }],
      updater: (metadata) => ({ ...metadata, path: '/private/after' }),
    });

    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    expect(patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0].patch).toMatchObject({
      mode: 'owner_team_credential_binding',
      operation: 'session.model.set',
      sessionExpectation: { kind: 'inactive_model_intent' },
      teamCredentialBindings: [{
        v: 1,
        slot: { kind: 'provider_model' },
        resourceId: 'resource-1',
        expectedResourceRevision: 9,
        deliveryMode: 'brokered',
      }],
    });
  });

  it('preserves a typed Team binding refusal without retrying it as a tuple conflict', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(36),
      },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: { path: '/private/before', host: 'private-host' },
      agentState: null,
      storedContentMode: 'plain',
    });
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({
      success: false,
      error: 'session_team_credential_binding_rejected',
      reason: 'resource_changed',
    });

    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_team_model_stale',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: fields.ownerMetadata,
        agentState: fields.agentState,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      sessionExpectation: { kind: 'inactive_model_intent' },
      teamCredentialBindings: [{
        v: 1,
        slot: { kind: 'provider_model' },
        resourceId: 'resource-1',
        expectedResourceRevision: 9,
        deliveryMode: 'brokered',
      }],
      updater: (metadata) => ({ ...metadata, path: '/private/after' }),
    })).rejects.toMatchObject({
      code: 'session_team_credential_binding_rejected',
      reason: 'resource_changed',
      retryable: false,
    });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
  });

  it('does not send a layout-1 tuple for a deep-equal metadata update', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(17),
      },
    };
    const currentMetadata = {
      path: '/private/same',
      host: 'same-host',
      summary: { text: 'Same', updatedAt: 1 },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: currentMetadata,
      agentState: { requests: {} },
      storedContentMode: 'plain',
    });

    const result = await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout1_noop',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: fields.ownerMetadata,
        agentState: fields.agentState,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({
        ...metadata,
        summary: { text: 'Same', updatedAt: 1 },
      }),
    });

    expect(result).toEqual({
      version: 3,
      metadata: expect.objectContaining(currentMetadata),
    });
    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  });

  it('follows authoritative owner metadata after HTTP 409', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(9),
      },
    };
    const initial = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: {
        path: '/private/initial',
        host: 'initial-host',
        summary: { text: 'Initial', updatedAt: 1 },
      },
      agentState: { requests: {} },
      storedContentMode: 'plain',
    });
    const authoritative = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: {
        path: '/private/authoritative',
        host: 'authoritative-host',
        summary: { text: 'Concurrent', updatedAt: 2 },
      },
      agentState: { requests: { concurrent: { createdAt: 2 } } },
      storedContentMode: 'plain',
    });
    patchSessionMetadataEnvelopeTupleMock
      .mockResolvedValueOnce({
        success: false,
        error: 'session_metadata_version_conflict',
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 4 },
        agentState: { version: 6 },
      })
      .mockResolvedValueOnce({
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 5 },
        ownerMetadata: { version: 5 },
        agentState: { version: 7 },
      });
    fetchSessionByIdCompatMock.mockResolvedValue({
      id: 'sess_layout_conflict',
      metadataLayoutVersion: 1,
      metadata: authoritative.sharedMetadata.ciphertext,
      metadataVersion: 4,
      ownerMetadata: authoritative.ownerMetadata,
      agentState: authoritative.agentState,
      agentStateVersion: 6,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue(
      e2eeCurrentness(credentials),
    );

    await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout_conflict',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: initial.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: initial.ownerMetadata,
        agentState: initial.agentState,
        agentStateVersion: 5,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({
        ...metadata,
        path: '/private/requested',
        summary: { text: 'Requested', updatedAt: 3 },
      }),
    });

    expect(fetchSessionByIdCompatMock).toHaveBeenCalledTimes(1);
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(2);
    const firstAttempt =
      patchSessionMetadataEnvelopeTupleMock.mock.calls[0]?.[0];
    const retry = patchSessionMetadataEnvelopeTupleMock.mock.calls[1]?.[0];
    expect(firstAttempt.patch).toMatchObject({
      expectedOwnerMetadata: initial.ownerMetadata,
      ownerMetadata: { t: 'encrypted' },
    });
    expect(retry.patch).toMatchObject({
      mode: 'owner',
      expectedOwnerMetadata: authoritative.ownerMetadata,
      ownerMetadata: { t: 'encrypted' },
      sharedMetadata: { expectedVersion: 4 },
      agentState: { expectedVersion: 6 },
    });
    const openedRetryOwner = openSessionOwnerMetadataEnvelopeV1({
      accountMode: 'e2ee',
      material: {
        type: 'legacy',
        secret: credentials.encryption.secret,
      },
      envelope: retry.patch.ownerMetadata,
    });
    expect(openedRetryOwner.ok).toBe(true);
    if (!openedRetryOwner.ok) throw new Error('expected encrypted retry owner metadata');
    expect(openedRetryOwner.ownerMetadata.workspace).toMatchObject({
      path: '/private/requested',
      host: 'authoritative-host',
    });
    expect(JSON.parse(retry.patch.agentState.ciphertext)).toEqual({
      requests: { concurrent: { createdAt: 2 } },
    });
  });

  async function expectRetiredDisplayTitleMutationStopsBeforeRetry(params: Readonly<{
    updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    retire: () => void;
    assertCurrent: () => void;
    signal?: AbortSignal;
    expectedCode: string;
  }>) {
    const credentials = {
      token: 'token-1',
      encryption: null,
    };
    const initial = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'plain',
      metadata: {
        path: '/private/initial',
        host: 'initial-host',
        summary: { text: 'Before', updatedAt: 1 },
      },
      agentState: null,
      storedContentMode: 'plain',
    });
    const authoritative = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'plain',
      metadata: {
        path: '/private/authoritative',
        host: 'authoritative-host',
        summary: { text: 'Concurrent', updatedAt: 2 },
      },
      agentState: null,
      storedContentMode: 'plain',
    });
    patchSessionMetadataEnvelopeTupleMock
      .mockImplementationOnce(async () => {
        params.retire();
        return {
          success: false,
          error: 'session_metadata_version_conflict',
          metadataLayoutVersion: 1,
          sharedMetadata: { version: 4 },
          agentState: { version: 6 },
        };
      })
      .mockResolvedValueOnce({
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 5 },
        ownerMetadata: { version: 5 },
        agentState: { version: 7 },
      });
    fetchSessionByIdCompatMock.mockResolvedValue({
      id: 'sess_display_title_conflict',
      metadataLayoutVersion: 1,
      metadata: authoritative.sharedMetadata.ciphertext,
      metadataVersion: 4,
      ownerMetadata: authoritative.ownerMetadata,
      agentState: authoritative.agentState,
      agentStateVersion: 6,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });

    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_display_title_conflict',
      accountEncryptionCurrentness: plainCurrentness,
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: initial.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: initial.ownerMetadata,
        agentState: initial.agentState,
        agentStateVersion: 5,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: params.updater,
      currentness: {
        ...(params.signal ? { signal: params.signal } : {}),
        assertCurrent: params.assertCurrent,
      },
    })).rejects.toMatchObject({ code: params.expectedCode });

    expect(fetchSessionByIdCompatMock).not.toHaveBeenCalled();
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
  }

  it('stops a retired display-title set after its first CAS conflict', async () => {
    const operation = new AbortController();
    const cancellation = Object.assign(
      new Error('Session title mutation was aborted'),
      { code: 'plugin_operation_aborted' },
    );
    await expectRetiredDisplayTitleMutationStopsBeforeRetry({
      updater: (metadata) => writeSessionStateFieldToMetadata(
        metadata,
        'display.title',
        { title: 'Requested', staleBehavior: 'bump-if-value-changed' },
      ),
      retire: () => operation.abort(),
      assertCurrent: () => {
        if (operation.signal.aborted) throw cancellation;
      },
      signal: operation.signal,
      expectedCode: 'plugin_operation_aborted',
    });
  });

  it('stops a retired display-title clear after its first CAS conflict', async () => {
    let current = true;
    const retirement = Object.assign(
      new Error('Session title mutation requires the current plugin invocation'),
      { code: 'plugin_session_display_title_scope_unavailable' },
    );
    await expectRetiredDisplayTitleMutationStopsBeforeRetry({
      updater: (metadata) => clearSessionStateFieldFromMetadata(
        metadata,
        'display.title',
      ),
      retire: () => { current = false; },
      assertCurrent: () => {
        if (!current) throw retirement;
      },
      expectedCode: 'plugin_session_display_title_scope_unavailable',
    });
  });

  it('refreshes the authoritative Session and Account snapshot after every consecutive HTTP 409', async () => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(29),
      },
    };
    const initial = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: { path: '/private/initial', host: 'initial-host' },
      agentState: { requests: {} },
      storedContentMode: 'plain',
    });
    const firstAuthoritative = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: { path: '/private/first', host: 'first-host' },
      agentState: { requests: { first: { createdAt: 2 } } },
      storedContentMode: 'plain',
    });
    const secondAuthoritative = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: { path: '/private/second', host: 'second-host' },
      agentState: { requests: { second: { createdAt: 3 } } },
      storedContentMode: 'plain',
    });
    patchSessionMetadataEnvelopeTupleMock
      .mockResolvedValueOnce({
        success: false,
        error: 'session_metadata_version_conflict',
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 4 },
        agentState: { version: 6 },
      })
      .mockResolvedValueOnce({
        success: false,
        error: 'session_metadata_version_conflict',
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 5 },
        agentState: { version: 7 },
      })
      .mockResolvedValueOnce({
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 6 },
        ownerMetadata: { version: 6 },
        agentState: { version: 8 },
      });
    fetchSessionByIdCompatMock
      .mockResolvedValueOnce({
        id: 'sess_layout_consecutive_conflicts',
        metadataLayoutVersion: 1,
        metadata: firstAuthoritative.sharedMetadata.ciphertext,
        metadataVersion: 4,
        ownerMetadata: firstAuthoritative.ownerMetadata,
        agentState: firstAuthoritative.agentState,
        agentStateVersion: 6,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      })
      .mockResolvedValueOnce({
        id: 'sess_layout_consecutive_conflicts',
        metadataLayoutVersion: 1,
        metadata: secondAuthoritative.sharedMetadata.ciphertext,
        metadataVersion: 5,
        ownerMetadata: secondAuthoritative.ownerMetadata,
        agentState: secondAuthoritative.agentState,
        agentStateVersion: 7,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      });
    const initialCurrentness = e2eeCurrentness(credentials);
    const firstCurrentness = {
      ...initialCurrentness,
      version: 2,
      updatedAt: 2,
    };
    const secondCurrentness = {
      ...initialCurrentness,
      version: 3,
      updatedAt: 3,
    };
    fetchAccountEncryptionCurrentnessMock
      .mockResolvedValueOnce(firstCurrentness)
      .mockResolvedValueOnce(secondCurrentness);

    await updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout_consecutive_conflicts',
      accountEncryptionCurrentness: initialCurrentness,
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: initial.sharedMetadata.ciphertext,
        metadataVersion: 3,
        ownerMetadata: initial.ownerMetadata,
        agentState: initial.agentState,
        agentStateVersion: 5,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({
        ...metadata,
        path: '/private/requested',
      }),
    });

    expect(fetchSessionByIdCompatMock).toHaveBeenCalledTimes(2);
    expect(fetchAccountEncryptionCurrentnessMock).toHaveBeenCalledTimes(2);
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(3);
    expect(
      patchSessionMetadataEnvelopeTupleMock.mock.calls.map(
        ([request]) => ({
          expectedOwnerMetadata: request.patch.expectedOwnerMetadata,
          sharedMetadataVersion: request.patch.sharedMetadata.expectedVersion,
          agentStateVersion: request.patch.agentState.expectedVersion,
        }),
      ),
    ).toEqual([
      {
        expectedOwnerMetadata: initial.ownerMetadata,
        sharedMetadataVersion: 3,
        agentStateVersion: 5,
      },
      {
        expectedOwnerMetadata: firstAuthoritative.ownerMetadata,
        sharedMetadataVersion: 4,
        agentStateVersion: 6,
      },
      {
        expectedOwnerMetadata: secondAuthoritative.ownerMetadata,
        sharedMetadataVersion: 5,
        agentStateVersion: 7,
      },
    ]);
  });

  it.each(['ECONNABORTED', 'ECONNRESET'] as const)(
    'replays through the shared tuple owner when an ambiguous %s layout-1 write left the exact source unchanged',
    async (code) => {
    const credentials = {
      token: 'token-1',
      encryption: {
        type: 'legacy' as const,
        secret: new Uint8Array(32).fill(5),
      },
    };
    const fields = buildSessionMetadataEnvelopeFields({
      credentials,
      accountEncryptionMode: 'e2ee',
      metadata: { path: '/private', host: 'private-host' },
      agentState: null,
      storedContentMode: 'plain',
    });
    const ambiguous = Object.assign(new Error('request acknowledgement was lost'), {
      code,
    });
    patchSessionMetadataEnvelopeTupleMock
      .mockRejectedValueOnce(ambiguous)
      .mockResolvedValueOnce({
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 2 },
        agentState: { version: 2 },
      });
    fetchSessionByIdCompatMock.mockResolvedValue({
      metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext,
      metadataVersion: 1,
      ownerMetadata: fields.ownerMetadata,
      agentState: fields.agentState,
      agentStateVersion: 1,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue(
      e2eeCurrentness(credentials),
    );

    await expect(updateSessionMetadataWithRetry({
      token: credentials.token,
      credentials,
      sessionId: 'sess_layout_ambiguous',
      accountEncryptionCurrentness: e2eeCurrentness(credentials),
      rawSession: {
        metadataLayoutVersion: 1,
        metadata: fields.sharedMetadata.ciphertext,
        metadataVersion: 1,
        ownerMetadata: fields.ownerMetadata,
        agentState: fields.agentState,
        agentStateVersion: 1,
        encryptionMode: 'plain',
        dataEncryptionKey: null,
      },
      updater: (metadata) => ({ ...metadata, path: '/private/after' }),
    })).resolves.toMatchObject({
      version: 2,
      metadata: {
        path: '/private/after',
      },
    });

    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(2);
    expect(fetchSessionByIdCompatMock).toHaveBeenCalledTimes(1);
    expect(patchSessionMetadataMock).not.toHaveBeenCalled();
    },
  );
});

describe('shared-editor Session metadata authority', () => {
  const sessionEncryptionKey = new Uint8Array(32).fill(7);

  beforeEach(() => {
    fetchSessionByIdCompatMock.mockReset();
    patchSessionMetadataEnvelopeTupleMock.mockReset();
    patchSessionMetadataMock.mockReset();
    fetchAccountEncryptionCurrentnessMock.mockReset();
    fetchAccountEncryptionCurrentnessMock.mockRejectedValue(
      new Error('shared editors must not read Account encryption currentness'),
    );
  });

  function buildRawSharedEditorSession(params: Readonly<{
    metadata: Record<string, unknown>;
    metadataVersion: number;
  }>) {
    const fields = buildSessionMetadataEnvelopeFields({
      credentials: { token: 'owner-token', encryption: null },
      accountEncryptionMode: 'plain',
      metadata: params.metadata,
      agentState: null,
      storedContentMode: 'e2ee',
      encryptionKey: sessionEncryptionKey,
      encryptionVariant: 'legacy',
    });
    return {
      // A shared recipient never receives the owner envelope or full Agent state.
      metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext,
      metadataVersion: params.metadataVersion,
      agentState: null,
      agentStateVersion: 4,
      encryptionMode: 'e2ee',
      dataEncryptionKey: null,
    };
  }

  it('reads the shared projection from the Session data key without Account credentials', () => {
    const snapshot = readSessionMetadataSharedEditorTupleSnapshot({
      rawSession: buildRawSharedEditorSession({
        metadata: {
          path: '/owner/only',
          summary: { text: 'Shared title', updatedAt: 11 },
        },
        metadataVersion: 5,
      }),
      mode: 'e2ee',
      ctx: {
        encryptionKey: sessionEncryptionKey,
        encryptionVariant: 'legacy',
      },
    });

    expect(snapshot).toMatchObject({
      mode: 'shared_editor',
      metadataLayoutVersion: 1,
      metadataVersion: 5,
      value: {
        metadata: { v: 1, summary: { text: 'Shared title', updatedAt: 11 } },
        ownerMetadata: null,
        agentState: null,
      },
    });
    expect(
      (snapshot.value.metadata as Record<string, unknown>).path,
    ).toBeUndefined();
  });

  it('commits a shared-editor tuple patch without owner metadata or Agent state', async () => {
    const rawSession = buildRawSharedEditorSession({
      metadata: { summary: { text: 'Before', updatedAt: 1 } },
      metadataVersion: 5,
    });
    patchSessionMetadataEnvelopeTupleMock.mockResolvedValue({
      success: true,
      metadataLayoutVersion: 1,
      sharedMetadata: { version: 6 },
    });

    const updated = await updateSessionMetadataEnvelopeTupleWithRetry({
      token: 'runtime-token',
      sessionId: 'sess_shared_editor',
      authority: { kind: 'shared_editor' },
      mode: 'e2ee',
      ctx: {
        encryptionKey: sessionEncryptionKey,
        encryptionVariant: 'legacy',
      },
      initialSnapshot: readSessionMetadataSharedEditorTupleSnapshot({
        rawSession,
        mode: 'e2ee',
        ctx: {
          encryptionKey: sessionEncryptionKey,
          encryptionVariant: 'legacy',
        },
      }),
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({
          ...metadata,
          summary: { text: 'After', updatedAt: 2 },
        }),
      },
    });

    expect(updated).toMatchObject({
      mode: 'shared_editor',
      metadataVersion: 6,
      value: {
        metadata: { v: 1, summary: { text: 'After', updatedAt: 2 } },
      },
    });
    expect(patchSessionMetadataEnvelopeTupleMock).toHaveBeenCalledTimes(1);
    const [{ patch, token }] =
      patchSessionMetadataEnvelopeTupleMock.mock.calls[0];
    expect(token).toBe('runtime-token');
    expect(patch).toMatchObject({
      mode: 'shared_editor',
      metadataLayoutVersion: 1,
      sharedMetadata: { expectedVersion: 5 },
    });
    expect(patch.ownerMetadata).toBeUndefined();
    expect(patch.agentState).toBeUndefined();
    expect(fetchAccountEncryptionCurrentnessMock).not.toHaveBeenCalled();
  });

  it('refuses an owner-only field and an owner Agent-state mutation from a shared editor', async () => {
    const rawSession = buildRawSharedEditorSession({
      metadata: { summary: { text: 'Before', updatedAt: 1 } },
      metadataVersion: 5,
    });
    const crypto = {
      mode: 'e2ee' as const,
      ctx: {
        encryptionKey: sessionEncryptionKey,
        encryptionVariant: 'legacy' as const,
      },
    };
    const initialSnapshot = readSessionMetadataSharedEditorTupleSnapshot({
      rawSession,
      ...crypto,
    });

    await expect(updateSessionMetadataEnvelopeTupleWithRetry({
      token: 'runtime-token',
      sessionId: 'sess_shared_editor',
      authority: { kind: 'shared_editor' },
      ...crypto,
      initialSnapshot,
      mutation: {
        kind: 'metadata',
        update: (metadata) => ({ ...metadata, path: '/owner/only' }),
      },
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
    });

    // Bot changes preserve the prechange memory baseline in owner work. A
    // shared title editor cannot acquire that owner authority via the marker.
    await expect(updateSessionMetadataEnvelopeTupleWithRetry({
      token: 'runtime-token', sessionId: 'sess_shared_editor',
      authority: { kind: 'shared_editor' }, ...crypto, initialSnapshot,
      mutation: { kind: 'metadata', update: metadata =>
        applySessionStateUpdatesToMetadata(metadata, [{ fieldId: 'display.bot', value: { kind: 'bot' } }]) },
    })).rejects.toMatchObject({ code: 'metadata_privacy_upgrade_required' });

    await expect(updateSessionMetadataEnvelopeTupleWithRetry({
      token: 'runtime-token',
      sessionId: 'sess_shared_editor',
      authority: { kind: 'shared_editor' },
      ...crypto,
      initialSnapshot,
      mutation: {
        kind: 'agentState',
        update: (agentState) => ({ ...agentState, thinking: true }),
      },
    })).rejects.toMatchObject({
      code: 'metadata_privacy_upgrade_required',
    });

    expect(patchSessionMetadataEnvelopeTupleMock).not.toHaveBeenCalled();
  });
});
