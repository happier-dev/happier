import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import * as z from 'zod/mini';
import Fastify from 'fastify';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import tweetnacl from 'tweetnacl';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    ArtifactHttpReadV1Schema,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilitySocketAuthV1,
    createActionExecutor,
    decodePlainArtifactStoredContent,
    encodePlainMachineStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    encodeBase64,
} from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MachineUpdateStateRequestSchema, MachineUpdateStateResponseSchema } from '@happier-dev/protocol/machines/metadataUpdate';
import { parseMachinePublishedDaemonStateV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1, type SkillFileInputV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { SessionCapabilitiesSetOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { MentionRefV1Schema } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { buildSkillComposerGroups, pickSkillComposerRow } from '../../../../../../ui/sources/sync/domains/skills/skillComposerGroups';
import { planSkillUsageWriteV1, readSkillUsageRowV1 } from '@happier-dev/protocol/prompts/library/skills/skillUsageV1';
import { deriveSkillAccountStatusesV1 } from '@happier-dev/protocol/prompts/library/skills/skillStatusV1';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 as secretOutputs } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { BUILT_IN_REGISTRY_SOURCES_V1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, RegistryItemV1Schema, computeGitBlobShaV1, computeGitTreeShaV1 } from '@happier-dev/protocol/registries';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema, AcpCatalogRowReadResponseV1Schema, openAcpCatalogContentV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { AgentsAcpBackendsInstallFromRegistryInputV1Schema, AgentsAcpBackendsInstallFromRegistryOutputV1Schema } from '../../../../../../../packages/protocol/src/acp/catalog/registry/registryInstallActionV1';
import { mapAcpRegistryAgentToDefinitionV1 } from '../../../../../../../packages/protocol/src/acp/catalog/registry/mapAcpRegistryAgentV1';
import { DaemonAgentInstallReadResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { ACP_REGISTRY_V1_FIXTURE } from '../../../../../../../packages/protocol/src/registries/formats/fixtures/acpRegistryV1Fixture';
import { MCP_REGISTRY_V01_READ_FIXTURE, MCP_REGISTRY_V01_PACKAGE_FIXTURE } from '../../../../../../../packages/protocol/src/registries/formats/fixtures/mcpRegistryV01Fixture';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema,
    McpServerCatalogV1Schema, openMcpServerCatalogContentV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryRowReadResponseV1Schema, openPromptLibraryContentV1,
    PromptLibraryRowMutationV1Schema, PromptLibraryRowMutationResponseV1Schema, PromptLibraryRowsListResponseV1Schema,
    PromptLibraryRowsInitializationV1Schema, PromptLibraryRowsInitializationResponseV1Schema,
    sealPromptLibraryContentV1, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { loadPromptLibraryCatalogV1, readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { removeSkillRulesV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import capturedPickerStack from '../../../../../../../packages/protocol/fixtures/0.2-picker-skill-instructions-stack.json';
import { createCliActionDeps } from '../../../../../../cli/src/session/actions/createCliActionDeps';
import { createCliMcpServerActionExecuteV1 } from '../../../../../../cli/src/session/actions/cliActionDeps/createCliMcpServerActionDeps';
import { createCliActionExecutorFromCredentials } from '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { bootstrapAccountSettingsContext } from '../../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { createAgentInstallJobOwner } from '../../../../../../cli/src/capabilities/installJobs/agentInstallJobOwner';
import { registerMachineAgentInstallJobRpcHandlers } from '../../../../../../cli/src/api/machine/rpcHandlers.agentInstallJobs';
import { registerCapabilitiesHandlers } from '../../../../../../cli/src/rpc/handlers/capabilities';
import { createFilesystemEffectAdmission } from '../../../../../../cli/src/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { invalidateDaemonContributionRegistryProjectionCache, registerDaemonContributionRegistryProjectionHandler } from '../../../../../../cli/src/rpc/handlers/daemonContributionRegistryProjection';
import { createPluginReloadController, type PluginRuntimeRegistryLease } from '../../../../../../cli/src/plugins/runtime/reload/controller';
import { resolveExecutablePluginRuntimeRegistry } from '../../../../../../cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginRegistryStateStore } from '../../../../../../cli/src/plugins/store/registry/currentState';
import type { RpcHandlerRegistrar } from '../../../../../../cli/src/api/rpc/types';
import { RpcHandlerManager } from '../../../../../../cli/src/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '../../../../../../cli/src/api/machine/machineRpcAuthorization';
import { resolveAcpLaunch } from '../../../../../../cli/src/agent/acp/catalog/configured/resolveAcpLaunch';
import { refreshDaemonAcpCatalog } from '../../../../../../cli/src/agent/acp/catalog/hydrateAcpCatalog';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { tryHandleSkillsCliCommand } from '../../../../../../cli/src/cli/actions/skillsNameArgAdapter';
import { tryHandleMcpServerCliCommand } from '../../../../../../cli/src/cli/actions/adapters/mcpServersArgv';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from '../../../../../../cli/src/cli/actions/compiledCommands';
import { runCompiledActionCliCommand, type ActionCliExecutionDeps } from '../../../../../../cli/src/cli/actions/executeCommand';
import { buildSessionMetadataEnvelopeCreateFields } from '../../../../../../cli/src/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { readSessionCapabilitySelectionFromMetadataV1, writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { openSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { writeRuntimeDescriptorV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '../../../../../../cli/src/api/clientCompatibility/cliClientCompatibility';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { startSocket } from '@/app/api/socket';
import { registerExternalActionRoutes } from '../actions/registerExternalActionRoutes';
import { registerExternalActionRpcHandler } from '../../../../../../cli/src/rpc/handlers/externalAction';
import { createDaemonExternalActionTargetResolver } from '../../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { verifyExternalActionExecutionAuthorizationCurrent } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions';
import type { Fastify as AppFastify } from '@/app/api/types';
import { accountRoutes } from '../account/accountRoutes';
import { registerPluginAvailabilityRoutes } from '@/app/plugins/availability/routes';
import * as cliPersistence from '../../../../../../cli/src/persistence';
import { artifactsRoutes } from './artifactsRoutes';
import { sessionRoutes } from '../session/sessionRoutes';
import { featuresRoutes } from '../features/featuresRoutes';
import { machinesRoutes } from '../machines/machinesRoutes';
import { db } from '@/storage/db';
import { eventRouter } from '@/app/events/eventRouter';
import { resolveServerFeaturePayload } from '@/app/features/catalog/resolveServerFeaturePayload';
import { serverFeatureRegistry } from '@/app/features/catalog/serverFeatureRegistry';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import serverIntegrationConfig from '../../../../../vitest.integration.config';

describe('capability Actions through the production CLI host, HTTP, SQLite and Socket.IO', () => {
    let harness: LightSqliteHarness;
    let app: AppFastify;
    let origin: string;
    let accountId: string;
    let token: string;
    let socket: Socket;
    let executor: ReturnType<typeof createActionExecutor>;
    const updates: unknown[] = [];
    const forbiddenResponses: { path: string; body: unknown }[] = [];
    const context = { surface: 'cli', authority: 'present_user', bypassApprovals: true } as const;
    const markdown = '---\nname: review\ndescription: Review a change\n---\nRead the diff.\n';
    const files: SkillFileInputV1[] = [
        { path: 'SKILL.md', contentBase64: Buffer.from(markdown).toString('base64'), contentKind: 'utf8', unixMode: 0o644 },
        { path: 'scripts/check.sh', contentBase64: Buffer.from('#!/bin/sh\nexit 0\n').toString('base64'), contentKind: 'utf8', unixMode: 0o755 },
    ];

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-capability-action-seams-', initAuth: true,
            initEncrypt: true, initFiles: true, env: {
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
            } });
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        accountId = account.id;
        token = await auth.createToken(accountId, undefined, { kind: 'account', authority: 'present_user' });
        app = Fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        enableErrorHandlers(app);
        enableAuthentication(app);
        app.addHook('onSend', async (request, reply, payload) => {
            if (reply.statusCode === 403) forbiddenResponses.push({ path: request.url, body: payload });
            return payload;
        });
        accountRoutes(app);
        artifactsRoutes(app);
        sessionRoutes(app);
        featuresRoutes(app);
        machinesRoutes(app);
        registerPluginAvailabilityRoutes(app);
        startSocket(app);
        registerExternalActionRoutes(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected the HTTP listener');
        origin = `http://127.0.0.1:${address.port}`;
        const policy = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
            'skills.create': ['cli', 'agent'], 'mcp.servers.create': ['cli'],
        } });
        const policyWrite = await app.inject({ method: 'POST', url: '/v2/account/settings', headers: {
            authorization: `Bearer ${token}`, ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        }, payload: { expectedVersion: 0, content: { t: 'plain', v: { actionsSettingsV1: policy } } } });
        expect(policyWrite.statusCode, policyWrite.body).toBe(200);
        expect(policyWrite.json()).toMatchObject({ success: true });
        // Daemon construction follows Account bootstrap; the full CLI factory also
        // prepares its own Account before executing a compiled command.
        const settings = await runWithServerHttpBaseUrl(origin, () => bootstrapAccountSettingsContext({
            credentials: { token, encryption: null }, mode: 'blocking',
        }));
        expect(settings.source).toBe('network');
        executor = runWithServerHttpBaseUrl(origin, () => createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
            serverId: origin, serverHttpBaseUrl: origin, sessionId: '', mode: 'plain', ctx: null,
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
                features: resolveServerFeaturePayload(process.env, serverFeatureRegistry) }),
        })));
        socket = ioClient(origin, { path: '/v1/updates/', transports: ['websocket'], autoConnect: false,
            reconnection: false, auth: { token, clientType: 'user-scoped', clientPurpose: 'sync',
                ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } });
        socket.on('update', update => updates.push(update));
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('connect_error', reject);
            socket.connect();
        });
        await socket.emitWithAck(SOCKET_RPC_EVENTS.CALL, { method: 'neutral.missing', params: {} });
    }, 120_000);

    afterAll(async () => {
        socket?.close();
        try { await app?.close(); } finally { eventRouter.clearIo(); await harness?.close(); }
    });
    afterEach(() => vi.unstubAllEnvs());

    async function readRules() {
        const response = await fetch(`${origin}${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`, {
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        const wire = PromptLibraryRowReadResponseV1Schema.parse(await response.json());
        if (wire.status === 'absent' || wire.status === 'deleted') return [];
        if (wire.status !== 'present') throw new Error('Expected persisted skill rules');
        const opened = openPromptLibraryContentV1({ key: 'skill-rules', mode: 'plain', material: null, content: wire.content });
        if (opened.status !== 'opened' || opened.record.key !== 'skill-rules') throw new Error('Expected opened skill rules');
        return opened.record.value.rules;
    }

    it('lists and reads the bundled happier skill through the real Action host and preserves Off without an Artifact', async () => {
        const listed = await executor.execute('skills.list', {}, context);
        expect(listed).toMatchObject({ ok: true });
        if (!listed.ok) throw new Error('Expected skill list');
        const stub = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(listed.result).items.find(item => item.skillId === 'happier:happier');
        expect(stub).toMatchObject({ provenance: { kind: 'first_party' }, rules: [] });
        if (!stub) throw new Error('Bundled skill missing from real host');
        const read = await executor.execute('skills.read', { skillId: stub.skillId, file: 'SKILL.md' }, context);
        expect(read).toMatchObject({ ok: true });
        if (!read.ok) throw new Error('Expected bundled read');
        const detail = SkillReadResultV1Schema.parse(read.result);
        expect(detail).toMatchObject({ revision: stub.revision, provenance: { kind: 'first_party' }, skillMd: expect.stringContaining('happier skills --help') });
        const beforeArtifacts = await db.artifact.count({ where: { accountId } });
        for (const actionId of ['skills.update', 'skills.delete'] as const) {
            expect(await executor.execute(actionId, { skillId: stub.skillId, expectedRevision: stub.revision }, context))
                .toMatchObject({ ok: false, errorCode: 'first_party_read_only' });
        }
        const off = await executor.execute('skills.rules.set', { items: [{ skillId: stub.skillId }],
            change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'off' } } }, context);
        expect(off).toMatchObject({ ok: true, result: { ok: true } });
        const reloaded = await executor.execute('skills.list', {}, context);
        if (!reloaded.ok) throw new Error('Expected reloaded library');
        expect(SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(reloaded.result).items.find(item => item.skillId === stub.skillId)?.rules).toEqual([expect.objectContaining({ target: { t: 'allMachines' }, enabled: false })]);
        expect(await db.artifact.count({ where: { accountId } })).toBe(beforeArtifacts);
        // Return the shared built-in to its implicit default for neighboring tests.
        expect(await executor.execute('skills.rules.set', { items: [{ skillId: stub.skillId }],
            change: { kind: 'replace', rules: [] } }, context)).toMatchObject({ ok: true, result: { ok: true } });
    });

    it('applies a dollar library pick through the registered Session Action and strict SQLite metadata consumer', async () => {
        const credentials = { token, encryption: null } as const;
        const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers: {
            authorization: `Bearer ${token}`, ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        }, payload: { tag: 'dollar-pick-session', encryptionMode: 'plain', dataEncryptionKey: null,
            ...buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
                metadata: writeRuntimeDescriptorV1ToMetadata({ path: tmpdir(), host: 'capabilities-test' }, { v: 1, agentId: 'claude', agent: {} }), agentState: null }),
        } });
        expect(created.statusCode).toBe(200);
        const session = await db.session.findFirstOrThrow({ where: { accountId, tag: 'dollar-pick-session' } });
        const listed = await executor.execute('skills.list', {}, context);
        if (!listed.ok) throw new Error('Expected library');
        const libraryItems = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(listed.result).items;
        const row = buildSkillComposerGroups({ open: true, query: 'happier', agentId: 'claude', machineId: null,
            libraryItems, sessionItems: [], found: null }).flatMap(group => group.rows).find(row => row.skillId === 'happier:happier');
        if (!row) throw new Error('Expected bundled picker row');
        const picked = await pickSkillComposerRow(row, { setItem: async (kind, id, state) => {
            const result = await executor.execute('session.capabilities.set', { sessionId: session.id, kind, id, state }, context);
            if (!result.ok) return { ok: false as const, message: result.error };
            const output = SessionCapabilitiesSetOutputV1Schema.parse(result.result);
            return output.ok ? { ok: true as const } : { ok: false as const, message: output.code };
        } });
        expect(picked).toMatchObject({ ok: true });
        if (!picked.ok) throw new Error(picked.message);
        expect(MentionRefV1Schema.parse(picked.mention)).toEqual({ kind: 'happier.skill', ref: 'skill:happier:happier', token: '[happier](happier-ref:skill:happier:happier)', label: 'happier' });
        const stored = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        if (!stored.ownerMetadata) throw new Error('Missing strict owner tuple');
        const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: 'plain', material: null, envelope: JSON.parse(stored.ownerMetadata) });
        if (!opened.ok) throw new Error('Unreadable owner tuple');
        const selection = readSessionCapabilitySelectionFromMetadataV1(projectSessionOwnerCompatibilityViewV1({
            sharedMetadata: JSON.parse(stored.metadata), ownerMetadata: opened.ownerMetadata,
        }));
        expect(selection.skills.forceIncludeSkillIds).toContain('happier:happier');
    });

    it('admits one-time legacy skill consumption through the strict server row schema and real SQLite CAS', async () => {
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewerToken = await auth.createToken(viewer.id, undefined, { kind: 'account', authority: 'present_user' });
        const headers = { authorization: `Bearer ${viewerToken}`, 'content-type': 'application/json',
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders() };
        const readRows = async () => {
            const response = await fetch(`${origin}${PROMPT_LIBRARY_ROWS_ROUTE_V1}`, { headers });
            expect(response.status).toBe(200);
            return PromptLibraryRowsListResponseV1Schema.parse(await response.json());
        };
        const writeRecord = async (input: { record: PromptLibraryRecordV1; expectedRevision: number | 'absent'; sourceSettingsVersion?: number }) => {
            const mutation = PromptLibraryRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision,
                content: sealPromptLibraryContentV1({ mode: 'plain', material: null, record: input.record }),
                ...(input.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: input.sourceSettingsVersion }) });
            // The production registration parses this producer output through
            // asServerProtocolZod, then the reserved row owner commits SQLite.
            const response = await fetch(`${origin}${PROMPT_LIBRARY_ROWS_ROUTE_V1}/${input.record.key}`, {
                method: 'POST', headers, body: JSON.stringify(mutation),
            });
            expect(response.status, await response.clone().text()).toBe(200);
            return PromptLibraryRowMutationResponseV1Schema.parse(await response.json());
        };
        // First activation goes through the batched row route, as the production clients do.
        const initializeRecords = async (input: { records: readonly PromptLibraryRecordV1[]; sourceSettingsVersion: number }) => {
            const initialization = PromptLibraryRowsInitializationV1Schema.parse({ sourceSettingsVersion: input.sourceSettingsVersion,
                rows: input.records.map(record => ({ key: record.key, content: sealPromptLibraryContentV1({ mode: 'plain', material: null, record }) })) });
            const response = await fetch(`${origin}${PROMPT_LIBRARY_ROWS_ROUTE_V1}`, { method: 'POST', headers, body: JSON.stringify(initialization) });
            expect(response.status, await response.clone().text()).toBe(200);
            return PromptLibraryRowsInitializationResponseV1Schema.parse(await response.json());
        };
        let artifactsAvailable = true;
        const load = () => loadPromptLibraryCatalogV1({ mode: 'plain', material: null, readRows,
            transfer: { readSourceSnapshot: async () => ({ raw: { promptStacksV1: capturedPickerStack.stacks }, version: 0 }),
                initializeRecords },
            skillMigration: { writeRecord, readArtifact: async ref => artifactsAvailable || ref.artifactId !== 'session-control-skill'
                ? capturedPickerStack.artifacts.find(artifact => artifact.id === ref.artifactId) ?? null : null },
        });
        const initial = await load();
        const read = readPromptLibraryCatalogRecordV1({ catalog: initial, key: 'skill-rules' });
        if (read.status !== 'ready' || read.record.key !== 'skill-rules') throw new Error('Missing migrated rules');
        expect(read.record.value).toMatchObject({ consumedLegacyEntryIds: ['migrated-stack:account:skill-entry'],
            rules: expect.arrayContaining([expect.objectContaining({ skillId: 'session-control-skill' })]) });
        expect(await removeSkillRulesV1({ serverId: origin, assertCurrent: () => {},
            readCatalog: async () => ({ catalog: await load() }), writeRecord,
        }, 'session-control-skill')).toBe(true);
        // Only the consumed skill is unavailable. Generic neighbors still classify.
        artifactsAvailable = false;
        const beforeReload = await readRows();
        const reloaded = await load();
        expect(reloaded.status).toBe('ready');
        const removed = readPromptLibraryCatalogRecordV1({ catalog: reloaded, key: 'skill-rules' });
        expect(removed).toMatchObject({ status: 'ready', record: { value: {
            consumedLegacyEntryIds: ['migrated-stack:account:skill-entry'],
        } } });
        if (removed.status !== 'ready' || removed.record.key !== 'skill-rules') throw new Error('Missing rules after removal');
        expect(removed.record.value.rules.some(rule => rule.skillId === 'session-control-skill')).toBe(false);
        expect(await readRows()).toEqual(beforeReload);
    });

    it('keeps personal secrets and registry token bindings in the private resource and reference-census owners', async () => {
        vi.stubEnv('HAPPIER_FEATURE_TEAMS__ENABLED', 'false');
        const credentials = { token, encryption: null, credentialProvenance: 'stored_session' } as const;
        const privateExecutor = await createCliActionExecutorFromCredentials({ credentials, serverId: origin, serverApiUrl: origin,
            readCredentials: async () => credentials, pluginActionExecutionOwner: 'current_process',
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
                features: resolveServerFeaturePayload(process.env, serverFeatureRegistry) }),
        });
        const originalValue = 'capability-private-fixture-original';
        const rotatedValue = 'capability-private-fixture-rotated';
        const created = await privateExecutor.execute('secrets.create', { name: 'Registry private fixture', kind: 'token', value: originalValue }, context);
        expect(created, JSON.stringify({ created, forbiddenResponses })).toMatchObject({ ok: true });
        if (!created.ok) throw new Error('Expected private resource creation');
        const secret = secretOutputs['secrets.create'].parse(created.result);
        expect(parseSavedSecretRefV1(secret.secretRef)).toEqual({ kind: 'shared_resource', resourceId: secret.secretId });
        expect(await db.savedSecretResource.findUniqueOrThrow({ where: { id: secret.secretId },
            select: { ownerAccountId: true, encryptionMode: true, revision: true } }))
            .toEqual({ ownerAccountId: accountId, encryptionMode: 'plain', revision: 1 });
        expect(await db.savedSecretAccountGrant.count({ where: { resourceId: secret.secretId } })).toBe(0);
        const listed = await privateExecutor.execute('secrets.list', {}, context);
        expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true });
        if (!listed.ok) throw new Error('Expected private metadata');
        expect(secretOutputs['secrets.list'].parse(listed.result).secrets).toContainEqual({ secretId: secret.secretId,
            name: 'Registry private fixture', kind: 'token', secretRef: secret.secretRef, updatedAt: 1 });
        expect(JSON.stringify(listed)).not.toContain(originalValue);
        const stale = await privateExecutor.execute('secrets.update', { secretId: secret.secretId, name: 'Stale update', expectedUpdatedAt: 2 }, context);
        expect(stale, JSON.stringify(stale)).toMatchObject({ ok: false, errorCode: 'revision_conflict' });
        const rotated = await privateExecutor.execute('secrets.update', { secretId: secret.secretId, value: rotatedValue, expectedUpdatedAt: 1 }, context);
        expect(rotated, JSON.stringify(rotated)).toMatchObject({ ok: true });
        if (!rotated.ok) throw new Error('Expected private resource rotation');
        expect(secretOutputs['secrets.update'].parse(rotated.result)).toEqual({ secretId: secret.secretId, updatedAt: 2 });
        const liveFetch = globalThis.fetch;
        const outboundCredentials: (string | null)[] = [];
        // Only GitHub is external. The factory, Action policy, Account routes,
        // row proofs, SQLite custody and subscribed Socket.IO remain real.
        const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
            if (!['api.github.com', 'raw.githubusercontent.com'].includes(url.hostname)) return liveFetch(input, init);
            outboundCredentials.push(new Headers(init?.headers).get('authorization'));
            if (url.hostname === 'raw.githubusercontent.com') return new Response('', { status: 404 });
            return Response.json(url.pathname.includes('/commits/') ? { sha: '1'.repeat(40) }
                : url.pathname.includes('/git/trees/') ? { sha: '2'.repeat(40), tree: [], truncated: false }
                : { name: 'private', default_branch: 'main' });
        });
        try {
            const sourceResult = await privateExecutor.execute('registries.sources.create', {
                url: 'https://github.com/capability-private-fixture/registry', token: { secretRef: secret.secretRef },
            }, context);
            expect(sourceResult, JSON.stringify(sourceResult)).toMatchObject({ ok: true });
            if (!sourceResult.ok) throw new Error('Expected credentialed source creation');
            const source = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.create'].parse(sourceResult.result).source;
            expect(source.token).toEqual({ secretRef: secret.secretRef });
            const page = await privateExecutor.execute('registries.items.list', { kind: 'skill', sourceIds: [source.id], refresh: true }, context);
            expect(page, JSON.stringify(page)).toMatchObject({ ok: true });
            if (!page.ok) throw new Error('Expected private registry list');
            expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(page.result).pages[0]?.status.state).toBe('ok');
            expect(outboundCredentials.length).toBeGreaterThan(0);
            expect(outboundCredentials.every(header => header === `Bearer ${rotatedValue}`)).toBe(true);
            expect(JSON.stringify(page)).not.toContain(rotatedValue);
            const blocked = await privateExecutor.execute('secrets.delete', { secretId: secret.secretId, expectedUpdatedAt: 2 }, context);
            expect(blocked, JSON.stringify(blocked)).toMatchObject({ ok: false, errorCode: 'in_use', details: {
                references: [{ owner: 'registrySource', path: 'registrySourcesCatalog.sources[0].token.secretRef' }],
            } });
            expect(await db.savedSecretResource.findUnique({ where: { id: secret.secretId } })).not.toBeNull();
            const cleared = await privateExecutor.execute('registries.sources.token.set', { sourceId: source.id, token: null }, context);
            expect(cleared, JSON.stringify(cleared)).toMatchObject({ ok: true });
            const deleted = await privateExecutor.execute('secrets.delete', { secretId: secret.secretId, expectedUpdatedAt: 2 }, context);
            expect(deleted, JSON.stringify(deleted)).toMatchObject({ ok: true });
            if (!deleted.ok) throw new Error('Expected unreferenced resource deletion');
            secretOutputs['secrets.delete'].parse(deleted.result);
            expect(await db.savedSecretResource.findUnique({ where: { id: secret.secretId } })).toBeNull();
        } finally {
            upstream.mockRestore();
        }
    });

    it('adds a captured MCP registry server through the registered reader, mapping and Account catalog', async () => {
        const registryOrigin = 'https://registry.modelcontextprotocol.io';
        const sourceId = 'builtin:mcp-registry';
        const wire = structuredClone(MCP_REGISTRY_V01_READ_FIXTURE);
        const packageWire = structuredClone(MCP_REGISTRY_V01_PACKAGE_FIXTURE);
        packageWire.server.name += '-package';
        const actualFetch = globalThis.fetch;
        const requestedVersions: string[] = [];
        // Intercept only the third-party Registry. Home reads and catalog CAS
        // still traverse the real HTTP listener and SQLite mutation owner.
        const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.origin !== registryOrigin) return actualFetch(input, init);
            const version = decodeURIComponent(url.pathname.split('/versions/')[1] ?? '');
            const itemId = decodeURIComponent(url.pathname.split('/servers/')[1]?.split('/versions/')[0] ?? '');
            const response = itemId === packageWire.server.name ? packageWire : wire;
            requestedVersions.push(version);
            return version === 'latest' || version === response.server.version
                ? Response.json(response) : new Response(null, { status: 404 });
        });
        const readCatalog = async () => {
            const response = await fetch(`${origin}${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, {
                headers: { authorization: `Bearer ${token}` },
            });
            expect(response.status).toBe(200);
            const row = McpServerCatalogRowReadResponseV1Schema.parse(await response.json());
            if (row.status !== 'present') throw new Error('Expected the durable MCP catalog');
            const opened = openMcpServerCatalogContentV1({ mode: 'plain', material: null, content: row.content });
            if (opened.status !== 'opened') throw new Error('Expected the MCP catalog strict consumer to open');
            return { row, catalog: McpServerCatalogV1Schema.parse(opened.catalog) };
        };
        try {
            const read = await executor.execute('registries.items.read', {
                kind: 'mcpServer', sourceId, itemId: wire.server.name,
            }, context);
            expect(read, JSON.stringify(read)).toMatchObject({ ok: true });
            if (!read.ok) throw new Error('Expected the registered MCP registry reader');
            const produced = RegistryItemV1Schema.parse(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(read.result).item);
            expect(produced.summary).toMatchObject({ sourceId, itemId: wire.server.name, version: wire.server.version });
            const before = await executor.execute('mcp.servers.list', {}, context);
            expect(before, JSON.stringify(before)).toMatchObject({ ok: true });
            if (!before.ok) throw new Error('Expected the current MCP catalog revision');
            const snapshot = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].parse(before.result);
            if (snapshot.status !== 'ready') throw new Error('Expected an active MCP catalog');
            const authorization = { t: 'template', template: 'Bearer {api_key}',
                vars: { api_key: { t: 'literal', v: 'registry-seam-key' } } } as const;
            const createInput = {
                expectedRevision: snapshot.revision, from: { registry: {
                    sourceId, itemId: produced.summary.itemId, version: produced.summary.version,
                } }, inputs: { Authorization: authorization },
            };
            const beforeMiswiring = await readCatalog();
            // Construct the same production MCP host without its Registry binding.
            // Only the unused Machine transport is guarded; the real store remains.
            const misboundMcpHost = createCliMcpServerActionExecuteV1({ credentials: { token, encryption: null },
                serverId: origin, serverHttpBaseUrl: origin, callMachineAction: async () => {
                    throw new Error('Registry catalog authoring does not call a Machine');
                } });
            const misbound = runWithServerHttpBaseUrl(origin, () => createActionExecutor({
                ...createCliActionDeps({ token, credentials: { token, encryption: null }, serverId: origin,
                    serverHttpBaseUrl: origin, sessionId: '', mode: 'plain', ctx: null,
                    resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
                        features: resolveServerFeaturePayload(process.env, serverFeatureRegistry) }),
                }), mcpServerAction: misboundMcpHost,
            }));
            expect(await misbound.execute('mcp.servers.create', createInput, context))
                .toMatchObject({ ok: false, errorCode: 'registry_unavailable' });
            expect(await readCatalog()).toEqual(beforeMiswiring);
            const created = await executor.execute('mcp.servers.create', createInput, context);
            expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
            if (!created.ok) throw new Error('Expected the composed registry create');
            const receipt = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.create'].parse(created.result);
            expect(receipt).toMatchObject({ status: 'updated' });
            if (receipt.status !== 'updated') throw new Error('Expected the committed catalog receipt');
            await vi.waitFor(() => expect(updates.some(update => {
                const parsed = UpdateContainerSchema.safeParse(update);
                return parsed.success && parsed.data.body.t === 'account-change' && parsed.data.seq === receipt.cursor;
            })).toBe(true));
            const persisted = await readCatalog();
            const entry = persisted.catalog.servers.find(server => server.origin?.kind === 'registry'
                && server.origin.provenance.itemId === wire.server.name);
            expect(entry).toMatchObject({ transport: 'http', remote: { url: wire.server.remotes[0]!.url,
                headers: { Authorization: authorization } }, origin: { kind: 'registry', provenance: {
                sourceId, format: 'mcp-registry', sourceUrl: registryOrigin, itemId: wire.server.name,
                ref: { kind: 'version', version: wire.server.version },
            } } });
            if (!entry) throw new Error('Expected the created registry server');
            expect(persisted.catalog.bindings.filter(rule => rule.serverId === entry.id)).toMatchObject([
                { target: { t: 'allMachines' }, enabled: true },
            ]);
            expect(requestedVersions).toContain(wire.server.version);
            const current = await executor.execute('mcp.servers.read', { serverId: entry.id }, context);
            expect(current, JSON.stringify(current)).toMatchObject({ ok: true });
            if (!current.ok) throw new Error('Expected the created server through its Action');
            expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.read'].parse(current.result))
                .toMatchObject({ status: 'present', server: entry, complete: true });
            const renamed = await executor.execute('mcp.servers.update', {
                expectedRevision: persisted.row.revision, entry: { ...entry, name: 'registry_personal_name',
                    tools: { default: 'allow_read_only', overrides: { write: 'off' } } },
            }, context);
            expect(renamed, JSON.stringify(renamed)).toMatchObject({ ok: true });
            const rulesChanged = await executor.execute('mcp.rules.set', {
                items: [{ serverId: entry.id }], change: { kind: 'replace', rules: [{ target: { t: 'allMachines' }, enabled: false }] },
            }, context);
            expect(rulesChanged, JSON.stringify(rulesChanged)).toMatchObject({ ok: true });
            const beforeUpdate = await readCatalog();
            wire.server.version = '1.1.0';
            wire.server.remotes[0]!.url = 'https://playwrightgen.com/api/mcp/v2';
            wire.server.remotes[0]!.headers.push({ name: 'X-Workspace', description: 'Required workspace for the updated service',
                isRequired: true, isSecret: false });
            const unavailablePin = await executor.execute('mcp.servers.update', {
                expectedRevision: beforeUpdate.row.revision, serverId: entry.id,
                from: { registry: { sourceId, itemId: wire.server.name, version: '1.0.0' } },
                inputs: { 'X-Workspace': { t: 'literal', v: 'selected-workspace' } },
            }, context);
            expect(unavailablePin, JSON.stringify(unavailablePin)).toMatchObject({ ok: false });
            expect(await readCatalog()).toEqual(beforeUpdate);
            const updateInput = { expectedRevision: beforeUpdate.row.revision, serverId: entry.id,
                from: { registry: { sourceId, itemId: wire.server.name, version: wire.server.version } } };
            const missing = await executor.execute('mcp.servers.update', updateInput, context);
            expect(missing, JSON.stringify(missing)).toMatchObject({ ok: false, errorCode: 'missing_values',
                details: { missingValues: [{ key: 'X-Workspace', target: 'header', serverName: 'registry_personal_name' }] } });
            expect(await readCatalog()).toEqual(beforeUpdate);
            const workspace = { t: 'literal', v: 'selected-workspace' } as const;
            const updated = await executor.execute('mcp.servers.update', {
                ...updateInput, inputs: { 'X-Workspace': workspace },
            }, context);
            expect(updated, JSON.stringify(updated)).toMatchObject({ ok: true });
            if (!updated.ok) throw new Error('Expected the explicit registry update');
            expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.update'].parse(updated.result))
                .toMatchObject({ status: 'updated' });
            const afterUpdate = await readCatalog();
            expect(afterUpdate.catalog.servers.find(server => server.id === entry.id)).toMatchObject({
                name: 'registry_personal_name', remote: { url: wire.server.remotes[0]!.url,
                    headers: { Authorization: authorization, 'X-Workspace': workspace } },
                tools: { default: 'allow_read_only', overrides: { write: 'off' } },
                origin: { kind: 'registry', provenance: { ref: { kind: 'version', version: '1.1.0' } } },
            });
            expect(afterUpdate.catalog.bindings).toEqual(beforeUpdate.catalog.bindings);
            // The fixture owner's package variant uses the published external
            // schema. It exercises env mapping through the same reader/Action.
            const packageRead = await executor.execute('registries.items.read', {
                kind: 'mcpServer', sourceId, itemId: packageWire.server.name,
            }, context);
            expect(packageRead, JSON.stringify(packageRead)).toMatchObject({ ok: true });
            if (!packageRead.ok) throw new Error('Expected the package registry record');
            const packageItem = RegistryItemV1Schema.parse(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(packageRead.result).item);
            const apiKey = { t: 'literal', v: '${REGISTRY_API_KEY}' } as const;
            const packageCreated = await executor.execute('mcp.servers.create', {
                expectedRevision: afterUpdate.row.revision, from: { registry: {
                    sourceId, itemId: packageItem.summary.itemId, version: packageItem.summary.version,
                } }, inputs: { API_KEY: apiKey },
                where: { kind: 'replace', rules: [{ target: { t: 'allMachines' }, enabled: false }] },
            }, context);
            expect(packageCreated, JSON.stringify(packageCreated)).toMatchObject({ ok: true });
            if (!packageCreated.ok) throw new Error('Expected the package registry create');
            expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.create'].parse(packageCreated.result))
                .toMatchObject({ status: 'updated' });
            const final = await readCatalog();
            const packageEntry = final.catalog.servers.find(server => server.origin?.kind === 'registry'
                && server.origin.provenance.itemId === packageWire.server.name);
            const pkg = packageWire.server.packages[0]!;
            expect(packageEntry).toMatchObject({ transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', `${pkg.identifier}@${pkg.version}`, '--mode', 'read'] },
                env: { API_KEY: apiKey, REGION: { t: 'literal', v: 'eu' } },
                origin: { kind: 'registry', provenance: { sourceId, itemId: packageWire.server.name,
                    ref: { kind: 'version', version: packageWire.server.version } } },
            });
            if (!packageEntry) throw new Error('Expected the persisted package registry entry');
            expect(final.catalog.bindings.filter(rule => rule.serverId === packageEntry.id)).toMatchObject([
                { target: { t: 'allMachines' }, enabled: false },
            ]);
            packageWire.server.version = '1.1.0';
            pkg.version = '2.3.5';
            const packageUpdated = await executor.execute('mcp.servers.update', {
                expectedRevision: final.row.revision, serverId: packageEntry.id,
                from: { registry: { sourceId, itemId: packageWire.server.name, version: packageWire.server.version } },
            }, context);
            expect(packageUpdated, JSON.stringify(packageUpdated)).toMatchObject({ ok: true });
            if (!packageUpdated.ok) throw new Error('Expected the package registry update');
            expect(MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.update'].parse(packageUpdated.result))
                .toMatchObject({ status: 'updated' });
            const repinned = await readCatalog();
            expect(repinned.catalog.servers.find(server => server.id === packageEntry.id)).toMatchObject({
                name: packageEntry.name, stdio: { command: 'npx', args: ['-y', `${pkg.identifier}@2.3.5`, '--mode', 'read'] },
                env: packageEntry.env, origin: { kind: 'registry', provenance: { ref: { kind: 'version', version: '1.1.0' } } },
            });
            expect(repinned.catalog.bindings).toEqual(final.catalog.bindings);

            // The released add spelling must reach the compiled Action, its real
            // credential factory and the same Account CAS used by registry adds.
            const credentials = { token, encryption: null, credentialProvenance: 'stored_session' } as const;
            const privateExecutor = await createCliActionExecutorFromCredentials({ credentials, serverId: origin, serverApiUrl: origin,
                readCredentials: async () => credentials, pluginActionExecutionOwner: 'current_process',
                resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
                    features: resolveServerFeaturePayload(process.env, serverFeatureRegistry) }),
            });
            const createdSecret = await privateExecutor.execute('secrets.create', {
                name: 'MCP argv token', value: 'mcp-argv-fixture-value',
            }, context);
            expect(createdSecret, JSON.stringify(createdSecret)).toMatchObject({ ok: true });
            if (!createdSecret.ok) throw new Error('Expected the private resource producer');
            const argvSecret = secretOutputs['secrets.create'].parse(createdSecret.result);
            const cliDeps: Partial<ActionCliExecutionDeps> = {
                readCredentialsFn: async () => credentials,
                readCredentialsForServerIdFn: async id => id === origin ? credentials : null,
                getServerProfileFn: async id => ({ id, name: 'Test Home', serverUrl: origin, webappUrl: origin,
                    createdAt: 0, updatedAt: 0, lastUsedAt: 0 }),
                createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params, pluginActionExecutionOwner: 'current_process' }),
            };
            const previousExitCode = process.exitCode;
            let output = '';
            const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
                output += String(chunk);
                const completed = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
                completed?.();
                return true;
            });
            try {
                process.exitCode = 0;
                expect(await tryHandleMcpServerCliCommand({ argv: ['mcp', 'servers', 'add', '--name', 'argv_stdio',
                    '--transport', 'stdio', '--command', 'mcp-fixture', '--arg', 'literal argument', '--arg=--read-only',
                    '--arg', '--server-id=not-a-selected-home', '--arg', '--',
                    '--env', `TOKEN=secret:${argvSecret.secretId}`, '--env', 'LITERAL=text:secret:not-a-reference',
                    '--server-id', origin, '--json'], actionExecutionDeps: cliDeps })).toBe(true);
                expect(process.exitCode ?? 0).toBe(0);
                const envelope: unknown = JSON.parse(output.trim());
                expect(envelope, JSON.stringify(envelope)).toMatchObject({ ok: true });
                if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) throw new Error('Expected MCP add CLI output');
                const argvReceipt = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.create'].parse(envelope.data);
                expect(argvReceipt).toMatchObject({ status: 'updated' });
                if (argvReceipt.status !== 'updated') throw new Error('Expected MCP argv CAS receipt');
                expect(argvReceipt.revision).not.toBe(repinned.row.revision);
                const afterArgv = await readCatalog();
                const argvEntry = afterArgv.catalog.servers.find(server => server.name === 'argv_stdio');
                expect(argvEntry).toMatchObject({ transport: 'stdio', stdio: {
                    command: 'mcp-fixture', args: ['literal argument', '--read-only', '--server-id=not-a-selected-home', '--'],
                }, env: { TOKEN: { t: 'savedSecret', secretId: argvSecret.secretRef },
                    LITERAL: { t: 'literal', v: 'secret:not-a-reference' } } });
                if (!argvEntry) throw new Error('Expected MCP argv entry in strict persisted catalog');
                expect(afterArgv.row.revision).toBe(argvReceipt.revision);
                expect(afterArgv.catalog.bindings.filter(rule => rule.serverId === argvEntry.id)).toMatchObject([
                    { target: { t: 'allMachines' }, enabled: true },
                ]);
                expect(afterArgv.catalog.servers.filter(server => server.id !== argvEntry.id)).toEqual(repinned.catalog.servers);

                const listCommand = findCompiledActionCliCommand(['mcp', 'servers', 'list'], listCompiledActionCliCommands());
                if (!listCommand) throw new Error('Expected compiled MCP list');
                output = '';
                await runCompiledActionCliCommand({ command: listCommand,
                    argv: ['mcp', 'servers', 'list', '--server-id', origin, '--json'], deps: cliDeps });
                expect(process.exitCode ?? 0).toBe(0);
                const listed: unknown = JSON.parse(output.trim());
                expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true });
                if (!listed || typeof listed !== 'object' || !('data' in listed)) throw new Error('Expected MCP list CLI output');
                const cliSnapshot = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].parse(listed.data);
                expect(cliSnapshot).toMatchObject({ status: 'ready', authority: 'active', revision: argvReceipt.revision });
                if (cliSnapshot.status !== 'ready') throw new Error('Expected ready MCP CLI catalog');
                expect(cliSnapshot.catalog.servers.find(server => server.id === argvEntry.id)).toMatchObject({
                    id: argvEntry.id, name: argvEntry.name, transport: 'stdio',
                });
            } finally {
                stdout.mockRestore();
                process.exitCode = previousExitCode;
            }
        } finally { upstream.mockRestore(); }
    });

    it('admits a captured registry Agent through Account CAS and installs it through the registered Machine job owner', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-registry-agent-seam-'));
        const credentials = { token, encryption: null } as const;
        const source = BUILT_IN_REGISTRY_SOURCES_V1.find(entry => entry.format === 'acp-registry');
        if (!source) throw new Error('Expected the registered ACP Registry source');
        const registry = structuredClone(ACP_REGISTRY_V1_FIXTURE);
        const npmEntry = registry.agents.find(entry => entry.id === 'claude-acp');
        if (!npmEntry || !('npx' in npmEntry.distribution) || !npmEntry.distribution.npx) throw new Error('Expected captured npm Agent');
        const actualFetch = globalThis.fetch;
        // The registry CDN is external. Its captured wire record still traverses the
        // production reader, registry Action, mapper and strict persistence boundary.
        const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            return url === source.url ? Response.json(registry) : actualFetch(input, init);
        });
        const pnpm = join(root, 'pnpm');
        const env = { ...process.env, HAPPIER_HOME_DIR: root, HAPPIER_PNPM_BIN: pnpm, HAPPIER_JS_RUNTIME_PATH: process.execPath };
        const owner = createAgentInstallJobOwner({ accountId, env,
            installerDeps: { execFileWithDeadline: async (command, args, options) => {
                if (command !== pnpm) return promisify(execFile)(command, [...args], { env: options.env, encoding: 'utf8' });
                // Substitute only npm's process. The real installer selects its bin,
                // records the package/definition identity and promotes the workspace.
                const workspace = args[1]!;
                const packageRoot = join(workspace, 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
                await mkdir(packageRoot, { recursive: true });
                await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
                    name: '@agentclientprotocol/claude-agent-acp', version: args[3]!.split('@').at(-1), bin: { cli: 'cli.js' },
                }));
                const bin = join(workspace, 'node_modules', '.bin', 'cli');
                await mkdir(dirname(bin), { recursive: true });
                await writeFile(bin, '#!/bin/sh\nprintf "registry-agent\\n"\n');
                await chmod(bin, 0o755);
                return { stdout: '', stderr: '' };
            } },
        });
        // Stored sign-in reads are an OS boundary absent from this standalone daemon fixture.
        const storedCredentials = vi.spyOn(cliPersistence, 'readStoredCredentials').mockResolvedValue(credentials);
        const previousHome = process.env.HAPPIER_HOME_DIR;
        const rpcDiagnostics: unknown[] = [];
        const reloadController = createPluginReloadController({ happyHomeDir: root,
            // This Machine hosts the real custom-ACP job owner, not executable
            // first-party plugins. Use the runtime's supported scope; retain its
            // real contribution catalog and do not forge activation/custody.
            resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ happyHomeDir: root, pluginIds: [] }),
            invalidateCaches: invalidateDaemonContributionRegistryProjectionCache });
        let runtimeLease: PluginRuntimeRegistryLease | undefined;
        let daemonSocket: Socket | undefined;
        let manager: RpcHandlerManager | undefined;
        try {
        process.env.HAPPIER_HOME_DIR = root;
        const serverIdentityId = await getOrCreateServerIdentityId();
        await createPluginRegistryStateStore({ happyHomeDir: root }).initialize();
        runtimeLease = await runWithServerHttpBaseUrl(origin, () => reloadController.acquireRuntimeRegistry());
        const runtimeRegistry = runtimeLease.registry;
        const machineId = randomUUID();
        const installationId = randomUUID();
        const installation = tweetnacl.sign.keyPair();
        const installationProof = signMachineInstallationProof({
            payload: { version: 1, installationId, machineId, accountId }, privateKey: installation.secretKey,
        });
        const registration = await app.inject({ method: 'POST', url: '/v1/machines', headers: {
            authorization: `Bearer ${token}`, ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        }, payload: { id: machineId, installationId, installationPublicKey: encodeBase64(installation.publicKey, 'base64url'),
            installationProof, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            metadata: encodePlainMachineStoredContent({ host: 'registry-seam', platform: process.platform, arch: process.arch,
                homeDir: root, happyHomeDir: root, happyCliVersion: '0.3.0' }),
        } });
        expect(registration.statusCode, registration.body).toBe(200);
        const rpcManager = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain',
            logger: (message, data) => { if (message === '[RPC] Request completed') rpcDiagnostics.push(data); },
            authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId,
                resolveCustodianAccountId: async () => accountId, resolveInstallationId: () => installationId,
                verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
                    privateKey: installation.secretKey, daemonToken: token, serverHttpBaseUrl: origin }),
            }),
        });
        manager = rpcManager;
        let heldStart: Readonly<{ entered(): void; released: Promise<void> }> | null = null;
        const registrar = {
            registerHandler: (method, handler) => {
                rpcManager.registerHandler(method, async (request, context) => {
                    const held = method === RPC_METHODS.DAEMON_AGENTS_INSTALL_START ? heldStart : null;
                    if (held) { held.entered(); await held.released; }
                    // ApiMachine normally refreshes this Account catalog on
                    // changes. This standalone registered-handler harness uses
                    // the same real hydration producer, not an injected record.
                    if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_START) {
                        const catalog = await refreshDaemonAcpCatalog({ credentials, signal: context?.signal });
                        expect(catalog.status).toBe('ready');
                    }
                    try { return await handler(request, context); }
                    catch (error) {
                        if (error instanceof Error) rpcDiagnostics.push({ method, exception: error.name,
                            frames: error.stack?.split('\n').slice(1, 4) });
                        throw error;
                    }
                });
            },
        } satisfies RpcHandlerRegistrar;
        registerMachineAgentInstallJobRpcHandlers({ owner, rpcHandlerManager: registrar });
        // Standalone host fixture supplies its physical identity boundary; RPC admission stays real.
        registerCapabilitiesHandlers(registrar, { filesystemEffectAdmission: createFilesystemEffectAdmission({
            resolveHomeServerIdentityId: async () => serverIdentityId,
            resolveHostIdentity: async () => ({ custodianAccountId: accountId, machineId, installationId }),
        }) });
        registerDaemonContributionRegistryProjectionHandler(registrar, { processEnv: env,
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => reloadController.getState().generation,
            resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId, machineId }),
        });
        const machineSocket = ioClient(origin, { path: '/v1/updates/', transports: ['websocket'], autoConnect: false,
            reconnection: false, auth: { token, clientType: 'machine-scoped', machineId, installationId,
                installationPublicKey: encodeBase64(installation.publicKey, 'base64url'), installationProof,
                ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
            },
        });
        daemonSocket = machineSocket;
        machineSocket.on(SOCKET_RPC_EVENTS.REQUEST, (request, acknowledge) => {
            void runWithServerHttpBaseUrl(origin, () => rpcManager.handleRequest(request)).then(acknowledge);
        });
        machineSocket.on('connect', () => rpcManager.onSocketConnect(machineSocket));
        machineSocket.on('disconnect', () => rpcManager.onSocketDisconnect());
        const registryExecutor = createCliActionExecutorFromCredentials({
            credentials, serverId: origin, serverApiUrl: origin, serverIdentityId,
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
                features: resolveServerFeaturePayload(process.env, serverFeatureRegistry) }),
        });
        const readCatalog = async () => {
            const response = await fetch(`${origin}${ACP_CATALOG_ROWS_ROUTE_V1}`, { headers: { authorization: `Bearer ${token}` } });
            expect(response.status).toBe(200);
            const row = AcpCatalogRowReadResponseV1Schema.parse(await response.json());
            if (row.status !== 'present') throw new Error('Expected the durable ACP catalog row');
            const opened = openAcpCatalogContentV1({ mode: 'plain', material: null, content: row.content });
            if (opened.status !== 'opened') throw new Error('Expected readable ACP catalog');
            return { row, record: AcpCatalogRecordV1Schema.parse(opened.record) };
        };
            // The registered inventory reads the actual host environment and receipts.
            process.env.HAPPIER_HOME_DIR = root;
            await writeFile(pnpm, '#!/bin/sh\nexit 0\n');
            await chmod(pnpm, 0o755);
            const connected = new Promise<void>((resolve, reject) => {
                machineSocket.once('connect', resolve);
                machineSocket.once('connect_error', reject);
            });
            machineSocket.connect();
            await connected;
            const machine = await db.machine.findUniqueOrThrow({ where: { id: machineId } });
            const state = MachineUpdateStateRequestSchema.parse({ machineId,
                daemonState: encodePlainMachineStoredContent(parseMachinePublishedDaemonStateV1({ status: 'running' })),
                expectedVersion: machine.daemonStateVersion, expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            });
            const published = MachineUpdateStateResponseSchema.parse(await new Promise<unknown>(resolve => {
                machineSocket.emit('machine-update-state', state, resolve);
            }));
            expect(published).toMatchObject({ result: 'success', version: machine.daemonStateVersion + 1 });
            expect((await db.machine.findUniqueOrThrow({ where: { id: machineId } })).active).toBe(true);
            expect(await rpcManager.waitForRegisteredHandlers([
                RPC_METHODS.DAEMON_AGENTS_INSTALL_START, RPC_METHODS.DAEMON_AGENTS_INSTALL_READ,
                RPC_METHODS.CAPABILITIES_DETECT, RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            ], { timeoutMs: serverIntegrationConfig.test!.testTimeout! })).toEqual({ status: 'ready' });
            const read = await registryExecutor.execute('registries.items.read', { kind: 'agent', sourceId: source.id, itemId: npmEntry.id }, context);
            expect(read, JSON.stringify(read)).toMatchObject({ ok: true });
            if (!read.ok) throw new Error('Expected registry Agent read');
            const item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(read.result).item;
            const input = AgentsAcpBackendsInstallFromRegistryInputV1Schema.parse({
                fromRegistry: { sourceId: source.id, itemId: item.summary.itemId, version: item.summary.version }, installOn: [machineId],
            });
            const installed = await registryExecutor.execute('agents.acp.backends.installFromRegistry', input, context);
            expect(installed, JSON.stringify({ installed, rpcDiagnostics })).toMatchObject({ ok: true });
            if (!installed.ok) throw new Error('Expected registry admission and install');
            const result = AgentsAcpBackendsInstallFromRegistryOutputV1Schema.parse(installed.result);
            expect(result.jobs).toEqual([{ machineId, jobId: expect.any(String) }]);
            expect(result.definition).toMatchObject({ launch: { kind: 'npm', package: '@agentclientprotocol/claude-agent-acp', version: npmEntry.version },
                origin: { kind: 'registry', provenance: { sourceId: source.id, itemId: npmEntry.id, ref: { kind: 'version', version: npmEntry.version } } } });
            expect((await readCatalog()).record.definitions).toContainEqual(result.definition);
            const waitForJob = async (jobId: string, version: string, intent: 'install' | 'update') => {
                let completed: unknown;
                await vi.waitFor(async () => {
                    const status = await registryExecutor.execute('machines.agents.install.status', { machineId, jobId, cursor: 0 }, context);
                    expect(status, JSON.stringify(status)).toMatchObject({ ok: true });
                    if (!status.ok) throw new Error('Expected installed job read');
                    completed = DaemonAgentInstallReadResponseSchema.parse(status.result);
                    expect(completed).toMatchObject({ ok: true, done: true });
                }, { timeout: serverIntegrationConfig.test?.testTimeout });
                expect(completed).toMatchObject({ outcome: { kind: 'succeeded', version } });
                expect(owner.list(accountId)).toMatchObject({ ok: true,
                    jobs: [expect.objectContaining({ jobId, definitionId: result.definition.id, intent })] });
            };
            await waitForJob(result.jobs[0]!.jobId, npmEntry.version, 'install');
            const ready = await resolveAcpLaunch({ accountId, definition: result.definition, env, platform: process.platform, arch: process.arch });
            expect(ready.kind).toBe('ready');
            if (ready.kind !== 'ready') throw new Error('Expected ready executable');
            expect((await promisify(execFile)(ready.command, ready.args, { env: { ...env, ...ready.env } })).stdout).toBe('registry-agent\n');
            const beforeEdit = await readCatalog();
            const edited = await registryExecutor.execute('agents.acp.backends.upsert', {
                backend: { ...result.definition, env: { SEAM_ENV: { t: 'literal', v: 'personal-edit' } }, defaultModel: 'personal-model' },
                expectedRevision: beforeEdit.row.revision,
            }, context);
            expect(edited, JSON.stringify(edited)).toMatchObject({ ok: true });
            // An upstream change cannot silently replace the version the user reviewed.
            npmEntry.version = '0.89.2';
            npmEntry.distribution.npx.package = '@agentclientprotocol/claude-agent-acp@0.89.2';
            const checked = await registryExecutor.execute('registries.updates.check', { kind: 'agent', keys: [result.definition.id] }, context);
            expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
            if (!checked.ok) throw new Error('Expected Agent checker registration');
            const observation = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(checked.result);
            expect(observation.results).toEqual([{ kind: 'agent', key: result.definition.id,
                upstream: { state: 'update_available', latest: { kind: 'version', version: npmEntry.version } } }]);
            const observedCatalog = await readCatalog();
            expect(observedCatalog.record.definitions[0]).toMatchObject({ launch: { version: '0.89.1' },
                env: { SEAM_ENV: { t: 'literal', v: 'personal-edit' } }, origin: { upstream: observation.results[0]!.upstream } });
            expect(await registryExecutor.execute('registries.updates.check', { kind: 'agent', keys: [result.definition.id] }, context))
                .toMatchObject({ ok: true });
            expect((await readCatalog()).row.revision).toBe(observedCatalog.row.revision);
            expect(await registryExecutor.execute('agents.acp.backends.installFromRegistry', input, context)).toMatchObject({ ok: false });
            expect((await readCatalog()).record.definitions.find(entry => entry.id === result.definition.id))
                .toMatchObject({ launch: { version: '0.89.1' }, env: { SEAM_ENV: { t: 'literal', v: 'personal-edit' } } });
            const updated = await registryExecutor.execute('agents.acp.backends.installFromRegistry', {
                ...input, fromRegistry: { ...input.fromRegistry, version: npmEntry.version },
            }, context);
            expect(updated, JSON.stringify(updated)).toMatchObject({ ok: true });
            if (!updated.ok) throw new Error('Expected registry pin update');
            const replacement = AgentsAcpBackendsInstallFromRegistryOutputV1Schema.parse(updated.result);
            expect(replacement.definition).toMatchObject({ id: result.definition.id, launch: { version: npmEntry.version },
                env: { SEAM_ENV: { t: 'literal', v: 'personal-edit' } }, defaultModel: 'personal-model' });
            await waitForJob(replacement.jobs[0]!.jobId, npmEntry.version, 'update');
            expect((await readCatalog()).record.definitions).toEqual([replacement.definition]);
            const updatedReady = await resolveAcpLaunch({ accountId, definition: replacement.definition, env,
                platform: process.platform, arch: process.arch });
            expect(updatedReady.kind).toBe('ready');
            if (updatedReady.kind !== 'ready') throw new Error('Expected updated executable');
            expect(updatedReady.command).not.toBe(ready.command);
            expect((await promisify(execFile)(ready.command, ready.args, { env })).stdout).toBe('registry-agent\n');
            // Hold the real START at the transport boundary, after its CAS receipt.
            // A second confirmed Action may repin the same id before the daemon accepts it.
            const jobsBeforeRace = owner.list(accountId);
            npmEntry.version = '0.89.3';
            npmEntry.distribution.npx.package = '@agentclientprotocol/claude-agent-acp@0.89.3';
            let releaseStart!: () => void;
            let startEntered!: () => void;
            const entered = new Promise<void>(resolve => { startEntered = resolve; });
            const released = new Promise<void>(resolve => { releaseStart = resolve; });
            heldStart = { entered: startEntered, released };
            const original = registryExecutor.execute('agents.acp.backends.installFromRegistry', {
                ...input, fromRegistry: { ...input.fromRegistry, version: npmEntry.version },
            }, context);
            let superseded: Awaited<ReturnType<typeof registryExecutor.execute>> | undefined;
            try {
                await Promise.race([entered, original.then(result => {
                    throw new Error(`Expected a held Machine START before Action settlement: ${JSON.stringify(result)}`);
                })]);
                expect((await readCatalog()).record.definitions[0]).toMatchObject({ launch: { version: '0.89.3' } });
                npmEntry.version = '0.89.4';
                npmEntry.distribution.npx.package = '@agentclientprotocol/claude-agent-acp@0.89.4';
                const next = await registryExecutor.execute('agents.acp.backends.installFromRegistry', {
                    fromRegistry: { ...input.fromRegistry, version: npmEntry.version },
                }, context);
                expect(next, JSON.stringify(next)).toMatchObject({ ok: true });
            } finally {
                heldStart = null;
                releaseStart();
                superseded = await original;
            }
            expect(superseded, JSON.stringify(superseded)).toMatchObject({ ok: false, errorCode: 'agent_install_partial', details: {
                definition: { id: result.definition.id, launch: { version: '0.89.3' } }, jobs: [],
                failures: [{ machineId, errorCode: 'definition_version_changed' }],
            } });
            expect(owner.list(accountId)).toEqual(jobsBeforeRace);
            expect((await readCatalog()).record.definitions[0]).toMatchObject({ launch: { version: '0.89.4' } });
            // Every captured distribution traverses the same reader and strict consumers,
            // including no-checksum binary metadata and the unsupported archive extension.
            for (const entry of registry.agents) {
                const observed = await registryExecutor.execute('registries.items.read', {
                    kind: 'agent', sourceId: source.id, itemId: entry.id, version: entry.version,
                }, context);
                expect(observed).toMatchObject({ ok: true });
                if (!observed.ok) throw new Error('Expected captured entry read');
                const produced = RegistryItemV1Schema.parse(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(observed.result).item);
                if (produced.payload.kind !== 'agent') throw new Error('Expected Agent payload');
                const mapped = mapAcpRegistryAgentToDefinitionV1({ agent: produced.payload.agent, nowMs: 1,
                    provenance: { sourceId: source.id, format: 'acp-registry', sourceUrl: source.url, itemId: entry.id,
                        ref: { kind: 'version', version: entry.version }, importedAt: 1 } });
                expect(mapped.ok).toBe(true);
                if (!mapped.ok) throw new Error('Expected mappable captured distribution');
                AcpBackendDefinitionV1Schema.parse(mapped.definition);
                AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [mapped.definition] });
            }
            const uvEntry = registry.agents.find(entry => entry.id === 'fast-agent');
            if (!uvEntry) throw new Error('Missing captured uv Agent');
            const uv = join(root, 'tools', 'uv', 'current', 'bin', 'uv');
            await mkdir(dirname(uv), { recursive: true });
            // Fixture only the vendor process; actual registry admission, row
            // CAS, authenticated job RPC, install and launch remain composed.
            await writeFile(uv, `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');
if(process.argv.slice(2).join(' ')!=='tool install fast-agent-acp==0.10.1') throw new Error('Wrong registry uv pin');
fs.mkdirSync(process.env.UV_TOOL_BIN_DIR,{recursive:true});
fs.writeFileSync(path.join(process.env.UV_TOOL_BIN_DIR,'fast-agent-acp'),'#!/bin/sh\\nprintf "registry-uv\\\\n"\\n',{mode:0o755});\n`);
            await chmod(uv, 0o755);
            const uvAdded = await registryExecutor.execute('agents.acp.backends.installFromRegistry', {
                fromRegistry: { sourceId: source.id, itemId: uvEntry.id, version: uvEntry.version }, installOn: [machineId],
            }, context);
            expect(uvAdded, JSON.stringify(uvAdded)).toMatchObject({ ok: true });
            if (!uvAdded.ok) throw new Error('Expected uv registry admission');
            const uvResult = AgentsAcpBackendsInstallFromRegistryOutputV1Schema.parse(uvAdded.result);
            await vi.waitFor(async () => {
                const status = await registryExecutor.execute('machines.agents.install.status', {
                    machineId, jobId: uvResult.jobs[0]!.jobId, cursor: 0,
                }, context);
                expect(status).toMatchObject({ ok: true });
                if (!status.ok) throw new Error('Expected uv job read');
                expect(DaemonAgentInstallReadResponseSchema.parse(status.result)).toMatchObject({
                    ok: true, done: true, outcome: { kind: 'succeeded', version: '0.10.1' },
                });
            }, { timeout: serverIntegrationConfig.test?.testTimeout });
            const uvLaunch = await resolveAcpLaunch({ accountId, definition: uvResult.definition, env,
                platform: process.platform, arch: process.arch });
            expect(uvLaunch.kind).toBe('ready');
            if (uvLaunch.kind !== 'ready') throw new Error('Expected uv executable');
            expect((await promisify(execFile)(uvLaunch.command, uvLaunch.args, { env: { ...env, ...uvLaunch.runtimeEnv, PATH: '' } })).stdout)
                .toBe('registry-uv\n');
        } finally {
            daemonSocket?.close();
            manager?.onSocketDisconnect();
            await owner.shutdown();
            await runtimeLease?.release();
            await reloadController.shutdown();
            storedCredentials.mockRestore();
            upstream.mockRestore();
            if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
            else process.env.HAPPIER_HOME_DIR = previousHome;
            await rm(root, { recursive: true, force: true });
        }
    });

    it('joins actual recorded Account usage through registered list and read Actions and strict consumers', async () => {
        const created = await executor.execute('skills.create', { name: 'review', files, where: { kind: 'replace', rules: [] } }, context);
        if (!created.ok) throw new Error('Expected skill creation');
        const identity = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(created.result);
        const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json',
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders() };
        const response = await fetch(`${origin}${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-usage`, { headers });
        expect(response.status).toBe(200);
        const wire = PromptLibraryRowReadResponseV1Schema.parse(await response.json());
        let row = readSkillUsageRowV1({ v: 1, lastUsedAt: {} })!;
        if (wire.status === 'present') {
            const opened = openPromptLibraryContentV1({ key: 'skill-usage', mode: 'plain', material: null, content: wire.content });
            if (opened.status !== 'opened' || opened.record.key !== 'skill-usage') throw new Error('Expected usage row');
            row = opened.record.value;
        }
        const nowMs = Date.now(), oldUse = nowMs - 31 * 86_400_000;
        const recorded = planSkillUsageWriteV1({ row, skillIds: [identity.skillId, 'happier:happier'], nowMs: oldUse });
        if (!recorded) throw new Error('Expected usage producer write');
        const mutation = PromptLibraryRowMutationV1Schema.parse({
            expectedRevision: wire.status === 'present' || wire.status === 'deleted' ? wire.revision : 'absent',
            content: sealPromptLibraryContentV1({ mode: 'plain', material: null,
                record: { key: 'skill-usage', value: recorded } }),
            ...(wire.status === 'absent' ? { sourceSettingsVersion: (await db.account.findUniqueOrThrow({ where: { id: accountId } })).settingsVersion } : {}),
        });
        const written = await fetch(`${origin}${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-usage`, { method: 'POST', headers, body: JSON.stringify(mutation) });
        expect(written.status, await written.clone().text()).toBe(200);
        expect(PromptLibraryRowMutationResponseV1Schema.parse(await written.json()).status).toBe('updated');
        const list = await executor.execute('skills.list', {}, context);
        expect(list).toMatchObject({ ok: true });
        if (!list.ok) throw new Error('Expected registered skill list');
        const projected = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(list.result);
        const skill = projected.items.find(item => item.skillId === identity.skillId);
        expect(skill).toMatchObject({ lastUsedAt: oldUse });
        expect(projected.usageObservedSince).toBeLessThanOrEqual(oldUse);
        expect(deriveSkillAccountStatusesV1(skill!, { nowMs, usageObservedSince: projected.usageObservedSince ?? null })).toContain('unused');
        const detail = await executor.execute('skills.read', { skillId: identity.skillId }, context);
        if (!detail.ok) throw new Error('Expected registered skill read');
        expect(SkillReadResultV1Schema.parse(detail.result)).toMatchObject({ skillId: identity.skillId, lastUsedAt: oldUse });
        const off = await executor.execute('skills.list', { state: 'off' }, context);
        if (!off.ok) throw new Error('Expected Off filter');
        expect(SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(off.result).items.map(item => item.skillId)).toContain(identity.skillId);
    });

    it('writes a skill and its default reach, publishes the committed Artifact, and preserves executable bytes across an edit', async () => {
        const created = await executor.execute('skills.create', { name: 'review', files }, context);
        expect(created).toMatchObject({ ok: true });
        if (!created.ok) throw new Error('Expected skill creation');
        const identity = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(created.result);
        expect(identity.includedInSessionId).toBeNull();
        expect(identity.incomplete).toBeUndefined();
        expect(await readRules()).toEqual(expect.arrayContaining([
            expect.objectContaining({ skillId: identity.skillId, enabled: true, target: { t: 'allMachines' } }),
        ]));
        await vi.waitFor(() => expect(updates.some(update => {
            const parsed = UpdateContainerSchema.safeParse(update);
            return parsed.success && parsed.data.body.t === 'new-artifact' && parsed.data.body.artifactId === identity.skillId;
        })).toBe(true));
        const response = await fetch(`${origin}/v1/artifacts/${identity.skillId}`, { headers: { authorization: `Bearer ${token}` } });
        expect(response.status).toBe(200);
        const wire = ArtifactHttpReadV1Schema.parse(await response.json());
        const header = PromptBundleArtifactHeaderV1Schema.parse(decodePlainArtifactStoredContent(wire.header));
        expect(header.bundleSchemaId).toBe('skills.skill_md_v1');
        const opened = decodePlainArtifactStoredContent(wire.body);
        if (!opened || typeof opened !== 'object' || !('body' in opened) || typeof opened.body !== 'string') throw new Error('Expected bundle body');
        const body = PromptBundleBodyV1Schema.parse(JSON.parse(opened.body));
        expect(body.entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'scripts/check.sh', unixMode: 0o755 })]));
        const edited = await executor.execute('skills.update', { skillId: identity.skillId,
            expectedRevision: identity.revision, files: [{ kind: 'upsert', file: { ...files[0]!,
                contentBase64: Buffer.from(`${markdown}\nCheck neighboring callers.\n`).toString('base64') } }] }, context);
        expect(edited).toMatchObject({ ok: true });
        if (!edited.ok) throw new Error('Expected skill update');
        const revision = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.update'].parse(edited.result).revision;
        expect(revision).not.toBe(identity.revision);
        expect(await executor.execute('skills.update', { skillId: identity.skillId,
            expectedRevision: identity.revision, name: 'stale' }, context)).toMatchObject({ ok: false, errorCode: 'revision_conflict' });
        const read = await executor.execute('skills.read', { skillId: identity.skillId }, context);
        expect(read).toMatchObject({ ok: true });
        if (!read.ok) throw new Error('Expected skill read');
        const skill = SkillReadResultV1Schema.parse(read.result);
        expect(skill.skillMd).toContain('Check neighboring callers.');
        expect(skill.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'scripts/check.sh', unixMode: 0o755 })]));
        expect(await executor.execute('skills.delete', { skillId: identity.skillId, expectedRevision: revision }, context))
            .toMatchObject({ ok: true, result: { deleted: true } });
        expect((await readRules()).some(rule => rule.skillId === identity.skillId)).toBe(false);
    });

    it('previews an upload without creating content and rejects invalid portable paths before storage', async () => {
        const before = await db.artifact.count({ where: { accountId } });
        const preview = await executor.execute('skills.install', { source: { kind: 'upload', files }, dryRun: true }, context);
        expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true });
        if (!preview.ok) throw new Error('Expected upload preview');
        const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(preview.result);
        expect(result).toMatchObject({ items: [expect.objectContaining({ trust: 'runs_scripts', files })] });
        expect(await db.artifact.count({ where: { accountId } })).toBe(before);
        expect(await executor.execute('skills.create', { name: 'review', files: [files[0]!, {
            ...files[1]!, path: 'CON.md',
        }] }, context)).toMatchObject({ ok: false, errorCode: 'invalid_path' });
        expect(await db.artifact.count({ where: { accountId } })).toBe(before);
    });

    it('runs compiled directory argv with Off and Everywhere and refuses Account-selected Agent-bridge context', async () => {
        const credentials = { token, encryption: null } as const;
        // Retain real Session selections so a refused Account-selected bridge
        // cannot silently mutate either Session.
        const initialMetadata = writeSessionCapabilitySelectionToMetadataV1(writeRuntimeDescriptorV1ToMetadata(
            { path: tmpdir(), host: 'capabilities-test' }, { v: 1, agentId: 'claude', agent: {} },
        ), {
            skills: { v: 1, forceIncludeSkillIds: ['existing-skill'], forceExcludeSkillIds: ['excluded-skill'], excludeNativeSkillNames: ['native-skill'] },
        }, { sessionActive: false });
        const createSession = async (tag: string) => {
            const response = await app.inject({ method: 'POST', url: '/v1/sessions', headers: {
                authorization: `Bearer ${token}`, ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            }, payload: { tag, encryptionMode: 'plain', dataEncryptionKey: null,
                ...buildSessionMetadataEnvelopeCreateFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain', metadata: initialMetadata, agentState: null }),
            } });
            expect(response.statusCode).toBe(200);
            const session = await db.session.findFirstOrThrow({ where: { accountId, tag } });
            return session.id;
        };
        const sessionId = await createSession('capabilities-argv-session');
        const otherSessionId = await createSession('capabilities-argv-other');
        const readSelection = async (id: string) => {
            const session = await db.session.findUniqueOrThrow({ where: { id } });
            if (!session.ownerMetadata) throw new Error('Expected layout-one owner metadata');
            const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: 'plain', material: null, envelope: JSON.parse(session.ownerMetadata) });
            if (!opened.ok) throw new Error('Expected readable plain owner metadata');
            return readSessionCapabilitySelectionFromMetadataV1(projectSessionOwnerCompatibilityViewV1({
                sharedMetadata: JSON.parse(session.metadata), ownerMetadata: opened.ownerMetadata,
            }));
        };
        // Credential/profile reads are OS boundaries. Policy is persisted by the real Account route;
        // argv, binding, Session resolution, Action policy and every HTTP/storage owner stay real.
        const deps: Partial<ActionCliExecutionDeps> = {
            readCredentialsFn: async () => credentials,
            readCredentialsForServerIdFn: async id => id === origin ? credentials : null,
            getServerProfileFn: async id => ({ id, name: 'Test Home', serverUrl: origin, webappUrl: origin, createdAt: 0, updatedAt: 0, lastUsedAt: 0 }),
            createExecutorFn: createCliActionExecutorFromCredentials,
        };
        const directory = await mkdtemp(join(tmpdir(), 'happier-skills-argv-'));
        const previousExitCode = process.exitCode;
        let output = '';
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
            output += String(chunk);
            const completed = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
            completed?.();
            return true;
        });
        const createArgv = async (name: string, extra: readonly string[]) => {
            output = '';
            const argv = ['skills', 'create', name, '--from', directory];
            expect(await tryHandleSkillsCliCommand({ argv: [...argv, '--server-id', origin, '--json', ...extra], actionExecutionDeps: deps })).toBe(true);
            const envelope: unknown = JSON.parse(output.trim());
            expect(envelope, JSON.stringify(envelope)).toMatchObject({ ok: true });
            if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) throw new Error('Expected a CLI success envelope');
            // The shared CLI success presenter removes the inner domain `ok` bit.
            return lazyZodSchema(() => z.omit(SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'], { ok: true })).parse(envelope.data);
        };
        try {
            await mkdir(join(directory, 'scripts'));
            await writeFile(join(directory, 'SKILL.md'), markdown);
            await writeFile(join(directory, 'scripts', 'check.sh'), '#!/bin/sh\nexit 0\n');
            await chmod(join(directory, 'scripts', 'check.sh'), 0o755);
            // A Session bridge must obtain its authority and Home from Session MCP.
            // An Account credential plus CLI resource selectors cannot create that admission.
            expect(await tryHandleSkillsCliCommand({ argv: ['skills', 'create', '--input-json', JSON.stringify({ name: 'argv-raw-session', files }),
                '--server-id', origin, '--json', '--agent-bridge', '--session-id', sessionId], actionExecutionDeps: deps })).toBe(true);
            const refused: unknown = JSON.parse(output.trim());
            expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
            const off = await createArgv('argv-off', ['--off']);
            expect(off.incomplete).toBeUndefined();
            expect((await readRules()).some(rule => rule.skillId === off.skillId)).toBe(false);
            const on = await createArgv('argv-on', []);
            expect((await readRules()).filter(rule => rule.skillId === on.skillId)).toMatchObject([{ enabled: true, target: { t: 'allMachines' } }]);
            expect((await readSelection(sessionId)).skills).toEqual({ v: 1,
                forceIncludeSkillIds: ['existing-skill'], forceExcludeSkillIds: ['excluded-skill'], excludeNativeSkillNames: ['native-skill'] });
            expect((await readSelection(otherSessionId)).skills.forceIncludeSkillIds).toEqual(['existing-skill']);
            const read = await executor.execute('skills.read', { skillId: off.skillId, file: 'scripts/check.sh' }, context);
            if (!read.ok) throw new Error('Expected directory skill read');
            const content = SkillReadResultV1Schema.parse(read.result);
            expect(content.files).toEqual(expect.arrayContaining([
                expect.objectContaining({ path: 'scripts/check.sh', unixMode: 0o755 }),
            ]));
            expect(content.file).toMatchObject({ path: 'scripts/check.sh', contentBase64: files[1]!.contentBase64 });
        } finally {
            stdout.mockRestore();
            process.exitCode = previousExitCode;
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('persists an Account source and installs the reviewed root skill after the upstream branch moves', async () => {
        const reviewedCommit = '1'.repeat(40);
        let head = reviewedCommit;
        const bytes = files.map(file => ({ path: file.path, unixMode: file.unixMode === 0o755 ? 0o755 as const : 0o644 as const,
            bytes: new Uint8Array(Buffer.from(file.contentBase64, 'base64')) }));
        const treeSha = computeGitTreeShaV1(bytes);
        let currentBytes = bytes;
        let upstreamFailure: Readonly<{ status: number; headers?: Record<string, string> }> | null = null;
        const liveFetch = globalThis.fetch;
        const upstreamReads: string[] = [];
        // GitHub is the external boundary; Account HTTP, storage and Action owners stay real.
        const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
            if (!['api.github.com', 'raw.githubusercontent.com'].includes(url.hostname)) return liveFetch(input, init);
            upstreamReads.push(url.href);
            if (upstreamFailure) return new Response('', upstreamFailure);
            if (url.pathname.endsWith('/.claude-plugin/marketplace.json')) return new Response('', { status: 404 });
            if (url.hostname === 'raw.githubusercontent.com') {
                expect(url.pathname.includes(`/${reviewedCommit}/`) || url.pathname.includes(`/${head}/`)).toBe(true);
                const pinned = url.pathname.includes(`/${reviewedCommit}/`) ? bytes : currentBytes;
                const file = pinned.find(entry => url.pathname.endsWith(`/${entry.path}`));
                if (!file) return new Response('', { status: 404 });
                return new Response(Buffer.from(file.bytes));
            }
            const value = url.pathname.includes('/commits/') ? { sha: url.pathname.endsWith('/HEAD') ? head : url.pathname.split('/').at(-1) }
                : url.pathname.includes('/git/trees/') ? { sha: url.pathname.includes(reviewedCommit) ? treeSha : computeGitTreeShaV1(currentBytes), truncated: false,
                    tree: (url.pathname.includes(reviewedCommit) ? bytes : currentBytes).map(file => ({ path: file.path, type: 'blob', mode: file.unixMode === 0o755 ? '100755' : '100644',
                        sha: computeGitBlobShaV1(file.bytes), size: file.bytes.byteLength })) }
                : { name: 'skills', default_branch: 'main' };
            return Response.json(value);
        });
        const machineId = randomUUID(), installationId = randomUUID();
        const installation = tweetnacl.sign.keyPair();
        const credentials = { token, encryption: null } as const;
        const installationProof = signMachineInstallationProof({ payload: { version: 1, machineId, installationId, accountId },
            privateKey: installation.secretKey });
        let machineSocket: Socket | undefined;
        try {
            const registered = await app.inject({ method: 'POST', url: '/v1/machines', headers: {
                authorization: `Bearer ${token}`, ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            }, payload: { id: machineId, installationId, installationPublicKey: encodeBase64(installation.publicKey, 'base64url'),
                installationProof, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                metadata: encodePlainMachineStoredContent({ host: 'registry-update-seam', platform: process.platform,
                    arch: process.arch, homeDir: tmpdir(), happyCliVersion: '0.3.0' }),
            } });
            expect(registered.statusCode, registered.body).toBe(200);
            await db.machine.update({ where: { id: machineId }, data: { active: true, lastActiveAt: new Date(),
                operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
            } });
            const rpcManager = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain',
                authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId,
                    resolveCustodianAccountId: async () => accountId, resolveInstallationId: () => installationId,
                    verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input,
                        privateKey: installation.secretKey, daemonToken: token, serverHttpBaseUrl: origin }),
                }),
            });
            registerExternalActionRpcHandler(rpcManager, { machineId, currentServerId: origin, currentServerHttpBaseUrl: origin,
                resolveAccountId: async () => accountId, resolveInstallationId: () => installationId,
                externalActionMachineRequestPrivateKey: installation.secretKey,
                verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
                    privateKey: installation.secretKey, installationId, serverHttpBaseUrl: origin }),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: origin }),
                executor,
            });
            machineSocket = ioClient(origin, { path: '/v1/updates/', transports: ['websocket'], autoConnect: false,
                reconnection: false, auth: { token, clientType: 'machine-scoped', machineId, installationId,
                    installationPublicKey: encodeBase64(installation.publicKey, 'base64url'), installationProof,
                    ...buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
                },
            });
            const daemonSocket = machineSocket;
            daemonSocket.on(SOCKET_RPC_EVENTS.REQUEST, (request, acknowledge) => {
                void runWithServerHttpBaseUrl(origin, () => rpcManager.handleRequest(request)).then(acknowledge);
            });
            daemonSocket.on('connect', () => rpcManager.onSocketConnect(daemonSocket));
            daemonSocket.on('disconnect', () => rpcManager.onSocketDisconnect());
            await new Promise<void>((resolve, reject) => {
                daemonSocket.once('connect', resolve); daemonSocket.once('connect_error', reject); daemonSocket.connect();
            });
            expect(await rpcManager.waitForRegisteredHandlers([EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1], {
                timeoutMs: serverIntegrationConfig.test!.testTimeout!,
            })).toEqual({ status: 'ready' });
            const checkThroughHome = async (skillId: string) => {
                const response = await fetch(`${origin}/v1/actions/registries.updates.check`, { method: 'POST',
                    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                    body: JSON.stringify({ v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId },
                        input: { kind: 'skill', keys: [skillId] } }),
                });
                const body: unknown = await response.json();
                expect(response.status, JSON.stringify(body)).toBe(200);
                return ExternalActionResponseEnvelopeV1Schema.parse(body).execution;
            };
            const created = await executor.execute('registries.sources.create', { url: 'https://github.com/example/skills' }, context);
            expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
            if (!created.ok) throw new Error('Expected source creation');
            const source = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.create'].parse(created.result).source;
            const response = await fetch(`${origin}${PROMPT_LIBRARY_ROWS_ROUTE_V1}/registry-sources`, { headers: { authorization: `Bearer ${token}` } });
            const row = PromptLibraryRowReadResponseV1Schema.parse(await response.json());
            if (row.status !== 'present') throw new Error('Expected committed registry source row');
            const opened = openPromptLibraryContentV1({ key: 'registry-sources', mode: 'plain', material: null, content: row.content });
            if (opened.status !== 'opened' || opened.record.key !== 'registry-sources') throw new Error('Expected opened registry sources');
            expect(opened.record.value.sources).toEqual(expect.arrayContaining([expect.objectContaining({ id: source.id, url: source.url })]));
            const read = await executor.execute('registries.items.read', { kind: 'skill', sourceId: source.id, itemId: '' }, context);
            expect(read).toMatchObject({ ok: true });
            if (!read.ok) throw new Error('Expected root skill read');
            const item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(read.result).item;
            expect(item.summary.version).toBe(reviewedCommit);
            head = '2'.repeat(40);
            currentBytes = bytes.map(file => file.path === 'SKILL.md' ? { ...file, bytes: new TextEncoder().encode(markdown + '\nNew upstream instructions') } : file);
            const installed = await executor.execute('skills.install', { source: { kind: 'registry', sourceId: source.id,
                itemId: '', version: item.summary.version! } }, context);
            expect(installed).toMatchObject({ ok: true });
            if (!installed.ok) throw new Error('Expected pinned installation');
            const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(installed.result);
            if (!('skillIds' in result)) throw new Error('Expected committed skill identities');
            expect(result.skillIds).toHaveLength(1);
            const skillRead = await executor.execute('skills.read', { skillId: result.skillIds[0]! }, context);
            if (!skillRead.ok) throw new Error('Expected installed skill read');
            const skill = SkillReadResultV1Schema.parse(skillRead.result);
            expect(skill.provenance).toMatchObject({ kind: 'registry', registry: { sourceId: source.id, itemId: '', ref: { commit: reviewedCommit } } });
            expect(skill.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'scripts/check.sh', unixMode: 0o755 })]));
            expect(skill.skillMd).toBe(markdown);
            expect(upstreamReads).toContain(`https://raw.githubusercontent.com/example/skills/${reviewedCommit}/SKILL.md`);
            const skillId = result.skillIds[0]!;
            const checked = await checkThroughHome(skillId);
            expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
            if (!checked.ok) throw new Error('Expected registered update checker');
            const observation = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(checked.result);
            expect(observation.results).toEqual([{ kind: 'skill', key: skillId, upstream: { state: 'update_available',
                latest: { kind: 'gitTree', repo: source.url, path: '', commit: head, treeSha: computeGitTreeShaV1(currentBytes) } } }]);
            const readObserved = await executor.execute('skills.read', { skillId }, context);
            if (!readObserved.ok) throw new Error('Expected observed skill');
            const observed = SkillReadResultV1Schema.parse(readObserved.result);
            expect(observed.upstream).toEqual(observation.results[0]!.upstream);
            expect(observed.files).toEqual(skill.files);
            const diff = await executor.execute('skills.updates.diff', { skillId }, context);
            if (!diff.ok) throw new Error('Expected R5 update inputs');
            const inputs = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.diff'].parse(diff.result);
            const instructions = inputs.files.find(file => file.path === 'SKILL.md')!;
            expect(instructions.changed).toBe(true);
            expect(Buffer.from(instructions.mine!.contentBase64, 'base64').toString()).toBe(markdown);
            expect(Buffer.from(instructions.theirs!.contentBase64, 'base64').toString()).toBe(markdown + '\nNew upstream instructions');
            expect(inputs.costDelta.theirs.bodyTokens).toBeGreaterThan(inputs.costDelta.mine.bodyTokens);
            const beforeRepeat = await db.artifact.findUniqueOrThrow({ where: { id: skillId } });
            expect(await checkThroughHome(skillId)).toMatchObject({ ok: true });
            expect(await db.artifact.findUniqueOrThrow({ where: { id: skillId } })).toEqual(beforeRepeat);
            for (const failure of [
                { status: 403, headers: { 'x-ratelimit-remaining': '0' }, reason: { state: 'rate_limited' } },
                { status: 429, reason: { state: 'rate_limited' } },
                { status: 403, reason: { state: 'auth_failed' } },
            ]) {
                upstreamFailure = failure;
                const failedCheck = await checkThroughHome(skillId);
                expect(failedCheck, JSON.stringify(failedCheck)).toMatchObject({ ok: true });
                if (!failedCheck.ok) throw new Error('Expected per-item unchecked observation');
                expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(failedCheck.result).results)
                    .toEqual([{ kind: 'skill', key: skillId, sourceId: source.id, sourceTitle: source.title, upstream: { state: 'unchecked', reason: failure.reason } }]);
                expect(await db.artifact.findUniqueOrThrow({ where: { id: skillId } })).toEqual(beforeRepeat);
            }
            upstreamFailure = null;
            const recovered = await checkThroughHome(skillId);
            expect(recovered).toMatchObject({ ok: true });
            if (!recovered.ok) throw new Error('Expected reachable source recovery');
            expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(recovered.result).results)
                .toEqual(observation.results);
            await vi.waitFor(() => expect(updates.some(update => {
                const parsed = UpdateContainerSchema.safeParse(update);
                return parsed.success && parsed.data.body.t === 'update-artifact' && parsed.data.body.artifactId === skillId;
            })).toBe(true));
        } finally { machineSocket?.close(); upstream.mockRestore(); }
    });
});
