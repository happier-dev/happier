import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol';
import { readSessionStartupFailurePreview } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { SessionTurnMutationV1Schema, type SessionTurnMutationV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { SPAWN_SESSION_ERROR_CODES, SPAWN_SESSION_ERROR_DETAIL_KINDS, type ConnectedServiceUxDiagnosticSpawnErrorDetail } from '@happier-dev/protocol/spawnSession';

import { reloadConfiguration } from '@/configuration';
import { createAccountEncryptionCurrentnessFixture, createCurrentSessionProjectionRecordFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionMetadataEnvelopeCreateFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createSpawnedSession } from './createSpawnedSession';

afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); resetServerFeaturesClientForTests(); });

describe('committed Session pre-admission failure', () => {
  it.each(['pool', 'diagnostic'] as const)('persists the %s refusal as a readable startup issue', async variant => {
    const home = await mkdtemp(join(tmpdir(), 'happier-pre-admission-refusal-'));
    const sessionId = 'c1234567890123456789012345';
    const credentials = { token: 'fixture-token', encryption: null } as const;
    const currentness = createAccountEncryptionCurrentnessFixture();
    const fields = buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: 'plain',
      storedContentMode: 'plain', metadata: { path: home, host: 'fixture-host', flavor: 'codex' }, agentState: null });
    const row = createCurrentSessionProjectionRecordFixture({ ...createSessionNotificationContextFixture(sessionId),
      encryptionMode: 'plain', share: null, active: false, archivedAt: null,
      metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
      ownerMetadata: fields.ownerMetadata, dataEncryptionKey: null });
    const mutations: SessionTurnMutationV1[] = [];
    const unknownRequests: string[] = [];
    const http = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      const path = request.url?.split('?')[0] ?? '';
      const send = (value: unknown) => response.end(JSON.stringify(value));
      if (path === '/v1/features') return send({ features: {}, capabilities: { encryption: {
        storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain',
      } } });
      if (path === '/v1/account/profile') return send({ id: 'fixture-account' });
      if (path === '/v1/account/encryption/currentness') return send(currentness);
      if (path.startsWith('/v1/access-keys/')) return send({ accessKey: 'fixture-existing-binding' });
      if (path === '/v2/sessions/lookup-by-tags') return send({ sessions: [] });
      if (path === '/v1/sessions' && request.method === 'POST') return send({ session: row, created: true });
      if (path === `/v1/sessions/${sessionId}/turns/mutations`) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const mutation = SessionTurnMutationV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        mutations.push(mutation);
        return send({ ok: true, receipt: { v: mutation.v, sessionId, mutationId: mutation.mutationId,
          action: mutation.action, ...('turnId' in mutation ? { turnId: mutation.turnId } : {}),
          observedAt: mutation.observedAt, appliedAt: mutation.observedAt, decision: 'applied' } });
      }
      if (path.endsWith('/archive')) return send({ archivedAt: 1 });
      unknownRequests.push(`${request.method} ${path}`);
      response.statusCode = 404;
      return send({ error: 'not_found' });
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture HTTP endpoint');
    vi.stubEnv('HAPPIER_HOME_DIR', home);
    vi.stubEnv('HAPPIER_SERVER_URL', `http://127.0.0.1:${address.port}`);
    reloadConfiguration();
    resetServerFeaturesClientForTests();
    const code = variant === 'pool' ? 'no_eligible_member' : 'no_eligible_group_member';
    try {
      await expect(createSpawnedSession({ credentials, directory: home, machineId: 'fixture-machine',
        accountEncryptionCurrentness: currentness, accountSettings: {},
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'refused' }),
        beforeLaunch: async () => {},
        directTransport: {
          spawn: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'PRIVATE_ADAPTER_PROSE', errorDetail: variant === 'pool'
              ? { kind: 'launch_error', code, message: 'PRIVATE_ADAPTER_PROSE',
                connectedAccountPool: { serviceId: 'openai-codex', excluded: [] } }
              : { kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC, uxDiagnostic: {
                code: 'no_eligible_group_member', failurePhase: 'materialization', source: 'spawn_resume', retryable: false, suggestedActions: [],
              } } satisfies ConnectedServiceUxDiagnosticSpawnErrorDetail }),
          resolveSpawnSessionByNonce: async () => { throw new Error('A definite refusal is already settled'); },
        },
      })).rejects.toMatchObject({ code });
      expect(unknownRequests).toEqual([]);
      const failed = mutations.find(mutation => mutation.action === 'fail');
      expect(failed).toMatchObject({ action: 'fail', issue: { code } });
      if (!failed || failed.action !== 'fail') throw new Error('Missing persisted failure');
      expect(readSessionStartupFailurePreview(failed.issue.code)).not.toBeNull();
      expect(JSON.stringify(mutations)).not.toContain('PRIVATE_ADAPTER_PROSE');
    } finally {
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });
});
