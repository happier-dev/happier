import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import nacl from 'tweetnacl';
import { expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationVerifyResponseV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequestV2, openExternalActionResponseV2, computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { ApiClient } from '@/api/api';
import { ApiMachineClient } from '@/api/apiMachine';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { encodeRequesterCredentials } from '@/persistence';
import { deriveAccountMachineKeyFromRecoverySecret, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { executeExternalAction } from '../externalActions/executeExternalAction';
import { startMachineRegistrationRetryLoop } from '../machine/startMachineRegistrationRetryLoop';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { logger } from '@/ui/logger';
import { createLocalServicesDaemonRuntime } from '../local/services/runtime';
import { createLocalServiceEndpointEnricher } from '../local/services/inventory/endpoint';
import { LocalServicePreviewResourceV1Schema } from '@happier-dev/protocol/local/services/preview/v1';

// Only the private listener, Home HTTP and Socket.IO are replaced.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async () => ({ port: 44324, stop: async () => {} }) }));

it('preserves a live Machine identity through Session-control runtime creation and registration replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daemon-machine-identity-'));
  const serverId = 'srv_identity_home';
  const serverHttpBaseUrl = 'https://identity-home.invalid';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`;
  const secret = nacl.randomBytes(32);
  const credentials = { token, encryption: { type: 'legacy' as const, secret } };
  const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
  const settingsContent = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
    material: credentials.encryption, payload: {}, randomBytes: nacl.randomBytes }) };
  // The exported runtime consumes a live identity. Full startDaemon producer
  // wiring still requires the Add-folder identity-rotation live journey.
  let machineId = 'before-registration';
  let originMachineId: string | undefined;
  let machine: ApiMachineClient | null = null;
  const channel = await createRequesterCurrentnessSocketHarness();
  const phases = vi.spyOn(logger, 'warnLocalFile');
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(url).pathname;
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'e2ee', version: 1,
      signingKeyFingerprint: 'fixture', contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(
        nacl.box.keyPair.fromSecretKey(material.machineKey).publicKey), updatedAt: 1 } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: settingsContent, version: 1 } };
    throw new Error(`Unexpected Home read: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/admission/verify')) return { status: 200, data: { v: 1, ok: true } };
    if (path.endsWith('/verify')) return { status: 200, data: ExternalActionExecutionAuthorizationVerifyResponseV1Schema.parse({ ok: true }) };
    throw new Error('Unexpected Home write');
  });
  const fixture = await createRequesterSessionControlRuntimeFixture({
    happyHomeDir: directory, activeServerDir: join(directory, 'server'), serverId, serverHttpBaseUrl,
    get machineId() { return machineId; }, custodianAccountId: 'owner', credentials,
    connectedServicesMaterializationBaseDir: join(directory, 'materialized'), registry: new ConnectedServiceRuntimeRegistry(),
    trackedSessions: new Map(), getRequester: () => null, getApiMachineForSessions: () => machine,
    resolveQualifiedConnectedAccountV4Support: () => 'indeterminate', startup: {
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId,
        machineId: originMachineId ?? machineId }),
    },
  });
  const services = createLocalServicesDaemonRuntime({
    get machineId() { return machineId; },
    accountId: 'owner', serverId, startLoop: false, inventoryEnabled: () => true,
    scan: async () => ({ listeners: [{ address: '127.0.0.1', port: 5173, pid: 400, protocol: 'tcp' as const }],
      processes: new Map([[400, { pid: 400, command: 'node vite' }]]), workspaces: [], diagnostics: [] }),
    endpointEnricher: createLocalServiceEndpointEnricher({ now: Date.now, probe: async ({ scheme }) => scheme === 'http' }),
    previewServer: { token, serverBaseUrl: serverHttpBaseUrl, http: {
      async post(_url, body) {
        const resource = LocalServicePreviewResourceV1Schema.parse(body);
        return { data: { resource, accessUrl: 'https://preview.example.test/', expiresAt: 65_000 } };
      },
      async delete() { return { data: { ok: true } }; },
    } },
  });
  try {
    const registered = { id: 'after-registration', encryptionMode: 'e2ee' as const,
      encryptionKey: secret, encryptionVariant: 'legacy' as const,
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const api = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => ApiClient.create(credentials));
    // A completed registration preflight is published by the real registration
    // loop after Session control starts, exactly as in daemon startup.
    await new Promise<void>(resolve => startMachineRegistrationRetryLoop({ api, metadataForRegistration: {
      host: 'fixture', platform: 'linux', happyCliVersion: 'dev', homeDir: directory, happyHomeDir: directory },
      initialDaemonState: {}, initialPreflightMachineRegistration: { machine: registered, machineId: registered.id, didRotateMachineId: true },
      machineRegistrationTimeoutMs: 10000, machineRegistrationRetryBaseDelayMs: 10000,
      machineRegistrationRetryMaxDelayMs: 10000, machineRegistrationRetryJitterMs: 0, machineRegistrationMaxAttempts: 1,
      resolvesWhenShutdownRequested: new Promise(() => {}), resolveMachineId: () => machineId,
      setMachineId: value => { machineId = value; }, isShuttingDown: () => false, onMachineRegistered: async () => resolve(),
    }));
    await services.refreshInventoryNow();
    const launcher = await services.launcherRoutes.getSnapshot({ scope: 'machine', discovery: 'cached' });
    const previewTarget = launcher.targets.find(item => item.sourceClass?.kind === 'inventory_entry');
    expect(previewTarget).toBeDefined();
    expect(await services.launcherRoutes.leaves!.openPreview({ machineId: registered.id, targetId: previewTarget!.id }))
      .toMatchObject({ status: 'opened', browserTarget: { machineId: registered.id } });
    expect(await services.previewRoutes.getSnapshot()).toMatchObject({ machineId: registered.id,
      resources: [{ machineId: registered.id }], previews: [{ resource: { machineId: registered.id } }] });
    for (const wrongMachineId of ['before-registration', 'genuinely-different-machine']) {
      expect(await services.previewRoutes.openOrCreate({ machineId: wrongMachineId, launchTargetId: 'registration-preview' }))
        .toEqual({ ok: false, reasonCode: 'wrong_machine' });
    }
    machine = new ApiMachineClient(token, registered, undefined, {
      resolveCurrentServerIdentityId: () => serverId,
    });
    machine.setRPCHandlers({
      spawnSession: async () => { throw new Error('Unexpected physical Session launch'); },
      sessionSpawnV1OutcomeRequired: true,
      resolveSpawnSessionByNonce: async () => { throw new Error('Unexpected physical Session lookup'); },
      stopSession: async () => { throw new Error('Unexpected physical Session stop'); },
      requestShutdown: () => { throw new Error('Unexpected daemon shutdown'); },
    }, { externalActionIngressOwner: fixture.runtime.externalActionIngressOwner! });
    await writeFile(join(directory, 'payload.txt'), 'registered');
    const installation = fixture.installation!;
    const actionId = 'daemon.filesystem.readFile';
    const target = { kind: 'machine' as const, machineId: registered.id };
    const actionBinding = { accountId: 'owner', authentication: { kind: 'account' as const, tokenEpoch: 0 }, actionId,
      requestId: 'rotation-dispatch', serverIdentityId: serverId, target };
    const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding: actionBinding, material, randomBytes: nacl.randomBytes, input: { rootPath: directory, path: 'payload.txt' } });
    const authorization = sealExternalActionRequesterAccountContextV1({
      authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-admission', binding: {
        ...actionBinding, machineId: registered.id, installationId: installation.installationId,
        custodianAccountId: 'owner', admittedMachineRole: 'manage', accountEncryptionMode: 'e2ee',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } }), credentials: encodeRequesterCredentials(credentials), purpose: { kind: 'external_action' },
      installationPublicKey: Buffer.from(installation.publicKey, 'base64url'), randomBytes: nacl.randomBytes,
    });
    const dispatch = () => executeExternalAction({ actionId, envelope,
      principal: { accountId: 'owner', authentication: actionBinding.authentication,
        authority: 'present_user' }, currentMachineId: registered.id,
      currentServerId: serverId, currentInstallationId: installation.installationId,
      externalActionMachineRequestPrivateKey: installation.privateKey, executionAuthorization: authorization,
      verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
        installationId: installation.installationId, privateKey: installation.privateKey, serverHttpBaseUrl }),
      prepareRequesterAccountContext: fixture.runtime.externalActionIngressOwner!.prepareRequesterAccountContext,
      resolveTarget: async () => target, executor: fixture.runtime.externalActionIngressOwner!.executor,
    });
    const result = await dispatch();
    expect(result, JSON.stringify({ kind: result.kind, code: result.kind === 'invalid_request' ? result.errorCode : null,
      phases: phases.mock.calls.map(([, value]) => value && typeof value === 'object' && 'phase' in value ? value.phase : null) }))
      .toMatchObject({ kind: 'response' });
    if (result.kind !== 'response') throw new Error('Requester dispatch refused before decryption');
    const execution = openExternalActionResponseV2({ envelope: result.response, request: envelope, binding: actionBinding, material });
    expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true });
    originMachineId = 'genuinely-different-machine';
    expect(await dispatch()).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope' });
  } finally {
    machine?.shutdown(); await services.stop(); await fixture.dispose(); await channel.close(); vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
