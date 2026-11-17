import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  decodeBase64,
  deriveBoxPublicKeyFromSeed,
  openEncryptedDataKeyEnvelopeV1,
  signAccountContentKeyBindingV1,
  SessionInitialTriggerAdmissionV1Schema,
  type PatchSessionDataKeyEnvelopesV1,
  type SessionInitialAccessDraftV1,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { getOrCreateSessionByTag } from '@/session/transport/http/sessionsHttp';
import { ApiClient } from './api';
import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { readSessionCreationTerminalSpawnErrorDetail } from './session/sessionCreationTerminalSpawnErrorDetail';
import { resolveConnectedServicesServerApiTimeoutMs } from './client/connectedServicesServerApiTimeout';
import { commitDaemonLaunchSession } from '@/daemon/spawn/commitDaemonLaunchSession';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

const initialAccess: SessionInitialAccessDraftV1 = {
  grants: [{ subject: { kind: 'team', teamId: 'team-1' }, accessLevel: 'edit', canApprovePermissions: false }],
};
const credentials = { token: 'token-1', encryption: null };
const metadata = {
  path: '/workspace', host: 'host', homeDir: '/home/user',
  happyHomeDir: '/home/user/.happier', happyLibDir: '/lib', happyToolsDir: '/tools',
};
const creation = { credentials, tag: 'access-create', metadata, agentState: null, state: null };
const initialTriggers = [SessionInitialTriggerAdmissionV1Schema.parse({
  automationId: 'automation-initial', name: 'Prepare workspace', enabled: true,
  workflowDefinitionId: 'builtin:review-and-converge', assignments: [{ machineId: 'machine-1', enabled: true }],
  executionRecipe: { v: 2, templateVersion: 0, triggerEvidence: null,
    workflow: { t: 'plain', v: { workspace: { directory: '/workspace' }, executionTarget: { kind: 'session' } } } },
  triggers: [{ triggerId: 'trigger-initial', trigger: { kind: 'sessionLifecycle', enabled: true,
    events: ['sessionStarted'], policy: { kind: 'firstMatch' } } }],
})];

function features(
  sharing: boolean,
  storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only' = 'plaintext_only',
) {
  // Initial access is Session sharing: there is no separate collaboration bit.
  return {
    features: {
      sessions: { enabled: true },
      sharing: { session: { enabled: sharing } },
    },
    capabilities: {
      accountStoredContentCompatibility: {
        v: 1, minimumProtocolVersion: 2, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        declarationTransport: 'http-header-and-socket-auth-v1',
      },
      encryption: { storagePolicy, allowAccountOptOut: false, defaultAccountMode: storagePolicy === 'plaintext_only' ? 'plain' : 'e2ee' },
    },
  };
}

for (const owner of ['api', 'http'] as const) {
  describe(`${owner} fresh Session initial access HTTP boundary`, () => {
    let createdByServer = true;
    const create = async (accessFields: Record<string, unknown>) => {
      const params = { ...creation, ...accessFields };
      if (owner === 'http') return getOrCreateSessionByTag(params);
      const api = await ApiClient.create(credentials);
      return api.getOrCreateSession(params);
    };
    beforeEach(() => {
      createdByServer = true;
      // The public feature snapshot is a process-local TTL cache keyed by Home
      // URL; each case stubs its own Home answer at the fetch boundary.
      resetServerFeaturesClientForTests();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features(true)))));
      vi.spyOn(axios, 'get').mockImplementation(async url => String(url).endsWith('/v2/account/settings')
        ? { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } }
        : { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } });
      vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
        const payload = body as { sharedMetadata: { ciphertext: string }; ownerMetadata: unknown };
        return { status: 200, data: { created: createdByServer, organizationPlacement: { folderId: null, tagIds: [] }, session: {
          id: 'created-session', seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
          encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: payload.sharedMetadata.ciphertext,
          share: null,
          ownerMetadata: payload.ownerMetadata, metadataVersion: 0, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
        } } };
      });
    });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

    it.each([true, false])('respects caller lifetime and the legacy POST cutoff (callerLifetime=%s)', async (hasLifetime) => {
      vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS', '1');
      vi.useFakeTimers();
      const lifetime = new AbortController();
      const post = vi.mocked(axios.post).getMockImplementation()!;
      vi.mocked(axios.post).mockImplementation(async (url, body, options) => await new Promise<Awaited<ReturnType<typeof post>>>((resolve, reject) => {
        // Axios is the network boundary: enforce its configured timeout so a
        // delayed server receipt cannot pass through a shorter transport cutoff.
        const response = setTimeout(() => {
          if (deadline !== undefined) clearTimeout(deadline);
          resolve(post(url, body, options));
        }, 60_001);
        const deadline = options?.timeout && options.timeout > 0 ? setTimeout(() => {
          clearTimeout(response);
          reject(new axios.AxiosError('Session creation timed out', 'ECONNABORTED'));
        }, options.timeout) : undefined;
      }));
      try {
        const pending = create(hasLifetime ? { signal: lifetime.signal } : {});
        const completed = hasLifetime ? expect(pending).resolves.toMatchObject(owner === 'api'
          ? { id: 'created-session' } : { session: { id: 'created-session' } })
          : expect(pending).rejects.toMatchObject({ code: 'outcome_unknown', cause: { code: 'ECONNABORTED' } });
        void completed.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(60_001);
        await completed;
        expect(axios.post).toHaveBeenCalledTimes(1);
      } finally {
        lifetime.abort();
        vi.useRealTimers();
      }
    });

    it('keeps uncertain creation diagnostics free of request credentials and content', async () => {
      vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS', '1');
      const secret = 'fixture-creation-private-content';
      vi.mocked(axios.post).mockRejectedValueOnce(Object.assign(new Error('Response lost'), {
        isAxiosError: true, code: 'ECONNRESET',
        config: { url: `https://home.example/v1/sessions?token=${secret}`, method: 'post',
          headers: { Authorization: `Bearer ${secret}` }, data: { metadata: secret } },
      }));
      const failure = await create({}).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'outcome_unknown', cause: { code: 'ECONNRESET' } });
      expect(JSON.stringify(failure)).not.toContain(secret);
    });

    if (owner === 'api') it('cancels daemon creation through the retained Action lifetime after the old POST cutoff', async () => {
      vi.useFakeTimers();
      const operations = createHostActionOperationRuntime({ machineId: 'machine-1', resolveAccountId: async () => 'owner-1',
        generateOperationId: () => 'creation-operation', supportsCoreCancellation: () => true });
      let postEntered!: () => void;
      const entered = new Promise<void>(resolve => { postEntered = resolve; });
      vi.mocked(axios.post).mockImplementation(async (_url, _body, options) => await new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          if (deadline !== undefined) clearTimeout(deadline);
          reject(new axios.CanceledError());
        };
        const deadline = options?.timeout && options.timeout > 0 ? setTimeout(() => {
          options?.signal?.removeEventListener?.('abort', onAbort);
          reject(new axios.AxiosError('Session creation timed out', 'ECONNABORTED'));
        }, options.timeout) : undefined;
        options?.signal?.addEventListener?.('abort', onAbort, { once: true });
        postEntered();
      }));
      const api = await ApiClient.create(credentials);
      let settled = false;
      const pending = operations.observeExecution({ actionId: 'session.spawn_new', input: { creationKey: 'creation-key' },
        execute: async operation => ({ ok: true, result: await commitDaemonLaunchSession({ api, credentials,
          options: { directory: '/workspace', projectSetupOperation: operation }, directory: '/workspace', accountSettings: {} }) }),
      });
      void pending.then(() => { settled = true; }, () => { settled = true; });
      try {
        await entered;
        await vi.advanceTimersByTimeAsync(60_001);
        expect(settled).toBe(false);
        expect(operations.runner.cancel({ accountId: 'owner-1', machineId: 'machine-1' }, 'creation-operation'))
          .toEqual({ kind: 'requested' });
        await expect(pending).rejects.toMatchObject({ code: 'outcome_unknown' });
        expect(axios.post).toHaveBeenCalledTimes(1);
      } finally {
        operations.runner.cancel({ accountId: 'owner-1', machineId: 'machine-1' }, 'creation-operation');
        await vi.advanceTimersByTimeAsync(60_001);
        await pending.catch(() => undefined);
        vi.useRealTimers();
      }
    });

    it('creates the Session when Account currentness arrives within its canonical HTTP budget', async () => {
      vi.useFakeTimers();
      vi.stubEnv('HAPPIER_CONNECTED_SERVICES_API_TIMEOUT_MS', '30000');
      const currentnessBudget = resolveConnectedServicesServerApiTimeoutMs();
      const responseDelay = currentnessBudget / 2;
      vi.mocked(axios.get).mockImplementation(async (url, options) => {
        if (!String(url).endsWith('/v1/account/encryption/currentness')) throw new Error('Unexpected GET');
        const currentnessResponse = { status: 200, data: {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
          recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
        } };
        return await new Promise<typeof currentnessResponse>((resolve, reject) => {
          const response = setTimeout(() => {
            clearTimeout(deadline);
            resolve(currentnessResponse);
          }, responseDelay);
          // Axios is the real network boundary: honor its supplied timeout,
          // rather than making a delayed response succeed under any budget.
          const deadline = setTimeout(() => {
            clearTimeout(response);
            reject(new axios.AxiosError('Account read timed out', 'ECONNABORTED'));
          }, options?.timeout ?? currentnessBudget);
        });
      });
      try {
        const created = create({});
        const settled = expect(created).resolves.toMatchObject(owner === 'api'
          ? { id: 'created-session' }
          : { session: { id: 'created-session' } });
        void settled.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(responseDelay - 1);
        expect(axios.post).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await settled;
        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toMatchObject({ encryptionMode: 'plain' });
      } finally {
        vi.useRealTimers();
      }
    });

    if (owner === 'api') it('reports an offline preflight distinctly before any durable Session creation attempt', async () => {
      vi.mocked(axios.get).mockRejectedValue(new axios.AxiosError('Account read timed out', 'ECONNABORTED'));
      const api = await ApiClient.create(credentials);
      const result = await commitDaemonLaunchSession({ api, credentials, options: { directory: '/workspace' },
        directory: '/workspace', accountSettings: {} });
      expect(result).toMatchObject({ ok: false, result: { type: 'error', errorCode: 'SPAWN_FAILED',
        errorMessage: expect.stringMatching(/offline|unreachable/i) } });
      expect(axios.post).not.toHaveBeenCalled();
    });

    if (owner === 'api') it('retains an exhausted server transaction as a server failure through daemon launch commitment', async () => {
      vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS', '1');
      vi.mocked(axios.post).mockRejectedValue(new axios.AxiosError('Request failed with status code 503', undefined,
        undefined, undefined, { status: 503, data: { error: 'database_transaction_conflict_exhausted', statusCode: 503 },
          headers: {}, statusText: 'Service Unavailable', config: { headers: new axios.AxiosHeaders() } }));
      const api = await ApiClient.create(credentials);
      const error: unknown = await commitDaemonLaunchSession({ api, credentials, options: { directory: '/workspace' },
        directory: '/workspace', accountSettings: {} }).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'database_transaction_conflict_exhausted', response: { status: 503 } });
      expect(classifyServerEndpointError(error)).toMatchObject({ kind: 'server_error', retryable: true, statusCode: 503 });
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('transports initial grants and explicit Team context only as create fields', async () => {
      await create({ initialAccess, primaryTeamId: 'team-1' });
      const body = vi.mocked(axios.post).mock.calls[0]?.[1];
      expect(body).toMatchObject({ metadataLayoutVersion: 1, initialAccess, primaryTeamId: 'team-1' });
      expect(JSON.stringify((body as { ownerMetadata: unknown }).ownerMetadata)).not.toContain('initialAccess');
      expect(JSON.stringify((body as { sharedMetadata: unknown }).sharedMetadata)).not.toContain('initialAccess');
      expect(vi.mocked(axios.get).mock.calls.some(call => String(call[0]).includes('/data-key/envelopes'))).toBe(false);
    });

    it('delivers the sealed trigger recipe only through the Session birth request', async () => {
      const preparedFinalSessionId = 'prepared-final-session';
      await create({ initialTriggers, preparedFinalSessionId });
      expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toMatchObject({ initialTriggers, preparedFinalSessionId });
      expect(JSON.stringify((vi.mocked(axios.post).mock.calls[0]?.[1] as { ownerMetadata: unknown }).ownerMetadata))
        .not.toContain('initialTriggers');
    });

    it.each(['invalid_input', 'target_unavailable', 'feature_disabled'] as const)(
      'preserves a no-effect initial-trigger birth refusal %s without retrying', async (code) => {
        const response = { status: code === 'invalid_input' ? 400 : 409,
          data: { error: 'initial_trigger_admission_failed', code } };
        if (owner === 'api') vi.mocked(axios.post).mockRejectedValueOnce({ isAxiosError: true, response });
        else vi.mocked(axios.post).mockResolvedValueOnce(response);
        const error = await create({ initialTriggers }).catch((error: unknown) => error);
        expect(error).toMatchObject({ code, retryable: false });
        expect(readSessionCreationTerminalSpawnErrorDetail(error)).toEqual({
          kind: 'session_creation_initial_trigger_refused', code,
        });
        expect(axios.post).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      [403, 'session_access_external_sharing_disabled'],
      [503, 'session_access_authentication_unavailable'],
    ] as const)('preserves server-rejected initial-access code %s/%s without retrying', async (status, code) => {
      const response = {
        status,
        data: { error: code },
      };
      if (owner === 'api') {
        vi.mocked(axios.post).mockRejectedValueOnce({ isAxiosError: true, response });
      } else {
        vi.mocked(axios.post).mockResolvedValueOnce(response);
      }

      await expect(create({ initialAccess, primaryTeamId: 'team-1' })).rejects.toMatchObject({
        code,
        retryable: false,
      });
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('keeps direct Account initial access key-free for a Plain Session', async () => {
      const directAccess: SessionInitialAccessDraftV1 = { grants: [{
        subject: { kind: 'account', accountId: 'recipient-account' },
        accessLevel: 'view', canApprovePermissions: false,
      }] };
      await create({ initialAccess: directAccess });
      expect((vi.mocked(axios.post).mock.calls[0]?.[1] as { initialAccess: unknown }).initialAccess).toEqual(directAccess);
      expect(vi.mocked(axios.get).mock.calls.some((call) => String(call[0]).includes('/v1/user/'))).toBe(false);
    });

    it.each([
      { created: true, lostReceipt: false },
      { created: false, lostReceipt: false },
      ...(owner === 'api' ? [{ created: false, lostReceipt: true }] : []),
    ])('prepares collective E2EE access using the returned Session key ($created, lostReceipt=$lostReceipt)', async ({ created, lostReceipt }) => {
      vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS', '0');
      const callerMachineKey = new Uint8Array(32).fill(7);
      const recipient = tweetnacl.box.keyPair();
      const signing = tweetnacl.sign.keyPair();
      const e2eeCredentials = { token: 'token-1', encryption: {
        type: 'dataKey' as const, publicKey: deriveBoxPublicKeyFromSeed(callerMachineKey), machineKey: callerMachineKey,
      } };
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features(true, 'required_e2ee')))));
      let committed: PatchSessionDataKeyEnvelopesV1 | undefined;
      vi.mocked(axios.get).mockImplementation(async (url) => {
        if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
          mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1,
          recipientEnvelopeReadiness: { status: 'available' },
        } };
        if (String(url).includes('/created-session/data-key/envelopes')) return { status: 200, data: {
          status: 'required', items: committed ? [] : [{
            recipientAccountId: 'teammate', envelopeState: 'missing', contentKey: {
              status: 'available', accountSigningPublicKey: Buffer.from(signing.publicKey).toString('hex'),
              contentPublicKey: Buffer.from(recipient.publicKey).toString('base64'),
              contentPublicKeySignature: Buffer.from(signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey, contentPublicKey: recipient.publicKey,
              })).toString('base64'),
            },
          }], nextCursor: null,
          summary: { prepared: committed ? 1 : 0, pending: committed ? 0 : 1, invalid: 0, recipientKeyUnavailable: 0 },
        } };
        throw new Error(`Unexpected GET ${String(url)}`);
      });
      vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
        committed = body as PatchSessionDataKeyEnvelopesV1;
        return { status: 200, data: { appliedCount: committed.entries.length } };
      });
      // A rejoin returns the original owner's envelope, never the new request's random key.
      let returnedOwnerEnvelope = '';
      let originalPayload: { sharedMetadata: { ciphertext: string }; ownerMetadata: unknown; dataEncryptionKey: string; agentState: string | null } | undefined;
      vi.mocked(axios.post).mockImplementation(async (_url, body) => {
        const firstCreate = originalPayload === undefined;
        originalPayload ??= body as NonNullable<typeof originalPayload>;
        const payload = originalPayload;
        returnedOwnerEnvelope = payload.dataEncryptionKey;
        if (firstCreate && lostReceipt) {
          throw new axios.AxiosError('Committed creation response lost', 'ECONNRESET');
        }
        return { status: 200, data: { created: firstCreate || created, organizationPlacement: { folderId: null, tagIds: [] }, session: {
          id: 'created-session', seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
          encryptionMode: 'e2ee', metadataLayoutVersion: 1, metadata: payload.sharedMetadata.ciphertext,
          share: null, ownerMetadata: payload.ownerMetadata, metadataVersion: 0,
          agentState: payload.agentState, agentStateVersion: 0, dataEncryptionKey: returnedOwnerEnvelope,
        } } };
      });
      if (!created && !lostReceipt) {
        const originalParams = { ...creation, credentials: e2eeCredentials, initialAccess };
        if (owner === 'http') await getOrCreateSessionByTag(originalParams);
        else await (await ApiClient.create(e2eeCredentials)).getOrCreateSession(originalParams);
        // A rejoin may repair a missing recipient tuple, but never changes the
        // original Team grant or replaces the returned Session's key.
        committed = undefined;
      }
      const params = { ...creation, credentials: e2eeCredentials, initialAccess };
      if (owner === 'http') await getOrCreateSessionByTag(params);
      else await (await ApiClient.create(e2eeCredentials)).getOrCreateSession(params);
      expect(committed?.entries).toHaveLength(1);
      expect(openEncryptedDataKeyEnvelopeV1({
        envelope: decodeBase64(committed!.entries[0]!.encryptedDataKey), recipientSecretKeyOrSeed: recipient.secretKey,
      })).toEqual(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(returnedOwnerEnvelope), recipientSecretKeyOrSeed: callerMachineKey }));
      expect(vi.mocked(axios.post).mock.calls[0]?.[1]).not.toHaveProperty('primaryTeamId');
      if (lostReceipt) {
        expect(vi.mocked(axios.post).mock.calls.map(call => call[1])).toMatchObject([
          { tag: creation.tag, initialAccess },
          { tag: creation.tag, initialAccess },
        ]);
      }
    });

    it('materializes a ready direct E2EE recipient envelope only at the physical create boundary', async () => {
      const callerMachineKey = new Uint8Array(32).fill(7);
      const callerPublicKey = deriveBoxPublicKeyFromSeed(callerMachineKey);
      const recipientContentKey = tweetnacl.box.keyPair();
      const recipientSigningKey = tweetnacl.sign.keyPair();
      const recipientContentKeySignature = signAccountContentKeyBindingV1({
        accountSigningSecretKey: recipientSigningKey.secretKey,
        contentPublicKey: recipientContentKey.publicKey,
      });
      const e2eeCredentials = {
        token: 'token-1',
        encryption: { type: 'dataKey' as const, publicKey: callerPublicKey, machineKey: callerMachineKey },
      };
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features(true, 'required_e2ee')))));
      vi.spyOn(axios, 'get').mockImplementation(async (url) => {
        if (String(url).endsWith('/v1/account/encryption/currentness')) {
          return { status: 200, data: {
            mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'available' },
          } };
        }
        if (String(url).endsWith('/v1/user/recipient-account')) {
          return { status: 200, data: { user: {
            id: 'recipient-account', firstName: 'Recipient', lastName: null, avatar: null,
            username: 'recipient', bio: null, badges: [], status: 'none',
            publicKey: Buffer.from(recipientSigningKey.publicKey).toString('hex'),
            contentPublicKey: Buffer.from(recipientContentKey.publicKey).toString('base64'),
            contentPublicKeySig: Buffer.from(recipientContentKeySignature).toString('base64'),
            recipientEnvelopeReadiness: { status: 'available' },
          } } };
        }
        throw new Error(`Unexpected GET ${String(url)}`);
      });
      vi.mocked(axios.post).mockImplementation(async (_url, body) => {
        const payload = body as Record<string, any>;
        return { status: 200, data: { created: true, organizationPlacement: { folderId: null, tagIds: [] }, session: {
          id: 'created-session', seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
          encryptionMode: 'e2ee', metadataLayoutVersion: 1, metadata: payload.sharedMetadata.ciphertext,
          share: null, ownerMetadata: payload.ownerMetadata, metadataVersion: 0,
          agentState: payload.agentState, agentStateVersion: 0, dataEncryptionKey: payload.dataEncryptionKey,
        } } };
      });

      const directAccess: SessionInitialAccessDraftV1 = { grants: [{
        subject: { kind: 'account', accountId: 'recipient-account' },
        accessLevel: 'edit', canApprovePermissions: false,
      }] };
      const params = { ...creation, credentials: e2eeCredentials, initialAccess: directAccess };
      if (owner === 'http') await getOrCreateSessionByTag(params);
      else await (await ApiClient.create(e2eeCredentials)).getOrCreateSession(params);

      expect(axios.post).toHaveBeenCalledTimes(1);
      const body = vi.mocked(axios.post).mock.calls[0]?.[1] as Record<string, any>;
      expect(directAccess.grants[0]).not.toHaveProperty('accountEnvelopeInput');
      expect(body.initialAccess.grants[0]).toMatchObject({
        subject: { kind: 'account', accountId: 'recipient-account' },
        accountEnvelopeInput: { v: 1, encryptedDataKey: expect.any(String) },
      });
      const ownerDataKey = openEncryptedDataKeyEnvelopeV1({
        envelope: decodeBase64(body.dataEncryptionKey),
        recipientSecretKeyOrSeed: callerMachineKey,
      });
      expect(ownerDataKey).not.toBeNull();
      expect(openEncryptedDataKeyEnvelopeV1({
        envelope: decodeBase64(body.initialAccess.grants[0].accountEnvelopeInput.encryptedDataKey),
        recipientSecretKeyOrSeed: recipientContentKey.secretKey,
      })).toEqual(ownerDataKey);
    });

    it.each(['encryption_setup_required', 'encryption_inconsistent'] as const)('keeps %s direct E2EE initial access key-free', async (reason) => {
      const callerMachineKey = new Uint8Array(32).fill(7);
      const e2eeCredentials = {
        token: 'token-1',
        encryption: { type: 'dataKey' as const, publicKey: deriveBoxPublicKeyFromSeed(callerMachineKey), machineKey: callerMachineKey },
      };
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features(true, 'required_e2ee')))));
      vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/v1/account/encryption/currentness')
        ? { status: 200, data: {
            mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'available' },
          } }
        : { status: 200, data: { user: {
            id: 'recipient-account', firstName: 'Recipient', lastName: null, avatar: null,
            username: 'recipient', bio: null, badges: [], status: 'none',
            publicKey: null, contentPublicKey: null, contentPublicKeySig: null,
            recipientEnvelopeReadiness: { status: 'unavailable', reason },
          } } });
      vi.mocked(axios.post).mockImplementation(async (_url, body) => {
        const payload = body as Record<string, any>;
        return { status: 200, data: { created: true, organizationPlacement: { folderId: null, tagIds: [] }, session: {
          id: 'created-session', seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
          encryptionMode: 'e2ee', metadataLayoutVersion: 1, metadata: payload.sharedMetadata.ciphertext,
          share: null, ownerMetadata: payload.ownerMetadata, metadataVersion: 0,
          agentState: payload.agentState, agentStateVersion: 0, dataEncryptionKey: payload.dataEncryptionKey,
        } } };
      });
      const directAccess: SessionInitialAccessDraftV1 = { grants: [{
        subject: { kind: 'account', accountId: 'recipient-account' }, accessLevel: 'view', canApprovePermissions: false,
      }] };
      const params = { ...creation, credentials: e2eeCredentials, initialAccess: directAccess };
      if (owner === 'http') await getOrCreateSessionByTag(params);
      else await (await ApiClient.create(e2eeCredentials)).getOrCreateSession(params);
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect((vi.mocked(axios.post).mock.calls[0]?.[1] as Record<string, any>).initialAccess).toEqual(directAccess);
    });

    it('rejects malformed direct-recipient binding before Session creation', async () => {
      const callerMachineKey = new Uint8Array(32).fill(7);
      const e2eeCredentials = {
        token: 'token-1',
        encryption: { type: 'dataKey' as const, publicKey: deriveBoxPublicKeyFromSeed(callerMachineKey), machineKey: callerMachineKey },
      };
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features(true, 'required_e2ee')))));
      vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).endsWith('/v1/account/encryption/currentness')
        ? { status: 200, data: {
            mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'available' },
          } }
        : { status: 200, data: { user: {
            id: 'recipient-account', firstName: 'Recipient', lastName: null, avatar: null,
            username: 'recipient', bio: null, badges: [], status: 'none',
            publicKey: 'not-hex', contentPublicKey: 'not-base64', contentPublicKeySig: 'not-base64',
            recipientEnvelopeReadiness: { status: 'available' },
          } } });
      const directAccess: SessionInitialAccessDraftV1 = { grants: [{
        subject: { kind: 'account', accountId: 'recipient-account' }, accessLevel: 'view', canApprovePermissions: false,
      }] };
      const params = { ...creation, credentials: e2eeCredentials, initialAccess: directAccess };
      const promise = owner === 'http'
        ? getOrCreateSessionByTag(params)
        : (await ApiClient.create(e2eeCredentials)).getOrCreateSession(params);
      await expect(promise).rejects.toMatchObject({ code: 'session_access_invalid_recipient_envelope' });
      expect(axios.post).not.toHaveBeenCalled();
    });

    if (owner === 'http') it('creates Replay access under its caller lifetime and removes it from the existing-row runner attachment', async () => {
      vi.useFakeTimers();
      const transportFailure = new Error('transport unavailable');
      const lifetime = new AbortController();
      const post = vi.mocked(axios.post).getMockImplementation()!;
      vi.mocked(axios.post).mockImplementation(async (url, body, options) => await new Promise<Awaited<ReturnType<typeof post>>>((resolve, reject) => {
        const response = setTimeout(() => {
          if (deadline !== undefined) clearTimeout(deadline);
          resolve(post(url, body, options));
        }, 60_001);
        const deadline = options?.timeout && options.timeout > 0 ? setTimeout(() => {
          clearTimeout(response);
          reject(new axios.AxiosError('Session creation timed out', 'ECONNABORTED'));
        }, options.timeout) : undefined;
      }));
      let attached: unknown;
      const pending = createSpawnedSession({
        signal: lifetime.signal,
        credentials, directory: metadata.path, initialAccess, initialTriggers, primaryTeamId: 'team-1',
        replaySeededCreation: {
          tag: creation.tag, flavor: 'codex', metadata,
          sourceRecipe: { sourceSessionId: 'source', cutoffSeqInclusive: 1 },
        },
        directTransport: {
          spawn: async (request) => { attached = request; throw transportFailure; },
          resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }),
        },
      });
      const completed = expect(pending).rejects.toBe(transportFailure);
      void completed.catch(() => undefined);
      try {
        await vi.advanceTimersByTimeAsync(60_001);
        await completed;
      } finally {
        lifetime.abort();
        vi.useRealTimers();
      }
      expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toMatchObject({ initialAccess, initialTriggers, primaryTeamId: 'team-1' });
      expect(attached).toMatchObject({ existingSessionId: 'created-session' });
      expect(attached).not.toHaveProperty('initialAccess');
      expect(attached).not.toHaveProperty('initialTriggers');
      expect(attached).not.toHaveProperty('preparedFinalSessionId');
      expect(attached).not.toHaveProperty('primaryTeamId');
    });

    if (owner === 'api') it('carries fresh bootstrap access through the real API and preserves refusal before opening a session', async () => {
      // The Home refuses access-bearing creation with its own typed reason
      // when Session sharing is off; nothing is created and nothing is opened.
      const refusal = { code: 'session_access_sharing_unavailable', status: 409, retryable: false };
      vi.mocked(axios.post).mockRejectedValueOnce({ isAxiosError: true, response: {
        status: 409, data: { error: 'session_access_sharing_unavailable' },
      } });
      await expect(initializeBackendRunSession({
        api: await ApiClient.create(credentials),
        sessionTag: creation.tag,
        initialAccess,
        primaryTeamId: 'team-1',
        metadata,
        state: { controlledByUser: false },
        uiLogPrefix: '[test]',
        startupMetadataOverrides: { permissionModeOverride: { mode: 'default', updatedAt: 1 } },
      })).rejects.toMatchObject(refusal);
      expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toMatchObject({ initialAccess, primaryTeamId: 'team-1' });
    });

    if (owner === 'api') it.each([true, false])(
      'reconciles an unknown Machine binding receipt within the creation budget (committed=%s)', async committed => {
        vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS', '2');
        vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS', '0');
        const post = vi.mocked(axios.post).getMockImplementation()!;
        const get = vi.mocked(axios.get).getMockImplementation()!;
        const sessionRequests: unknown[] = [];
        const bindingPaths: string[] = [];
        let bound = false;
        let loseReceipt = true;
        vi.mocked(axios.get).mockImplementation(async (url, options) => String(url).includes('/v1/access-keys/')
          ? { status: 200, data: { accessKey: bound ? { data: 'incumbent-binding' } : null } }
          : get(url, options));
        vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
          if (String(url).includes('/v1/access-keys/')) {
            bindingPaths.push(String(url));
            if (loseReceipt) {
              loseReceipt = false;
              bound = committed;
              throw new axios.AxiosError('Private binding response lost', 'ECONNABORTED', {
                url: String(url), headers: new axios.AxiosHeaders(),
              });
            }
            bound = true;
            return { status: 200, data: { success: true } };
          }
          sessionRequests.push(body);
          return post(url, body, options);
        });
        const api = await ApiClient.create(credentials);
        api.setLocalMachineId(`receipt-machine-${committed}`);
        await expect(api.getOrCreateSession({ ...creation, initialAccess })).resolves.toMatchObject({ id: 'created-session' });
        expect(bound).toBe(true);
        expect(sessionRequests).toHaveLength(2);
        expect(sessionRequests[1]).toEqual(sessionRequests[0]);
        expect(new Set(bindingPaths.map(path => new URL(path).pathname))).toEqual(new Set([
          `/v1/access-keys/created-session/receipt-machine-${committed}`,
        ]));
        // A committed lost receipt rejoins by GET; an uncommitted one writes
        // the same tuple. Neither may replace an established access key.
        expect(bindingPaths).toHaveLength(committed ? 1 : 2);
      },
    );

    if (owner === 'api') it('preserves preparation classification when the Machine binding budget is exhausted', async () => {
      vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS', '2');
      vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS', '0');
      const post = vi.mocked(axios.post).getMockImplementation()!;
      const get = vi.mocked(axios.get).getMockImplementation()!;
      vi.mocked(axios.get).mockImplementation(async (url, options) => String(url).includes('/v1/access-keys/')
        ? { status: 200, data: { accessKey: null } } : get(url, options));
      const bindingPaths: string[] = [];
      vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
        if (!String(url).includes('/v1/access-keys/')) return post(url, body, options);
        bindingPaths.push(String(url));
        throw new axios.AxiosError('Private binding response lost', 'ECONNABORTED', {
          url: String(url), headers: new axios.AxiosHeaders(),
        });
      });
      const api = await ApiClient.create(credentials);
      api.setLocalMachineId('receipt-machine-exhausted');
      const failure: unknown = await api.getOrCreateSession({ ...creation }).catch((error: unknown) => error);
      expect(bindingPaths).toHaveLength(2);
      const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure }));
      expect(issue).toMatchObject({ code: 'preparation_pending', source: 'dependency_failure' });
      expect(JSON.stringify(issue)).not.toMatch(/Private|localhost|token-1/);
    });

    it('refuses explicit initial access before POST when Session sharing is disabled', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features(false)))));
      const refusal = await create({ initialAccess }).catch((error: unknown) => error);
      // The same typed reason the Home's atomic create answers, never an update requirement.
      expect(refusal).toMatchObject({ code: 'session_access_sharing_unavailable', retryable: false });
      expect(refusal).not.toMatchObject({ kind: 'update_required' });
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('preserves the Home\'s typed sharing-unavailable refusal from the atomic create', async () => {
      const response = { status: 409, data: { error: 'session_access_sharing_unavailable' } };
      if (owner === 'api') vi.mocked(axios.post).mockRejectedValueOnce({ isAxiosError: true, response });
      else vi.mocked(axios.post).mockResolvedValueOnce(response);
      await expect(create({ initialAccess })).rejects.toMatchObject({
        code: 'session_access_sharing_unavailable', status: 409, retryable: false,
      });
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('does not reinterpret a generic bad request as an update requirement', async () => {
      const response = { status: 400, data: { error: 'invalid-params' } };
      if (owner === 'api') vi.mocked(axios.post).mockRejectedValueOnce({ isAxiosError: true, response });
      else vi.mocked(axios.post).mockResolvedValueOnce(response);
      const result = await create({ initialAccess }).catch((error: unknown) => error);
      expect(result).not.toMatchObject({ kind: 'update_required' });
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('preserves access and the creation key after a transport timeout', async () => {
      vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS', '0');
      vi.mocked(axios.post).mockRejectedValueOnce({ isAxiosError: true, code: 'ETIMEDOUT', message: 'timeout' });
      const result = await create({ initialAccess }).catch((error: unknown) => error);
      expect(result).toMatchObject(owner === 'api'
        ? { id: 'created-session' }
        : { code: 'outcome_unknown' });
      expect(axios.post).toHaveBeenCalledTimes(owner === 'api' ? 2 : 1);
      for (const call of vi.mocked(axios.post).mock.calls) {
        expect(call[1]).toMatchObject({ tag: creation.tag, initialAccess });
      }
    });

    if (owner === 'api') it.each(['ECONNRESET', 'ENOTFOUND', 'access_refusal'])(
      'keeps the original unknown receipt when reconciliation exhausts or fails (%s)', async (nextFailure) => {
        vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS', '2');
        vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS', '0');
        const lostReceipt = new axios.AxiosError('Committed creation response lost', 'ECONNRESET');
        vi.mocked(axios.post).mockRejectedValueOnce(lostReceipt).mockRejectedValueOnce(nextFailure === 'access_refusal'
          ? { isAxiosError: true, response: { status: 503, data: { error: 'session_access_authentication_unavailable' } } }
          : new axios.AxiosError('Reconciliation unavailable', nextFailure));
        await expect(create({ initialAccess })).rejects.toMatchObject({ code: 'outcome_unknown', cause: { code: 'ECONNRESET' } });
        expect(axios.post).toHaveBeenCalledTimes(2);
      },
    );

    if (owner === 'api') it('cancels reconciliation without losing the original unknown creation outcome', async () => {
      vi.useFakeTimers();
      const lifetime = new AbortController();
      vi.mocked(axios.post).mockRejectedValue(new axios.AxiosError('Committed creation response lost', 'ECONNRESET'));
      const pending = create({ signal: lifetime.signal }).catch((error: unknown) => error);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(axios.post).toHaveBeenCalledTimes(1);
        lifetime.abort(new Error('Caller cancelled'));
        expect(await pending).toMatchObject({ code: 'outcome_unknown', cause: { code: 'ECONNRESET' } });
        expect(axios.post).toHaveBeenCalledTimes(1);
      } finally {
        lifetime.abort();
        vi.useRealTimers();
      }
    });

    it('preserves create-or-load settlement without a follow-up access mutation', async () => {
      createdByServer = false;
      const result = await create({ initialAccess, primaryTeamId: 'team-1' });
      expect(result).toMatchObject(owner === 'api'
        ? { sessionCreationOutcome: { disposition: 'rejoined' } }
        : { created: false });
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed grant authority before POST', async () => {
      await expect(create({ initialAccess: { grants: [{ ...initialAccess.grants[0], requiredByTeamPolicy: true }] } })).rejects.toThrow();
      expect(axios.post).not.toHaveBeenCalled();
    });

    if (owner === 'api') it('retains access and creation identity across the existing transient-server retry', async () => {
      vi.stubEnv('HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS', '0');
      vi.mocked(axios.post).mockRejectedValueOnce({ isAxiosError: true, response: { status: 503, data: { error: 'unavailable' } } });
      await create({ initialAccess, primaryTeamId: 'team-1' });
      expect(vi.mocked(axios.post).mock.calls.map((call) => call[1])).toMatchObject([
        { tag: creation.tag, initialAccess, primaryTeamId: 'team-1' },
        { tag: creation.tag, initialAccess, primaryTeamId: 'team-1' },
      ]);
    });

    it('still creates without Session sharing when no access or Team context was requested', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features(false)))));
      await create({});
      const body = vi.mocked(axios.post).mock.calls[0]?.[1];
      expect(body).not.toHaveProperty('initialAccess');
      expect(body).not.toHaveProperty('primaryTeamId');
    });

    it('preserves an explicit personal context and omits absent initial grants', async () => {
      await create({ primaryTeamId: null });
      const body = vi.mocked(axios.post).mock.calls[0]?.[1];
      expect(body).toHaveProperty('primaryTeamId', null);
      expect(body).not.toHaveProperty('initialAccess');
    });
  });
}
