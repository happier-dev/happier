import { once } from 'node:events';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Server } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { McpServersSettingsV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPromptBundleInLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { SpawnCapabilitiesPreviewSuccessV1Schema, SessionCapabilitiesGetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { PromptLibraryCatalogKeyV1Schema, PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineMcpServersRpcHandlers } from '@/api/machine/rpcHandlers.mcpServers';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createSessionRecordFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { configuration, reloadConfiguration } from '@/configuration';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema, ProjectAccountRowReadRequestV1Schema, ProjectAccountRowReadResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createCliActionDeps } from './createCliActionDeps';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { writeCapabilitySelectionApplyV1, writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { refreshActiveMcpServerCatalog } from '@/settings/mcp/hydrateMcpServerCatalog';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { readRpcErrorCode, RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1,
  projectSessionOwnerCompatibilityViewV1, SessionMetadataOwnerPatchV1Schema, StoredSessionOwnerMetadataEnvelopeV1Schema,
  StoredSessionSharedMetadataV1Schema, SessionMetadataTuplePatchSuccessV1Schema, SessionMetadataVersionConflictV1Schema,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

describe('Session capabilities composed Account and Machine seam', () => {
  it('previews Off items through real HTTP/Socket.IO and writes Account metadata while the machine is offline', async () => {
    await withTempDir('happier-impl-p2c-machine-composed-', async home => {
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, revision INTEGER NOT NULL, ownerMetadata TEXT NOT NULL, agentState TEXT, agentRevision INTEGER NOT NULL)');
      const sessionId = 'c111111111111111111111111';
      const machineId = 'capabilities-machine';
      const metadata = writeCapabilitySelectionApplyV1(createTestMetadata({ path: home, host: 'fixture', machineId, flavor: 'codex',
        workspaceId: 'project-checkout', projectId: 'account-project',
        agentRuntimeCapabilitiesV1: { capabilitySelection: { vendorResume: 'supported', skillsLiveReload: 'supported' } },
      }), {
        skills: { source: 'rules', reason: 'restart_to_apply', restartBy: 'user' },
      });
      const owner = createSessionOwnerMetadataV1({ metadata });
      if (!owner.ok) throw new Error(`Invalid canonical metadata fixture: ${owner.unsupportedFields.join(',')}`);
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(sessionId,
        JSON.stringify(projectSessionSharedMetadataV1({ metadata })), 1,
        JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata)), null, 0);
      const persistedMetadata = () => {
        const row = db.prepare('SELECT metadata, ownerMetadata FROM sessions WHERE id = ?').get(sessionId)!;
        const envelope = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(JSON.parse(String(row.ownerMetadata)));
        if (envelope.t !== 'plain') throw new Error('Plain Account fixture changed mode');
        return projectSessionOwnerCompatibilityViewV1({ sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(JSON.parse(String(row.metadata))),
          ownerMetadata: envelope.v });
      };
      const settings = McpServersSettingsV1Schema.parse({ v: 1, servers: [{ id: 'mcp-linear', name: 'linear', transport: 'http',
        remote: { url: 'https://example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [{
          id: 'everywhere-off', serverId: 'mcp-linear', target: { t: 'allMachines' }, enabled: false, createdAt: 1, updatedAt: 1,
        }] });
      const catalog = { v: 1, servers: settings.servers, bindings: settings.bindings };
      let catalogRevision = 1;
      const failures: unknown[] = [];
      const rpcResponses: unknown[] = [];
      let machineOnline = true;
      let sessionActive = false;
      let accountSessionReadable = true;
      let acceptedCheckoutReadable = true;
      let projectStatusReads = 0;
      let acknowledgeNextRead = false;
      let relayMethodNotFound = false;
      let relayRequestTimeout = false;
      let waitForDetection: (() => Promise<void>) | undefined;
      const skillArtifacts: Array<Readonly<{ id: string; header: string; body: string;
        ownerAccountId: string; access: 'owner'; encryptionMode: 'plain'; dataEncryptionKey: string;
        headerVersion: number; bodyVersion: number; seq: number; createdAt: number; updatedAt: number }>> = [];
      const skillReads = { inventory: 0, bodies: 0 };
      let addressedSkillUnavailable = false;
      const server = createServer((request, response) => { void (async () => {
        const path = new URL(request.url ?? '/', 'http://fixture.test').pathname;
        let text = ''; for await (const chunk of request) text += String(chunk);
        let result: unknown;
        let status = 200;
        if ((request.method === 'HEAD' || request.method === 'GET') && path === '/') result = {};
        else if (path === '/v1/account/encryption/currentness') result = { mode: 'plain', version: 0,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 };
        else if (path === '/v1/account/encryption') result = { mode: 'plain', updatedAt: 0 };
        else if (path === '/v2/account/settings') result = { version: 1, content: { t: 'plain', v: {} } };
        else if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list` || path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`) {
          projectStatusReads++;
          const serverId = configuration.activeServerId;
          const key = { kind: 'workspace-ref', serverId, id: 'project-checkout' };
          const rows = ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: !acceptedCheckoutReadable ? [] : [{ key, revision: 1,
            content: { t: 'plain', v: { key, value: { id: key.id, serverId, machineId, rootPath: home,
              projectKey: 'account-project', repositoryIdentity: { kind: 'github', deployment: 'https://github.com', repository: 'acme/project' }, createdAtMs: 1 } } } }] });
          if (rows.status !== 'listed') throw new Error('Invalid checkout fixture');
          if (path.endsWith('/read')) {
            expect(ProjectAccountRowReadRequestV1Schema.parse(JSON.parse(text))).toEqual({ key });
            result = ProjectAccountRowReadResponseV1Schema.parse(rows.rows[0] ? { status: 'present', row: rows.rows[0] } : { status: 'absent' });
          } else result = rows;
        }
        else if (path === '/v1/account/entity-rows/mcp') result = { status: 'present', revision: catalogRevision, content: { t: 'plain', v: catalog } };
        else if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
          result = PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 0,
            inventoryComplete: true, snapshots: [], releases: [] });
        }
        else if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) result = { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
          key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) };
        else if (path === '/v1/artifacts') {
          skillReads.inventory++;
          skillReads.bodies += skillArtifacts.length;
          result = new URL(request.url!, 'http://fixture.test').searchParams.has('kind')
            ? { items: skillArtifacts, hasUnclassified: false } : skillArtifacts;
        }
        else if (path.startsWith('/v1/artifacts/')) {
          const artifact = skillArtifacts.find(item => path === `/v1/artifacts/${item.id}`);
          if (addressedSkillUnavailable) { status = 503; result = { error: 'artifact_content_unavailable' }; }
          else if (artifact) { skillReads.bodies++; result = artifact; }
          else { status = 404; result = { error: 'not_found' }; }
        }
        else if (path === `/v1/machines/${machineId}`) result = { machine: { id: machineId, kind: 'persistent', active: machineOnline,
          storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null } };
        else if (path === `/v2/sessions/${sessionId}` && request.method === 'GET') {
          const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
          if (!row) throw new Error('Missing test Session');
          if (!accountSessionReadable) { status = 503; result = { error: 'Session read unavailable' }; }
          else result = { session: V2SessionRecordSchema.parse(createSessionRecordFixture({ id: sessionId, active: sessionActive, encryptionMode: 'plain', share: null,
            metadataLayoutVersion: 1, metadata: String(row.metadata), metadataVersion: Number(row.revision),
            effectiveAccess: createSessionNotificationContextFixture(sessionId).effectiveAccess,
            ownerMetadata: StoredSessionOwnerMetadataEnvelopeV1Schema.parse(JSON.parse(String(row.ownerMetadata))),
            agentState: row.agentState === null ? null : String(row.agentState), agentStateVersion: Number(row.agentRevision) })) };
          if (acknowledgeNextRead) {
            acknowledgeNextRead = false;
            const acknowledged = createSessionOwnerMetadataV1({ metadata: { ...persistedMetadata(), hostPid: 42 } });
            if (!acknowledged.ok) throw new Error('Invalid runtime acknowledgment');
            db.prepare('UPDATE sessions SET ownerMetadata = ?, revision = revision + 1 WHERE id = ?').run(
              JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(acknowledged.ownerMetadata)), sessionId);
          }
        } else if (path === `/v2/sessions/${sessionId}` && request.method === 'PATCH') {
          const body = SessionMetadataOwnerPatchV1Schema.parse(JSON.parse(text));
          const updated = db.prepare('UPDATE sessions SET metadata = ?, revision = revision + 1, ownerMetadata = ?, agentState = ?, agentRevision = agentRevision + 1 WHERE id = ? AND revision = ? AND agentRevision = ? AND ownerMetadata = ?')
            .run(body.sharedMetadata.ciphertext, JSON.stringify(body.ownerMetadata), body.agentState.ciphertext, sessionId,
              body.sharedMetadata.expectedVersion, body.agentState.expectedVersion, JSON.stringify(body.expectedOwnerMetadata));
          const row = db.prepare('SELECT revision, agentRevision FROM sessions WHERE id = ?').get(sessionId)!;
          status = updated.changes ? 200 : 409;
          result = updated.changes ? SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
            sharedMetadata: { version: Number(row.revision) }, agentState: { version: Number(row.agentRevision) } })
            : SessionMetadataVersionConflictV1Schema.parse({ code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
              sharedMetadata: { version: Number(row.revision) }, agentState: { version: Number(row.agentRevision) } });
        } else { throw new Error(`Unexpected composed Home route ${request.method} ${path}`); }
        response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
      })().catch(error => { failures.push(error); response.writeHead(500); response.end('{}'); }); });
      const socketServer = new Server(server, { path: '/v1/updates/' });
      const manager = new RpcHandlerManager({ scopePrefix: machineId, encryptionMode: 'plain', logger: () => undefined });
      socketServer.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL, (request, ack) => {
        if (!machineOnline) { ack({ ok: false, error: 'RPC target unavailable', errorCode: 'target_unavailable' }); return; }
        if (relayMethodNotFound) { ack({ ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }); return; }
        if (relayRequestTimeout) { ack({ ok: false, error: 'Deadline exceeded', errorCode: 'RPC_REQUEST_TIMEOUT' }); return; }
        void manager.handleRequest(request).then(result => { rpcResponses.push(result); ack({ ok: true, result }); }, error => ack({
          ok: false, error: error instanceof Error ? error.message : 'RPC call failed',
          ...(readRpcErrorCode(error) ? { errorCode: readRpcErrorCode(error) } : {}),
        }));
      }));
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server address');
      const base = `http://127.0.0.1:${address.port}`;
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
      const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'capabilities-account' })).toString('base64url')}.signature`, encryption: null };
      let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
      try {
        env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: base, HAPPIER_WEBAPP_URL: base }); reloadConfiguration();
        resetInMemoryAccountSettingsContextForTests();
        runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController, runtimeOptions: { pluginIds: ['codex'] } });
        registerMachineMcpServersRpcHandlers({ rpcHandlerManager: manager, deps: { readCredentials: async () => credentials,
          detectProviderMcpServers: async () => { await waitForDetection?.(); return { servers: [], warnings: [] }; },
          bootstrapAccountSettingsContext: input => runWithServerHttpBaseUrl(base, () => bootstrapAccountSettingsContext(input)),
        } });
        await runWithServerHttpBaseUrl(base, () => bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' }));
        const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: 'cli-global', mode: 'plain', ctx: null });
        const executor = createActionExecutor(deps);
        const context = { surface: 'ui', authority: 'present_user' } as const;
        const readsBeforeStatus = projectStatusReads;
        const ordinaryStatus = await executor.execute('session.status.get', { sessionId }, context);
        expect(ordinaryStatus).toMatchObject({ ok: true, result: { session: { id: sessionId },
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } });
        expect(ordinaryStatus).not.toHaveProperty('result.acceptedWorkspace');
        expect(projectStatusReads).toBe(readsBeforeStatus);
        const acceptedStatus = await executor.execute('session.status.get', { sessionId: 'self', includeAcceptedWorkspace: true },
          { ...context, serverId: configuration.activeServerId, defaultSessionId: sessionId });
        expect(acceptedStatus, JSON.stringify(failures)).toMatchObject({ ok: true, result: { session: { id: sessionId },
          acceptedWorkspace: { checkout: { serverId: configuration.activeServerId, workspaceId: 'project-checkout', machineId, rootPath: home },
            repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/project' } } } });
        expect(projectStatusReads).toBe(readsBeforeStatus + 1);
        acceptedCheckoutReadable = false;
        const unavailableStatus = await executor.execute('session.status.get', { sessionId, includeAcceptedWorkspace: true }, context);
        expect(unavailableStatus).toMatchObject({ ok: true, result: { session: { id: sessionId } } });
        expect(unavailableStatus).not.toHaveProperty('result.acceptedWorkspace');
        acceptedCheckoutReadable = true;
        const preview = await executor.execute('sessions.spawn.capabilities.preview', { machineId, agentId: 'codex' }, context);
        expect(preview, JSON.stringify({ preview, rpcResponses, failures: failures.map(error => error instanceof Error ? error.message : error) })).toMatchObject({ ok: true, result: { ok: true,
          mcp: { items: [{ id: 'mcp-linear', selected: false, reason: 'rule_off' }] } } });
        if (!preview.ok) throw new Error(preview.error);
        SpawnCapabilitiesPreviewSuccessV1Schema.parse(preview.result);
        const selection = { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['mcp-linear'], forceExcludeServerIds: [] } };
        const defaultBindings = catalog.bindings;
        // Directory-only spawn and real stored Session metadata use the same
        // Account checkout resolver through the registered Machine handler.
        catalog.bindings = [{ ...defaultBindings[0]!, target: { t: 'project', projectKey: 'account-project' }, enabled: true }];
        catalogRevision++;
        await runWithServerHttpBaseUrl(base, () => refreshActiveMcpServerCatalog({ credentials }));
        const projectPreview = await executor.execute('sessions.spawn.capabilities.preview', { machineId, agentId: 'codex', directory: home }, context);
        const projectSession = await executor.execute('session.capabilities.get', { sessionId }, context);
        for (const output of [projectPreview, projectSession]) expect(output, JSON.stringify(failures)).toMatchObject({ ok: true, result: {
          ok: true, mcp: { items: [{ id: 'mcp-linear', selected: true, reason: 'rule_on' }] },
        } });
        if (projectPreview.ok) SpawnCapabilitiesPreviewSuccessV1Schema.parse(projectPreview.result);
        if (projectSession.ok) SessionCapabilitiesGetOutputV1Schema.parse(projectSession.result);
        for (const bindings of [[], [{ ...defaultBindings[0]!, target: { t: 'machine' as const, machineId: 'elsewhere' } }],
          [{ ...defaultBindings[0]!, agentId: 'gemini' }]]) {
          catalog.bindings = bindings; catalogRevision++;
          await runWithServerHttpBaseUrl(base, () => refreshActiveMcpServerCatalog({ credentials }));
          const included = await executor.execute('sessions.spawn.capabilities.preview', { machineId, agentId: 'codex', capabilitySelection: selection }, context);
          expect(included).toMatchObject({ ok: true, result: { ok: true, mcp: { items: [{
            id: 'mcp-linear', selected: true, selectable: true, reason: 'session_added', sessionOverride: 'added',
          }] } } });
          if (!included.ok) throw new Error('Registered preview failed');
          SpawnCapabilitiesPreviewSuccessV1Schema.parse(included.result);
        }
        catalog.bindings = defaultBindings; catalogRevision++;
        await runWithServerHttpBaseUrl(base, () => refreshActiveMcpServerCatalog({ credentials }));
        const transport = await resolveSessionTransportContext({ reason: 'session-action', credentials, idOrPrefix: sessionId });
        expect(transport).toMatchObject({ ok: true });
        if (!transport.ok) throw new Error(`Canonical fixture read failed: ${transport.code}`);
        const opened = tryDecryptSessionOwnerMetadataView({ credentials, accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
          rawSession: transport.rawSession });
        expect(opened, JSON.stringify(transport.rawSession)).toMatchObject({ machineId, path: home, flavor: 'codex' });
        const stopped = await executor.execute('session.capabilities.get', { sessionId }, context);
        expect(stopped, JSON.stringify({ stopped, rpcResponses, failures: failures.map(error => error instanceof Error ? error.message : error) }))
          .toMatchObject({ ok: true, result: { ok: true, applyTiming: { mcp: { t: 'session_not_running' } } } });
        if (stopped.ok) SessionCapabilitiesGetOutputV1Schema.parse(stopped.result);
        expect(stopped).toMatchObject({ ok: true, result: { ok: true,
          pendingApply: { mcp: false, skills: true, reason: 'restart_to_apply', restartBy: 'user' } } });
        expect(stopped).not.toHaveProperty('result.pendingApply.source');
        const prior = db.prepare('SELECT metadata, ownerMetadata FROM sessions WHERE id = ?').get(sessionId)!;
        try {
          const bothPending = writeCapabilitySelectionApplyV1(writeSessionCapabilitySelectionToMetadataV1(persistedMetadata(), {
            mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['mcp-linear'], forceExcludeServerIds: [] },
          }, { sessionActive: true }), { skills: { source: 'rules', reason: 'missing_resume_snapshot' } });
          const owner = createSessionOwnerMetadataV1({ metadata: bothPending });
          if (!owner.ok) throw new Error('Invalid aggregate capability fixture');
          db.prepare('UPDATE sessions SET metadata = ?, ownerMetadata = ? WHERE id = ?').run(
            JSON.stringify(projectSessionSharedMetadataV1({ metadata: bothPending })),
            JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata)), sessionId);
          const aggregate = await executor.execute('session.capabilities.get', { sessionId }, context);
          expect(aggregate).toMatchObject({ ok: true, result: { ok: true, pendingApply: { mcp: true, skills: true } } });
          expect(aggregate).not.toHaveProperty('result.pendingApply.reason');
        } finally {
          db.prepare('UPDATE sessions SET metadata = ?, ownerMetadata = ? WHERE id = ?').run(prior.metadata, prior.ownerMetadata, sessionId);
        }
        sessionActive = true;
        relayRequestTimeout = true;
        const timedOut = await executor.execute('session.capabilities.get', { sessionId }, context);
        expect(timedOut).toMatchObject({ ok: true, result: { ok: false, code: 'preview_timeout' } });
        if (timedOut.ok) SessionCapabilitiesGetOutputV1Schema.parse(timedOut.result);
        relayRequestTimeout = false;
        let releaseDetection!: () => void;
        let enteredDetection = 0;
        let allEntered!: () => void;
        const detectionEntered = new Promise<void>(resolve => { allEntered = resolve; });
        const detectionReleased = new Promise<void>(resolve => { releaseDetection = resolve; });
        // Native configuration I/O can legitimately outlive the generic 20s RPC
        // default. The containing Action, including its signal, owns this read.
        waitForDetection = async () => { if (++enteredDetection === 3) allEntered(); await detectionReleased; };
        const slowReads = Promise.all([
          executor.execute('session.capabilities.get', { sessionId }, context),
          executor.execute('sessions.spawn.capabilities.preview', { machineId, agentId: 'codex' }, context),
          executor.execute('sessions.spawn.mcp_servers.preview', { machineId, agentId: 'codex', directory: home }, context),
        ]);
        try {
          await detectionEntered;
          await new Promise(resolve => setTimeout(resolve, 21_000));
          releaseDetection();
          const [running, spawn, legacy] = await slowReads;
          expect(running).toMatchObject({ ok: true, result: { ok: true, applyTiming: { mcp: { t: 'next_turn' } } } });
          if (running.ok) SessionCapabilitiesGetOutputV1Schema.parse(running.result);
          expect(spawn).toMatchObject({ ok: true, result: { ok: true } });
          if (spawn.ok) SpawnCapabilitiesPreviewSuccessV1Schema.parse(spawn.result);
          expect(legacy).toMatchObject({ ok: true, result: { ok: true, preview: { ok: true } } });
        } finally {
          releaseDetection();
          await slowReads;
          waitForDetection = undefined;
          sessionActive = false;
        }
        let cancellationDetectionEntered!: () => void;
        let releaseCancelledDetection!: () => void;
        let cancelledReadsEntered = 0;
        const cancellationEntered = new Promise<void>(resolve => { cancellationDetectionEntered = resolve; });
        const cancellationReleased = new Promise<void>(resolve => { releaseCancelledDetection = resolve; });
        waitForDetection = async () => { if (++cancelledReadsEntered === 3) cancellationDetectionEntered(); await cancellationReleased; };
        const controller = new AbortController();
        const cancelledReads = Promise.all([
          executor.execute('session.capabilities.get', { sessionId }, { ...context, signal: controller.signal }),
          executor.execute('sessions.spawn.capabilities.preview', { machineId, agentId: 'codex' }, { ...context, signal: controller.signal }),
          executor.execute('sessions.spawn.mcp_servers.preview', { machineId, agentId: 'codex', directory: home }, { ...context, signal: controller.signal }),
        ]);
        try {
          await cancellationEntered;
          controller.abort();
          releaseCancelledDetection();
          expect((await cancelledReads).map(result => result.ok)).toEqual([false, false, false]);
        } finally { releaseCancelledDetection(); await cancelledReads; waitForDetection = undefined; }
        machineOnline = false;
        for (let index = 0; index < 139; index++) await createPromptBundleInLibrary({ store: {
          read: async () => null, update: async () => { throw new Error('Unexpected fixture update'); },
          create: async ({ header, body }) => {
            const id = `skill-${index}`;
            skillArtifacts.push({ id, header: encodePlainArtifactStoredContent(header),
              body: encodePlainArtifactStoredContent({ body }), ownerAccountId: 'capabilities-account',
              access: 'owner', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
              headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return id;
          },
        }, request: { title: 'review', bundleSchemaId: 'skills.skill_md_v1', entries: [{ path: 'SKILL.md',
          contentKind: 'utf8', contentBase64: Buffer.from('---\nname: review\n---\nReview a change.').toString('base64') }] } });
        for (const id of ['happier:happier', 'skill-0']) {
          skillReads.inventory = 0; skillReads.bodies = 0;
          expect(await executor.execute('session.capabilities.set', { sessionId, kind: 'skill', id, state: 'on' }, context))
            .toMatchObject({ ok: true, result: { ok: true } });
          expect(persistedMetadata()).toMatchObject({ skillSelectionV1: { forceIncludeSkillIds: expect.arrayContaining([id]) } });
          expect(skillReads).toEqual({ inventory: 0, bodies: id === 'happier:happier' ? 0 : 1 });
        }
        // Names still require the complete catalog; ambiguous and missing names never write.
        addressedSkillUnavailable = true;
        expect(await executor.execute('session.capabilities.set', { sessionId, kind: 'skill', id: 'happier', state: 'off' }, context))
          .toMatchObject({ ok: true, result: { ok: true } });
        addressedSkillUnavailable = false;
        const beforeNameRefusal = persistedMetadata();
        for (const id of ['review', 'missing-skill']) {
          expect(await executor.execute('session.capabilities.set', { sessionId, kind: 'skill', id, state: 'on' }, context))
            .toMatchObject({ ok: true, result: { ok: false, code: 'not_found' } });
          expect(persistedMetadata()).toEqual(beforeNameRefusal);
        }
        const changed = await executor.execute('session.capabilities.set', { sessionId, kind: 'mcp_server', id: 'linear', state: 'on' }, context);
        expect(changed, JSON.stringify({ changed, failures: failures.map(error => error instanceof Error ? error.message : error) }))
          .toMatchObject({ ok: true, result: { ok: true, previous: 'inherit', applyTiming: { t: 'session_not_running' } } });
        expect(persistedMetadata()).toMatchObject({ mcpSelectionV1: { forceIncludeServerIds: ['mcp-linear'] } });
        acknowledgeNextRead = true;
        expect(await executor.execute('session.capabilities.set', { sessionId, kind: 'native_skill', id: 'native-from-offline-machine', state: 'off' }, context))
          .toMatchObject({ ok: true, result: { ok: true, previous: 'inherit', applyTiming: { t: 'session_not_running' } } });
        expect(persistedMetadata()).toMatchObject({ hostPid: 42,
          skillSelectionV1: { excludeNativeSkillNames: ['native-from-offline-machine'] } });
        expect(await executor.execute('session.capabilities.get', { sessionId }, context))
          .toMatchObject({ ok: true, result: { ok: false, code: 'session_unavailable' } });
        machineOnline = true;
        expect(await executor.execute('session.capabilities.get', { sessionId }, context))
          .toMatchObject({ ok: true, result: { ok: true, mcp: { items: [{ id: 'mcp-linear', selected: true, reason: 'session_added' }] } } });
        const beforeReadFailure = persistedMetadata();
        accountSessionReadable = false;
        expect(await executor.execute('session.capabilities.get', { sessionId }, context))
          .toMatchObject({ ok: true, result: { ok: false, code: 'session_unavailable' } });
        expect(await executor.execute('session.capabilities.set', { sessionId, kind: 'mcp_server', id: 'linear', state: 'off' }, context))
          .toMatchObject({ ok: true, result: { ok: false, code: 'session_unavailable' } });
        expect(persistedMetadata()).toEqual(beforeReadFailure);
        accountSessionReadable = true;
        relayMethodNotFound = true;
        expect(await executor.execute('sessions.spawn.capabilities.preview', { machineId, agentId: 'codex' }, context))
          .toMatchObject({ ok: true, result: { ok: false, reason: 'invalid_input' } });
        relayMethodNotFound = false;
        manager.unregisterHandler(RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW);
        expect(await executor.execute('sessions.spawn.capabilities.preview', { machineId, agentId: 'codex' }, context))
          .toMatchObject({ ok: true, result: { ok: false, reason: 'invalid_input' } });
        expect(failures).toEqual([]);
      } finally {
        await runtime?.dispose();
        env.restore(); reloadConfiguration(); resetInMemoryAccountSettingsContextForTests();
        await new Promise<void>(resolve => socketServer.close(() => resolve()));
        server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        db.close();
      }
    });
  }, 60_000);
});
