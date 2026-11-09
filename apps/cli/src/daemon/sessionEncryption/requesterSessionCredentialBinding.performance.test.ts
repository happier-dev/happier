import fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { expect, it, vi } from 'vitest';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { encodeBase64, encryptLegacy } from '@/api/encryption';
import type { Credentials } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { logger } from '@/utils/logger';
import { refreshActiveProfileCatalog } from '@/settings/profiles/hydrateProfileCatalog';
import { bindRequesterSessionRuntimeMachineAdmissionCurrentness, prepareRequesterSessionBootstrap,
  verifyRequesterSessionCredentialBinding, verifyRequesterSessionMachineAdmissionCurrent } from './requesterSessionCredentials';
import { artifactListResponse } from '@/testkit/http/artifactHome';

// The socket transport is unavailable in this HTTP custody composition.
vi.mock('socket.io-client', () => ({ io: () => { throw new Error('Socket unavailable'); } }));

it('opens owner metadata only for creation correspondence while retaining fresh requester authorization', async () => {
  const app = fastify();
  const origin = 'http://requester-binding.test';
  const attribution = { serverId: 'bob-home', accountId: 'bob', machineId: 'machine', installationId: 'installation' };
  const secret = new Uint8Array(32).fill(19);
  const installation = tweetnacl.sign.keyPair();
  let materialReads = 0;
  let access = true;
  let mode: 'plain' | 'e2ee' = 'e2ee';
  let role: 'owner' | 'view' = 'owner';
  const requests: string[] = [];
  const responses: string[] = [];
  let heldSession: (() => Promise<void>) | undefined;
  let sessionStatus = 200;
  const credentials: Credentials = { token: 'bob-ordinary', encryption: {
    // Observe real key demand; decryption and authorization remain production code.
    type: 'legacy', get secret() { materialReads++; return secret; },
  } };
  const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag: `create:v1:${'a'.repeat(43)}`,
    recipe: { execution: { machineId: 'machine', directory: { kind: 'path', path: '/workspace' } },
      organization: { folderId: null, tagIds: [] }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null,
      connectedServices: null, capabilitySelection: null, transcriptStorage: null, terminal: null,
      agentSessionStartupInstructionsMarkerV1: null, checkout: null } });
  const metadata = encodeBase64(encryptLegacy({ machineId: 'machine', path: '/workspace',
    sessionCreationCorrespondenceV1: correspondence }, secret));
  app.addHook('onRequest', async request => { requests.push(request.url);
    if (request.url === '/v2/sessions/session') await heldSession?.(); });
  app.addHook('onResponse', async (request, reply) => { responses.push(`${request.url} ${reply.statusCode}`); });
  app.get('/v1/account/profile', async () => ({ id: 'bob' }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode, version: 1, updatedAt: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null }));
  app.get('/v2/account/settings', async () => ({ content: null, version: 1 }));
  app.get('/v1/access-keys/session/machine', async () => ({ accessKey: { id: 'existing' } }));
  app.get('/v1/machines/machine', async (_request, reply) => access ? { machine: {
    id: 'machine', installationId: 'installation', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    access: { custodian: { accountId: 'alice', displayName: 'Custodian' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
  } } : reply.code(403).send({ kind: 'refused', code: 'access_denied' }));
  app.post('/v1/machines/machine/admission/verify', async (request, reply) => {
    // The Home HTTP service is the boundary; signing and verification stay real.
    const body = request.body as { context: SocketRpcMachineAdmissionContextV1;
      purpose: { kind: 'requester_session_currentness'; sessionId: string };
      proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
    const valid = body.purpose?.kind === 'requester_session_currentness' && body.purpose.sessionId === 'session'
      && verifyMachineInstallationProof({ publicKey: installation.publicKey, proof: body.proof,
        payload: { version: 1, accountId: 'alice', machineId: 'machine', installationId: 'installation',
          rpcAdmission: { context: body.context, purpose: body.purpose } } });
    return access && valid ? { v: 1, ok: true } : reply.code(403).send({ error: 'access_denied' });
  });
  app.get('/v2/sessions/session', async (_request, reply) => sessionStatus !== 200
    ? reply.code(sessionStatus).send({ error: 'private-response-body' }) : ({ session: createSessionRecordFixture({ id: 'session',
    encryptionMode: 'e2ee', metadata, dataEncryptionKey: null,
    share: role === 'owner' ? null : { accessLevel: 'view', canApprovePermissions: false },
  }) }));
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin });
  const directory = await mkdtemp(join(tmpdir(), 'requester-binding-performance-'));
  let bootstrap: Awaited<ReturnType<typeof prepareRequesterSessionBootstrap>> = null;
  try {
    const binding = { credentials, attribution, sessionId: 'session', serverHttpBaseUrl: origin,
      verifyMachineAdmissionCurrent: () => verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution,
        sessionId: 'session', serverHttpBaseUrl: origin, boundary: { machineId: 'machine', daemonToken: 'alice-daemon',
          isHomeCurrent: () => true, readInstallation: () => ({ installationId: 'installation', privateKey: installation.secretKey }) },
      }) };
    expect(await verifyRequesterSessionCredentialBinding(binding), JSON.stringify(responses)).toBe(true);
    console.info('single binding HTTP reads', { profile: requests.filter(path => path === '/v1/account/profile').length,
      access: requests.filter(path => path === '/v1/machines/machine').length,
      signed: requests.filter(path => path === '/v1/machines/machine/admission/verify').length });
    expect(requests.filter(path => path === '/v1/account/profile')).toHaveLength(1);
    expect(requests.filter(path => path === '/v1/machines/machine')).toHaveLength(1);
    expect(requests.filter(path => path === '/v1/machines/machine/admission/verify')).toHaveLength(2);
    expect(materialReads).toBe(0);
    const phaseLog = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      sessionStatus = 403;
      expect(await verifyRequesterSessionCredentialBinding(binding)).toBe(false);
      const failed = phaseLog.mock.calls.filter(([message]) => message === '[PluginExec] Requester currentness phase');
      expect(failed).toEqual(expect.arrayContaining([[expect.any(String), expect.objectContaining({
        phase: 'session', status: 'failed', errorClass: 'HttpStatusError', errorCode: 'not_authenticated', httpStatus: 403,
        stackFrames: expect.arrayContaining([expect.objectContaining({ file: expect.stringContaining('sessionsHttp.ts') })]),
      })]]));
      expect(JSON.stringify(failed)).not.toMatch(/private-response-body|bob-ordinary|Unauthorized|Zod/);
    } finally { sessionStatus = 200; phaseLog.mockRestore(); }
    requests.length = 0;
    let releaseSession: (() => void) | undefined;
    let enteredSession: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { enteredSession = resolve; });
    heldSession = async () => { enteredSession?.(); await new Promise<void>(resolve => { releaseSession = resolve; }); };
    const pendingBinding = verifyRequesterSessionCredentialBinding(binding);
    await entered;
    access = false;
    heldSession = undefined;
    releaseSession?.();
    expect(await pendingBinding).toBe(false);
    // Revocation must be decided by the fresh second signed proof, even though
    // its unchanged discovery context came from the admitted first proof.
    expect(requests.filter(path => path === '/v1/machines/machine')).toHaveLength(1);
    expect(requests.filter(path => path === '/v1/machines/machine/admission/verify')).toHaveLength(2);
    access = true;
    expect(requests).toEqual(expect.arrayContaining(['/v1/account/profile', '/v1/account/encryption/currentness',
      '/v2/sessions/session', '/v1/machines/machine/admission/verify']));
    expect(await verifyRequesterSessionCredentialBinding({ ...binding, expectedSessionCreationTag: correspondence.sessionCreationTag })).toBe(true);
    expect(materialReads).toBeGreaterThan(0);
    expect(await verifyRequesterSessionCredentialBinding({ ...binding, expectedSessionCreationTag: `create:v1:${'b'.repeat(43)}` })).toBe(false);
    expect(await verifyRequesterSessionCredentialBinding({ ...binding, attribution: { ...attribution, machineId: 'other-machine' },
      expectedSessionCreationTag: correspondence.sessionCreationTag })).toBe(false);
    bootstrap = await prepareRequesterSessionBootstrap({ credentials, attribution,
      preparedSessionId: 'session', boundary: { serverId: attribution.serverId, serverHttpBaseUrl: origin, happyHomeDir: directory },
      verifyMachineAdmissionCurrent: binding.verifyMachineAdmissionCurrent });
    expect(bootstrap).not.toBeNull();
    bindRequesterSessionRuntimeMachineAdmissionCurrentness({ bootstrap: bootstrap!.admitted,
      boundary: { machineId: 'machine', daemonToken: 'alice-daemon', isHomeCurrent: () => true,
        readInstallation: () => ({ installationId: 'installation', privateKey: installation.secretKey }) } });
    expect(await bootstrap!.admitted.bindSession('session', `create:v1:${'b'.repeat(43)}`)).toBeNull();
    expect(await bootstrap!.admitted.bindSession('session', correspondence.sessionCreationTag)).not.toBeNull();
    materialReads = 0;
    requests.length = 0;
    expect(await bootstrap!.admitted.isCurrent()).toBe(true);
    // Binding already proved immutable creation correspondence. Runtime checks
    // still prove fresh authority without opening owner content on every field.
    expect(materialReads).toBe(0);
    expect(requests).toEqual(expect.arrayContaining(['/v1/account/profile', '/v1/account/encryption/currentness',
      '/v2/sessions/session', '/v1/machines/machine/admission/verify']));
    expect(await bootstrap!.admitted.bindSession('session', `create:v1:${'b'.repeat(43)}`)).toBeNull();
    role = 'view';
    expect(await bootstrap!.admitted.isCurrent()).toBe(false);
    role = 'owner'; access = false;
    expect(await bootstrap!.admitted.isCurrent()).toBe(false);
    access = true; mode = 'plain';
    expect(await bootstrap!.admitted.isCurrent()).toBe(false);
    mode = 'e2ee';
    materialReads = 0;
    role = 'view';
    expect(await verifyRequesterSessionCredentialBinding(binding)).toBe(false);
    role = 'owner'; mode = 'plain';
    expect(await verifyRequesterSessionCredentialBinding(binding)).toBe(false);
    mode = 'e2ee'; access = false;
    expect(await verifyRequesterSessionCredentialBinding(binding)).toBe(false);
    access = true;
    expect(await verifyRequesterSessionCredentialBinding({ ...binding, signal: AbortSignal.abort() })).toBe(false);
    expect(materialReads).toBe(0);
  } finally { await bootstrap?.cleanupOnFailure(); restore(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each([
  { scenario: 'spawn preparation', revoke: 'access' }, { scenario: 'unknown Profile', revoke: 'access' },
  { scenario: 'spawn preparation', revoke: 'mode' }, { scenario: 'unknown Profile', revoke: 'mode' },
] as const)('bounds Home verification reads for $scenario, retaining held-read $revoke fences', async ({ scenario, revoke }) => {
  const app = fastify();
  const origin = 'http://requester-preparation.test';
  const directory = await mkdtemp(join(tmpdir(), 'requester-preparation-'));
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.fixture`;
  const credentials = { token, encryption: null };
  let current = true;
  let mode: 'plain' | 'e2ee' = 'plain';
  const installation = tweetnacl.sign.keyPair();
  const attribution = { serverId: 'bob-home', accountId: 'bob', machineId: 'machine', installationId: 'installation' };
  let hold: string | undefined;
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const requests: string[] = [];
  app.addHook('onRequest', async request => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === hold) {
      entered?.();
      await new Promise<void>(resolve => { release = resolve; });
    }
  });
  app.get('/v1/account/profile', async () => ({ id: 'bob' }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode, version: 1, updatedAt: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null }));
  app.get('/v1/machines/machine', async (_request, reply) => current ? { machine: {
    id: 'machine', installationId: 'installation', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    access: { custodian: { accountId: 'alice', displayName: 'Custodian' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
  } } : reply.code(403).send({ kind: 'refused', code: 'access_denied' }));
  app.post('/v1/machines/machine/admission/verify', async (request, reply) => {
    const body = request.body as { context: SocketRpcMachineAdmissionContextV1;
      purpose: { kind: 'requester_session_currentness'; sessionId: string };
      proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
    const valid = body.purpose?.kind === 'requester_session_currentness' && body.purpose.sessionId === 'session'
      && verifyMachineInstallationProof({ publicKey: installation.publicKey, proof: body.proof,
        payload: { version: 1, accountId: 'alice', machineId: 'machine', installationId: 'installation',
          rpcAdmission: { context: body.context, purpose: body.purpose } } });
    return current && valid ? { v: 1, ok: true } : reply.code(403).send({ error: 'access_denied' });
  });
  app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
  app.get('/v2/sessions/session', async () => ({ session: createSessionRecordFixture({ id: 'session',
    encryptionMode: 'plain', ownerAccountId: 'bob', dataEncryptionKey: null, share: null,
    origin: { kind: 'none' }, metadata: JSON.stringify({ machineId: 'machine', path: '/workspace', flavor: 'codex' }),
  }) }));
  app.get('/v1/account/entity-rows/acp', async () => ({ status: 'present', revision: 1,
    content: { t: 'plain', v: { v: 1, definitions: [] } } }));
  app.get('/v1/account/entity-rows/prompt-library', async () => ({ status: 'listed',
    rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
      content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })),
  }));
  app.get('/v1/artifacts', async (request) => artifactListResponse(request.url, []));
  app.get('/v1/account/entity-rows/profiles', async () => ({ status: 'listed', rows: [], nextCursor: null,
    complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } }));
  app.get('/v1/account/entity-rows/profiles/reference-guard', async () => ({ status: 'ready', revision: 1 }));
  app.get('/v1/account/entity-rows/profiles/transfer', async () => ({ status: 'absent' }));
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin });
  let prepared: Awaited<ReturnType<typeof prepareRequesterSessionBootstrap>> = null;
  try {
    // Only Home HTTP responses and installation storage are boundaries. Machine
    // proof signing/verification, requester custody, catalogs and Actions run.
    prepared = await prepareRequesterSessionBootstrap({ credentials,
      attribution,
      boundary: { serverId: 'bob-home', serverHttpBaseUrl: origin, happyHomeDir: directory },
      preparedSessionId: 'session', boundSessionId: 'session', verifyMachineAdmissionCurrent: signal =>
        verifyRequesterSessionMachineAdmissionCurrent({ credentials, attribution, sessionId: 'session', serverHttpBaseUrl: origin,
          boundary: { machineId: 'machine', daemonToken: 'alice-daemon', isHomeCurrent: () => true,
            readInstallation: () => ({ installationId: 'installation', privateKey: installation.secretKey }) }, signal }),
    });
    if (!prepared) throw new Error('Missing real requester bootstrap');
    const bootstrap = prepared.admitted;
    const deps = createCliActionDeps({ token, credentials: bootstrap.credentials, sessionId: 'session', mode: 'plain', ctx: null,
      serverId: 'bob-home', serverHttpBaseUrl: origin, rawSession: { workDepth: 0 },
      getCurrentSessionMetadata: () => ({ machineId: 'machine', path: '/workspace', flavor: 'codex' }),
      savedSecretOperationContext: bootstrap.savedSecretOperationContext,
      actionsSettingsProvider: createActionSettingsProvider({ scopeKey: bootstrap.savedSecretOperationContext.readSnapshot()?.scopeKey,
        getAccountSettings: () => bootstrap.savedSecretOperationContext.readSnapshot()?.settings ?? null }),
    });
    const diagnostics: unknown[] = [];
    const phaseReads = new Map<string, number>();
    const context = { surface: 'agent', authority: 'account_automation', callerPermissionMode: 'default', defaultSessionId: 'session', serverId: 'bob-home',
      runtimeAccountId: 'bob', actionCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 },
      recordActionStartDiagnostic: value => { diagnostics.push(value); phaseReads.set(value.phase, sessionReads()); },
    } satisfies ActionExecutorContext;
    const sessionReads = () => requests.filter(path => path === 'GET /v2/sessions/session').length;
    await runWithServerHttpBaseUrl(origin, async () => {
      for (let invocation = 0; invocation < 2; invocation++) {
        requests.length = 0;
        if (scenario === 'spawn preparation') {
          const start = await deps.resolveAgentStartContext!(context);
          expect(start, JSON.stringify(diagnostics)).toMatchObject({ baseline: { machineId: 'machine', directory: '/workspace' } });
        } else {
          const refused = await createActionExecutor(deps).execute('session.spawn_new', { creationKey: `unknown-profile-${invocation}`, profileId: 'missing-profile',
            executionTarget: { serverId: 'bob-home', machineId: 'machine' }, directory: { kind: 'path', path: '/workspace' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          }, context);
          expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, errorCode: 'target_unavailable',
            details: { reason: 'profile_unavailable' } });
        }
        const verificationReads = sessionReads();
        console.info('requester preparation HTTP reads', { scenario, invocation, session: verificationReads,
          profile: requests.filter(path => path === 'GET /v1/account/profile').length,
          access: requests.filter(path => path === 'GET /v1/machines/machine').length,
          signed: requests.filter(path => path === 'POST /v1/machines/machine/admission/verify').length,
          encryption: requests.filter(path => path === 'GET /v1/account/encryption/currentness').length });
        expect(verificationReads).toBeGreaterThan(0);
        expect(requests.filter(path => !path.startsWith('GET ') && path !== 'POST /v1/machines/machine/admission/verify')).toEqual([]);
        expect(requests.filter(path => path === 'GET /v1/account/profile')).toHaveLength(verificationReads);
        expect(requests.filter(path => path === 'GET /v1/machines/machine')).toHaveLength(verificationReads);
        expect(requests.filter(path => path === 'POST /v1/machines/machine/admission/verify')).toHaveLength(2 * verificationReads);
        if (scenario === 'spawn preparation' && invocation === 1) {
          // Built-in Role sources only read Artifacts and captured Settings. No
          // effect separates them from warm Role override preparation. The cold
          // loader can still publish/maintain its source outside the checkpoint.
          expect(phaseReads.get('role_sources')! - phaseReads.get('role_overrides')!).toBe(0);
        }
      }
      for (const cancel of [true, false]) {
        const controller = new AbortController();
        const previousProfileCatalog = bootstrap.savedSecretOperationContext.readSnapshot()?.profileCatalog;
        hold = scenario === 'spawn preparation' ? '/v1/account/entity-rows/acp' : '/v1/account/entity-rows/profiles';
        const held = new Promise<void>(resolve => { entered = resolve; });
        const pending = scenario === 'spawn preparation'
          ? deps.resolveAgentStartContext!({ ...context, signal: controller.signal })
          : refreshActiveProfileCatalog({ credentials: bootstrap.credentials, signal: controller.signal,
            operationContext: bootstrap.savedSecretOperationContext });
        await held;
        if (cancel) controller.abort(); else if (revoke === 'access') current = false; else mode = 'e2ee';
        hold = undefined;
        release?.();
        if (scenario === 'unknown Profile') {
          await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
          if (cancel) expect(bootstrap.savedSecretOperationContext.readSnapshot()?.profileCatalog).toBe(previousProfileCatalog);
        } else if (cancel) await expect(pending).rejects.toBeDefined();
        else await expect(pending).rejects.toMatchObject({ code: 'ACP_CATALOG_UNAVAILABLE', reason: 'scope-retired' });
        if (!cancel) expect(bootstrap.savedSecretOperationContext.readSnapshot()).toBeNull();
        current = true;
        mode = 'plain';
      }
    });
  } finally {
    release?.();
    await prepared?.cleanupOnFailure();
    restore(); await app.close(); await rm(directory, { recursive: true, force: true });
  }
});
