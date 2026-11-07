import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../server/sources/storage/db';
import { auth } from '../../../../server/sources/app/auth/auth';
import { inTx } from '../../../../server/sources/storage/inTx';
import { setEligibleMachineAccessGrantInTx } from '../../../../server/sources/testkit/machineAccessGrant.testkit';
import { resolveMachineAccess } from '../../../../server/sources/app/machines/machineAccess';
import { createSessionMachineAccessKeyInTx } from '../../../../server/sources/app/accessKeys/sessionMachineAccessKeyMutations';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { registerSessionListingRoutes } from '../../../../server/sources/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionLookupByTagsRoute } from '../../../../server/sources/app/api/routes/session/registerSessionLookupByTagsRoute';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchSessionById, lookupSessionsByTags } from '@/session/transport/http/sessionsHttp';
import { SessionOwnerMetadataEnvelopeV1Schema, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { makeShareEligibleForTest } from '../../../../server/sources/testkit/shareEligibility.testkit';
import { putSessionAccessGrantInTx } from '../../../../server/sources/app/session/access/sessionAccessGrantService';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { fetchSessionInventoryPage } from './sessionInventoryVisibility';
import { subscribeManagedSessionDirectoryRemoval } from './subscribeManagedSessionDirectoryRemoval';

let database: LightSqliteHarness;
beforeAll(async () => {
  database = await createLightSqliteHarness({ tempDirPrefix: 'happier-directory-restart-', initAuth: true,
    env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
}, 120_000);
afterAll(async () => { await database?.close(); });

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture origin unavailable');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

it('refuses a shared editor asserting fresh creation with a different stored Session tag before directory binding', async () => {
  const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
  const editor = await db.account.create({ data: { encryptionMode: 'plain' } });
  const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
  const editorToken = await auth.createToken(editor.id, undefined, { kind: 'account', authority: 'present_user' });
  const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
    installationId: randomUUID(), active: true, installationPublicKey: tweetnacl.sign.keyPair().publicKey,
    metadata: encodePlainMachineStoredContent({ host: 'binding-target', platform: 'linux', happyCliVersion: 'test',
      homeDir: '/home/binding-target', happyHomeDir: '/home/binding-target/.happier' }),
    dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
    operationProtocolCapabilitiesRevision: 1,
    operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
  } });
  expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id,
    machineId: machine.id, principal: { kind: 'account', accountId: editor.id }, level: 'view' })))
    .toMatchObject({ kind: 'saved', readiness: 'ready' });
  expect(await resolveMachineAccess({ actorAccountId: editor.id, machineId: machine.id }))
    .toMatchObject({ role: 'use', accessState: 'ready' });
  const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-fresh-binding-'));
  const directories = createManagedSessionDirectories({ activeServerDir });
  const storedTag = deriveSessionCreationTagV1({ callerCreationNamespace: owner.id, creationKey: 'birth' });
  const claimedTag = deriveSessionCreationTagV1({ callerCreationNamespace: editor.id, creationKey: 'different-birth' });
  const legitimate = directories.prepareForCreation({ sessionCreationTag: storedTag });
  const forged = directories.prepareForCreation({ sessionCreationTag: claimedTag });
  const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag: storedTag,
    recipe: { execution: { machineId: machine.id, directory: { kind: 'managed' } },
      organization: { folderId: null, tagIds: [] },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
      configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: null,
      terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null },
  });
  const ownerMetadata = SessionOwnerMetadataV1Schema.parse({ v: 1,
    workspace: { machineId: machine.id, path: legitimate.directory },
    system: { sessionCreationCorrespondenceV1: correspondence },
  });
  const session = await db.session.create({ data: { accountId: owner.id, tag: storedTag, encryptionMode: 'plain',
    metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), ownerMetadata: JSON.stringify({ t: 'plain', v: ownerMetadata }),
  } });
  await makeShareEligibleForTest(owner.id, editor.id);
  expect(await inTx(tx => putSessionAccessGrantInTx(tx, { actorAccountId: owner.id, sessionId: session.id,
    subject: { kind: 'account', accountId: editor.id }, grant: { accessLevel: 'edit', canApprovePermissions: false },
    authentication: { authority: 'present_user', authenticationEvidence: undefined, env: process.env },
  }))).toMatchObject({ ok: true, value: { accessLevel: 'edit' } });
  const home = createAuthenticatedTestApp({ authentication: 'real' });
  registerSessionListingRoutes(home);
  const serverUrl = await home.listen({ port: 0, host: '127.0.0.1' });
  try {
    const editorSession = await fetchSessionById({ token: editorToken, sessionId: session.id, serverUrl, reason: 'session-action' });
    expect(editorSession?.id).toBe(session.id);
    const readStoredTag = async (token: string) => {
      const row = await fetchSessionById({ token, sessionId: session.id, serverUrl, reason: 'session-action' });
      expect(row?.id).toBe(session.id);
      const envelope = SessionOwnerMetadataEnvelopeV1Schema.parse(row?.ownerMetadata);
      if (envelope.t !== 'plain') throw new Error('Plain fixture returned encrypted owner content');
      return SessionOwnerMetadataV1Schema.parse(envelope.v).system?.sessionCreationCorrespondenceV1?.sessionCreationTag;
    };
    // The storage/attach owner supplies this fact internally. Edit access is
    // real; it does not authorize replacing the Session's birth correspondence.
    const request = { directory: forged.directory, existingSessionId: session.id, freshSessionCreation: true,
      sessionCreationTag: claimedTag, existingSessionCreationTag: await readStoredTag(ownerToken) };
    await expect(directories.prepareForSpawn(request)).rejects.toMatchObject({ code: 'creation_conflict' });
    await expect(directories.prepareForSpawn({ ...request, sessionCreationTag: storedTag,
      existingSessionCreationTag: undefined })).rejects.toMatchObject({ code: 'creation_conflict' });
    expect(await directories.listRecords()).toEqual([]);
    await expect(access(forged.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    const admitted = await directories.prepareForSpawn({ ...request, directory: legitimate.directory,
      sessionCreationTag: storedTag, existingSessionCreationTag: await readStoredTag(ownerToken) });
    expect(admitted).toMatchObject({ ok: true, directory: legitimate.directory });
    expect(await directories.listRecords()).toMatchObject([{ sessionId: session.id, sessionCreationTag: storedTag }]);
  } finally {
    await home.close();
    await rm(activeServerDir, { recursive: true, force: true });
  }
});

// The controller, guest daemon and runner have independent HTTP origins. Home
// authentication/listing and all directory lifecycle logic are real; only the
// coding Agent is represented by a finite child that reads its retained cwd.
it.each(process.platform === 'win32' ? ['ordinary', 'unbound'] as const : ['ordinary', 'isolated-member', 'unbound'] as const)(
  'resumes a grantee no-folder Session after guest daemon restart (%s)', async placement => {
  const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
  const grantee = await db.account.create({ data: { encryptionMode: 'plain' } });
  const daemonToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
  const granteeToken = await auth.createToken(grantee.id, undefined, { kind: 'account', authority: 'present_user' });
  const createMachine = (host: string) => db.machine.create({ data: {
    id: randomUUID(), accountId: owner.id, installationId: randomUUID(), active: true,
    installationPublicKey: tweetnacl.sign.keyPair().publicKey,
    metadata: encodePlainMachineStoredContent({ host, platform: 'linux', happyCliVersion: 'test',
      homeDir: `/home/${host}`, happyHomeDir: `/home/${host}/.happier` }),
    dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
    operationProtocolCapabilitiesRevision: 1,
    operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] },
      requesterExecutionIsolation: { protocolVersions: [1] } },
  } });
  const controllerMachine = await createMachine('controller');
  const guestMachine = await createMachine('guest');
  for (const machine of [controllerMachine, guestMachine]) {
    expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: owner.id,
      machineId: machine.id, principal: { kind: 'account', accountId: grantee.id }, level: 'view' })))
      .toMatchObject({ kind: 'saved', readiness: 'ready' });
  }
  expect(await resolveMachineAccess({ actorAccountId: grantee.id, machineId: guestMachine.id }))
    .toMatchObject({ role: 'use', accessState: 'ready' });
  const guestHome = await mkdtemp(join(tmpdir(), 'happier-guest-directory-'));
  const memberWorkspace = await mkdtemp(join(tmpdir(), 'happier-member-directory-'));
  const activeServerDir = join(guestHome, 'servers', 'home');
  const directoryOptions = { activeServerDir,
    ...(placement === 'isolated-member' ? { payloadPlacement: { root: memberWorkspace, agentUid: process.getuid!() } } : {}) };
  const directories = createManagedSessionDirectories(directoryOptions);
  const tag = randomUUID();
  const allocation = await directories.materializeForFreshSpawn({ sessionCreationTag: tag });
  const session = await db.session.create({ data: { accountId: grantee.id, tag, active: false,
    encryptionMode: 'plain', metadata: JSON.stringify({ machineId: guestMachine.id, path: allocation.directory,
      sessionDirectoryV1: { v: 1, kind: 'managed' } }) } });
  expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: grantee.id,
    sessionId: session.id, machineId: guestMachine.id, data: MACHINE_PLAIN_DATA_KEY_MARKER }))).toMatchObject({ ok: true });
  if (placement !== 'unbound') await directories.bind({ allocationId: allocation.allocationId, sessionId: session.id });
  await writeFile(join(allocation.directory, 'retained.txt'), 'Woke.');
  const home = createAuthenticatedTestApp({ authentication: 'real' });
  registerSessionListingRoutes(home); registerSessionLookupByTagsRoute(home);
  const homeOrigin = await home.listen({ port: 0, host: '127.0.0.1' });
  let reset: (() => void | Promise<void>) | undefined;
  const cleanupParams = {
    token: daemonToken, directories,
    stopSession: async () => ({ status: 'not_found' as const }),
    onSessionDeletedChange: () => () => {},
    onSessionAccessReset: (listener: () => void | Promise<void>) => { reset = listener; return () => { reset = undefined; }; },
  };
  let dispose = () => {};
  const runnerOrigins: string[] = [];
  const daemon = createServer((_request, response) => {
    void (async () => {
      const resumed = await createManagedSessionDirectories(directoryOptions).prepareForSpawn({
        directory: allocation.directory, existingSessionId: session.id, sessionCreationTag: tag,
      });
      if (!resumed.ok) { response.end(JSON.stringify(resumed)); return; }
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        "import{createServer}from'node:http';import{readFile}from'node:fs/promises';const s=createServer(async(_,r)=>{r.end(JSON.stringify({reply:await readFile('retained.txt','utf8'),cwd:process.cwd()}));s.close();});s.listen(0,'127.0.0.1',()=>process.send(s.address().port));"],
      { cwd: resumed.directory, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const exited = once(child, 'exit');
      const [port] = await once(child, 'message');
      const origin = `http://127.0.0.1:${port}`;
      runnerOrigins.push(origin);
      const turn = await (await fetch(origin)).json();
      expect((await exited)[0]).toBe(0);
      response.end(JSON.stringify({ ok: true, ...turn }));
    })().catch(error => { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); });
  });
  const daemonOrigin = await listen(daemon);
  const controller = createServer((_request, response) => {
    void fetch(daemonOrigin).then(result => result.text()).then(body => response.end(body))
      .catch(error => { response.statusCode = 500; response.end(String(error)); });
  });
  const controllerOrigin = await listen(controller);
  try {
    await runWithServerHttpBaseUrl(homeOrigin, async () => {
      // Machine Use never grants the Machine owner access to B's conversation.
      expect((await fetchSessionInventoryPage({ token: daemonToken, scope: 'active' })).sessions).toEqual([]);
      expect(await lookupSessionsByTags({ token: granteeToken, tags: [tag] }))
        .toMatchObject({ state: 'available', sessions: [{ id: session.id }] });
      dispose = await subscribeManagedSessionDirectoryRemoval(cleanupParams);
      dispose();
      // New owner instances and subscriptions represent daemon restart. Only
      // the guest's durable filesystem survives; no runner is retained.
      dispose = await subscribeManagedSessionDirectoryRemoval({ ...cleanupParams,
        directories: createManagedSessionDirectories(directoryOptions) });
      await reset?.();
      expect(await readFile(join(allocation.directory, 'retained.txt'), 'utf8')).toBe('Woke.');
      expect(await (await fetch(controllerOrigin)).json()).toMatchObject({ ok: true, reply: 'Woke.' });
      expect(new Set([homeOrigin, controllerOrigin, daemonOrigin, ...runnerOrigins]).size).toBe(4);
      // Actual deletion remains a typed refusal; startup must never recreate it.
      await rm(allocation.directory, { recursive: true });
      expect(await (await fetch(controllerOrigin)).json()).toEqual({ ok: false, errorCode: 'SESSION_DIRECTORY_MISSING' });
    });
  } finally {
    dispose(); await close(controller); await close(daemon); await home.close();
    await rm(guestHome, { recursive: true, force: true });
    await rm(memberWorkspace, { recursive: true, force: true });
  }
});
