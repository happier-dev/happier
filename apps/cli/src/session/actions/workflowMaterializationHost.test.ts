import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
// Collect the real Session resolver graph before timing individual admission cases.
import '@/daemon/workflows/invocationRecoveryObserver';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, resolveRoleSelectionV1, materializeWorkflowAcceptedSnapshotV1, admitAgentStartV1, DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, WorkflowActionFailureV1Schema } from '@happier-dev/protocol';
import { createCredentialedWorkflowMaterializationHostV1, createWorkflowMaterializationHostV1, projectWorkflowConversationRoleSelection, type WorkflowMaterializationHostDeps } from './workflowMaterializationHost';
import { resolveWorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactReadBatchInputV1Schema, ArtifactReadBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { RoleArtifactV1Schema } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

const credentials = { token: 'workflow-session-admission', encryption: null } as const;
const sessionId = 'c123456789012345678901234';

function sessionAdmissionHost(machineId: string, readHostActionContract?: WorkflowMaterializationHostDeps['readHostActionContract'],
  readAcpCatalog?: WorkflowMaterializationHostDeps['readAcpCatalog'], nativeSignIn: 'unknown' | 'signedOut' = 'unknown') {
  // Only authenticated HTTP and daemon RPC are replaced; Session resolution,
  // owner-metadata opening, Machine authority and the materializer stay real.
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    expect(String(url).startsWith('http://127.0.0.1:41371/')).toBe(true);
    if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: {
      id: sessionId, seq: 0, createdAt: 0, updatedAt: 0, active: true, activeAt: 0,
      metadataVersion: 0, agentStateVersion: 0, agentState: null, dataEncryptionKey: null,
      encryptionMode: 'plain', metadata: JSON.stringify({ machineId, path: '/repo' }),
    } } };
    throw new Error(`unexpected_session_read:${url}`);
  });
  return createWorkflowMaterializationHostV1({
    credentials, serverId: 'workflow-home', serverIdentityId: 'srv_workflow_home', serverHttpBaseUrl: 'http://127.0.0.1:41371',
    readRoleSelection: async () => ({}), readLaunchProfile: async () => null,
    readWorkflowDefinition: async () => null,
    ...(readAcpCatalog ? { readAcpCatalog } : {}),
    readHostActionContract: readHostActionContract ?? (async () => ({ inputSchema: { type: 'object' }, outputSchema: {} })),
    callMachineAction: async ({ method }) => {
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
        protocolVersion: 1, projection: { v: 2, generation: 1, agentsById: { installed: {
          id: 'installed', identity: { pluginId: 'test.agent', localId: 'agent' },
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        }, 'custom-acp': {
          id: 'custom-acp', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } },
      };
      if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
        'cli.installed': { ok: true, data: { installed: true, version: '1', latestVersion: null,
          update: { supported: false, command: null }, signIn: { status: nativeSignIn, loginSupport: 'unsupported' },
          platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } },
      } };
      throw new Error('unexpected_machine_method');
    },
  });
}

describe('exact-machine workflow materialization effects', () => {
  it('preserves an exact Session read refusal rather than reporting an absent Session', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"not_authenticated"}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback server');
    try {
      const host = createWorkflowMaterializationHostV1({ credentials, serverId: 'workflow-home',
        serverHttpBaseUrl: `http://127.0.0.1:${address.port}`,
        readRoleSelection: async () => ({}), readLaunchProfile: async () => null,
        readWorkflowDefinition: async () => null, callMachineAction: async () => null,
      });
      const admission = await host({ machineId: 'run-machine', directory: '/repo' });
      await expect(admission.effects.resolveSessionTarget?.(sessionId)).rejects.toMatchObject({ code: 'not_authenticated' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each(['roster', 'capabilities', 'action-schema'] as const)(
    'preserves a failed %s transport observation rather than inventing target absence', async boundary => {
      const refused = new RpcError('Machine read refused', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE);
      const host = createWorkflowMaterializationHostV1({
        credentials, readRoleSelection: async () => ({}), readLaunchProfile: async () => null,
        readWorkflowDefinition: async () => null,
        callMachineAction: async ({ method }) => {
          if (boundary === 'roster') throw refused;
          if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
            protocolVersion: 1, projection: { v: 2, generation: 1, agentsById: {},
              actionsById: { 'test.action/invoke': { id: 'test.action/invoke', pluginId: 'test.action', occurrenceId: 'test-occurrence',
                title: 'Invoke', scopes: ['machine'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe' } } },
          };
          throw refused;
        },
      });
      const admission = await host({ machineId: 'run-machine', directory: '/repo' });
      if (boundary === 'action-schema' || boundary === 'roster') {
        await expect(admission.effects.readActionContract?.('test.action/invoke')).rejects.toBe(refused);
      } else {
        await expect(admission.effects.resolveTargetAvailability({
          blockId: 'writer', kind: 'step', selection: {
            agentTarget: { kind: 'agent', identity: { pluginId: 'test.agent', localId: 'agent' } },
          }, executionTarget: { kind: 'session' },
        }, { sessionIds: [] })).rejects.toBe(refused);
      }
    },
  );

  it('carries Session baseline selections into same-Machine Workflow leaves through the shared selection owner', () => {
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'test.agent', localId: 'agent' } };
    const connectedServices = { v: 2 as const, bindingsByServiceId: {
      'test.agent/auth': { source: 'connected' as const, selection: 'profile' as const, profileId: 'parent-account' },
    } };
    const origin = { sessionId, machineId: 'origin-machine', directory: '/repo', agentTarget,
      runtimeSelection: { agentTarget, profileId: 'parent-launch', connectedServices } };
    const selection = (machineId: string) => resolveWorkflowStepSelectionV1({ defaults: { engine: { agentTarget } },
      roleSelection: projectWorkflowConversationRoleSelection(origin, machineId) }).selection;
    expect(selection('origin-machine')).toMatchObject({ profileId: 'parent-launch', connectedServices });
    expect(selection('other-machine').profileId).toBeUndefined();
    expect(selection('other-machine').connectedServices).toBeUndefined();
  });

  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetInMemoryAccountSettingsContextForTests(); });

  it('reads only an explicitly consumed unfrozen Role without preparing the unrelated Artifact inventory', async () => {
    const accountId = 'workflow-role-demand';
    const scopedCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const roleId = 'selected-workflow-role';
    let instructions = 'Original Role instructions';
    let readable = true;
    const artifactReads: string[] = [];
    const storedRole = () => {
      const role = RoleArtifactV1Schema.parse({ name: 'Selected', instructions, runsAs: { kind: 'session' },
        engine: { agentTargetKey: 'agent:test.agent/agent' }, workspaceWrites: 'deny', enabled: true, secondOpinion: 'off' });
      return { id: roleId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        header: encodePlainArtifactStoredContent({ kind: 'role.v1', name: role.name }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(role) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    };
    const unrelated = Array.from({ length: 501 }, (_, index) => ({ ...storedRole(), id: `unrelated-${index}`,
      header: encodePlainArtifactStoredContent({ kind: 'document.v1', title: 'Unrelated document' }) }));
    // Only authenticated HTTP and daemon RPC are replaced. Settings, source
    // selection, Artifact opening, Role layering and materialization stay real.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const url = new URL(String(input));
      expect(url.origin).toBe('http://127.0.0.1:41371');
      if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (url.pathname === '/v1/account/entity-rows/prompt-library') return { status: 200, data: { status: 'listed',
        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
          content: { t: 'plain', v: emptyPromptLibraryRecordV1(key, 1) } })) } };
      if (url.pathname === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
      if (url.pathname === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (url.pathname === '/v1/artifacts') {
        artifactReads.push(url.pathname);
        const inventory = [...unrelated, storedRole()];
        const items = url.searchParams.has('cursor') ? inventory.slice(500) : inventory.slice(0, 500);
        return { status: 200, data: url.searchParams.has('kind') ? { items, hasUnclassified: false } : items };
      }
      if (url.pathname === `/v1/artifacts/${roleId}`) {
        artifactReads.push(url.pathname);
        return readable ? { status: 200, data: storedRole() } : { status: 403, data: { error: 'forbidden' } };
      }
      if (url.pathname === `/v1/artifacts/${roleId}/access/grants`) {
        artifactReads.push(url.pathname);
        return { status: 200, data: { artifactId: roleId, ownerAccountId: accountId, access: 'owner', grants: [] } };
      }
      if (url.pathname === `/v1/artifacts/${roleId}/access/recipients`) {
        artifactReads.push(url.pathname);
        return { status: 200, data: { artifactId: roleId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, callerDataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
          provenanceDataEncryptionKey: null, callerProvenanceDataEncryptionKey: null, recipients: [] } };
      }
      throw new Error(`Unexpected Workflow Role HTTP boundary: ${url.pathname}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
      const path = new URL(String(input)).pathname;
      expect(path).toBe('/v1/artifacts/read');
      artifactReads.push(path);
      return { status: 200, data: ArtifactReadBatchResponseV1Schema.parse({ items:
        ArtifactReadBatchInputV1Schema.parse(body).artifactIds.map(artifactId => ({ artifactId, ok: true,
          artifact: storedRole(), recipientCensus: null })) }) };
    });
    const resolve = createCredentialedWorkflowMaterializationHostV1({ credentials: scopedCredentials, accountId,
      serverHttpBaseUrl: 'http://127.0.0.1:41371', readWorkflowDefinition: async () => null,
      callMachineAction: async ({ method }) => {
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
          protocolVersion: 1, projection: { v: 2, generation: 1, agentsById: { installed: {
            id: 'installed', identity: { pluginId: 'test.agent', localId: 'agent' },
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          } } } };
        if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
          'cli.installed': { ok: true, data: { installed: true, version: '1', latestVersion: null,
            update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'unsupported' },
            platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } },
        } };
        throw new Error(`Unexpected Workflow machine boundary: ${method}`);
      },
    });
    const target = { machineId: 'run-machine', directory: '/repo' };
    const context = { source: { kind: 'inline' as const }, inputs: {}, machineId: target.machineId,
      executionTarget: { kind: 'session' as const },
      workspaceTarget: { project: { ...target, checkoutRootPath: target.directory } }, authorization: { principal: { kind: 'host' as const } } };
    const authored = { version: 1, defaults: {}, blocks: [{ kind: 'step', id: 'work',
      document: { text: 'Work', references: [], attachments: [] },
      execution: { agentTarget: { kind: 'agent', identity: { pluginId: 'test.agent', localId: 'agent' } } } }] };
    for (let index = 0; index < 3; index++) {
      expect(await materializeWorkflowAcceptedSnapshotV1({ ...await resolve(target), definition: authored,
        context, admission: { kind: 'user' } })).toMatchObject({ ok: true });
    }
    const host = await resolve(target);
    expect(artifactReads).toEqual([]);
    instructions = 'Freshly updated before first use';
    const withRole = { ...authored, blocks: [{ ...authored.blocks[0], execution: { engine: { role: roleId } } }] };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ ...host, definition: withRole, context, admission: { kind: 'user' } });
    expect(accepted).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ role: { roleId, instructions } }] } });
    expect(artifactReads.filter(path => path === `/v1/artifacts/${roleId}`)).toHaveLength(1);
    expect(artifactReads).not.toContain('/v1/artifacts');
    expect(artifactReads).not.toContain('/v1/artifacts/read');
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
    const acceptedReads = [...artifactReads];
    readable = false;
    const replay = await materializeWorkflowAcceptedSnapshotV1({ ...await resolve(target), definition: withRole, context,
      replay: { snapshot: accepted.snapshot }, admission: { kind: 'user' } });
    expect(replay).toMatchObject({ ok: true, snapshot: { materializedLeaves: accepted.snapshot.materializedLeaves } });
    expect(artifactReads).toEqual(acceptedReads);
    await expect(materializeWorkflowAcceptedSnapshotV1({ ...await resolve(target), definition: withRole, context,
      admission: { kind: 'user' } })).rejects.toMatchObject({ response: { status: 403 } });
    expect(artifactReads.filter(path => path === `/v1/artifacts/${roleId}`)).toHaveLength(2);
    const controller = new AbortController();
    const cancelledHost = await resolve({ ...target, signal: controller.signal });
    const cancelled = new Error('Workflow Role demand cancelled');
    controller.abort(cancelled);
    await expect(materializeWorkflowAcceptedSnapshotV1({ ...cancelledHost, definition: withRole, context,
      admission: { kind: 'user' } })).rejects.toBe(cancelled);
    expect(artifactReads.filter(path => path === `/v1/artifacts/${roleId}`)).toHaveLength(2);
  });

  it('resolves typed Session inputs from exact authorized metadata rather than the coordinator Machine', async () => {
    const host = sessionAdmissionHost('review-machine');
    const admission = await host({ machineId: 'coordinator-machine', directory: '/repo' });
    const resolve = admission.effects.resolveSessionTarget;
    expect(await resolve?.(sessionId)).toEqual({
      address: { serverId: 'srv_workflow_home', sessionId }, machineId: 'review-machine',
    });
    // Repeated references in this admission share its authorized observation;
    // replay constructs a fresh host rather than retaining this observation.
    vi.mocked(axios.get).mockRejectedValue(new Error('later_session_observation_unavailable'));
    expect(await resolve?.({ serverId: 'workflow-home', sessionId })).toEqual({
      address: { serverId: 'workflow-home', sessionId }, machineId: 'review-machine',
    });
    expect(await resolve?.({ serverId: 'foreign-home', sessionId })).toBeNull();
  });

  it('refuses a typed Session input when its exact identity or authoritative Machine is unavailable', async () => {
    const host = sessionAdmissionHost('');
    const admission = await host({ machineId: 'coordinator-machine', directory: '/repo' });
    expect(await admission.effects.resolveSessionTarget?.({ serverId: 'srv_workflow_home', sessionId })).toBeNull();
    // Even a successful exact-detail transport cannot substitute a record with a different ID.
    sessionAdmissionHost('review-machine');
    const read = vi.mocked(axios.get).getMockImplementation()!;
    const prefix = 'c123456789012345';
    vi.mocked(axios.get).mockImplementation((url, config) => read(String(url).replace(prefix, sessionId), config));
    expect(await admission.effects.resolveSessionTarget?.({ serverId: 'srv_workflow_home', sessionId: prefix })).toBeNull();
  });

  it('admits the full accepted model target on its Run Machine and refuses a foreign Home or Machine', async () => {
    const admission = await sessionAdmissionHost('run-machine')({ machineId: 'run-machine', directory: '/repo' });
    const launch = { executionTarget: { serverId: 'srv_workflow_home', machineId: 'run-machine' },
      directory: { kind: 'path' as const, path: '/review' },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'test.agent', localId: 'agent' } },
      configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: null, updatedAtMs: 0 }, options: {} },
      connectedServices: { v: 2 as const, bindingsByServiceId: {} },
    };
    const leaf = { blockId: 'participant', selection: {}, executionTarget: { kind: 'session' as const },
      participant: { kind: 'model' as const, launch } };
    await expect(admission.effects.resolveTargetAvailability(leaf, { sessionIds: [] })).resolves.toBe(true);
    await expect(admission.effects.resolveTargetAvailability({ ...leaf,
      participant: { kind: 'model', launch: { ...launch, executionTarget: { ...launch.executionTarget,
        machineId: 'replacement-machine' } } } }, { sessionIds: [] }))
      .resolves.toMatchObject({ reason: 'selection_unavailable' });
    await expect(admission.effects.resolveTargetAvailability({ ...leaf,
      participant: { kind: 'model', launch: { ...launch, executionTarget: { ...launch.executionTarget,
        serverId: 'foreign-home' } } } }, { sessionIds: [] }))
      .resolves.toMatchObject({ reason: 'selection_unavailable' });
  });

  it.each([true, false])('admits a contributed Session input through production materialization (context default: %s)', async (contextDefault) => {
    const ownerMachine = contextDefault ? 'run-machine' : 'review-machine';
    const selectedHome = contextDefault ? 'srv_workflow_home' : 'workflow-home';
    const host = sessionAdmissionHost(ownerMachine);
    const admitted = await materializeWorkflowAcceptedSnapshotV1({
      ...await host({ machineId: 'run-machine', directory: '/repo' }), admission: { kind: 'user' },
      definition: { version: 1, inputs: [{ name: 'source', valueType: 'json', required: true,
        defaultFrom: 'origin_session', inputType: { hostType: 'session' } }],
        defaults: { conversation: { kind: 'input', name: 'source' } },
        blocks: [{ kind: 'step', id: 'continue', document: { text: 'Continue', references: [], attachments: [] } }] },
      context: { source: { kind: 'catalog', ref: 'plugin:test.workflow/source', version: 1 },
        inputs: contextDefault ? {} : { source: { serverId: selectedHome, sessionId } }, machineId: 'run-machine',
        executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'run-machine', directory: '/repo', checkoutRootPath: '/repo' } },
        ...(contextDefault ? { origin: { kind: 'direct' as const, originSessionId: sessionId } } : {}),
        authorization: { principal: { kind: 'host' } } },
    });
    expect(admitted).toMatchObject({ ok: true, snapshot: {
      inputs: { source: { serverId: selectedHome, sessionId } },
      materializedLeaves: [{ selection: { conversation: { kind: 'existing_session', sessionId, machineId: ownerMachine } } }],
    } });
  });

  it('keeps a connected authentication override on admission and replay despite native sign-out', async () => {
    const connectedServices = { v: 2 as const, bindingsByServiceId: {
      'test.agent/auth': { source: 'connected' as const, selection: 'profile' as const, profileId: 'step-profile' },
    } };
    const definition = { version: 1, defaults: { agentTarget: { kind: 'agent' as const,
      identity: { pluginId: 'test.agent', localId: 'agent' } }, connectedServices: { v: 2 as const, bindingsByServiceId: {
        'test.agent/auth': { source: 'connected' as const, selection: 'group' as const, groupId: 'workflow-pool' },
      } } }, blocks: [{ kind: 'step' as const, id: 'reply', document: { text: 'Reply', references: [], attachments: [] },
        execution: { connectedServices } }] };
    const context = { source: { kind: 'inline' as const }, inputs: {}, machineId: 'run-machine',
      executionTarget: { kind: 'session' as const },
      workspaceTarget: { project: { machineId: 'run-machine', directory: '/repo', checkoutRootPath: '/repo' } },
      authorization: { principal: { kind: 'host' as const } } };
    const host = sessionAdmissionHost('run-machine', undefined, undefined, 'signedOut');
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ ...await host({ machineId: 'run-machine', directory: '/repo' }),
      definition, context, admission: { kind: 'user' } });
    expect(accepted).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ selection: { connectedServices } }] } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted));
    const replay = await materializeWorkflowAcceptedSnapshotV1({ ...await host({ machineId: 'run-machine', directory: '/repo' }),
      definition, context, replay: { snapshot: accepted.snapshot }, admission: { kind: 'user' } });
    expect(replay).toMatchObject({ ok: true, snapshot: { materializedLeaves: [{ selection: { connectedServices } }] } });
  });

  it('preserves the failed Agent observation through materialization and the Workflow Action refusal', async () => {
    const host = createWorkflowMaterializationHostV1({
      credentials, readRoleSelection: async () => ({}), readLaunchProfile: async () => null,
      readWorkflowDefinition: async () => null,
      callMachineAction: async ({ method }) => method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
        ? { protocolVersion: 1, projection: { v: 2, generation: 1, agentsById: { claude: {
          id: 'claude', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } } }
        : { protocolVersion: 1, results: { 'cli.claude': { ok: false, error: { code: 'cli-detection-failed', message: 'private diagnostics' } } } },
    });
    const context = await host({ machineId: 'run-machine', directory: '/repo' });
    const result = await materializeWorkflowAcceptedSnapshotV1({ ...context, admission: { kind: 'user' },
      definition: { version: 1, defaults: {}, blocks: [{ kind: 'step', id: 'writer', document: { text: 'reply', references: [], attachments: [] },
        execution: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } }] },
      context: { source: { kind: 'inline' }, inputs: {}, machineId: 'run-machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'run-machine', directory: '/repo', checkoutRootPath: '/repo' } },
        authorization: { principal: { kind: 'host' } } },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'target_unavailable', blockId: 'writer',
      reason: 'agent_probe_failed', agentId: 'claude', errorCode: 'cli-detection-failed' } });
    if (result.ok) throw new Error('Expected a pre-effect refusal');
    expect(WorkflowActionFailureV1Schema.parse({ ok: false, errorCode: result.error.code, error: result.error.code, details: result.error }))
      .toMatchObject({ details: { reason: 'agent_probe_failed', agentId: 'claude', errorCode: 'cli-detection-failed' } });
  });

  it('freezes one Action catalog observation per admission, but rechecks availability on replay', async () => {
    const contract = { inputSchema: { type: 'object' }, outputSchema: { type: 'string' } };
    let observed = false;
    // The executing machine's catalog transport yields one observation; a
    // redundant fetch would no longer be available. No domain logic is mocked.
    const host = sessionAdmissionHost('run-machine', async () => {
      if (observed) return null;
      observed = true;
      return contract;
    });
    const definition = { version: 1, defaults: {}, blocks: [
      { kind: 'action', id: 'first', actionId: 'notify_me', input: {} },
      { kind: 'action', id: 'second', actionId: 'notify_me', input: {} },
    ] };
    const context = { source: { kind: 'inline' as const }, inputs: {}, machineId: 'run-machine',
      executionTarget: { kind: 'session' as const },
      workspaceTarget: { project: { machineId: 'run-machine', directory: '/repo', checkoutRootPath: '/repo' } },
      authorization: { principal: { kind: 'host' as const } } };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ ...await host({ machineId: 'run-machine', directory: '/repo' }),
      definition, context, admission: { kind: 'user' } });
    expect(accepted).toMatchObject({ ok: true, snapshot: { materializedLeaves: [
      { actionContract: contract }, { actionContract: contract },
    ] } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted));

    const unavailableHost = sessionAdmissionHost('run-machine', async () => null);
    const replay = await materializeWorkflowAcceptedSnapshotV1({
      ...await unavailableHost({ machineId: 'run-machine', directory: '/repo' }),
      definition, context, replay: { snapshot: accepted.snapshot }, admission: { kind: 'user' },
    });
    expect(replay).toMatchObject({ ok: false, error: { code: 'target_unavailable' } });
  });

  it.each(['origin_session', 'existing_session', 'existing_session_with_agent', 'session_context', 'origin_session_id', 'condition', 'default_origin'] as const)
    ('refuses a cross-Machine %s before the accepted program can run its earlier Action', async (reference) => {
      const host = sessionAdmissionHost('other-machine');
      const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'test.agent', localId: 'agent' } };
      const leaf = reference === 'origin_session_id' || reference === 'default_origin'
        ? { kind: 'action', id: 'bound', actionId: 'session.goal.set', input: reference === 'origin_session_id'
          ? { sessionId: { kind: 'origin_session_id' } } : {} }
        : reference === 'condition'
          ? { kind: 'if', id: 'condition', when: { kind: 'exists', value: { kind: 'session_context_field', field: 'goal.tokenBudget' } },
              then: [{ kind: 'wait', id: 'held', document: { text: 'Wait', references: [], attachments: [] } }], otherwise: [] }
          : { kind: 'step', id: 'bound', document: { text: 'Continue', references: [], attachments: [] }, input: reference === 'session_context'
              ? [{ kind: 'session_context', recentTurns: 0 }] : [],
            execution: { ...(reference === 'session_context' || reference === 'existing_session_with_agent' ? { agentTarget } : {}),
              ...(reference === 'session_context' ? {} : { conversation: reference === 'origin_session' ? { kind: 'origin_session' }
                : { kind: 'existing_session', sessionId, machineId: 'run-machine' } }) } };
      const effect = vi.fn();
      await runWithServerHttpBaseUrl('http://127.0.0.1:41371', async () => {
        const materialization = await host({ machineId: 'run-machine', directory: '/repo' });
        const accepted = await materializeWorkflowAcceptedSnapshotV1({ ...materialization,
          definition: { version: 1, inputs: [], defaults: {}, blocks: [
            { kind: 'action', id: 'earlier', actionId: 'notify_me', input: {} }, leaf,
          ] }, admission: { kind: 'user' }, context: { source: { kind: 'inline' }, inputs: {},
            machineId: 'run-machine', executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId: 'run-machine', directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct', originSessionId: sessionId }, authorization: { principal: { kind: 'host' } } },
        });
        if (accepted.ok) effect();
        expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: false, error: { code: 'target_unavailable' } });
        expect(effect).not.toHaveBeenCalled();
      });
    });

  it.each([
    { source: 'direct', ownerMachine: 'run-machine', available: true },
    { source: 'trigger', ownerMachine: 'run-machine', available: true },
    { source: 'trigger', ownerMachine: 'other-machine', available: false },
  ] as const)('checks $source retained Session Machine authority: $available', async ({ source, ownerMachine, available }) => {
    const host = sessionAdmissionHost(ownerMachine);
    const context = await host({ machineId: 'run-machine', directory: '/repo' });
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'uninstalled.agent', localId: 'agent' } };
    const admitted = await materializeWorkflowAcceptedSnapshotV1({ ...context,
      definition: { version: 1, defaults: {}, blocks: [{ kind: 'step', id: 'bound',
        document: { text: 'Continue', references: [], attachments: [] },
        execution: { agentTarget, conversation: { kind: 'existing_session', sessionId, machineId: 'run-machine' } },
      }] }, context: { source: source === 'direct' ? { kind: 'inline' } : { kind: 'automation', automationId: 'automation' },
        inputs: {}, machineId: 'run-machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'run-machine', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', originSessionId: sessionId }, authorization: { principal: { kind: 'host' } } },
      admission: source === 'direct' ? { kind: 'user' } : { kind: 'trigger', workDepth: 0,
        admitLeaf: async (leaf) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, {
          caller: { kind: 'originless', runId: 'run', runDepth: 0, runOriginSessionId: sessionId },
          baseline: { machineId: 'run-machine', directory: '/repo', configuration: { agentTarget, permissionMode: 'default' } },
          callerPermissionCeiling: 'yolo', workDepthLimit: 8, roles: {}, ledSubtreeSessionIds: [],
        }) },
    });
    expect(admitted, JSON.stringify(admitted)).toMatchObject(available ? { ok: true } : { ok: false, error: { code: 'target_unavailable' } });
    const sessionReads = vi.mocked(axios.get).mock.calls.filter(([url]) => String(url).endsWith(`/v2/sessions/${sessionId}`));
    expect(sessionReads).toHaveLength(1);
  });

  it('checks the supplied Action default origin and preserves cancellation from the Session read', async () => {
    const host = sessionAdmissionHost('other-machine');
    const controller = new AbortController();
    const aborted = new Error('session_admission_aborted');
    vi.mocked(axios.get).mockImplementation(async () => { controller.abort(aborted); throw aborted; });
    const context = await host({ machineId: 'run-machine', directory: '/repo', signal: controller.signal });
    await expect(materializeWorkflowAcceptedSnapshotV1({ ...context,
      definition: { version: 1, defaults: {}, blocks: [{ kind: 'action', id: 'notify', actionId: 'notify_me', input: {} }] },
      context: { source: { kind: 'inline' }, inputs: {}, machineId: 'run-machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'run-machine', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', originSessionId: sessionId }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' },
    })).rejects.toBe(aborted);
  });

  it('does not admit with invented policy defaults when Account settings are unavailable', async () => {
    resetInMemoryAccountSettingsContextForTests();
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    // The HTTP transport is unavailable; the real settings owner must not be
    // replaced by the caller's environment opt-out or a factory-local policy.
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('account_settings_network_unavailable'));
    const resolve = createCredentialedWorkflowMaterializationHostV1({
      credentials: { token: 'unavailable-workflow-account', encryption: null },
      serverHttpBaseUrl: 'http://127.0.0.1:41371',
      readWorkflowDefinition: async () => null, callMachineAction: async () => { throw new Error('must_not_probe_unadmitted_account'); },
    });
    await expect(resolve({ machineId: 'run-machine', directory: '/repo' })).rejects.toMatchObject({ code: 'source_unavailable' });
  });
  it.each([true, false])('uses native run machine readiness despite unavailable optional ACP authority: %s', async (detachedAvailable) => {
    const calls: string[] = [];
    const resolve = createWorkflowMaterializationHostV1({
      credentials,
      readRoleSelection: async () => ({}), readLaunchProfile: async () => null, readWorkflowDefinition: async () => null,
      // The real catalog refresh returns an unavailable snapshot on a failed
      // resource read, rather than rejecting or returning no reader at all.
      readAcpCatalog: async () => ({ status: 'unavailable', reason: 'unreachable' }),
      callMachineAction: async ({ machineId, method }) => {
        expect(machineId).toBe('run-machine');
        calls.push(method);
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
          protocolVersion: 1, projection: { v: 2, generation: 3, agentsById: { installed: {
            id: 'installed', identity: { pluginId: 'test.agent', localId: 'agent' }, catalogAgentId: 'installed',
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          }, nativeOnly: {
            id: 'nativeOnly', identity: { pluginId: 'native.agent', localId: 'agent' }, catalogAgentId: 'nativeOnly',
            capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } },
          }, 'custom-acp': {
            id: 'custom-acp', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          } } },
        };
        if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
          'cli.installed': { ok: true, data: { installed: true, version: '1', latestVersion: null,
            update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'unsupported' },
            platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } },
          'tool.executionRuns': { ok: true, data: { available: detachedAvailable, features: { detachedScope: true }, backends: { installed: { available: true }, nativeOnly: { available: true } } } },
        } };
        throw new Error('unexpected_machine_method');
      },
    });
    const context = await resolve({ machineId: 'run-machine', directory: '/repo', roleSelection: async () => ({
      defaultEngine: { agentTargetKey: 'agent:native.agent/agent', modelId: 'caller-model' },
    }) });
    // Catalog effects occur in the materializer's availability phase, after policy.
    const ambient = await context.effects.readRoleSelection?.();
    const secondOpinion = resolveRoleSelectionV1({ ...ambient, roleId: 'second_opinion' });
    expect(secondOpinion).toMatchObject({ ok: true, selection: { engine: { agentTargetKey: 'agent:test.agent/agent' } } });
    if (secondOpinion.ok) expect(secondOpinion.selection.engine?.modelId).toBeUndefined();
    const leaf = { blockId: 'work', selection: { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'test.agent', localId: 'agent' } } } };
    await expect(context.effects.resolveTargetAvailability({ ...leaf, executionTarget: { kind: 'session' } }, { sessionIds: [] })).resolves.toBe(true);
    expect(await context.effects.resolveTargetAvailability({ ...leaf, executionTarget: { kind: 'detached_run' } }, { sessionIds: [] }))
      .toEqual(detachedAvailable ? true : { code: 'target_unavailable', reason: 'detached_execution_unavailable', agentId: 'installed' });
    const nativeLeaf = { ...leaf, selection: { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'native.agent', localId: 'agent' } } } };
    await expect(context.effects.resolveTargetAvailability({ ...nativeLeaf, executionTarget: { kind: 'session' } }, { sessionIds: [] })).resolves.toMatchObject({ reason: 'session_creation_unavailable', agentId: 'nativeOnly' });
    expect(await context.effects.resolveTargetAvailability({ ...nativeLeaf, executionTarget: { kind: 'detached_run' } }, { sessionIds: [] }))
      .toEqual(detachedAvailable ? true : { code: 'target_unavailable', reason: 'detached_execution_unavailable', agentId: 'nativeOnly' });
    for (const kind of ['session', 'detached_run'] as const) {
      await expect(context.effects.resolveTargetAvailability({ blockId: 'configured', executionTarget: { kind },
        selection: { agentTarget: { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'selected' } },
      }, { sessionIds: [] })).rejects.toMatchObject({ code: 'ACP_CATALOG_UNAVAILABLE' });
    }
    await expect(context.effects.resolveTargetAvailability({ ...leaf, selection: { agentTarget: { kind: 'agent', identity: { pluginId: 'relay.agent', localId: 'agent' } } }, executionTarget: { kind: 'session' } }, { sessionIds: [] })).resolves.toMatchObject({ reason: 'selection_unavailable' });
    // Projected Action starts are not retained-Session steps, even when their
    // ambient selection names a Session already checked by the materializer.
    await expect(context.effects.resolveTargetAvailability({ ...leaf, selection: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'uninstalled.agent', localId: 'agent' } },
      conversation: { kind: 'existing_session', sessionId, machineId: 'run-machine' },
    }, executionTarget: { kind: 'session' } }, { sessionIds: [] })).resolves.toMatchObject({ reason: 'selection_unavailable' });
    expect(calls).toEqual([RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, RPC_METHODS.CAPABILITIES_DETECT]);
  });

  it('admits only the selected concrete Custom ACP definition from the Account catalog', async () => {
    const identity = CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1;
    const resolve = createWorkflowMaterializationHostV1({
      credentials,
      acpCatalogSnapshot: { status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({ v: 1,
        definitions: [{ id: 'selected', name: 'selected', title: 'Selected', launch: { kind: 'command' as const, command: 'selected', args: [] }, createdAt: 1, updatedAt: 1 }],
      }) },
      readRoleSelection: async () => ({}), readLaunchProfile: async () => null, readWorkflowDefinition: async () => null,
      callMachineAction: async ({ method }) => method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
        ? { protocolVersion: 1, projection: { v: 2, generation: 1, agentsById: { 'custom-acp': {
          id: 'custom-acp', identity, capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } } }
        : { protocolVersion: 1, results: {
          'cli.custom-acp': { ok: true, data: { installed: false, version: null, latestVersion: null,
            update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'unsupported' },
            platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } },
          'tool.executionRuns': { ok: true, data: { available: true, features: { detachedScope: true }, backends: {
            'agent:happier.agent.custom-acp/custom-acp:definition:selected': { available: true },
          } } },
        } },
    });
    const context = await resolve({ machineId: 'run-machine', directory: '/repo' });
    for (const kind of ['session', 'detached_run'] as const) {
      await expect(context.effects.resolveTargetAvailability({ blockId: 'work', executionTarget: { kind },
        selection: { agentTarget: { kind: 'agent', identity, definitionId: 'selected' } },
      }, { sessionIds: [] })).resolves.toBe(true);
      await expect(context.effects.resolveTargetAvailability({ blockId: 'work', executionTarget: { kind },
        selection: { agentTarget: { kind: 'agent', identity, definitionId: 'deleted' } },
      }, { sessionIds: [] })).resolves.toMatchObject({ reason: 'selection_unavailable' });
    }
  });

  it('admits a native Agent without demanding unavailable ACP authority', async () => {
    const host = sessionAdmissionHost('run-machine', undefined, async () => {
      throw new Error('acp_catalog_unavailable');
    });
    const context = await host({ machineId: 'run-machine', directory: '/repo' });
    await expect(context.effects.resolveTargetAvailability({ blockId: 'native', executionTarget: { kind: 'session' },
      selection: { agentTarget: { kind: 'agent', identity: { pluginId: 'test.agent', localId: 'agent' } } },
    }, { sessionIds: [] })).resolves.toBe(true);
  });

  it.each(['source_retired', 'reader_aborted', 'snapshot_aborted'] as const)
    ('preserves contextual ACP admission failure: %s', async (failure) => {
      const controller = new AbortController();
      const retired = Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
      const aborted = new Error('workflow_catalog_aborted');
      const host = sessionAdmissionHost('run-machine', undefined, async () => {
        if (failure === 'source_retired') throw retired;
        controller.abort(aborted);
        if (failure === 'reader_aborted') throw aborted;
        return { status: 'unavailable', reason: 'cancelled' };
      });
      const context = await host({ machineId: 'run-machine', directory: '/repo', signal: controller.signal,
        roleSelection: { defaultEngine: { agentTargetKey: 'agent:test.agent/agent' } },
      });
      await expect(context.effects.readRoleSelection?.()).rejects.toBe(failure === 'source_retired' ? retired : aborted);
    });

  it('preserves a failed Machine observation at the leaf boundary', async () => {
    const resolve = createWorkflowMaterializationHostV1({
      credentials,
      readRoleSelection: async () => ({}), readLaunchProfile: async () => null, readWorkflowDefinition: async () => null,
      callMachineAction: async () => { throw new Error('machine_offline'); },
    });
    const context = await resolve({ machineId: 'offline-machine', directory: '/repo' });
    await expect(context.effects.resolveTargetAvailability({ blockId: 'work', selection: { agentTarget: { kind: 'agent', identity: { pluginId: 'test.agent', localId: 'agent' } } }, executionTarget: { kind: 'session' } }, { sessionIds: [] })).rejects.toThrow('machine_offline');
  });

  it.each(['schema_rejected', 'schema_malformed', 'core_rejected', 'schema_aborted', 'core_aborted'])
    ('distinguishes a malformed Action contract from failed or cancelled reads: %s', async (failure) => {
      const controller = new AbortController();
      const aborted = new Error('caller_aborted_action_schema_read');
      const actionId = failure.startsWith('core_') ? 'session.inspect' : 'test.action/check';
      const roster = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        protocolVersion: 1, projection: { v: 2, generation: 1, actionsById: {
          'test.action/check': { id: 'test.action/check', pluginId: 'test.action', occurrenceId: 'action-occurrence',
            title: 'Check', scopes: ['machine'], surfaces: ['cli'], execution: { target: 'daemon' }, dangerLevel: 'safe' },
        } },
      });
      const unavailable = () => {
        if (failure.endsWith('aborted')) { controller.abort(aborted); throw aborted; }
        throw new Error('action_contract_transport_unavailable');
      };
      const resolve = createWorkflowMaterializationHostV1({
        credentials,
        readRoleSelection: async () => ({}), readLaunchProfile: async () => null, readWorkflowDefinition: async () => null,
        readHostActionContract: async () => unavailable(),
        callMachineAction: async ({ method }) => {
          if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return roster;
          if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {} };
          if (method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
            return failure === 'schema_malformed' ? { ok: true, inputSchema: 'not_a_schema' } : unavailable();
          }
          throw new Error('unexpected_machine_method');
        },
      });
      const context = await resolve({ machineId: 'run-machine', directory: '/repo', signal: controller.signal });
      const result = context.effects.readActionContract!(actionId);
      if (failure.endsWith('aborted')) await expect(result).rejects.toBe(aborted);
      else if (failure === 'schema_malformed') await expect(result).resolves.toBeNull();
      else await expect(result).rejects.toThrow('action_contract_transport_unavailable');
    });
});
