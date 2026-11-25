import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { accountSettingsParse, getActionSpec, ProjectWorkerActionInputSchemasV1, ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineBootstrapV1Schema,
  ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol';
import { bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createExternalMcpServer } from './createExternalMcpServer';

// Home HTTP is the boundary. Standalone exposure, Machine Action admission
// and validation of the receiver's result run through the production owners.
afterEach(() => {
  vi.restoreAllMocks();
  resetActiveAccountSettingsSnapshotForTests();
});

function enableNamedWorkerTools(token: string) {
  const rawSettings = { actionsSettingsV1: { v: 1, actions: {
    'projects.worker.status': { toolExposureModes: { mcp: 'direct' } },
    'projects.worker.copy.inspect': { toolExposureModes: { mcp: 'direct' } },
  } } };
  setActiveAccountSettingsSnapshot({ scopeKey: resolveAccountSettingsScopeKeyForToken(token), source: 'network',
    settingsVersion: 1, settings: accountSettingsParse(rawSettings), rawSettings, settingsSecretsReadKeys: [], loadedAtMs: 1 });
}

function readToolValue(result: ReturnType<typeof CallToolResultSchema.parse>): unknown {
  const content = result.content.find(entry => entry.type === 'text');
  if (!content || content.type !== 'text') throw new Error('Missing MCP Action result');
  return JSON.parse(content.text);
}

function workerPublication(id: string) {
  return ExternalActionMachineBootstrapV1Schema.parse({ id, installationId: `${id}-installation`,
    kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
    access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
}

describe('standalone MCP worker Action composition', () => {

  it('settles a missing Home identity as a typed admission refusal', async () => {
    const serverId = configuration.activeServerId;
    const serverHttpBaseUrl = 'https://standalone-worker-mcp-refusal.test';
    const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url') + '.signature';
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' } as const;
    enableNamedWorkerTools(token);
    const status = ProjectWorkerActionInputSchemasV1['projects.worker.status'].parse({
      workspace: { serverId, refId: 'checkout' }, destination: { kind: 'machine', machineId: 'worker' }, purpose: 'finite',
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url === `${serverHttpBaseUrl}/v1/account/encryption`) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      expect(url).toBe(`${serverHttpBaseUrl}/v1/machines/worker`);
      return { status: 200, data: { machine: workerPublication('worker') } };
    });
    const post = vi.spyOn(axios, 'post');
    const { mcp } = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createExternalMcpServer({ credentials, machineId: 'source' }));
    const client = new Client({ name: 'standalone-worker-no-home-identity-test', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const unavailable = CallToolResultSchema.parse(await client.callTool({ name: 'projects_worker_status', arguments: status }));
      expect(unavailable.isError).toBe(true);
      expect(readToolValue(unavailable)).toMatchObject({
        errorCode: 'admission_unavailable', error: 'admission_unavailable',
      });
      expect(post).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it('keeps named and generic Machine status tools alongside Sync inspection and Account preferences', async () => {
    const serverId = configuration.activeServerId;
    const serverHttpBaseUrl = 'https://standalone-worker-mcp.test';
    const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url') + '.signature';
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' } as const;
    enableNamedWorkerTools(token);
    const example = ProjectWorkerActionInputSchemasV1['projects.worker.copy.inspect'].parse(
      JSON.parse(getActionSpec('projects.worker.copy.inspect').examples!.voice!.argsExample!),
    );
    const workspace = { ...example.workspace, serverId };
    const inspect = { ...example, workspace };
    const preview = { ok: true, preview: { targetMachineId: inspect.targetMachineId,
      workspaceRefId: inspect.targetWorkspaceRefId, rootFingerprint: 'd'.repeat(64), sizeBytes: 24 } };
    const status = ProjectWorkerActionInputSchemasV1['projects.worker.status'].parse({
      workspace, destination: { kind: 'machine', machineId: 'worker' }, purpose: 'finite',
    });
    const statusResult = { eligible: true, candidate: { serverId, machineId: 'worker' },
      load: { kind: 'unknown' }, explanation: 'load_unknown' };
    const serverIdentityId = 'srv_standalone-worker-home';
    let statusResponse: unknown = statusResult;
    let credentialRevoked = false;
    let statusFailure: { ok: false; errorCode: string; error: string } | null = null;
    let inspectionFailure: { ok: false; errorCode: string; error: string } | null = null;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url === `${serverHttpBaseUrl}/v1/account/encryption`) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      const machineId = url === `${serverHttpBaseUrl}/v1/machines/worker` ? 'worker' : inspect.machineId;
      expect(url).toBe(`${serverHttpBaseUrl}/v1/machines/${machineId}`);
      return { status: 200, data: { machine: workerPublication(machineId) } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
      const statusAction = url === `${serverHttpBaseUrl}/v1/actions/projects.worker.status`
        || url === `${serverHttpBaseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1('projects.worker.status')}`;
      const actionId = statusAction ? 'projects.worker.status' : 'projects.worker.copy.inspect';
      const machineId = statusAction ? 'worker' : inspect.machineId;
      expect(request.machineId).toBe(machineId);
      expect(envelope.target).toEqual({ kind: 'machine', machineId });
      expect(envelope.input).toEqual(statusAction ? status : inspect);
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-worker-read', binding: {
        accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 },
        serverIdentityId, machineId, installationId: workerPublication(machineId).installationId,
        accountEncryptionMode: 'plain', actionId, requestId: envelope.requestId,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target,
      } });
      if (url === `${serverHttpBaseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`) {
        return credentialRevoked
          ? { status: 401, data: { error: 'invalid_token' } }
          : { status: 200, data: authorization };
      }
      expect(url).toBe(`${serverHttpBaseUrl}/v1/actions/${actionId}`);
      expect(request.executionAuthorization).toEqual(authorization);
      return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1,
        actionId, requestId: envelope.requestId, execution: (statusAction ? statusFailure : inspectionFailure)
          ?? { ok: true, result: statusAction ? statusResponse : preview } }) };
    });
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      if (config.url === `${serverHttpBaseUrl}/v1/account/encryption`) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      expect(config.url).toBe(`${serverHttpBaseUrl}/v1/projects/execution/config/read`);
      expect(config.data).toEqual({ address: workspace });
      return { status: 200, data: { status: 'absent' } };
    });
    const serverFeaturesSnapshot = { status: 'ready' as const, provenance: 'authenticated' as const,
      features: FeaturesResponseSchema.parse({ features: {},
        capabilities: { serverIdentity: { serverIdentityId } } }) };
    const { mcp, toolNames } = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createExternalMcpServer({
      credentials, machineId: 'source', serverFeaturesSnapshot,
    }));
    const client = new Client({ name: 'standalone-worker-test', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const invoke = async (actionId: string, input: unknown) => {
      const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
      return { isError: result.isError === true, value: readToolValue(result) };
    };
    try {
      expect(toolNames).toContain('projects_worker_status');
      const namedStatus = CallToolResultSchema.parse(await client.callTool({ name: 'projects_worker_status', arguments: status }));
      expect(namedStatus.isError, JSON.stringify(namedStatus)).not.toBe(true);
      expect(namedStatus.structuredContent).toEqual(statusResult);
      expect(await invoke('projects.worker.status', status)).toEqual({ isError: false, value: statusResult });
      expect(await invoke('projects.worker.copy.inspect', inspect)).toEqual({ isError: false, value: preview });
      expect(await invoke('projects.worker.preferences.get', { workspace }))
        .toMatchObject({ isError: false, value: { status: 'ready', revision: 'absent' } });
      statusResponse = { ...statusResult, candidate: { serverId, machineId: 'another-worker' } };
      expect(await invoke('projects.worker.status', status))
        .toMatchObject({ isError: true, value: { errorCode: 'invalid_action_output' } });
      statusFailure = { ok: false, errorCode: 'target_unavailable', error: 'Worker admission is unavailable' };
      const namedFailure = CallToolResultSchema.parse(await client.callTool({ name: 'projects_worker_status', arguments: status }));
      expect(namedFailure.isError).toBe(true);
      const statusRefusal = { errorCode: statusFailure.errorCode, error: statusFailure.error };
      expect(readToolValue(namedFailure)).toMatchObject(statusRefusal);
      expect(await invoke('projects.worker.status', status)).toMatchObject({ isError: true, value: statusRefusal });
      inspectionFailure = { ok: false, errorCode: 'MACHINE_RPC_TIMEOUT', error: 'Machine RPC call timeout' };
      const inspectionRefusal = { errorCode: inspectionFailure.errorCode, error: inspectionFailure.error };
      const timedOut = CallToolResultSchema.parse(await client.callTool({ name: 'projects_worker_copy_inspect', arguments: inspect }));
      expect(timedOut.isError).toBe(true);
      expect(readToolValue(timedOut)).toMatchObject(inspectionRefusal);
      expect(await invoke('projects.worker.copy.inspect', inspect)).toMatchObject({ isError: true, value: inspectionRefusal });
      statusFailure = null;
      statusResponse = statusResult;
      credentialRevoked = true;
      vi.mocked(axios.post).mockClear();
      expect(await invoke('projects.worker.status', status)).toMatchObject({
        isError: true, value: { errorCode: 'invalid_token' },
      });
      expect(vi.mocked(axios.post).mock.calls.map(([url]) => url))
        .toEqual([`${serverHttpBaseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1('projects.worker.status')}`]);
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
