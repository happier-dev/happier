import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Server as NotificationServer } from 'socket.io';

import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import {
  computeRunnerMachineContentKeyFingerprintV1,
  sealEncryptedDataKeyEnvelopeV1,
  sealRunnerMachineContentKeyVerifierFactV1,
  signRunnerClaimV1,
  signRunnerMachineContentKeyBindingV1,
  wrapApiTokenEncryptionAccessV1,
} from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { actionSpecToActionDefinitionV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import {
  ExternalActionRequestEnvelopeV2Schema,
  openExternalActionRequestV2,
  prepareExternalActionResponseV2,
  type ExternalActionEncryptionBindingV2,
  type ExternalActionRequestEnvelopeV2,
} from '@happier-dev/protocol/actions';

// Exercise the published entry point: protected credentials are useful only if
// the public SDK export reaches the privacy-preserving client implementation.
import { connect } from './index.public.js';
import { HappierClientClosedError, HappierTransportError } from './errors.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

const material = { type: 'dataKey' as const, machineKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1) };
const pins = { serverIdentityId: 'srv_sdk', accountId: 'account-1',
  tokenId: '123e4567-e89b-42d3-a456-426614174000',
  contentPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=' };
const wrappingSecret = new Uint8Array(32).fill(7);
const bearer = `hap_v1_${pins.tokenId}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context: pins, wrappingSecret,
  contentPrivateKey: material.machineKey, randomBytes: (length) => new Uint8Array(length).fill(3) });
const token = formatAccountApiTokenCredentialV1({ bearer, serverIdentityId: pins.serverIdentityId,
  accountId: pins.accountId, contentPublicKey: pins.contentPublicKey,
  wrappingSecret: encodeBase64(wrappingSecret, 'base64url') });
const accessResponse = { v: 1, accountId: pins.accountId, tokenId: pins.tokenId, encryptionAccess };

type Invocation = Readonly<{ request: ExternalActionRequestEnvelopeV2; binding: ExternalActionEncryptionBindingV2; input: unknown }>;

const RUNNER_MACHINE_ID = 'runner-1';
const runnerContentKey = new Uint8Array(32).fill(9);
const runnerMaterial = { type: 'dataKey' as const, machineKey: runnerContentKey };

/**
 * The exact facts a creator publishes for a restricted Runner: an Account-sealed
 * content-key envelope, the strict binding signed by the activation identity,
 * that identity sealed for every authorized Account reader, and the endpoint's
 * activation-signed claim the Home persisted when the Runner claimed its Session.
 */
const RUNNER_SESSION_ID = 'session-runner-1';

function buildRunnerClaim(params: Readonly<{
  activationId: string;
  machineId: string;
  sessionId: string;
  installationId: string;
  signing: tweetnacl.SignKeyPair;
}>) {
  const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
  return signRunnerClaimV1({
    activationSecretKey: params.signing.secretKey,
    payload: {
      v: 1,
      purpose: 'happier.ephemeral-session-runner.claim',
      binding: {
        activationId: params.activationId,
        homeServerIdentityId: pins.serverIdentityId,
        creatorAccountId: pins.accountId,
        creatorTokenEpoch: 0,
        activationExpiresAt: null,
        workspace: { kind: 'choose_on_endpoint' },
        sessionId: params.sessionId,
        machineId: params.machineId,
        activationSigningPublicKey: encodeBase64(params.signing.publicKey, 'base64url'),
        authoringCommitment: encodeBase64(new Uint8Array(32).fill(13), 'base64url'),
        artifact: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
        endpointFactsRecipient: { mode: 'plain', creatorAccountId: pins.accountId },
      },
      runnerBoxPublicKey: encodeBase64(
        tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(14)).publicKey, 'base64url',
      ),
      installation: {
        installationId: params.installationId,
        publicKey: encodeBase64(installation.publicKey, 'base64url'),
        proof: signMachineInstallationProof({
          payload: {
            version: 1,
            installationId: params.installationId,
            machineId: params.machineId,
            accountId: pins.accountId,
          },
          privateKey: installation.secretKey,
        }),
      },
      protocolEpoch: 1,
    },
  });
}

function buildRunnerBootstrapRow(overrides: Readonly<{
  contentKey?: Uint8Array;
  machineId?: string;
  verifierMachineId?: string;
  sessionId?: string;
  activationSeed?: number;
}> = {}) {
  const contentKey = overrides.contentKey ?? runnerContentKey;
  const machineId = overrides.machineId ?? RUNNER_MACHINE_ID;
  const activationId = '11111111-2222-4333-8444-555555555555';
  const installationId = 'installation-1';
  const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(overrides.activationSeed ?? 5));
  const binding = signRunnerMachineContentKeyBindingV1({
    payload: {
      v: 1,
      purpose: 'happier.ephemeral-runner.machine-content-key',
      homeServerIdentityId: pins.serverIdentityId,
      activationId,
      creatorAccountId: pins.accountId,
      machineId,
      installationId,
      machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(contentKey),
    },
    activationSigningSecretKey: signing.secretKey,
  });
  return {
    id: machineId,
    active: true,
    revokedAt: null,
    replacedByMachineId: null,
    kind: 'ephemeral_session_runner' as const,
    runnerClaim: buildRunnerClaim({
      activationId, machineId, installationId, signing,
      sessionId: overrides.sessionId ?? RUNNER_SESSION_ID,
    }),
    installationId,
    dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: contentKey,
      recipientPublicKey: decodeBase64(pins.contentPublicKey),
      randomBytes: (length) => new Uint8Array(length).fill(6),
    })),
    runnerContentKeyBinding: {
      ...binding,
      creatorVerifierFactCiphertext: sealRunnerMachineContentKeyVerifierFactV1({
        payload: {
          v: 1,
          activationId,
          machineId: overrides.verifierMachineId ?? machineId,
          activationSigningPublicKey: encodeBase64(signing.publicKey, 'base64url'),
        },
        material,
        randomBytes: (length) => new Uint8Array(length).fill(2),
      }),
    },
  };
}

async function serve(params: Readonly<{
  bootstrap?: (response: ServerResponse) => Promise<void> | void;
  invoke?: (invocation: Invocation, response: ServerResponse) => Promise<void> | void;
  machines?: readonly unknown[];
  /** Status this endpoint answers `/v1/machines` with instead of the projection. */
  machinesFailureStatus?: number;
  requestMaterial?: Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;
}> = {}) {
  const captured: Array<{ path: string; authorization: string | undefined; body: string }> = [];
  const failures: unknown[] = [];
  const send = (response: ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const path = request.url ?? '';
    captured.push({ path, authorization: request.headers.authorization, body });
    if (path.endsWith('/encryption-access')) {
      if (params.bootstrap) await params.bootstrap(response);
      else send(response, accessResponse);
      return;
    }
    if (path === '/v1/machines') {
      if (params.machinesFailureStatus !== undefined) {
        send(response, { error: params.machinesFailureStatus === 404 ? 'not_found' : 'server_unavailable' },
          params.machinesFailureStatus);
        return;
      }
      send(response, params.machines ?? []);
      return;
    }
    const envelope = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(body));
    if (!envelope.target) throw new Error('Expected target');
    const binding = { serverIdentityId: pins.serverIdentityId, accountId: pins.accountId,
      credentialId: pins.tokenId, actionId: decodeURIComponent(path.split('/').at(-1)!),
      requestId: envelope.requestId, target: envelope.target };
    const requestMaterial = params.requestMaterial ?? material;
    const opened = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding, material: requestMaterial });
    if (!opened) throw new Error('Request did not authenticate');
    if (binding.actionId === 'action.spec.get') {
      send(response, prepareExternalActionResponseV2({ binding, request: envelope, material: requestMaterial,
        executedMachineId: binding.target.kind === 'machine' ? binding.target.machineId : 'machine-1',
        randomBytes: (length) => new Uint8Array(length).fill(4), execution: { ok: true, result: {
          actionSpec: actionSpecToActionDefinitionV1(getActionSpec('session.message.send'), { surface: 'api', includeOutputSchema: false }),
        } },
      }).response);
      return;
    }
    if (params.invoke) await params.invoke({ request: envelope, binding, input: opened.input }, response);
    else send(response, prepareExternalActionResponseV2({ binding, request: envelope, material: requestMaterial,
      executedMachineId: binding.target.kind === 'machine' ? binding.target.machineId : 'machine-1',
      randomBytes: (length) => new Uint8Array(length).fill(4),
      execution: { ok: true, result: { status: 'accepted', localId: 'result-sentinel' } },
    }).response);
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => { failures.push(error); send(response, {}, 500); });
  });
  const notifications = new NotificationServer(server, { path: '/v1/updates/' });
  const notificationAuth: unknown[] = [];
  notifications.on('connection', (socket) => { notificationAuth.push(socket.handshake.auth); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return { endpoint: `http://127.0.0.1:${address.port}`, captured, failures, send, notificationAuth,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => notifications.close(() => resolve())); },
  };
}

describe('SDK protected invocation lifecycle through real HTTP', () => {
  it('carries encryption-only same-token deployment material inside the exact encrypted request', async () => {
    const server = await serve({ invoke: ({ binding, request }, response) => {
      expect(binding.actionId).toBe('deployments.deploy');
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material })).toMatchObject({
        apiTokenContentAccess: { contentPublicKey: pins.contentPublicKey,
          wrappingSecret: encodeBase64(wrappingSecret, 'base64url') },
      });
      server.send(response, prepareExternalActionResponseV2({ binding, request, material,
        executedMachineId: 'machine-1', randomBytes: length => new Uint8Array(length).fill(4),
        execution: { ok: false, errorCode: 'approval_required', error: 'approval_required' },
      }).response);
    } });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine('machine-1').actions.deployments.deploy({ serverId: pins.serverIdentityId,
        environmentId: 'environment', targetLinkId: 'runtime', requestKey: 'deploy' })).rejects.toMatchObject({ code: 'approval_required' });
      expect(server.failures).toEqual([]);
      expect(JSON.stringify(server.captured)).not.toContain(encodeBase64(wrappingSecret, 'base64url'));
    } finally { await client.close(); await server.close(); }
  });
  it.each([
    {
      caseName: 'workflow.run.start',
      actionId: 'workflow.run.start',
      input: { runId: '11111111-1111-4111-8111-111111111111',
        source: { kind: 'inline', definition: { blocks: ['work'] } } },
      options: { project: { machineId: 'machine-1', directory: '/repo' } },
      expectsContentAccess: true,
    },
    {
      caseName: 'workflow.run.list private projection',
      actionId: 'workflow.run.list',
      input: {},
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'workflow.run.list membership projection',
      actionId: 'workflow.run.list',
      input: { projection: 'membership', attention: 'required' },
      options: undefined,
      expectsContentAccess: false,
    },
    {
      caseName: 'workflow.run.resume recovery',
      actionId: 'workflow.run.resume',
      input: { mode: 'recover', runId: '33333333-3333-4333-8333-333333333333', expectedRevision: 1,
        invocations: [{ kind: 'reattach', invocation: { recordId: '44444444-4444-4444-8444-444444444444' } }] },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'workflow.run.resume boundary',
      actionId: 'workflow.run.resume',
      input: { mode: 'boundary', runId: '33333333-3333-4333-8333-333333333333', expectedRevision: 1 },
      options: undefined,
      expectsContentAccess: false,
    },
    {
      caseName: 'workflow.run.invocations.list with content',
      actionId: 'workflow.run.invocations.list',
      input: { runId: '33333333-3333-4333-8333-333333333333', includeContent: true },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'workflow.run.invocations.list metadata only',
      actionId: 'workflow.run.invocations.list',
      input: { runId: '33333333-3333-4333-8333-333333333333', includeContent: false },
      options: undefined,
      expectsContentAccess: false,
    },
    {
      caseName: 'workflow.run.invocations.list metadata under a project target',
      actionId: 'workflow.run.invocations.list',
      input: { runId: '33333333-3333-4333-8333-333333333333', includeContent: false },
      options: { project: { machineId: 'machine-1', directory: '/repo' } },
      expectsContentAccess: true,
    },
    {
      caseName: 'workflow.run.pause without a project target',
      actionId: 'workflow.run.pause',
      input: { runId: '33333333-3333-4333-8333-333333333333', expectedRevision: 1 },
      options: undefined,
      expectsContentAccess: false,
    },
    {
      caseName: 'workflow.run.pause under a project target',
      actionId: 'workflow.run.pause',
      input: { runId: '33333333-3333-4333-8333-333333333333', expectedRevision: 1 },
      options: { project: { machineId: 'machine-1', directory: '/repo' } },
      expectsContentAccess: true,
    },
    {
      caseName: 'template.preview',
      actionId: 'template.preview',
      input: { source: { kind: 'artifact', serverId: pins.serverIdentityId,
        artifactId: '22222222-2222-4222-8222-222222222222' } },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'template.preview from a plugin',
      actionId: 'template.preview',
      input: { source: { kind: 'plugin', registryItem: {
        sourceId: 'npm', itemId: 'helper', version: '1.0.0' }, contributionId: 'template' } },
      options: undefined,
      expectsContentAccess: false,
    },
    {
      caseName: 'machines.setup.plan',
      actionId: 'machines.setup.plan',
      input: { homeId: pins.serverIdentityId, machineId: 'machine-1', mode: 'check' },
      options: undefined,
      expectsContentAccess: false,
    },
    {
      caseName: 'deployments.targets.link public intent',
      actionId: 'deployments.targets.link',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', expectedRevision: 1,
        requestKey: 'link-intent', targetId: 'own-server', role: 'runtime',
        machines: [{ machineId: 'machine-1', installationId: 'installation-1' }] },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.targets.link already prepared content',
      actionId: 'deployments.targets.link',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', expectedRevision: 1,
        requestKey: 'link-prepared', targetId: 'own-server', role: 'runtime',
        machines: [{ machineId: 'machine-1', installationId: 'installation-1' }],
        contentArtifactId: 'target-artifact', contentHeaderVersion: 1, contentBodyVersion: 1 },
      options: undefined,
      expectsContentAccess: false,
    },
    {
      caseName: 'deployments.environments.create',
      actionId: 'deployments.environments.create',
      input: { serverId: pins.serverIdentityId, projectSourceId: 'project', requestKey: 'create',
        protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'machine-1',
        contentArtifactId: 'environment-artifact', contentHeaderVersion: 1, contentBodyVersion: 1 },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.environments.update',
      actionId: 'deployments.environments.update',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', expectedRevision: 1,
        contentArtifactId: 'environment-artifact', contentHeaderVersion: 1, contentBodyVersion: 1 },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.bindings.set',
      actionId: 'deployments.bindings.set',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', expectedRevision: 1,
        contentArtifactId: 'environment-artifact', contentHeaderVersion: 1, contentBodyVersion: 1,
        referencedSavedSecretRevisions: [] },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.rollback',
      actionId: 'deployments.rollback',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', deploymentId: 'deployment', requestKey: 'rollback' },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.promote',
      actionId: 'deployments.promote',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', sourceEnvironmentId: 'source-environment',
        sourceDeploymentId: 'source-deployment', artifact: 'rebuild', requestKey: 'promote' },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.teardown with retained content',
      actionId: 'deployments.teardown',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', expectedRevision: 1,
        targetLinkId: 'runtime', expectedTargetLinkRevision: 1, requestKey: 'teardown', reason: 'manual',
        contentArtifactId: 'receipt-artifact', contentHeaderVersion: 1, contentBodyVersion: 1 },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.teardown record-only detach',
      actionId: 'deployments.teardown',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', expectedRevision: 1,
        targetLinkId: 'runtime', expectedTargetLinkRevision: 1, requestKey: 'detach', reason: 'manual', detachKeepRunning: true },
      options: undefined,
      expectsContentAccess: false,
    },
    {
      caseName: 'deployments.observation.get',
      actionId: 'deployments.observation.get',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', targetLinkId: 'runtime' },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.receipts.observe',
      actionId: 'deployments.receipts.observe',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', deploymentId: 'deployment' },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.domains.add',
      actionId: 'deployments.domains.add',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', domainId: 'domain', expectedRevision: 1,
        targetLinkId: 'runtime', expectedTargetLinkRevision: 1, requestKey: 'domain-add',
        contentArtifactId: 'domain-artifact', contentHeaderVersion: 1, contentBodyVersion: 1 },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.domains.remove',
      actionId: 'deployments.domains.remove',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', domainId: 'domain', expectedRevision: 1,
        expectedDomainRevision: 1, requestKey: 'domain-remove' },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.domains.verify',
      actionId: 'deployments.domains.verify',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', domainId: 'domain', expectedRevision: 1,
        expectedDomainRevision: 1, requestKey: 'domain-verify' },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.health.read',
      actionId: 'deployments.health.read',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', deploymentId: 'deployment',
        targetLinkId: 'runtime', machineId: 'machine-1', installationId: 'installation-1',
        service: { kind: 'deployment', machineId: 'machine-1', environmentId: 'environment',
          environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.health.current',
      actionId: 'deployments.health.current',
      input: { serverId: pins.serverIdentityId, machineId: 'machine-1', environmentId: 'environment', targetLinkId: 'runtime' },
      options: undefined,
      expectsContentAccess: false,
    },
    {
      caseName: 'deployments.drift.read',
      actionId: 'deployments.drift.read',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', deploymentId: 'deployment',
        targetLinkId: 'runtime', machineId: 'machine-1', installationId: 'installation-1', expectedRevision: 1,
        service: { kind: 'deployment', machineId: 'machine-1', environmentId: 'environment',
          environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.logs.read build output',
      actionId: 'deployments.logs.read',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', deploymentId: 'deployment',
        targetLinkId: 'runtime', machineId: 'machine-1', installationId: 'installation-1', kind: 'build' },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.logs.read runtime output',
      actionId: 'deployments.logs.read',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', deploymentId: 'deployment',
        targetLinkId: 'runtime', machineId: 'machine-1', installationId: 'installation-1', kind: 'runtime',
        service: { kind: 'deployment', machineId: 'machine-1', environmentId: 'environment',
          environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } },
      options: undefined,
      expectsContentAccess: false,
    },
    {
      caseName: 'deployments.restart',
      actionId: 'deployments.restart',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', deploymentId: 'deployment',
        targetLinkId: 'runtime', machineId: 'machine-1', installationId: 'installation-1', expectedGeneration: 'generation',
        service: { kind: 'deployment', machineId: 'machine-1', environmentId: 'environment',
          environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } },
      options: undefined,
      expectsContentAccess: false,
    },
    {
      caseName: 'deployments.backups.inventory',
      actionId: 'deployments.backups.inventory',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', machineId: 'machine-1', installationId: 'installation-1',
        targetLinkId: 'runtime', deploymentId: 'deployment', expectedRevision: 1, configRevision: 1 },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.backups.run',
      actionId: 'deployments.backups.run',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', machineId: 'machine-1', installationId: 'installation-1',
        targetLinkId: 'runtime', deploymentId: 'deployment', expectedRevision: 1, configRevision: 1 },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.backups.verify',
      actionId: 'deployments.backups.verify',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', machineId: 'machine-1', installationId: 'installation-1',
        targetLinkId: 'runtime', deploymentId: 'deployment', expectedRevision: 1, configRevision: 1,
        backupOperationId: 'backup-operation', snapshotId: 'a'.repeat(64), level: 'manifestReadBack' },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.backups.prune',
      actionId: 'deployments.backups.prune',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', machineId: 'machine-1', installationId: 'installation-1',
        targetLinkId: 'runtime', deploymentId: 'deployment', expectedRevision: 1, configRevision: 1,
        retention: { kind: 'keepEverything' } },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.backups.restore',
      actionId: 'deployments.backups.restore',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment', machineId: 'machine-1', installationId: 'installation-1',
        targetLinkId: 'runtime', deploymentId: 'deployment', restoreBackupId: 'backup', expectedRevision: 1, mode: 'prepare' },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.templates.instantiate',
      actionId: 'deployments.templates.instantiate',
      input: { mode: 'apply', serverId: pins.serverIdentityId, machineId: 'machine-1', projectSourceId: 'project',
        templateRef: { sourceId: 'apps', itemId: 'app', version: '1', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
        environment: { kind: 'create', name: 'App', requestKey: 'template', protection: 'nonProduction', purpose: 'standard',
          deployerMode: 'managers', controllerMachineId: 'machine-1' },
        target: { kind: 'new', installationId: 'installation-1' }, destination: { kind: 'stored' }, bindings: [] },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.publish.prepare',
      actionId: 'deployments.publish.prepare',
      input: { serverId: pins.serverIdentityId, machineId: 'machine-1', installationId: 'installation-1',
        projectSourceId: 'project', sourceRevision: 1,
        templateRef: { sourceId: 'apps', itemId: 'app', version: '1', ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } } },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'deployments.environments.get metadata',
      actionId: 'deployments.environments.get',
      input: { serverId: pins.serverIdentityId, environmentId: 'environment' },
      options: undefined,
      expectsContentAccess: false,
    },
    {
      caseName: 'session.spawn_new with software setup',
      actionId: 'session.spawn_new',
      input: {
        directory: { kind: 'path', path: '/workspace/project' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        machineSetupPlanInput: { homeId: pins.serverIdentityId, machineId: 'machine-1' },
      },
      options: undefined,
      expectsContentAccess: true,
    },
    {
      caseName: 'session.spawn_new without software setup',
      actionId: 'session.spawn_new',
      input: {
        directory: { kind: 'path', path: '/workspace/project' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      },
      options: undefined,
      expectsContentAccess: false,
    },
  ] as const)('projects requester Account content access for $caseName only when its owner consumes content', async ({
    actionId, input, options, expectsContentAccess,
  }) => {
    // Content delegation belongs to the Action declaration, including operand-dependent readers.
    if (expectsContentAccess) {
      expect(getActionSpec(actionId).requesterAccountContentDemandForInput).toBeTypeOf('function');
    }
    let disclosedContentAccess: boolean | undefined;
    const server = await serve({ invoke: ({ binding, request }, response) => {
      expect(binding.actionId).toBe(actionId);
      disclosedContentAccess = openExternalActionRequestV2({
        projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
        envelope: request,
        binding,
        material,
      })?.apiTokenContentAccess !== undefined;
      server.send(response, prepareExternalActionResponseV2({ binding, request, material,
        executedMachineId: 'machine-1', randomBytes: length => new Uint8Array(length).fill(4),
        execution: { ok: false, errorCode: 'approval_required', error: 'approval_required' },
      }).response);
    } });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine('machine-1').actions.execute(actionId, input, options))
        .rejects.toMatchObject({ code: 'approval_required' });
      expect(server.failures).toEqual([]);
      expect(disclosedContentAccess).toBe(expectsContentAccess);
    } finally { await client.close(); await server.close(); }
  });
  it('does not project requester Account content access for a malformed conditional request', async () => {
    let disclosedContentAccess = false;
    const server = await serve({ invoke: ({ binding, request }, response) => {
      disclosedContentAccess = openExternalActionRequestV2({
        projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
        envelope: request,
        binding,
        material,
      })?.apiTokenContentAccess !== undefined;
      server.send(response, prepareExternalActionResponseV2({ binding, request, material,
        executedMachineId: 'machine-1', randomBytes: length => new Uint8Array(length).fill(4),
        execution: { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' },
      }).response);
    } });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      const actions = client.machine('machine-1').actions;
      await expect(Reflect.apply(actions.execute, actions, ['workflow.run.resume', { mode: 'recover' }]))
        .rejects.toMatchObject({ code: expect.any(String) });
      expect(disclosedContentAccess).toBe(false);
    } finally { await client.close(); await server.close(); }
  });
  it('keeps Account content access out of a protected Session message', async () => {
    let disclosedContentAccess = false;
    const server = await serve({ invoke: ({ binding, request }, response) => {
      expect(binding.actionId).toBe('session.message.send');
      disclosedContentAccess = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material })?.apiTokenContentAccess !== undefined;
      server.send(response, prepareExternalActionResponseV2({ binding, request, material,
        executedMachineId: 'machine-1', randomBytes: length => new Uint8Array(length).fill(4),
        execution: { ok: true, result: { status: 'accepted', localId: 'result-sentinel' } },
      }).response);
    } });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine('machine-1').sessions.get('session-1').send('private-input-sentinel'))
        .resolves.toMatchObject({ status: 'accepted', localId: 'result-sentinel' });
      expect(server.failures).toEqual([]);
      expect(disclosedContentAccess).toBe(false);
      expect(JSON.stringify(server.captured)).not.toContain(encodeBase64(wrappingSecret, 'base64url'));
    } finally { await client.close(); await server.close(); }
  });
  it('protects a newly registered Team Action without delegating undeclared Account content access', async () => {
    expect(getActionSpec('teams.credentials.entitled.list').requesterAccountContentDemandForInput).toBeUndefined();
    let disclosedContentAccess = false;
    const server = await serve({ invoke: ({ binding, input, request }, response) => {
      expect(binding.actionId).toBe('teams.credentials.entitled.list');
      expect(input).toEqual({ teamId: 'private-team-sentinel' });
      disclosedContentAccess = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material })?.apiTokenContentAccess !== undefined;
      server.send(response, prepareExternalActionResponseV2({ binding, request, material,
        executedMachineId: 'machine-1', randomBytes: (length) => new Uint8Array(length).fill(4),
        execution: { ok: true, result: { resources: [] } },
      }).response);
    } });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine('machine-1').actions.teams.credentials.entitled.list({
        teamId: 'private-team-sentinel',
      })).resolves.toEqual({ resources: [], nextCursor: null });
      expect(server.failures).toEqual([]);
      expect(disclosedContentAccess).toBe(false);
      expect(server.notificationAuth).toEqual([]);
      const actionCall = server.captured.find((call) => call.path.startsWith('/v1/actions/'));
      expect(actionCall?.path).toBe('/v1/actions/teams.credentials.entitled.list');
      expect(actionCall ? JSON.parse(actionCall.body).v : undefined).toBe(2);
      expect(actionCall?.body).not.toContain('private-team-sentinel');
      expect(JSON.stringify(server.captured)).not.toContain('resources');
    } finally { await client.close(); await server.close(); }
  });

  it('seals a protected Action for a restricted Runner with that Runner\'s own content key', async () => {
    let disclosedContentAccess = false;
    const runnerRow = buildRunnerBootstrapRow();
    const server = await serve({ machines: [runnerRow], requestMaterial: runnerMaterial,
      invoke: ({ binding, input, request }, response) => {
        expect(binding.target).toEqual({ kind: 'machine', machineId: RUNNER_MACHINE_ID });
        expect(input).toEqual({ teamId: 'private-team-sentinel' });
        disclosedContentAccess = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material: runnerMaterial })?.apiTokenContentAccess !== undefined;
        server.send(response, prepareExternalActionResponseV2({ binding, request, material: runnerMaterial,
          executedMachineId: RUNNER_MACHINE_ID, randomBytes: (length) => new Uint8Array(length).fill(4),
          execution: { ok: true, result: { resources: [] } },
        }).response);
      } });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine(RUNNER_MACHINE_ID).actions.teams.credentials.entitled.list({
        teamId: 'private-team-sentinel',
      })).resolves.toEqual({ resources: [], nextCursor: null });
      expect(server.failures).toEqual([]);
      expect(disclosedContentAccess).toBe(false);
      // The Account key never sealed this request: the relay bytes do not open
      // with it, and the plaintext never left the SDK.
      const actionCall = server.captured.find((call) => call.path.startsWith('/v1/actions/'));
      const envelope = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(actionCall!.body));
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, material,
        binding: { serverIdentityId: pins.serverIdentityId, accountId: pins.accountId,
          credentialId: pins.tokenId, actionId: 'teams.credentials.entitled.list',
          requestId: envelope.requestId, target: envelope.target! },
      })).toBeNull();
      expect(actionCall?.body).not.toContain('private-team-sentinel');
    } finally { await client.close(); await server.close(); }
  });

  it('seals a Session-targeted Action for the Runner that Session was activated for', async () => {
    const runnerRow = buildRunnerBootstrapRow();
    const server = await serve({ machines: [runnerRow], requestMaterial: runnerMaterial });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.sessions.get(RUNNER_SESSION_ID).send('input-sentinel'))
        .resolves.toMatchObject({ status: 'accepted' });
      expect(server.failures).toEqual([]);
      const actionCall = server.captured.find((call) => call.path.startsWith('/v1/actions/'));
      const envelope = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(actionCall!.body));
      expect(envelope.target).toEqual({ kind: 'session', sessionId: RUNNER_SESSION_ID });
      // The Account key never sealed it: only the Runner's own content key opens it.
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, material,
        binding: { serverIdentityId: pins.serverIdentityId, accountId: pins.accountId,
          credentialId: pins.tokenId, actionId: 'session.message.send',
          requestId: envelope.requestId, target: envelope.target! },
      })).toBeNull();
      expect(actionCall?.body).not.toContain('input-sentinel');
    } finally { await client.close(); await server.close(); }
  });

  it('keeps Account sealing for a Session no published Runner was activated for', async () => {
    const server = await serve({ machines: [buildRunnerBootstrapRow()] });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.sessions.get('session-other').send('input-sentinel'))
        .resolves.toMatchObject({ status: 'accepted' });
      expect(server.failures).toEqual([]);
      const actionCall = server.captured.find((call) => call.path.startsWith('/v1/actions/'));
      const envelope = ExternalActionRequestEnvelopeV2Schema.parse(JSON.parse(actionCall!.body));
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, material,
        binding: { serverIdentityId: pins.serverIdentityId, accountId: pins.accountId,
          credentialId: pins.tokenId, actionId: 'session.message.send',
          requestId: envelope.requestId, target: envelope.target! },
      })).not.toBeNull();
    } finally { await client.close(); await server.close(); }
  });

  it('never seals a Session\'s request to another genuine Runner the Home maps it to', async () => {
    // Runner B is entirely genuine — key, binding, verifier fact and its own
    // claim for its own Session. The Home asserts B holds Session A by
    // rewriting the relayed claim; the activation signature no longer verifies.
    const runnerB = buildRunnerBootstrapRow({ sessionId: 'session-b' });
    const relabelled = { ...runnerB, runnerClaim: {
      ...runnerB.runnerClaim,
      payload: { ...runnerB.runnerClaim.payload,
        binding: { ...runnerB.runnerClaim.payload.binding, sessionId: 'session-a' } },
    } };
    const server = await serve({ machines: [relabelled], requestMaterial: runnerMaterial });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.sessions.get('session-a').send('input-sentinel'))
        .rejects.toMatchObject({ name: 'HappierTransportError', code: 'invalid_encrypted_envelope' });
      expect(server.captured.some((call) => call.path.startsWith('/v1/actions/'))).toBe(false);
      expect(JSON.stringify(server.captured)).not.toContain('input-sentinel');
    } finally { await client.close(); await server.close(); }
  });

  it('does not treat two Runners claiming one Session as a correspondence', async () => {
    const server = await serve({ machines: [
      buildRunnerBootstrapRow(),
      buildRunnerBootstrapRow({ machineId: 'runner-2', activationSeed: 6 }),
    ], requestMaterial: runnerMaterial });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.sessions.get(RUNNER_SESSION_ID).send('input-sentinel'))
        .rejects.toMatchObject({ name: 'HappierTransportError', code: 'invalid_encrypted_envelope' });
      expect(server.captured.some((call) => call.path.startsWith('/v1/actions/'))).toBe(false);
    } finally { await client.close(); await server.close(); }
  });

  it.each([
    ['a binding signed for another Machine content key', () => buildRunnerBootstrapRow({
      contentKey: new Uint8Array(32).fill(11),
    })],
    ['a verifier fact replayed from another Runner', () => buildRunnerBootstrapRow({
      verifierMachineId: 'runner-2',
    })],
  ])('refuses a substituted Runner key binding without downgrading to the Account key (%s)', async (_label, build) => {
    const row = _label.startsWith('a binding signed')
      // Substitute only the envelope so the published key no longer matches the
      // signed fingerprint; the Home relays both fields.
      ? { ...build(), dataEncryptionKey: buildRunnerBootstrapRow().dataEncryptionKey }
      : build();
    const server = await serve({ machines: [row], requestMaterial: runnerMaterial });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine(RUNNER_MACHINE_ID).actions.teams.credentials.entitled.list({
        teamId: 'private-team-sentinel',
      })).rejects.toMatchObject({ name: 'HappierTransportError', code: 'invalid_encrypted_envelope' });
      expect(server.captured.some((call) => call.path.startsWith('/v1/actions/'))).toBe(false);
      expect(JSON.stringify(server.captured)).not.toContain('private-team-sentinel');
    } finally { await client.close(); await server.close(); }
  });

  it('keeps Account sealing when the endpoint serves no Machine bootstrap projection', async () => {
    // A daemon-hosted Action API answers Actions but not the Home's Machine
    // listing. That is not evidence about the target, so the released Account
    // sealing stands instead of failing the request.
    const server = await serve({ machinesFailureStatus: 404,
      invoke: ({ binding, request }, response) => server.send(response,
        prepareExternalActionResponseV2({ binding, request, material,
          executedMachineId: 'machine-1', randomBytes: (length) => new Uint8Array(length).fill(4),
          execution: { ok: true, result: { resources: [] } },
        }).response) });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine('machine-1').actions.teams.credentials.entitled.list({
        teamId: 'private-team-sentinel',
      })).resolves.toEqual({ resources: [], nextCursor: null });
      expect(server.failures).toEqual([]);
    } finally { await client.close(); await server.close(); }
  });

  it('surfaces a failed Machine bootstrap read instead of taking the bootstrap-absent path', async () => {
    // A Home that serves the projection but fails this read says nothing about
    // the target either. Keeping Account sealing here would move the failure to
    // the Runner after a dispatch, so the read failure stays its own typed
    // error and no Action leaves the SDK.
    const server = await serve({ machinesFailureStatus: 503 });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine(RUNNER_MACHINE_ID).actions.teams.credentials.entitled.list({
        teamId: 'private-team-sentinel',
      })).rejects.toMatchObject({ name: 'HappierTransportError', status: 503 });
      expect(server.captured.some((call) => call.path.startsWith('/v1/actions/'))).toBe(false);
      expect(JSON.stringify(server.captured)).not.toContain('private-team-sentinel');
    } finally { await client.close(); await server.close(); }
  });

  it('does not expose an arbitrary retry header from an untrusted non-JSON response', async () => {
    const server = await serve({ bootstrap: (response) => {
      response.writeHead(503, { 'x-happier-retry-reason': 'private-header-sentinel' });
      response.end('not JSON');
    } });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine('machine-1').sessions.get('session-1').send('input-sentinel'))
        .rejects.toMatchObject({ code: undefined, status: 503, details: undefined });
      expect(server.captured.map((call) => call.path)).toEqual([
        '/v1/machines', '/v1/auth/api-tokens/encryption-access',
      ]);
    } finally { await client.close(); await server.close(); }
  });

  it('refuses an authenticated result outside its declared output schema without disclosing it', async () => {
    const server = await serve({ invoke: ({ binding, request }, response) => server.send(response,
      prepareExternalActionResponseV2({ binding, request, material,
        executedMachineId: 'machine-1', randomBytes: (length) => new Uint8Array(length).fill(4),
        execution: { ok: true, result: { resources: 'result-sentinel' } },
      }).response) });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      const failure = await client.machine('machine-1').actions.teams.credentials.entitled.list({
        teamId: 'private-team-sentinel',
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: 'HappierTransportError', code: 'invalid_action_output' });
      expect((failure as HappierTransportError).details).toBeUndefined();
      expect(String((failure as Error).message)).not.toContain('result-sentinel');
      expect(server.failures).toEqual([]);
    } finally { await client.close(); await server.close(); }
  });

  it('preserves an unsupported encrypted transport code without retry or downgrade', async () => {
    const server = await serve({ invoke: (invocation, response) => server.send(response,
      {
        error: 'invalid_request',
        code: 'encrypted_action_unsupported',
        requestId: invocation.binding.requestId,
      }, 409) });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine('machine-1').sessions.get('session-1').send('input-sentinel'))
        .rejects.toMatchObject({ code: 'encrypted_action_unsupported', status: 409, details: undefined });
      // The one target-Machine read, Account bootstrap when needed, and exactly one
      // Action attempt: no retry and no downgraded second send.
      expect(server.captured.map((call) => call.path)).toEqual([
        '/v1/machines',
        '/v1/auth/api-tokens/encryption-access',
        '/v1/actions/session.message.send',
      ]);
    } finally { await client.close(); await server.close(); }
  });

  it('preserves the target refusal phase without retrying a protected Action', async () => {
    const server = await serve({ invoke: (invocation, response) => server.send(response, {
      error: 'invalid_request', code: 'target_not_local',
      requestId: invocation.binding.requestId, phase: 'target_installation',
    }, 409) });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine('machine-1').sessions.get('session-1').send('private-input-sentinel'))
        .rejects.toMatchObject({ code: 'target_not_local', status: 409,
          details: { phase: 'target_installation' } });
      expect(server.captured.filter((call) => call.path === '/v1/actions/session.message.send')).toHaveLength(1);
    } finally { await client.close(); await server.close(); }
  });

  it('does not trust a protected outer error correlated to another request', async () => {
    const server = await serve({ invoke: (_invocation, response) => server.send(response, {
      error: 'invalid_request',
      code: 'target_unavailable',
      requestId: 'different-request',
    }, 409) });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine('machine-1').sessions.get('session-1').send('input-sentinel'))
        .rejects.toMatchObject({ code: undefined, status: 409, details: undefined });
      expect(server.captured.map((call) => call.path)).toEqual([
        '/v1/machines',
        '/v1/auth/api-tokens/encryption-access',
        '/v1/actions/session.message.send',
      ]);
    } finally { await client.close(); await server.close(); }
  });

  it('preserves the strict PAT-self repair code without disclosing response details or downgrading', async () => {
    const server = await serve({ bootstrap: (response) => server.send(response, { error: 'api_token_encryption_stale' }, 409) });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine('machine-1').sessions.get('session-1').send('input-sentinel'))
        .rejects.toMatchObject({ code: 'api_token_encryption_stale', status: 409, details: undefined });
      expect(server.captured.map((call) => call.path)).toEqual([
        '/v1/machines', '/v1/auth/api-tokens/encryption-access',
      ]);
    } finally { await client.close(); await server.close(); }
  });

  it.each([
    { ...accessResponse, accountId: 'wrong-account' },
    { ...accessResponse, tokenId: '223e4567-e89b-42d3-a456-426614174000' },
    { ...accessResponse, encryptionAccess: { ...encryptionAccess, serverIdentityId: 'srv_wrong' } },
    { ...accessResponse, encryptionAccess: { ...encryptionAccess, contentPublicKey: encodeBase64(new Uint8Array(32).fill(4), 'base64') } },
  ])('rejects a retrieved record outside the locally pinned binding', async (record) => {
    const server = await serve({ bootstrap: (response) => server.send(response, record) });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine('machine-1').sessions.get('session-1').send('input-sentinel'))
        .rejects.toMatchObject({ code: 'invalid_encrypted_envelope' });
      expect(server.captured.map((call) => call.path)).toEqual([
        '/v1/machines', '/v1/auth/api-tokens/encryption-access',
      ]);
    } finally { await client.close(); await server.close(); }
  });

  it('protects stream and transcript cleanup before disposing the shared credential', async () => {
    const completed: string[] = [];
    const server = await serve({ invoke: ({ binding, request }, response) => {
      const result = binding.actionId === 'execution.run.stream.start' ? { streamId: 'stream-1' }
        : binding.actionId === 'session.status.get'
          ? { session: { id: 'session-1', active: true, createdAt: 0, updatedAt: 0, activeAt: 0, encryption: null } }
        : binding.actionId === 'transcript.follow'
          ? { items: [{ role: 'assistant', content: { t: 'encrypted', c: 'stored-row' } }], nextCursor: '1', truncated: false }
          : { ok: true };
      server.send(response, prepareExternalActionResponseV2({ binding, request, material,
        executedMachineId: 'machine-1', randomBytes: (length) => new Uint8Array(length).fill(4),
        execution: { ok: true, result } }).response);
      completed.push(binding.actionId);
    } });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await client.machine('machine-1').runs.startStream({ runId: 'run-1', message: 'stream-sentinel' });
      const iterator = client.sessions.get('session-1').followTranscript()[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { content: { t: 'encrypted', c: 'stored-row' } } });
      await client.close();
      expect(completed).toContain('execution.run.stream.cancel');
      expect(completed).toContain('transcript.unfollow');
      expect(server.failures).toEqual([]);
      expect(server.notificationAuth).toEqual([]);
      expect(server.captured.filter((call) => call.path.endsWith('/encryption-access'))).toHaveLength(1);
      expect(server.captured.filter((call) => call.path.startsWith('/v1/actions/'))
        .every((call) => JSON.parse(call.body).v === 2)).toBe(true);
      expect(JSON.stringify(server.captured)).not.toContain('sentinel');
    } finally { await client.close(); await server.close(); }
  });

  it('shares lazy bootstrap across children and isolates one cancelled waiter', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const server = await serve({ bootstrap: async (response) => {
      started.resolve(); await release.promise; server.send(response, accessResponse);
    } });
    const client = connect({ endpoint: server.endpoint, token });
    const abort = new AbortController();
    const cancellation = new Error('cancel caller');
    try {
      expect(server.captured).toHaveLength(0);
      const cancelled = client.machine('machine-1').sessions.get('session-1').send('cancelled-sentinel', { signal: abort.signal });
      const rejected = expect(cancelled).rejects.toBe(cancellation);
      await started.promise;
      const live = client.machine('machine-2').sessions.get('session-2').send('input-sentinel');
      abort.abort(cancellation);
      release.resolve();
      await expect(live).resolves.toMatchObject({ status: 'accepted', localId: 'result-sentinel' });
      await rejected;
      await client.machines.list();
      expect(server.captured.filter((call) => call.path.endsWith('/encryption-access'))).toHaveLength(1);
      expect(server.captured.filter((call) => call.path.startsWith('/v1/actions/'))).toHaveLength(1);
      expect(server.captured.every((call) => call.authorization === `Bearer ${bearer}`)).toBe(true);
      expect(JSON.stringify(server.captured)).not.toContain('sentinel');
      expect(JSON.stringify(server.captured)).not.toContain(token);
      expect(server.failures).toEqual([]);
    } finally { release.resolve(); await client.close(); await server.close(); }
  });

  it('retries only a failed read-only bootstrap on a later explicit invocation', async () => {
    let count = 0;
    const server = await serve({ bootstrap: (response) => server.send(response, ++count === 1 ? { error: 'unavailable' } : accessResponse, count === 1 ? 503 : 200) });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine('machine-1').sessions.get('session-1').send('input-sentinel')).rejects.toBeInstanceOf(HappierTransportError);
      expect(server.captured.filter((call) => call.path.startsWith('/v1/actions/'))).toHaveLength(0);
      await expect(client.machine('machine-1').sessions.get('session-1').send('input-sentinel')).resolves.toMatchObject({ localId: 'result-sentinel' });
      expect(count).toBe(2);
      expect(server.captured.filter((call) => call.path.startsWith('/v1/actions/'))).toHaveLength(1);
    } finally { await client.close(); await server.close(); }
  });

  it('closes pending bootstrap and never starts an Action after late retrieval', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const server = await serve({ bootstrap: async (response) => { started.resolve(); await release.promise; server.send(response, accessResponse); } });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      const pending = client.machine('machine-1').sessions.get('session-1').send('input-sentinel');
      const rejected = expect(pending).rejects.toBeInstanceOf(HappierClientClosedError);
      await started.promise;
      await client.close(); release.resolve(); await rejected;
      await expect(client.machine('machine-2').sessions.get('session-2').send('late-sentinel')).rejects.toBeInstanceOf(HappierClientClosedError);
      expect(server.captured.filter((call) => call.path.startsWith('/v1/actions/'))).toHaveLength(0);
    } finally { release.resolve(); await client.close(); await server.close(); }
  });

  it('carries every post-open outcome family inside the authenticated response', async () => {
    const server = await serve({ invoke: ({ binding, request }, response) => {
      const execution = binding.actionId === 'session.message.send'
        ? { ok: true as const, result: { status: 'outcomeUnknown', localId: 'turn-sentinel-id', code: 'session_input_outcome_unknown' } }
        : binding.actionId === 'execution.run.stop'
          ? { ok: false as const, errorCode: 'conflict', error: 'The Run is already stopping.' }
          : { ok: true as const, result: { kind: 'approval_request_created',
            artifactId: 'private-approval-artifact', actionId: binding.actionId } };
      server.send(response, prepareExternalActionResponseV2({ binding, request, material,
        executedMachineId: 'machine-1', randomBytes: (length) => new Uint8Array(length).fill(4),
        execution }).response);
    } });
    const client = connect({ endpoint: server.endpoint, token });
    const machineClient = client.machine('machine-1');
    const run = machineClient.sessions.get('session-1').runs.get('run-1');
    try {
      // `outcomeUnknown` keeps its own local id: no adapter collapses it into a
      // codeless wait failure and no mutation is retried.
      await expect(run.sendAndWait('turn-sentinel')).resolves
        .toEqual({ status: 'outcomeUnknown', localId: 'turn-sentinel-id', code: 'session_input_outcome_unknown' });
      // A post-open domain failure keeps its canonical code instead of arriving
      // as a bare HTTP error the client would have to guess about.
      await expect(run.stop()).rejects.toMatchObject({ name: 'HappierActionError', code: 'conflict' });
      // The same protected decoder serves both public seams: raw keeps the
      // approval as admitted domain data, fluent raises the typed refusal.
      await expect(machineClient.actions.execution.run.wait({ sessionId: 'session-1', runId: 'run-1' }))
        .resolves.toMatchObject({ kind: 'approval_request_created', artifactId: 'private-approval-artifact' });
      await expect(run.wait()).rejects.toMatchObject({
        name: 'HappierActionError', code: 'approval_required',
      });
      expect(server.failures).toEqual([]);
      expect(JSON.stringify(server.captured)).not.toContain('sentinel');
    } finally { await client.close(); await server.close(); }
  });

  it('surfaces a caller cancellation of an opened invocation without retry or downgrade', async () => {
    const reached = deferred<void>();
    const release = deferred<void>();
    const server = await serve({ invoke: async ({ binding, request }, response) => {
      reached.resolve();
      await release.promise;
      server.send(response, prepareExternalActionResponseV2({ binding, request, material,
        executedMachineId: 'machine-1', randomBytes: (length) => new Uint8Array(length).fill(4),
        execution: { ok: true, result: { ok: true } } }).response);
    } });
    const client = connect({ endpoint: server.endpoint, token });
    const abort = new AbortController();
    const cancellation = new Error('caller cancelled');
    try {
      const pending = client.machine('machine-1').sessions.get('session-1')
        .runs.get('run-1').send('turn-sentinel', {}, { signal: abort.signal });
      const rejected = expect(pending).rejects.toBe(cancellation);
      await reached.promise;
      abort.abort(cancellation);
      await rejected;
      release.resolve();
      // Exactly one admitted send: a lost response never becomes a second
      // sealed mutation.
      expect(server.captured.filter((call) => call.path.startsWith('/v1/actions/'))).toHaveLength(1);
      expect(JSON.stringify(server.captured)).not.toContain('sentinel');
    } finally { release.resolve(); await client.close(); await server.close(); }
  });

  it('rejects a response authenticated against a different target or tampered ciphertext', async () => {
    for (const corruption of ['target', 'ciphertext'] as const) {
      const server = await serve({ invoke: ({ binding, request }, response) => {
        const bound = corruption === 'target'
          // The daemon's own binding must cover the exact requested target: a
          // result sealed for another Machine is not this invocation's result.
          ? { ...binding, target: { kind: 'machine' as const, machineId: 'machine-2' } }
          : binding;
        const sealed = prepareExternalActionResponseV2({ binding: bound, request, material,
          executedMachineId: 'machine-1', randomBytes: (length) => new Uint8Array(length).fill(4),
          execution: { ok: true, result: { status: 'accepted', localId: 'result-sentinel' } } }).response;
        const payload = 'payload' in sealed ? sealed.payload : undefined;
        if (!payload) throw new Error('Expected a protected response payload');
        server.send(response, corruption === 'ciphertext'
          ? { ...sealed, payload: { ...payload, c: `${payload.c.slice(0, -4)}AAAA` } }
          : sealed);
      } });
      const client = connect({ endpoint: server.endpoint, token });
      try {
        await expect(client.machine('machine-1').sessions.get('session-1').send('input-sentinel'))
          .rejects.toMatchObject({ code: 'invalid_encrypted_envelope' });
        expect(JSON.stringify(server.captured)).not.toContain('sentinel');
      } finally { await client.close(); await server.close(); }
    }
  });

  it('rejects raw or stale authenticated responses without mutation retry', async () => {
    let first: unknown;
    let count = 0;
    const server = await serve({ invoke: ({ binding, request }, response) => {
      count += 1;
      first ??= prepareExternalActionResponseV2({ binding, request, material, executedMachineId: 'machine-1',
        randomBytes: (length) => new Uint8Array(length).fill(4),
        execution: { ok: true, result: { status: 'accepted', localId: 'first-sentinel-id' } } }).response;
      server.send(response, count === 3 ? { v: 1, actionId: binding.actionId, requestId: binding.requestId, execution: { ok: true, result: 'raw' } } : first);
    } });
    const client = connect({ endpoint: server.endpoint, token });
    const session = client.machine('machine-1').sessions.get('session-1');
    try {
      await expect(session.send('first-sentinel', { requestId: 'same-id' }))
        .resolves.toEqual({ status: 'accepted', localId: 'first-sentinel-id' });
      await expect(session.send('second-sentinel', { requestId: 'same-id' })).rejects.toMatchObject({ code: 'invalid_encrypted_envelope' });
      await expect(session.send('third-sentinel', { requestId: 'same-id' })).rejects.toMatchObject({ code: 'invalid_encrypted_envelope' });
      expect(count).toBe(3);
      expect(JSON.stringify(server.captured)).not.toContain('sentinel');
    } finally { await client.close(); await server.close(); }
  });
});
