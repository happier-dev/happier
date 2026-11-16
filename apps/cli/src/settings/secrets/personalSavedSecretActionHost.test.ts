import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsSchema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { createAccountScopedCryptoMaterialSnapshotV1, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { SharedSavedSecretCreateInputV1Schema, SharedSavedSecretUpdateInputV1Schema, SharedSavedSecretDeleteInputV1Schema, SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { ManagedMachinePresetV1Schema, ManagedMachinePresetListResultV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { ManagedOpaquePresetReadV1Schema, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { machinePresetActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { ManagedMachinePresetContentV1Schema, projectManagedMachinePresetForRecipientV1, sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { SavedSecretCatalogEntryV1Schema, type SavedSecretResourceMaterialV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { createCliPersonalSavedSecretActionExecute, updateOwnedSavedSecretResourceForOperation } from './personalSavedSecretActionHost';
import { createInvocationSavedSecretOperationContextV1 } from './savedSecretOperationContext';
import { createSavedSecretMaterializerFromSnapshotV1 } from './savedSecretCatalog';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createSecretSourceHostFixture } from '@/plugins/testkit/secretSources';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { connectedEntitySubjectKeyV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationSchemasV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createConfidentialActionInputsExecutor } from '@/daemon/surfaces/confidentialSecretFill';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { prepareSavedSecretsCliInput } from '@/cli/actions/adapters/savedSecretsInput';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionAccountActionExecutor } from '@/mcp/runtime/createSessionAccountActionExecutor';
import { createSessionDaemonAuthorityFixture } from '@/mcp/runtime/sessionDaemonAuthority.testkit';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';

// HTTP is the process boundary; Account admission, resource opening, sealing and Action execution stay real.
vi.mock('axios', async importOriginal => {
    const actual = await importOriginal<typeof import('axios')>();
    return { ...actual, default: Object.assign(actual.default.create(), { get: vi.fn(), post: vi.fn(), request: vi.fn() }) };
});
afterEach(() => { vi.mocked(axios.get).mockReset(); vi.mocked(axios.post).mockReset(); vi.mocked(axios.request).mockReset(); vi.unstubAllGlobals(); });

describe('personal Saved Secret key rotation', () => {
    it.each((['plain', 'e2ee'] as const).flatMap(mode =>
        (['unrelated', 'source', 'snapshot', 'unavailable', ...(mode === 'e2ee' ? ['unavailable-with-snapshot' as const] : [])] as const).map(target => ({ mode, target }))))(
        'deletes using the actual opaque Preset census: $mode $target', async ({ mode, target }) => {
        const accountId = 'secret-owner';
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const keys = tweetnacl.box.keyPair();
        const credentials = { token, encryption: mode === 'plain' ? null
            : { type: 'dataKey' as const, publicKey: keys.publicKey, machineKey: keys.secretKey } };
        const fingerprint = mode === 'plain' ? null : convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: mode, material: credentials.encryption!,
                dataKeyPublicKey: keys.publicKey }).contentPublicKeyFingerprint);
        const operationContext = createInvocationSavedSecretOperationContextV1({ credentials,
            serverHttpBaseUrl: 'https://preset-delete.example.test', isCurrent: async () => true,
            snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 0,
                loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKeyForToken(token), settingsSecretsReadKeys: [] } });
        const ref = formatSharedSavedSecretRefV1('one');
        const content = (referenced: boolean) => ({ v: 1, name: 'Saved computer', setup: { secretRefs: { v: 1,
            bindings: { TOKEN: { ref: referenced ? ref : formatSharedSavedSecretRefV1('another'), revision: 1 } } } } });
        const seal = (referenced: boolean) => mode === 'plain'
            ? sealManagedMachinePresetContentV1({ presetId: 'preset', mode, content: ManagedMachinePresetContentV1Schema.parse(content(referenced)) })
            : sealManagedMachinePresetContentV1({ presetId: 'preset', mode, content: ManagedMachinePresetContentV1Schema.parse(content(referenced)),
                recipientCensus: [{ account: { kind: 'account', accountId, name: null, firstName: null, lastName: null, username: null, avatarUrl: null },
                    readiness: { status: 'available', contentPublicKey: Buffer.from(keys.publicKey).toString('base64'),
                        contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys.publicKey) }, envelopeStatus: 'missing' }],
                randomBytes: length => new Uint8Array(length).fill(61) });
        const source = seal(target === 'source');
        const snapshot = seal(target === 'snapshot' || target === 'unavailable-with-snapshot');
        const preset = ManagedMachinePresetV1Schema.parse({ id: 'preset', homeId: 'srv_delete_home', revision: 1,
            owner: { kind: 'account', accountId }, contentEncryptionMode: mode,
            content: source.content, recipients: target === 'unavailable' || target === 'unavailable-with-snapshot' ? [] : source.recipients });
        const presetList = ManagedMachinePresetListResultV1Schema.parse({ kind: 'listed', presets: [preset] });
        const retained = ManagedOpaquePresetReadV1Schema.parse({ machine: { id: 'retained', homeId: preset.homeId,
            custodianAccountId: accountId, preset: { id: preset.id, revision: 1, contentEncryptionMode: mode },
            allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            presetContent: projectManagedMachinePresetForRecipientV1({ content: snapshot.content,
                recipients: snapshot.recipients, recipientAccountId: accountId }) });
        const resource: SavedSecretResourceMaterialV1 = { resourceId: 'one', encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: 'Key', kind: 'apiKey', value: 'dummy-test-key' } },
            entry: SavedSecretCatalogEntryV1Schema.parse({ ref, source: 'shared_resource', relationship: 'owner', ownerAccountId: accountId,
                name: 'Key', kind: 'apiKey', revision: 1, materialStatus: 'ready', deploymentReferenceState: 'unreferenced',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }) };
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
            capabilities: { serverIdentity: { serverIdentityId: preset.homeId } } }))));
        vi.mocked(axios.get).mockImplementation(async rawUrl => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: accountId }) };
            if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: deleted ? [] : [resource] } };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode, version: 1,
                settingsVersion: 0, signingKeyFingerprint: null, contentKeyFingerprint: fingerprint, updatedAt: 1,
                recipientEnvelopeReadiness: mode === 'plain' ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' } } };
            if (path === '/v2/account/settings') return { status: 200, data: { version: 0,
                content: mode === 'plain' ? { t: 'plain', v: {} } : { t: 'encrypted',
                    c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: credentials.encryption!, payload: {},
                        randomBytes: length => new Uint8Array(length).fill(11) }) } } };
            if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
            if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [], nextCursor: null,
                complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } } };
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 1 } };
            if (path === PROFILE_TRANSFER_ROUTE_V1 || path.startsWith('/v1/account/')) return { status: 200, data: { status: 'absent' } };
            throw new Error(`Unexpected boundary request ${path}`);
        });
        vi.mocked(axios.post).mockImplementation(async (rawUrl, body) => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === machinePresetActionEndpointPathV1('machines.presets.list')) return { status: target === 'unavailable' && mode === 'plain' ? 503 : 200,
                data: presetList };
            if (path === managedMachineActionEndpointPathV1('machines.managed.list')) return { status: 200,
                data: { machines: typeof body === 'object' && body && 'archived' in body && body.archived ? [retained] : [] } };
            throw new Error(`Unexpected boundary request ${path}`);
        });
        let deleted = false;
        const execute = createCliPersonalSavedSecretActionExecute({ credentials, operationContext,
            // Home HTTP is the boundary: its existing delete contract refuses supplied opaque references.
            home: async ({ input }) => {
                const request = SharedSavedSecretDeleteInputV1Schema.parse(input);
                const opaque = request.referenceCensus.opaquePresetReferences;
                if (opaque?.presets.length || opaque?.snapshots.length) return { ok: false, errorCode: 'resource_in_use', error: 'resource_in_use' };
                deleted = true;
                return { resourceId: request.resourceId };
            } });
        const result = await execute({ actionId: 'secrets.delete', input: { secretId: 'one', expectedUpdatedAt: 1 }, context: { surface: 'cli' } });
        const unreadable = mode === 'e2ee' && (target === 'unavailable' || target === 'unavailable-with-snapshot');
        if (target === 'unrelated') expect(result).toEqual({ deleted: true });
        else expect(result).toMatchObject({ ok: false, errorCode: unreadable ? 'unreadable_references'
            : target === 'unavailable' ? 'secret_unavailable' : 'resource_in_use',
            ...(unreadable ? { details: { count: 1, consequence: 'secret_unavailable' }, effectAttempted: false } : {}) });
        expect(deleted).toBe(target === 'unrelated');
        if (unreadable) {
            const executor = createActionExecutor({ personalSavedSecretActionExecute: execute });
            const confirmedInput = await prepareSavedSecretsCliInput({ actionId: 'secrets.delete',
                input: { secretId: 'one', confirmedUnreadableReferences: true },
                execute: (actionId, input) => executor.execute(actionId, input, { surface: 'cli' }) });
            const confirmed = await execute({ actionId: 'secrets.delete', input: confirmedInput, context: { surface: 'cli' } });
            expect(confirmed).toMatchObject(target === 'unavailable' ? { deleted: true }
                : { ok: false, errorCode: 'resource_in_use' });
            expect(deleted).toBe(target === 'unavailable');
            if (deleted) {
                await expect(execute({ actionId: 'secrets.list', input: {}, context: { surface: 'cli' } }))
                    .resolves.toMatchObject({ secrets: [] });
                expect(createSavedSecretMaterializerFromSnapshotV1(operationContext.readSnapshot()!).resolve(ref))
                    .toEqual({ status: 'forbidden' });
            }
        }
        const requests = vi.mocked(axios.post).mock.calls.map(([url]) => new URL(String(url)).pathname);
        expect(requests.filter(path => path === machinePresetActionEndpointPathV1('machines.presets.list'))).toHaveLength(unreadable ? 2 : 1);
        expect(requests.filter(path => path === managedMachineActionEndpointPathV1('machines.managed.list'))).toHaveLength(target === 'unavailable' && mode === 'plain' ? 0 : unreadable ? 4 : 2);
        expect(requests).not.toContain('/v1/machines/presets/recipient-census');
    });
    it.each(['agent', 'mcp'] as const)('stores a person-entered value through %s MCP → private approval RPC → Saved Secret owner without disclosing it', async surface => {
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'secret-owner' })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null };
        const scopeKey = resolveAccountSettingsScopeKeyForToken(token)!;
        const snapshot = { source: 'network' as const, settings: AccountSettingsSchema.parse({}), rawSettings: {},
            settingsVersion: 0, loadedAtMs: 1, scopeKey, settingsSecretsReadKeys: [] };
        setActiveAccountSettingsSnapshot(snapshot);
        const operationContext = createInvocationSavedSecretOperationContextV1({ credentials,
            serverHttpBaseUrl: 'https://secret-approval.example.test', isCurrent: async () => true, snapshot });
        vi.stubGlobal('fetch', async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} })));
        vi.mocked(axios.get).mockImplementation(async rawUrl => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v2/sessions/session') return { status: 200, data: { session: createSessionRecordFixture({ id: 'session', share: null }) } };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                settingsVersion: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
            throw new Error(`Unexpected boundary request ${path}`);
        });
        const material = 'synthetic-person-only-credential-1107';
        let saved: ReturnType<typeof SharedSavedSecretCreateInputV1Schema.parse> | undefined;
        let approval: ApprovalRequest | undefined;
        const history: unknown[] = [];
        const observations: unknown[] = [];
        const deliveredMessages: string[] = [];
        const executor = createActionExecutor({
            // Session input delivery is the transport boundary; approval settlement stays real.
            sessionSendMessage: async ({ sessionId, message, localId }) => {
                expect(sessionId).toBe('session'); deliveredMessages.push(message);
                return { status: 'accepted', localId };
            },
            approvalsCreate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); history.push(structuredClone(approval)); return { artifactId: 'secret-approval' }; },
            approvalsGet: async () => structuredClone(approval),
            approvalsUpdate: async ({ request, expectedStatus }) => {
                if (!approval) throw new Error('Missing approval');
                const next = ApprovalRequestV2Schema.parse(request);
                const transition = decideApprovalRequestTransition(approval, next, { expectedStatus });
                if (!transition.ok) return transition;
                approval = next; history.push(structuredClone(next)); return { ok: true };
            },
            isApprovalExecutionOriginCurrent: async () => true,
            confidentialActionInputs: createConfidentialActionInputsExecutor({ expectedScopeKey: scopeKey,
                expectedAccountId: 'secret-owner', serverId: 'home', machineId: 'machine', readAccountMode: async () => 'plain' }),
            personalSavedSecretActionExecute: createCliPersonalSavedSecretActionExecute({ credentials, operationContext,
                // The Home mutation is the storage/network boundary. Sealing, materialization and the private resource writer stay real.
                home: async ({ actionId, input }) => {
                    expect(actionId).toBe('secrets.shared.create');
                    saved = SharedSavedSecretCreateInputV1Schema.parse(input);
                    return { resourceId: saved.resourceId, revision: 1 };
                } }),
            observeActionExecution: async event => { observations.push(event); },
        });
        const input = { name: 'Replay3 disposable secret' };
        const daemonExecute = createDaemonSessionAccountActionExecutor({ serverId: 'home', machineId: 'machine',
            serverHttpBaseUrl: 'https://secret-approval.example.test', token, createExecutor: () => executor });
        const daemon = await createSessionDaemonAuthorityFixture({ sessionId: 'session',
            execute: operation => daemonExecute(operation, { sessionId: 'session', isCurrent: async () => true }) });
        const sessionExecutor = createSessionAccountActionExecutor({ base: executor, client: {
            sessionId: 'session', getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://secret-approval.example.test' }),
            rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
            getActiveTurnAdmissionWitness: () => ({ turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1],
                agentStartCaller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 } }),
        } });
        const bridge = createActionToolExecutorBridge({ surface, executor: {
            execute: (id, args, context) => sessionExecutor.execute(id, args, { ...context, actionRequestId: 'request' }),
        } });
        const server = new McpServer({ name: 'happier', version: '1' });
        registerHappierMcpBuiltInTools(server, { sessionId: 'session', sessionMachineId: 'machine', surface,
            deps: { ...bridge, changeTitle: async () => ({ success: true }),
                resolveActionOptions: args => bridge.resolveActionOptions(args, 'session') } });
        const client = new Client({ name: 'secret-seam', version: '1' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        try {
            await server.connect(serverTransport); await client.connect(clientTransport);
            const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
                actionId: 'secrets.create', input,
            } }));
            const text = response.content.find(block => block.type === 'text');
            if (text?.type !== 'text') throw new Error('Missing Action result');
            expect(JSON.parse(text.text)).toMatchObject({ kind: 'approval_request_created', artifactId: 'secret-approval' });
            expect(saved).toBeUndefined();
            expect(approval).toMatchObject({ actionArgs: input, preview: { confidentialInputs: { kind: 'action_inputs', paths: ['value'] } } });
            expect(await executor.execute('approval.request.decide', { artifactId: 'secret-approval', decision: 'approve' },
                { surface: 'ui', authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'confidential_choice_required' });
            const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
                authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'machine',
                    resolveCustodianAccountId: async () => 'secret-owner', resolveInstallationId: () => 'installation',
                    // The authenticated Home verification is a network boundary.
                    verifyMachineAdmission: async () => true,
                }) });
            registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: executor });
            const result = await rpc.handleRequest({ method: `machine:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`, callerAuthority: 'present_user',
                machineAdmission: { actorAccountId: 'secret-owner', custodianAccountId: 'secret-owner', machineId: 'machine',
                    installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
                params: { v: 1, kind: 'action_inputs', artifactId: 'secret-approval', requestId: 'request', actionId: 'secrets.create', request: input,
                    serverId: 'home', machineId: 'machine', accountEncryptionMode: 'plain', choices: [{ path: 'value', choice: { kind: 'once', value: material } }] } });
            expect(result).not.toHaveProperty('errorCode');
            expect(result).toMatchObject({ ok: true, result: { secretId: expect.any(String) } });
            expect(saved).toBeDefined();
            // The private result redactor may omit secret-named fields; the
            // stable id still identifies the resource that was actually stored.
            expect(result).toMatchObject({ result: { secretId: saved!.resourceId } });
            expect(openSavedSecretResourceStoredContentV1({ resourceId: saved!.resourceId, mode: 'plain', storedContent: saved!.storedContent }))
                .toMatchObject({ name: input.name, value: material });
            expect(approval).toMatchObject({ status: 'executed' });
            expect(deliveredMessages.map(message => JSON.parse(message))).toContainEqual(expect.objectContaining({
                actionId: 'secrets.create', execution: expect.objectContaining({ ok: true,
                    result: expect.objectContaining({ secretId: saved!.resourceId }) }),
            }));
            expect(JSON.stringify({ response, result, history, observations, deliveredMessages })).not.toContain(material);
        } finally { await client.close(); await server.close(); await daemon.close(); resetActiveAccountSettingsSnapshotForTests(); }
    });
    it('reads value-free Used-by through the agent Action in the caller Account only, sharing the list/delete census', async () => {
        const accountId = 'secret-owner';
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null };
        const operationContext = createInvocationSavedSecretOperationContextV1({ credentials,
            serverHttpBaseUrl: 'https://describe.example.test', isCurrent: async () => true,
            snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 0,
                loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKeyForToken(token), settingsSecretsReadKeys: [] } });
        const account = { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'work' };
        const resource: SavedSecretResourceMaterialV1 = { resourceId: 'one', encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: 'Key', kind: 'apiKey', value: 'dummy-test-key' } },
            entry: SavedSecretCatalogEntryV1Schema.parse({ ref: formatSharedSavedSecretRefV1('one'), source: 'shared_resource',
                relationship: 'owner', ownerAccountId: accountId, name: 'Key', kind: 'apiKey', revision: 1, materialStatus: 'ready',
                deploymentReferenceState: 'referenced',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }) };
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }))));
        const otherToken = `e30.${Buffer.from(JSON.stringify({ sub: 'other-account' })).toString('base64url')}.signature`;
        vi.mocked(axios.get).mockImplementation(async (rawUrl, config) => {
            const path = new URL(String(rawUrl)).pathname;
            const otherAccount = config?.headers?.Authorization === `Bearer ${otherToken}`;
            if (path === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: accountId,
                connectedAccountsV4: [{ ref: account, displayName: 'Provider name', status: 'connected', authenticationModeId: 'api-key',
                    revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                    configurationReady: true, configurationRevision: null, savedSecretResourceIds: ['one'] }],
                ...(otherAccount ? { id: 'other-account', connectedAccountsV4: [] } : {}) }) };
            if (path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1 && otherAccount) return { status: 200, data: { status: 'absent' } };
            if (path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1) return { status: 200, data: { status: 'present', revision: 1,
                content: { t: 'plain', v: { v: 1, entries: [{ v: 1, subject: { kind: 'account', account }, label: 'Work credential' }] } } } };
            if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: otherAccount ? [] : [resource] } };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                settingsVersion: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
            if (path === '/v2/account/settings') return { status: 200, data: { version: 0, content: { t: 'plain', v: {} } } };
            if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
            if (path === PROFILE_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [], nextCursor: null,
                complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } } };
            if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return { status: 200, data: { status: 'ready', revision: 1 } };
            // All catalog transports use their real empty-row envelope; unknown paths still fail their schema.
            if (path === PROFILE_TRANSFER_ROUTE_V1 || path.startsWith('/v1/account/')) return { status: 200, data: { status: 'absent' } };
            throw new Error(`Unexpected boundary request ${path}`);
        });
        const execute = createCliPersonalSavedSecretActionExecute({ credentials, operationContext,
            home: async () => { throw new Error('Describe must not mutate'); } });
        const executor = createActionExecutor({ personalSavedSecretActionExecute: execute });
        const ref = formatSharedSavedSecretRefV1('one');
        const agent = { surface: 'agent', authority: 'account_automation' } as const;
        const result = await executor.execute('secrets.usedBy', { ref }, agent);
        expect(result).toMatchObject({ ok: true, result: { references: [{ owner: 'connectedAccountCredential',
            referrer: { id: connectedEntitySubjectKeyV1({ kind: 'account', account }), displayName: 'Work credential' } },
            { owner: 'deploymentEnvironment', path: 'deploymentEnvironments.bindings' }] } });
        const censusReads = vi.mocked(axios.get).mock.calls.filter(([url, config]) =>
            new URL(String(url)).pathname === '/v1/account/saved-secrets/resources/materials'
            && config?.params?.includeReferenceCensus === true);
        expect(censusReads).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain('dummy-test-key');
        expect(vi.mocked(axios.get).mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/account/profile')).toHaveLength(1);
        // An active A snapshot must never supply B's census, even for A's exact reference.
        const activeRawSettings = { secretBindingsByProfileId: { 'private-profile-a': { API_KEY: ref } } };
        setActiveAccountSettingsSnapshot({ ...operationContext.readSnapshot()!,
            settings: AccountSettingsSchema.parse(activeRawSettings), rawSettings: activeRawSettings });
        try {
            const otherCredentials = { token: otherToken, encryption: null };
            const otherContext = createInvocationSavedSecretOperationContextV1({ credentials: otherCredentials,
                serverHttpBaseUrl: 'https://describe.example.test', isCurrent: async () => true,
                snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 0,
                    loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKeyForToken(otherToken), settingsSecretsReadKeys: [] } });
            const otherExecutor = createActionExecutor({ personalSavedSecretActionExecute: createCliPersonalSavedSecretActionExecute({
                credentials: otherCredentials, operationContext: otherContext,
                home: async () => { throw new Error('Used-by must not mutate'); } }) });
            await expect(otherExecutor.execute('secrets.usedBy', { ref }, agent)).resolves.toEqual({ ok: true, result: { references: null } });
            await expect(otherExecutor.execute('secrets.usedBy', { ref, accountId }, agent))
                .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        } finally { resetActiveAccountSettingsSnapshotForTests(); }
        resource.entry.deploymentReferenceState = 'unavailable';
        await expect(executor.execute('secrets.usedBy', { ref }, agent)).resolves.toEqual({ ok: true, result: { references: null } });
        resource.entry.deploymentReferenceState = 'unreferenced';
        vi.mocked(axios.get).mockClear();
        await expect(execute({ actionId: 'secrets.list', input: { secretId: 'one' }, context: { surface: 'cli' } }))
            .resolves.toMatchObject({ secrets: [{ secretId: 'one', name: 'Key' }], usedBy: [{ owner: 'connectedAccountCredential',
                referrer: { kind: 'connectedAccountCredential', id: connectedEntitySubjectKeyV1({ kind: 'account', account }), displayName: 'Work credential' } }] });
        expect(vi.mocked(axios.get).mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/account/profile')).toHaveLength(1);
        await expect(execute({ actionId: 'secrets.delete', input: { secretId: 'one', expectedUpdatedAt: 1 }, context: { surface: 'cli' } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'in_use', details: { references: [{ owner: 'connectedAccountCredential',
                referrer: { id: connectedEntitySubjectKeyV1({ kind: 'account', account }), displayName: 'Work credential' } }] } });
        expect(axios.post).not.toHaveBeenCalled();
    });
    it('lists installed source declarations without acquiring native values', async () => {
        let reads = 0;
        const source = await createSecretSourceHostFixture({ runtime: {
            async acquire() { reads += 1; return { ok: true, value: 'private' }; },
        } });
        try {
            const token = `e30.${Buffer.from(JSON.stringify({ sub: 'secret-owner' })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null };
            const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, secretSources: source.host,
                serverHttpBaseUrl: 'https://list.example.test', isCurrent: async () => true,
                snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 0,
                    loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKeyForToken(token), settingsSecretsReadKeys: [] } });
            vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }))));
            vi.mocked(axios.get).mockImplementation(async rawUrl => {
                const path = new URL(String(rawUrl)).pathname;
                if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [] } };
                throw new Error(`Unexpected boundary request ${path}`);
            });
            const execute = createCliPersonalSavedSecretActionExecute({ credentials, operationContext,
                home: async () => { throw new Error('List must not mutate'); } });
            await expect(execute({ actionId: 'secrets.list', input: {}, context: { surface: 'cli' } })).resolves.toEqual({
                secrets: [], sources: [{ contribution: source.contribution, title: 'Fixture vault' }],
            });
            expect(reads).toBe(0);
        } finally { await source.dispose(); }
    });

    it.each([
        { mode: 'plain', sourceKind: 'external' }, { mode: 'e2ee', sourceKind: 'external' },
        { mode: 'plain', sourceKind: 'passkey' }, { mode: 'e2ee', sourceKind: 'passkey' },
    ] as const)('imports $sourceKind through the real $mode resource sealing owner', async ({ mode, sourceKind }) => {
        const accountId = 'secret-owner';
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const keys = tweetnacl.box.keyPair();
        const credentials = { token, encryption: mode === 'plain' ? null : { type: 'dataKey' as const, publicKey: keys.publicKey, machineKey: keys.secretKey } };
        const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
        const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://link.example.test',
            snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 0,
                loadedAtMs: 1, scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
        let retainedResource: SavedSecretResourceMaterialV1 | null = null;
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }))));
        vi.mocked(axios.get).mockImplementation(async rawUrl => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: retainedResource ? [retainedResource] : [] } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode, version: 1, settingsVersion: 0,
                signingKeyFingerprint: null, contentKeyFingerprint: mode === 'plain' ? null : convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'dataKey', machineKey: keys.secretKey }, dataKeyPublicKey: keys.publicKey }).contentPublicKeyFingerprint),
                updatedAt: 1, recipientEnvelopeReadiness: { status: mode === 'plain' ? 'unavailable' : 'available', ...(mode === 'plain' ? { reason: 'plain_account' } : {}) } } };
            throw new Error(`Unexpected boundary request ${path}`);
        });
        const source = sourceKind === 'external'
            ? { kind: 'external' as const, contribution: { pluginId: 'acme.vault', localId: 'vault' }, account: 'my-account', reference: 'op://vault/item/token' }
            : { kind: 'passkey' as const, rpId: 'example.com', credentialId: 'AQID', userHandle: 'BAUG', privateKey: 'BwgJ',
                algorithm: -7 as const, signCount: 0, backupEligibility: true, backupState: true };
        const kind = sourceKind === 'external' ? 'token' : 'other';
        const submitted: ReturnType<typeof SharedSavedSecretCreateInputV1Schema.parse>[] = [];
        const execute = createCliPersonalSavedSecretActionExecute({ credentials, operationContext, home: async ({ actionId, input }) => {
            expect(actionId).toBe('secrets.shared.create');
            const request = SharedSavedSecretCreateInputV1Schema.parse(input); submitted.push(request);
            return { resourceId: request.resourceId, revision: 1 };
        } });
        const result = await execute({ actionId: 'secrets.create', input: { name: 'Vault token', kind, source }, context: { surface: 'cli' } });
        expect(result).toMatchObject({ secretId: expect.any(String), secretRef: expect.any(String) });
        expect(submitted).toHaveLength(1);
        const request = submitted[0]!;
        const resourceDataKey = mode === 'plain' ? null : openEncryptedDataKeyEnvelopeV1({
            envelope: decodeBase64(request.keyEnvelopes![0]!.encryptedDataKey, 'base64'), recipientSecretKeyOrSeed: keys.secretKey });
        const opened = mode === 'plain' ? openSavedSecretResourceStoredContentV1({ resourceId: request.resourceId, mode, storedContent: request.storedContent })
            : openSavedSecretResourceStoredContentV1({ resourceId: request.resourceId, mode, storedContent: request.storedContent, resourceDataKey: resourceDataKey! });
        expect(opened).toEqual({ v: 2, name: 'Vault token', kind, source });
        if (mode === 'e2ee') expect(JSON.stringify(request)).not.toContain(sourceKind === 'passkey' ? 'BwgJ' : 'op://vault/item/token');
        expect(request.accountGrants).toEqual([]); expect(request.teamGrants).toEqual([]); expect(request.groupGrants).toEqual([]);
        const ownerEnvelope = request.keyEnvelopes?.[0];
        retainedResource = { resourceId: request.resourceId, encryptionMode: mode, storedContent: request.storedContent,
            recipientEnvelope: ownerEnvelope ? { encryptedDataKey: ownerEnvelope.encryptedDataKey,
                recipientContentPublicKeyFingerprint: ownerEnvelope.recipientContentPublicKeyFingerprint } : null,
            entry: SavedSecretCatalogEntryV1Schema.parse({ ref: formatSharedSavedSecretRefV1(request.resourceId), source: 'shared_resource',
                relationship: 'owner', ownerAccountId: accountId, name: 'Vault token', kind, revision: 1, materialStatus: 'ready',
                audience: { accounts: [{ kind: 'account', accountId, name: null, firstName: null, lastName: null, username: null, avatarUrl: null }],
                    teams: [], groups: [] }, capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }) };
        await expect(updateOwnedSavedSecretResourceForOperation({ credentials, operationContext, resourceId: request.resourceId,
            expectedRevision: 1, nextName: 'Renamed credential', executeMutation: async input => {
                expect(input).toMatchObject({ resourceId: request.resourceId, expectedRevision: 1, displayName: 'Renamed credential' });
                return { resourceId: request.resourceId, revision: 2 };
            } })).resolves.toEqual({ resourceId: request.resourceId, revision: 2 });
        resourceDataKey?.fill(0);
    });
    it.each([
        { entry: 'action', mismatchedEnvelope: false },
        { entry: 'native', mismatchedEnvelope: false },
        { entry: 'native-default-http', mismatchedEnvelope: false },
        { entry: 'action', mismatchedEnvelope: true },
    ] as const)('rotates one retained Plain resource on an E2EE Account through $entry, mismatchedEnvelope=$mismatchedEnvelope', async ({ entry, mismatchedEnvelope }) => {
        const accountId = 'secret-owner';
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const keys = tweetnacl.box.keyPair();
        const credentials = { token, encryption: { type: 'dataKey' as const, publicKey: keys.publicKey, machineKey: keys.secretKey } };
        const scopeKey = resolveAccountSettingsScopeKeyForToken(token);
        const resourceId = 'held-cloud-key';
        const ref = formatSharedSavedSecretRefV1(resourceId);
        const createdByPlugin = { pluginId: 'acme.cloud', secretId: 'cloud-api' };
        let resource: Extract<SavedSecretResourceMaterialV1, { resourceId: string }> = { resourceId, encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: mismatchedEnvelope ? { t: 'encrypted' as const, c: 'AA==' } : { t: 'plain' as const,
                v: { v: 1 as const, name: 'Cloud key', kind: 'apiKey' as const, value: 'old-key', createdByPlugin } },
            entry: SavedSecretCatalogEntryV1Schema.parse({ ref, source: 'shared_resource' as const, relationship: 'owner' as const, ownerAccountId: accountId,
                name: 'Cloud key', kind: 'apiKey' as const, revision: 7, materialStatus: 'ready' as const,
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } }) };
        const context = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://rotate.example.test',
            snapshot: { source: 'network', settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 4,
                loadedAtMs: 1, scopeKey, settingsSecretsReadKeys: [] }, isCurrent: async () => true });
        const submitted: ReturnType<typeof SharedSavedSecretUpdateInputV1Schema.parse>[] = [];
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }))));
        vi.mocked(axios.get).mockImplementation(async rawUrl => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [resource] } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'e2ee', version: 1, settingsVersion: 4,
                signingKeyFingerprint: null, contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'dataKey', machineKey: keys.secretKey }, dataKeyPublicKey: keys.publicKey }).contentPublicKeyFingerprint),
                updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } } };
            if (path === '/v1/account/saved-secrets/resources/envelope-census') return { status: 200, data: { resourceId, revision: 8, recipients: [], nextCursor: null } };
            throw new Error(`Unexpected boundary request ${path}`);
        });
        const executeMutation = async (input: unknown) => {
            const update = SharedSavedSecretUpdateInputV1Schema.parse(input);
            submitted.push(update);
            const ownerEnvelope = update.keyEnvelopes?.find(envelope => envelope.recipientAccountId === accountId);
            expect(ownerEnvelope).toBeDefined();
            resource = { ...resource, encryptionMode: 'e2ee', storedContent: update.storedContent,
                recipientEnvelope: { encryptedDataKey: ownerEnvelope!.encryptedDataKey,
                    recipientContentPublicKeyFingerprint: ownerEnvelope!.recipientContentPublicKeyFingerprint },
                entry: { ...resource.entry, revision: 8 } };
            return { resourceId, revision: 8 };
        };
        const execute = createCliPersonalSavedSecretActionExecute({ credentials, operationContext: context,
            home: async ({ actionId, input }) => {
                expect(actionId).toBe('secrets.shared.update');
                return executeMutation(input);
            },
        });
        vi.mocked(axios.request).mockImplementation(async request => {
            expect(request.url).toBe(`https://rotate.example.test${SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.update']}`);
            expect(request.method).toBe('POST');
            return { status: 200, data: await executeMutation(request.data) };
        });
        const signal = new AbortController().signal;
        const operation = entry === 'action'
            ? execute({ actionId: 'secrets.update', input: { secretId: resourceId, value: 'rotated-key', expectedUpdatedAt: 7 }, context: { surface: 'cli', signal } })
            : updateOwnedSavedSecretResourceForOperation({ credentials, resourceId, nextValue: 'rotated-key', operationContext: context,
                signal, ...(entry === 'native-default-http' ? {} : { executeMutation }) });
        if (mismatchedEnvelope) {
            // The canonical material-response boundary rejects the mode/envelope mismatch before any mutation.
            await expect(operation).rejects.toMatchObject({ issues: expect.arrayContaining([
                expect.objectContaining({ path: ['resources', 0] }),
            ]) });
            expect(submitted).toEqual([]);
            return;
        }
        const result = await operation;
        expect(result).toEqual(entry === 'action' ? { secretId: resourceId, updatedAt: 8 } : { resourceId, revision: 8 });
        expect(submitted).toHaveLength(1);
        const update = submitted[0]!;
        expect(update).toMatchObject({ resourceId, expectedRevision: 7, toMode: 'e2ee' });
        expect(update).not.toHaveProperty('accountGrants');
        expect(update).not.toHaveProperty('teamGrants');
        expect(update).not.toHaveProperty('groupGrants');
        const dataKey = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(update.keyEnvelopes![0]!.encryptedDataKey, 'base64'), recipientSecretKeyOrSeed: keys.secretKey });
        expect(dataKey).not.toBeNull();
        expect(openSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', storedContent: update.storedContent, resourceDataKey: dataKey! }))
            .toEqual({ v: 1, name: 'Cloud key', kind: 'apiKey', value: 'rotated-key', createdByPlugin });
        expect(await createSavedSecretMaterializerFromSnapshotV1(context.readSnapshot()!).resolve(ref)).toMatchObject({ status: 'ready', value: 'rotated-key' });
        dataKey!.fill(0);
    });
});
