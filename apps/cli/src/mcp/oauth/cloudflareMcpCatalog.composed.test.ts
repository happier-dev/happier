import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createMcpServerActionExecuteV1, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { commitMcpServerCatalogMutationV1, loadMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { resolveMcpToolDecisionV1 } from '@happier-dev/protocol/mcp/servers/tools/resolveMcpToolDecisionV1';
import { executeConnectedServiceConfigurationActionV1, type ConnectedServiceConfigurationActionHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { QualifiedConnectedAccountCredentialMutationV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedConnectedAccountCredentialPayloadV1Schema, openQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createConnectedAccountConfigurationOwner, parseConnectedAccountConfigurationRecordContent } from '@happier-dev/cli-common/connectedAccounts';
import { resolveQualifiedConnectedAccountPeerOperationTransport } from '@/api/client/qualifiedConnectedAccountApi';
import { createConnectedAccountDaemonRuntime } from '@/daemon/connectedServices/ConnectedAccountDaemonRuntime';
import { createQualifiedConnectedAccountDaemonPersistence } from '@/daemon/connectedServices/qualifiedConnectedAccountDaemonPersistence';
import { createQualifiedConnectedAccountAttemptTransactionAdapters } from '@/daemon/connectedServices/qualifiedConnectedAccountAttemptTransactionAdapters';
import { createConnectedAccountAttemptTransactionApiBoundary } from '@/testkit/connectedAccountAttemptTransactionApi';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { authorizationServer, registeredRegistry, registerMcpOAuthFixtureCleanup } from './mcpOAuthFixture.testkit';

describe('Cloudflare MCP catalog composition', () => {
    it.each([
        { suggestionId: 'cloudflare-api', resource: 'https://mcp.cloudflare.com/mcp', oauth: true, challenge: false },
        { suggestionId: 'cloudflare-docs', resource: 'https://docs.mcp.cloudflare.com/mcp', oauth: false, challenge: false },
        { suggestionId: 'cloudflare-docs', resource: 'https://docs.mcp.cloudflare.com/mcp', oauth: false, challenge: true },
    ])('composes discovery, selected create, exported import and saved-row use for $suggestionId', async ({ suggestionId, resource, oauth, challenge }) => {
        const fixture = await authorizationServer({ resource, tool: oauth || challenge ? 'oauth' : 'public' });
        const registry = await registeredRegistry();
        const service = HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1;
        const serverFeatures = { status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
            capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } }) } as const;
        const persisted: ReturnType<typeof QualifiedConnectedAccountCredentialMutationV4Schema.parse>[] = [];
        // Account HTTP is the persistence boundary. The real daemon owns OAuth
        // transactions, state/PKCE admission and credential/configuration custody.
        const persistence = createQualifiedConnectedAccountDaemonPersistence({
            credentials: { token: 'fixture-account-token', encryption: null }, getAccountEncryptionMode: async () => 'plain',
            attemptTransactions: createQualifiedConnectedAccountAttemptTransactionAdapters({
                credentials: { token: 'fixture-account-token', encryption: null },
                getAccountEncryptionMode: async () => 'plain', getMachineId: () => 'fixture-machine',
                api: createConnectedAccountAttemptTransactionApiBoundary(),
            }),
            resolveServerFeaturesSnapshot: () => serverFeatures,
            readCredential: async () => null, readConfiguration: async () => null,
            listProfiles: async () => ({ service, accounts: [] }),
            secrets: { admit: async () => {}, has: async () => false, read: async () => null },
            async mutateCredential(input) {
                const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(input.mutation);
                persisted.push(mutation);
                return { success: true, credentialRevision: 'csr_1234567890123456789012',
                    configurationRevision: 'initialConfiguration' in mutation ? 'configuration-1' : null };
            },
        });
        const reloadController = createPluginReloadController({ resolveRuntimeRegistry: async () => registry });
        const configurationOwner = createConnectedAccountConfigurationOwner({
            ...persistence.configuration,
            // No service-level configuration is stored in this fresh Account.
            read: async target => target.kind === 'service' ? null : persistence.configuration.read(target),
            isRuntimeCurrent: async () => true,
        });
        const unexpectedRevocation = (): never => { throw new Error('Unexpected revocation during catalog setup'); };
        const daemon = createConnectedAccountDaemonRuntime({
            reloadController, persistence, configurationOwner,
            resolvePeerOperationTransport: input => resolveQualifiedConnectedAccountPeerOperationTransport({ ...input, snapshot: serverFeatures }),
            configurationConsequences: { assertAvailable: async () => {}, apply: async () => {} },
            // Catalog setup must never enter the revocation seam. Refresh and
            // revoke behavior retain their existing runtime-suite coverage.
            revocation: { token: 'fixture-account-token', deleteCredential: unexpectedRevocation,
                resolveV4Support: unexpectedRevocation, resolveRemovalReviewSupport: unexpectedRevocation,
                establishedRuntimeOwner: { invokeWithReceipt: unexpectedRevocation, readCredentialRevision: unexpectedRevocation } },
        });
        registerMcpOAuthFixtureCleanup(async () => { daemon.dispose(); await reloadController.shutdown(); });
        let authenticationRequests = 0;
        const host: ConnectedServiceConfigurationActionHostV1 = {
            assertCurrent() {}, async request() { throw new Error('Unexpected Account HTTP'); },
            async mutatePurposeBindings() {}, async resolveAgent() { return null; }, async resetQuota() {},
            authenticationCommand: async (_machineId, command) => {
                authenticationRequests += 1;
                return daemon.execute(command);
            },
            controlCommand: async (_machineId, command) => daemon.control(command),
        };
        let catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] };
        let revision = 0;
        let identity = 0;
        const execute = createMcpServerActionExecuteV1({
            resolveWebappUrl: () => 'https://app.happier.dev',
            readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
                readRow: async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }) }),
            mutate: (change, expectedRevision) => commitMcpServerCatalogMutationV1({ catalog, revision, change, scope: null,
                writeCatalog: async candidate => {
                    if (revision !== expectedRevision) return { status: 'conflict', revision };
                    catalog = candidate.catalog;
                    return { status: 'updated', revision: ++revision, cursor: revision };
                } }),
            ruleWriteContext: () => ({ nowMs: 1, newId: () => `catalog-${++identity}` }),
            machine: async () => { throw new Error('Unexpected MCP test'); },
            resolveAdministrationMachine: async () => 'fixture-machine',
            describeConnectedService: async (_machineId, command) => daemon.control(command),
            connectedServiceAction: request => executeConnectedServiceConfigurationActionV1(host, request.actionId, request.input),
        });
        const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        const options = await createActionExecutor({}).execute('action.options.resolve', {
            actionId: 'mcp.servers.create', fieldPath: 'suggestionId',
        }, context);
        expect(options).toMatchObject({ ok: true, result: { options: [
            { value: 'cloudflare-api', label: 'Cloudflare API' }, { value: 'cloudflare-docs', label: 'Cloudflare Docs' },
            { value: 'cloudflare-browser', label: 'Cloudflare Browser Run' }, { value: 'cloudflare-containers', label: 'Cloudflare Containers' },
        ] } });
        const where = { kind: 'write', write: { place: { t: 'machine', machineId: 'fixture-machine' }, state: 'on' } } as const;
        const created = await execute({ actionId: 'mcp.servers.create', input: { expectedRevision: 0, suggestionId, where }, context });
        expect(created.ok).toBe(true);
        expect(catalog.servers).toHaveLength(1);
        const createdRow = catalog.servers[0]!;
        expect(createdRow.remote).toMatchObject({ url: resource, ...(oauth ? { auth: { kind: 'oauth' } } : {}) });
        expect(createdRow.remote?.auth).toEqual(oauth ? { kind: 'oauth' } : undefined);
        expect(createdRow.origin).toBeUndefined();
        expect(resolveMcpToolDecisionV1({ policy: createdRow.tools, toolName: 'execute', permissionMode: 'default' }))
            .toMatchObject({ approval: 'ask', effectClass: 'unknown' });
        expect(catalog.bindings).toEqual([expect.objectContaining({ serverId: createdRow.id,
            target: where.write.place, enabled: true })]);
        const read = await execute({ actionId: 'mcp.servers.read', input: { serverId: createdRow.id }, context });
        const exported = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.read'].parse(read.ok ? read.result : null);
        if (exported.status !== 'present' || !('installLink' in exported) || !exported.installLink) throw new Error('Missing exported link');
        catalog = { v: 1, servers: [], bindings: [] };
        revision = 0;
        const source = { kind: 'link', url: exported.installLink } as const;
        const preview = await execute({ actionId: 'mcp.servers.import', input: { source, dryRun: true }, context });
        expect(preview).toMatchObject({ ok: true, result: { servers: [
            expect.objectContaining(oauth ? { auth: { kind: 'oauth' } } : { transport: 'http' }),
        ] } });
        const imported = await execute({ actionId: 'mcp.servers.import', input: { source, dryRun: false, expectedRevision: 0, where }, context });
        expect(imported.ok).toBe(true);
        expect(catalog.servers).toHaveLength(1);
        const saved = catalog.servers[0]!;
        expect(saved.remote?.auth).toEqual(oauth ? { kind: 'oauth' } : undefined);
        expect(saved.remote?.url).toBe(resource);
        expect(fixture.requests).toEqual([]);
        expect(persisted).toEqual([]);
        expect(authenticationRequests).toBe(0);
        const signIn = () => execute({ actionId: 'mcp.servers.signIn.start', input: { serverId: saved.id }, context });
        let headers: Record<string, string> = {};
        if (oauth || challenge) {
            {
                const start = await signIn();
                expect(start.ok).toBe(true);
                const waiting = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.signIn.start'].parse(start.ok ? start.result : null);
                const result = await daemon.execute({ operation: 'cancel', attemptId: waiting.attemptId });
                expect(result.status).toBe('cancelled');
                expect(persisted).toEqual([]);
                expect(fixture.requests.some(request => request.path === '/token')).toBe(false);
            }
            const start = await signIn();
            const waiting = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.signIn.start'].parse(start.ok ? start.result : null);
            const authorization = new URL(waiting.authorizationUrl);
            expect(authorization.searchParams.get('resource')).toBe(resource);
            expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
            const completed = await daemon.execute({ operation: 'completeOAuth', attemptId: waiting.attemptId,
                completion: { callbackUrl: 'https://app.happier.dev/oauth/mcp/callback',
                    state: authorization.searchParams.get('state')!, code: 'fixture-code', iss: `${fixture.base}/issuer` } });
            expect(completed).toMatchObject({ status: 'connected', account: { service, accountId: saved.id } });
            expect(persisted).toHaveLength(1);
            const mutation = persisted[0]!;
            const credential = QualifiedConnectedAccountCredentialPayloadV1Schema.parse(openQualifiedConnectedAccountContentEnvelope({
                kind: 'credential', accountMode: 'plain', envelope: mutation.content,
            }));
            if (!('initialConfiguration' in mutation) || !mutation.initialConfiguration) throw new Error('Missing settled configuration');
            const configuration = openQualifiedConnectedAccountContentEnvelope({ kind: 'configuration', accountMode: 'plain',
                envelope: mutation.initialConfiguration.replacementContentEnvelope });
            const record = parseConnectedAccountConfigurationRecordContent(configuration, 'configuration-1');
            const lease = await registry.resolveConnectedAccountRuntime?.(service);
            if (!lease || lease.owner !== 'host') throw new Error('Missing registered host runtime');
            const material = await lease.runtime.materialize({ kind: 'httpHeaders', origin: new URL(resource).origin, headerNames: ['authorization'] }, {
                account: { service, accountId: saved.id }, signal: new AbortController().signal, invokedAtMs: Date.now(),
                configuration: { target: { kind: 'account', account: { service, accountId: saved.id }, modeId: 'oauth' },
                    revision: record.revision, values: record.values, getSecret: async key => record.secretValues?.[key] ?? null },
                credentials: { get: async key => credential.values[key] ?? null },
            });
            if (material.kind !== 'httpHeaders') throw new Error('Missing HTTP credential material');
            headers = { ...material.headers };
            const verifier = new URLSearchParams(fixture.requests.find(request => request.path === '/token')!.body).get('code_verifier')!;
            expect(authorization.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
            expect(JSON.stringify({ preview, imported, start, completed, catalog })).not.toContain('access-1');
            expect(JSON.stringify(record.values)).not.toContain('registration-secret');
        } else {
            expect(fixture.requests).toEqual([]);
            expect(persisted).toEqual([]);
            expect(authenticationRequests).toBe(0);
        }
        const client = new Client({ name: 'saved-row-harmless-read', version: '1' });
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(saved.remote!.url), { requestInit: { headers } }));
            expect(await client.callTool({ name: 'read_status', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'fixture status: ready' }] });
        } finally { await client.close(); }
    });

});
