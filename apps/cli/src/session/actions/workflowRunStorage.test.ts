import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  projectDeploymentPreparationAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { PluginInstallationManifestPublisherHeaderV1Schema, PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { projectExternalActionRequesterHttpAuthorization, resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import * as installations from '@/daemon/identity/currentMachineInstallation';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import * as sockets from '@/api/session/sockets';
import { createCliWorkflowRunStorage } from './workflowRunStorage';

const home = 'https://requester-home.test';
const machineId = 'host';
const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
const parent = { actionId: 'machines.setup.apply' as const, input: MachineSetupApplyInputV1Schema.parse({
  homeId: 'srv_home', machineId, targets: [{ homeId: 'srv_home', machineId,
    sources: [{ kind: 'direct', setup: {} }], desiredRevision: 0, recipePlans: [] }],
}) };
const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-setup-proof', binding: {
  accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, custodianAccountId: 'requester',
  serverIdentityId: 'srv_home', machineId, installationId: 'installation', actionId: parent.actionId,
  requestId: 'setup-request', requestEnvelopeDigest: 'a'.repeat(43), accountEncryptionMode: 'plain',
  target: { kind: 'machine', machineId },
  deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(parent.actionId, parent.input),
} });

let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>>;
beforeEach(async () => {
  channel = await createRequesterCurrentnessSocketHarness();
  // Home HTTP and installed identity files are the genuine boundaries. Keep
  // requester admission, credential selection, storage and publisher signing real.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'requester' } };
    if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    throw new Error('unexpected_requester_read');
  });
  vi.spyOn(installations, 'readCurrentMachineInstallation').mockResolvedValue({ machineId, identity: {
    version: 1, installationId: 'installation', createdAt: 1,
    publicKey: encodeBase64(keys.publicKey, 'base64url'), privateKey: encodeBase64(keys.secretKey, 'base64url'),
  } });
});
afterEach(async () => { await requester?.dispose(); requester = null; await channel.close(); vi.restoreAllMocks(); });

function factory() {
  return createCliWorkflowRunStorage({ token: 'different-ambient-account', serverHttpBaseUrl: 'https://ambient-home.test' },
    async () => machineId,
    (context, effectActionId, request) => {
      const resolved = resolveExternalActionServerRequestHeaders({ context, effectActionId, ...request,
        daemonToken: 'different-ambient-account', serverIdentityId: 'srv_home', privateKey: keys.secretKey, installationId: 'installation' });
      return resolved.ok ? resolved.headers : null;
    }, value => typeof value === 'string' && value.trim() ? value.trim() : null);
}

async function admittedContext(isCurrent = async () => true, root = authorization): Promise<ActionExecutorContext> {
  requester = await admitRequesterAccountActionContext({ authorization: root, credentials: { token: 'requester-account', encryption: null },
    serverId: 'home-profile', serverIdentityId: 'srv_home', serverHttpBaseUrl: home, isCurrent });
  if (!requester) throw new Error('requester_admission_required');
  return { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
    actionRequestId: authorization.binding.requestId, externalActionTarget: authorization.binding.target,
    externalActionExecutionAuthorization: requester.authorization };
}

describe('combined parent Run storage authority', () => {
  it('uses the verified signed combined parent for Run HTTP while retaining installed Account wake observation', async () => {
    const setupParent = { actionId: 'machines.setup.apply' as const, input: MachineSetupApplyInputV1Schema.parse({
      homeId: 'srv_home', machineId, targets: [{ homeId: 'srv_home', machineId,
        sources: [{ kind: 'direct', setup: {} }], desiredRevision: 0, recipePlans: [] }],
    }) };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-setup-root', binding: {
      accountId: 'requester', principalId: 'requester-principal', credentialId: 'requester-pat',
      grant: API_TOKEN_FULL_GRANT_V1, custodianAccountId: 'requester', serverIdentityId: 'srv_home', machineId,
      installationId: 'installation', actionId: setupParent.actionId, requestId: 'setup-request',
      requestEnvelopeDigest: 'a'.repeat(43), accountEncryptionMode: 'plain', target: { kind: 'machine', machineId },
      deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(setupParent.actionId, setupParent.input),
    } });
    let live = true;
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const projected = await projectExternalActionRequesterHttpAuthorization({ authorization: root,
      serverId: 'home-profile', serverIdentityId: 'srv_home', serverHttpBaseUrl: home, target: root.binding.target,
      installationId: 'installation', privateKey: keys.secretKey, isCurrent: async () => live });
    if (!projected) throw new Error('verified_signed_root_required');
    post.mockClear();
    const context: ActionExecutorContext = { surface: 'cli', externalActionTarget: root.binding.target,
      externalActionExecutionAuthorization: projected };
    const unsignedStorage = factory().createWorkflowRunStorage({ parent: setupParent,
      context: { ...context, externalActionExecutionAuthorization: root } });
    await expect(unsignedStorage.execute({ operation: 'get', runId: 'setup-run' })).rejects.toMatchObject({ code: 'run_access_denied' });
    expect(post).not.toHaveBeenCalled();
    post.mockResolvedValue({ data: { accepted: true } });
    const storage = factory().createWorkflowRunStorage({ parent: setupParent, context });
    await expect(storage.execute({ operation: 'get', runId: 'setup-run' })).resolves.toEqual({ accepted: true });
    const [url, body, options] = post.mock.calls[0]!;
    expect(url).toBe(`${home}/v3/automations/runs/workflow-storage`);
    expect(options?.headers).not.toHaveProperty('Authorization');
    expect(options?.headers).toHaveProperty(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, root.token);
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: setupParent.actionId,
      target: root.binding.target, installationId: 'installation', requestId: root.binding.requestId,
      method: 'POST', path: '/v3/automations/runs/workflow-storage', body, publicKey: keys.publicKey,
      signature: String(options?.headers?.['x-happier-action-machine-signature'] ?? '') })).toBe(true);
    let connected!: () => void;
    let connectionFailed!: (error: unknown) => void;
    const wake = new Promise<void>((resolve, reject) => { connected = resolve; connectionFailed = reject; });
    const observation = storage.observeChanges!('setup-run', connected, connectionFailed);
    try {
      await wake;
      expect(vi.mocked(sockets.createUserScopedSocketConnection).mock.calls.at(-1)?.[0]).toMatchObject({
        token: 'different-ambient-account', serverUrl: home,
      });
      expect(post).toHaveBeenCalledTimes(1);
    } finally { await observation.dispose(); }
    live = false;
    await expect(storage.execute({ operation: 'get', runId: 'setup-run' })).rejects.toMatchObject({ code: 'run_access_denied' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('uses retained requester Run access and the unchanged installed publisher instead of the Publish proof or ambient Account', async () => {
    const context = await admittedContext();
    const original = context.externalActionExecutionAuthorization;
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { accepted: true } });
    const storage = factory().createWorkflowRunStorage({ parent, context });
    await expect(storage.execute({ operation: 'get', runId: 'reviewed-run' }, { publisherMachineId: machineId }))
      .resolves.toEqual({ accepted: true });
    const [url, body, options] = post.mock.calls[0]!;
    expect(url).toBe(`${home}/v3/automations/runs/workflow-storage`);
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer requester-account' });
    expect(options?.headers).not.toHaveProperty(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER);
    expect(body).toMatchObject({ operation: 'get', runId: 'reviewed-run', publisherMachineId: machineId });
    const header = PluginInstallationManifestPublisherHeaderV1Schema.parse(JSON.parse(Buffer.from(
      String(options?.headers?.[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]), 'base64url').toString('utf8')));
    expect(header.proof).toMatchObject({ machineId, installationId: 'installation', path: '/v3/automations/runs/workflow-storage' });
    expect(context.externalActionExecutionAuthorization).toBe(original);
    expect(original?.binding.actionId).toBe(parent.actionId);
  });

  it('refuses missing or revoked signed requester custody before any Run HTTP request, and rechecks after disclosure', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { private: 'run' } });
    const missing = factory().createWorkflowRunStorage({ parent, context: { surface: 'cli', externalActionExecutionAuthorization: authorization } });
    await expect(missing.execute({ operation: 'get', runId: 'reviewed-run' })).rejects.toMatchObject({ code: 'run_access_denied' });
    expect(post).not.toHaveBeenCalled();
    let live = true;
    const context = await admittedContext(async () => live);
    const storage = factory().createWorkflowRunStorage({ parent, context });
    live = false;
    await expect(storage.execute({ operation: 'get', runId: 'reviewed-run' })).rejects.toMatchObject({ code: 'run_access_denied' });
    expect(post).not.toHaveBeenCalled();
    live = true;
    post.mockImplementation(async () => { live = false; return { data: { private: 'run' } }; });
    await expect(storage.execute({ operation: 'get', runId: 'reviewed-run' })).rejects.toMatchObject({ code: 'run_access_denied' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary signed Workflow Actions on their original exact-purpose headers', async () => {
    const context: ActionExecutorContext = { surface: 'cli', externalActionTarget: authorization.binding.target, externalActionExecutionAuthorization: {
      ...authorization, binding: { ...authorization.binding, actionId: 'workflow.run.get', deploymentPreparationAdmission: undefined },
    } };
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { observed: true } });
    await factory().createWorkflowRunStorage({ actionId: 'workflow.run.get', context })
      .execute({ operation: 'get', runId: 'existing-run' });
    expect(post.mock.calls[0]?.[2]?.headers).toHaveProperty(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, authorization.token);
    expect(post.mock.calls[0]?.[2]?.headers).not.toHaveProperty('Authorization');
  });

  it('observes only the same requester Home and Account while custody is current, and retires the wait on revocation', async () => {
    let live = true;
    const context = await admittedContext(async () => live);
    const changed = vi.fn();
    let connected!: () => void;
    const initialWake = new Promise<void>(resolve => { connected = resolve; });
    let failed!: (error: unknown) => void;
    const revoked = new Promise<unknown>(resolve => { failed = resolve; });
    const observation = factory().createWorkflowRunStorage({ parent, context }).observeChanges!('reviewed-run',
      () => { changed(); connected(); }, failed);
    try {
      await initialWake;
      expect(vi.mocked(sockets.createUserScopedSocketConnection).mock.calls.at(-1)?.[0]).toMatchObject({
        token: 'requester-account', serverUrl: home,
      });
      const wakeCount = changed.mock.calls.length;
      live = false;
      await channel.hintAccountChange();
      await expect(revoked).resolves.toMatchObject({ code: 'run_access_denied' });
      expect(changed).toHaveBeenCalledTimes(wakeCount);
    } finally { await observation.dispose(); }
    const clients = channel.clients.length;
    const missing = factory().createWorkflowRunStorage({ parent, context: { surface: 'cli', externalActionExecutionAuthorization: authorization } });
    const refused = new Promise<unknown>(resolve => {
      const stopped = missing.observeChanges!('reviewed-run', () => { throw new Error('missing_custody_must_not_observe'); },
        error => { void stopped.dispose(); resolve(error); });
    });
    await expect(refused).resolves.toMatchObject({ code: 'run_access_denied' });
    expect(channel.clients).toHaveLength(clients);
  });
});


describe('approved Account proposal HTTP custody', () => {
  it('spends the admitted requester for the witnessed effect while retaining the proposal root', async () => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: {
      ...authorization.binding, actionId: 'approval.request.create', deploymentPreparationAdmission: undefined,
    } });
    const context: ActionExecutorContext = { ...await admittedContext(async () => true, root),
      presentUserApproval: { artifactId: 'approval', actionId: 'workflow.run.start',
        requestId: root.binding.requestId, inputDigest: 'approved-input', decidingAccountId: 'requester' },
      approvedActionReplay: { artifactId: 'approval', origin: { surface: 'cli', caller: { kind: 'host' }, accountId: 'requester' } },
    };
    const request = { context, effectActionId: 'workflow.run.start', method: 'GET', path: '/v1/account/encryption/currentness',
      daemonToken: 'different-ambient-account', serverIdentityId: 'srv_home', privateKey: keys.secretKey, installationId: 'installation' };
    expect(resolveExternalActionServerRequestHeaders(request)).toMatchObject({ ok: true, headers: { Authorization: 'Bearer requester-account' } });
    expect(context.externalActionExecutionAuthorization?.binding.actionId).toBe('approval.request.create');
    for (const changed of [
      { ...context, presentUserApproval: undefined },
      { ...context, presentUserApproval: { ...context.presentUserApproval!, decidingAccountId: 'another-person' } },
      { ...context, externalActionExecutionAuthorization: root },
    ]) expect(resolveExternalActionServerRequestHeaders({ ...request, context: changed })).toEqual({ ok: false });
    expect(resolveExternalActionServerRequestHeaders({ ...request, effectActionId: 'projects.sources.create' })).toEqual({ ok: false });
  });
});
