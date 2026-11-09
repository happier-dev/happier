import type { AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol';
import { SESSION_SUBAGENT_CUSTODY_CAPABILITY_V1, MAX_SESSION_SUBAGENT_CUSTODY_RECORDS, MAX_SESSION_SUBAGENT_CUSTODY_RECEIPTS, SESSION_SUBAGENT_CUSTODY_RECEIPT_RETENTION_MS, SessionSubagentCustodyMutationRequestV1Schema, SessionSubagentCustodyMutationResponseV1Schema, SessionSubagentCustodyPageV1Schema, type SessionSubagentCustodyMutationRequestV1, type SessionSubagentCustodyMutationResponseV1 } from '@happier-dev/protocol/sessions/subagents/durableCustodyV1';
import { SessionSystemRecordStoredUpsertRequestSchema, SessionSystemRecordStoredSchema, SessionSystemRecordStoredReadResponseSchema, type SessionSystemRecordStored } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createMuseMspProcessFixture, readMuseMspProcessAudit, waitForMuseMspProcessAudit, type MuseMspProcessAudit } from './mspProcess.js';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createSessionRoleContext } from '@/session/roles/sessionRoleContext';
import { createRoleSourceReader } from '@/session/roles/roleSources';
import { resolveBackendEngineAdapterResolution } from '@/agent/runtime/registry/engineRegistry';
import { composeNativeAgentSessionRuntimeContext, createNativeAgentSessionHostServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { bindNativeAgentSessionServices, createNativeAgentCurrentSessionUiServices, createNativeAgentSessionServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';
import { createNativeAgentSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createNativeAgentSessionWorkStateService } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionWorkState';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createSessionScopedSocketConnection } from '@/api/session/sockets';
import { createPluginInvocationPresentation } from '@/plugins/runtime/invocation/services/interactions';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { loadRetainedAgentRuntimeLeaf } from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readPluginSessionsSubagentObservation } from '@/session/services/pluginSessionsInventory';


/** Real admitted host owners; only the native process and remote transport are test boundaries. */
export async function createAdmittedMuseSessionFixture(options: Readonly<{
  native?: Parameters<typeof createMuseMspProcessFixture>[0];
  systemRecords?: boolean;
  sessionId?: string;
}> = {}) {
  const pluginId = 'happier.agent.muse';
  const agentId = 'muse';
  const sessionId = options.sessionId ?? 'host-admitted-muse';
  const controller = new AbortController();
  const signal = controller.signal;
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-admitted-'));
  const auditPath = join(scratch, 'native-audit.json');
  const native = await createMuseMspProcessFixture({ ...options.native, auditPath, cwd: process.cwd() });
  let launched = 0;
  const exec = createStablePluginExecService({ ...native, signal, isOccurrenceCurrent: () => true,
    async resolveExecutable() { launched++; return native.resolveExecutable(); },
  });
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.sig`;
  const credentials = { token, encryption: null };
  const initialSession = createPlainSessionFixture({ id: sessionId });
  const tuple = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
    metadata: initialSession.metadata, agentState: initialSession.agentState, storedContentMode: 'plain' });
  const row = createSessionRecordFixture({ id: sessionId, metadataLayoutVersion: 1,
    metadata: tuple.sharedMetadata.ciphertext, metadataVersion: initialSession.metadataVersion,
    ownerMetadata: tuple.ownerMetadata, agentState: tuple.agentState,
    agentStateVersion: initialSession.agentStateVersion, encryptionMode: 'plain', share: null });
  const custodyMutations: SessionSubagentCustodyMutationRequestV1[] = [];
  const custodyReceipts = new Map<string, SessionSubagentCustodyMutationResponseV1>();
  const custodyRecords = new Map<string, SessionSubagentCustodyMutationResponseV1['record']>();
  const systemRecords = new Map<string, SessionSystemRecordStored>();
  const storedWrites: SessionSystemRecordStored[] = [];
  const boundaryRequests: Array<Readonly<{ method: string; path: string }>> = [];
  const recordKey = (address: SessionSystemRecordStored['address']) => JSON.stringify([address.owner, address.namespace, address.kind, address.localId]);
  const http = createServer(async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      boundaryRequests.push({ method: request.method ?? '', path });
      if (request.method === 'GET' && path === '/v1/auth/ping') return send(200, {});
      if (options.systemRecords && request.method === 'GET' && path === '/v1/features') {
        return send(200, { features: {}, capabilities: { session: { systemRecords: { protocolVersions: [1] } } } });
      }
      const custodyRoute = `/v2/sessions/${sessionId}/subagents/custody`;
      if (request.method === 'GET' && path === `${custodyRoute}/capability`) return send(200, {
        capability: SESSION_SUBAGENT_CUSTODY_CAPABILITY_V1, maxRecords: MAX_SESSION_SUBAGENT_CUSTODY_RECORDS,
        maxReceipts: MAX_SESSION_SUBAGENT_CUSTODY_RECEIPTS, receiptRetentionMs: SESSION_SUBAGENT_CUSTODY_RECEIPT_RETENTION_MS,
      });
      if (request.method === 'GET' && path === custodyRoute) {
        return send(200, SessionSubagentCustodyPageV1Schema.parse({ records: [...custodyRecords.values()] }));
      }
      if (request.method === 'POST' && path === `${custodyRoute}/mutations`) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const mutation = SessionSubagentCustodyMutationRequestV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const receipt = custodyReceipts.get(mutation.operationId);
        if (receipt) return send(200, { ...receipt, replayed: true });
        const previous = custodyRecords.get(mutation.subagentId);
        if (mutation.expectedRevision !== (previous?.revision ?? null)) return send(409, { error: 'cas-conflict' });
        const result = SessionSubagentCustodyMutationResponseV1Schema.parse({ record: {
          subagentId: mutation.subagentId, groupId: mutation.groupId, status: mutation.status,
          revision: (previous?.revision ?? -1) + 1, updatedAt: Date.now(),
        }, replayed: false });
        custodyMutations.push(mutation);
        custodyRecords.set(mutation.subagentId, result.record);
        custodyReceipts.set(mutation.operationId, result);
        return send(200, result);
      }
      const recordsRoute = `/v2/sessions/${sessionId}/system-records`;
      if (options.systemRecords && request.method === 'GET' && path === `${recordsRoute}/record`) {
        const query = new URL(request.url ?? '/', 'http://localhost').searchParams;
        const record = [...systemRecords.values()].find(value => value.address.owner === query.get('owner')
          && value.address.namespace === query.get('namespace') && value.address.kind === query.get('kind')
          && value.address.localId === query.get('localId')) ?? null;
        return send(200, SessionSystemRecordStoredReadResponseSchema.parse({ record }));
      }
      if (options.systemRecords && request.method === 'PUT' && path === recordsRoute) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const mutation = SessionSystemRecordStoredUpsertRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const key = recordKey(mutation.address);
        const previous = systemRecords.get(key);
        const record = SessionSystemRecordStoredSchema.parse({ id: previous?.id ?? `record-${systemRecords.size + 1}`,
          address: mutation.address, content: mutation.content,
          // Canonical plain-record fixture revision; the native content and host publication are under test.
          revision: 'ssr1.AAAAAWkAAAAB', createdAt: previous?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() });
        systemRecords.set(key, record);
        storedWrites.push(record);
        return send(200, { record });
      }
      if (request.method === 'GET' && path === '/v1/account/encryption/currentness') {
        return send(200, createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
      }
      if (request.method === 'GET' && path === `/v2/sessions/${sessionId}`) return send(200, { session: row });
      if (request.method === 'PATCH' && path.startsWith(`/v2/sessions/${sessionId}`)) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (patch.mode !== 'owner') throw new Error('Expected owner tuple patch');
        if (patch.sharedMetadata.expectedVersion !== row.metadataVersion || patch.agentState.expectedVersion !== row.agentStateVersion) {
          return send(409, { code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
            sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } });
        }
        row.metadata = patch.sharedMetadata.ciphertext;
        row.ownerMetadata = patch.ownerMetadata;
        row.metadataVersion += 1;
        row.agentState = patch.agentState.ciphertext;
        row.agentStateVersion = (row.agentStateVersion ?? 0) + 1;
        return send(200, SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
          sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }));
      }
      return send(404, {});
    } catch {
      return send(500, { error: 'fixture_boundary_refused' });
    }
  });
  let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
  let untouched: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
  let session: AgentSessionRuntime | undefined;
  let host: ApiSessionClient | undefined;
  let owners: ReturnType<typeof createNativeAgentSessionHostServiceOwners> | undefined;
  let publications: ReturnType<typeof createNativeAgentSessionPublications> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', resolve);
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Expected local HTTP boundary');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    return await runWithServerHttpBaseUrl(serverUrl, async () => {
    untouched = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [],
      scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() },
    } });
    const untouchedHasMuse = untouched.registry.agentRuntimesByAgentId.has(agentId);
    const untouchedLaunchCount = launched;
    admitted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: untouched.happyHomeDir,
      controller: untouched.controller, runtimeOptions: { pluginIds: [pluginId],
      scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() },
    } });
    const registry = admitted.registry;
    const lease = registry.agentRuntimesByAgentId.get(agentId);
    const binding = lease?.sessionRunnerFactoryBinding;
    if (!lease || !binding) throw new Error('Expected admitted Muse Session factory');
    const leaf = await loadRetainedAgentRuntimeLeaf({ paths: resolvePluginStorePaths({ happyHomeDir: admitted.happyHomeDir }),
      binding, developmentOccurrenceId: lease.occurrenceId });
    const runtime = await leaf.factory({ plugin: { id: pluginId, version: lease.pluginVersion }, agent: { id: agentId }, signal });
    if (!runtime.sessions) throw new Error('Expected admitted Muse Session runtime');
    const selectedFactoryLaunchCount = launched;
    host = new ApiSessionClient(token, { ...initialSession, metadataLayoutVersion: 1,
      ownerMetadata: tuple.ownerMetadataValue, ownerMetadataEnvelope: tuple.ownerMetadata }, {
      metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials },
      transport: { serverId: 'muse-fixture-home', serverUrl,
        createSessionSocketTransport: ({ sessionId, machineId }) => createSessionScopedSocketConnection({ token, sessionId, machineId, serverUrl }),
      },
    });
    const resolution = await resolveBackendEngineAdapterResolution(agentId, { runtimeRegistry: registry });
    if (!resolution) throw new Error('Expected admitted Muse engine resolution');
    const sessionRoleContext = createSessionRoleContext({ readMetadata: () => host!.getMetadataSnapshot(),
      readOrganization: async () => ({}), readRoleSources: createRoleSourceReader({}),
      readAccountRoleOverrides: () => ({ status: 'ready', overrides: {} }),
    });
    const permissionHandler = new ProviderEnforcedPermissionHandler(host, { logPrefix: 'Muse fixture',
      getWorkspaceWrites: sessionRoleContext.readWorkspaceWrites });
    const sourceCustody = registry.readPluginSourceCustody(pluginId);
    if (!sourceCustody) throw new Error('Expected admitted Muse source custody');
    const nativeSessionParams = { permissionHandler, pluginId, contributionId: agentId, runtimeId: agentId,
      sessionId, occurrenceId: lease.occurrenceId, sourceCustody, isCurrent: lease.isCurrent, signal,
      credentials, readCredentials: async () => credentials,
      readPermissionMode: () => 'default',
    };
    const currentSessionUi = createNativeAgentCurrentSessionUiServices(nativeSessionParams);
    const nativeSessionServices = createNativeAgentSessionServices({ ...nativeSessionParams, currentSessionUi });
    const operationServices = await registry.createAgentInvocationServices({ pluginId, pluginVersion: lease.pluginVersion,
      agentId, occurrenceId: lease.occurrenceId, correlationId: 'muse-admitted-open', cwd: process.cwd(), signal,
      isOccurrenceCurrent: lease.isCurrent, session: { id: sessionId, current: currentSessionUi },
    });
    const services = bindNativeAgentSessionServices(operationServices, nativeSessionServices);
    const identity = { pluginId, pluginVersion: lease.pluginVersion, agentId, occurrenceId: lease.occurrenceId, isCurrent: lease.isCurrent };
    owners = createNativeAgentSessionHostServiceOwners({ runtimeRegistry: registry, identity,
      backend: resolution.backend, agent: resolution.agent,
      hostSession: { session: host, machineId: 'muse-fixture-machine', accountSettingsAuthority: 'session',
        permissionHandler,
      }, sessionId, directory: process.cwd(), signal, happyHomeDir: admitted.happyHomeDir,
    });
    publications = createNativeAgentSessionPublications({ agentId, session: host, signal,
      isCurrent: lease.isCurrent, supportsInFlightSteer: false,
    });
    const sessionServices = createNativeAgentSessionHostServices({ owners, agentId, sessionId,
      directory: process.cwd(), signal, isCurrent: lease.isCurrent, session: host,
      publications: publications.services, readToolExecutionCapability: () => runtime.toolExecution?.capability ?? null,
      subagents: readPluginSessionsSubagentObservation(services.sessions),
    });
    const context = composeNativeAgentSessionRuntimeContext({ identity, contributionId: agentId, sessionId,
      invokedAtMs: Date.now(), signal, services: { ...services, exec }, sessionServices,
      ui: createPluginInvocationPresentation({ currentSession: currentSessionUi, signal, isOccurrenceCurrent: lease.isCurrent }),
      protocols: createPublicAcpRuntimeProtocols({ pluginId, agentId, signal, isCurrent: lease.isCurrent,
        services, models: sessionServices.models, interactions: currentSessionUi.interactions,
      }),
      workState: createNativeAgentSessionWorkStateService({ session: host, pluginId, contributionId: agentId,
        agentId, occurrenceId: lease.occurrenceId,
        declarations: readAgentSessionCapabilities(resolution.agent.richDefinition?.definition)?.workStateSources ?? [],
        isCurrent: lease.isCurrent,
      }),
    });
    const selectedRegistry = admitted;
    const untouchedRegistry = untouched;
    const boundPublications = publications;
    return {
      runtime, context, host, permissionHandler, custodyMutations, storedWrites, boundaryRequests,
      publications: boundPublications,
      admission: { untouchedHasMuse, untouchedLaunchCount, selectedFactoryLaunchCount },
      get launchCount() { return launched; },
      run<T>(operation: () => T): T { return runWithServerHttpBaseUrl(serverUrl, operation); },
      async open(request: AgentSessionOpenRequest) {
        session = await runWithServerHttpBaseUrl(serverUrl, () => runtime.sessions!.open(request, context));
        return session;
      },
      async closeSession() { await session?.dispose(); session = undefined; },
      async readAudit() { return await readMuseMspProcessAudit(auditPath); },
      async waitForAudit(accept: (audit: MuseMspProcessAudit) => boolean, options?: { signal?: AbortSignal }) {
        return await waitForMuseMspProcessAudit(auditPath, accept, { signal: options?.signal ?? signal });
      },
      async retire() { await selectedRegistry.dispose(); },
      get retiredHasMuse() { return untouchedRegistry.controller.getState().activeRegistry?.agentRuntimesByAgentId.has(agentId) ?? false; },
      async dispose() { await dispose(); },
    };
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  async function dispose() {
    try { await session?.dispose(); }
    finally {
      controller.abort();
      publications?.dispose();
      try { await owners?.dispose(); }
      finally {
        try { await host?.close(); }
        finally {
          try { await admitted?.dispose(); }
          finally {
            try { await untouched?.dispose(); }
            finally {
              try { await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); }
              finally { await rm(scratch, { recursive: true, force: true }); }
            }
          }
        }
      }
    }
  }
}
