import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountPortableRuntime, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

const input = defineProtocolObject({ key: defineProtocolString() }, { policy: 'closed' });
const writeInput = defineProtocolObject({ key: defineProtocolString(), value: defineProtocolString() }, { policy: 'closed' });
const purposeInput = defineProtocolObject({
    link: defineProtocolObject({ credentialRef: defineProtocolObject({
        service: defineProtocolObject({ pluginId: defineProtocolString(), localId: defineProtocolString() }, { policy: 'closed' }),
        accountId: defineProtocolString(),
    }, { policy: 'closed' }) }, { policy: 'closed' }),
    key: defineProtocolString(),
}, { policy: 'closed' });
const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } as const;

const portablePlatformRuntime = {
    authentication: { modes: { token: { kind: 'manual', async complete(input, context) {
        await context.attemptCredentials.set('token', input.fields.token!);
        return { status: 'connected', displayName: 'Platform fixture', scopes: [] };
    } } } },
    async materialize(request, context) {
        if (request.kind !== 'httpHeaders' || request.origin !== 'https://purpose-provider.example'
            || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) {
            throw new PluginError({ code: 'credential_unavailable' });
        }
        const token = await context.credentials.get('token');
        if (!token) throw new PluginError({ code: 'credential_unavailable' });
        return { kind: 'httpHeaders', headers: { authorization: `Bearer ${token}` } };
    },
} satisfies ConnectedAccountPortableRuntime;

const platformRuntime: ConnectedAccountRuntime = {
    ...portablePlatformRuntime,
    async status() { return { status: 'connected', displayName: 'Platform fixture', scopes: [] }; },
    async refresh() { return { status: 'connected', displayName: 'Platform fixture', scopes: [] }; },
    async revoke() { return { status: 'remoteUnsupported' }; },
};

const plugin = definePlugin({
    id: 'acme.account-actions', version: '1.0.0',
    entrypoints: { daemon: './dist/index.js' },
    // KV handlers require this plugin's Account storage grant.
    hostAccess: { required: [{
        id: 'account-storage', capability: 'storage.account',
        reason: 'Read and write personal values in this Account.', scope: { enabled: true },
    }, {
        id: 'controller-api', capability: 'network', reason: 'Send the admitted controller request.',
        scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://account-services.test' }], methods: ['POST'] },
    }, {
        id: 'purpose-api', capability: 'network', reason: 'Inspect the admitted platform target.',
        scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://purpose-provider.example' }], methods: ['GET'] },
    }, {
        id: 'deploy-manage', capability: 'connectedAccounts', reason: 'Use the recorded platform credential.',
        scope: { serviceRefs: ['platform'], operations: ['use'], materializationKinds: ['httpHeaders'] },
    }], optional: [] },
    secrets: [{ id: 'controller-token', custody: 'account' }],
    connectedAccountDescriptors: {
        platform: {
            declaration: { title: 'Platform fixture', authentication: { defaultModeId: 'token', account: execution.account, modes: [{
                id: 'token', kind: 'manual', outcomeReconciliation: 'none',
                fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }],
            }] } },
            runtime: platformRuntime,
            accountRuntime: portablePlatformRuntime,
        },
    },
    resources: {
        'personal-context': { source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'global', execution,
            runtime: { read: ({ context }) => JSON.stringify(context), observe: () => ({ dispose() {} }) } },
    },
    settings: {
        preferences: { title: 'Preferences', target: { kind: 'plugin' }, scope: 'account',
            fields: [{ id: 'endpoint', title: 'Endpoint', schema: { type: 'string' }, default: 'https://default.example' }],
        },
    },
    actions: {
        'controller-connector': { title: 'Mint an installation connector', surfaces: ['plugin', 'cli'], placementBindings: [],
            execution, inputSchema: input, dangerLevel: 'writesRemote', hostAccess: ['controller-api'],
            confirmation: { title: 'Mint an installation connector?' },
            run: async ({ key }, context) => {
                const { http, machineConnectorSecrets } = context.services;
                if (!http || !machineConnectorSecrets) throw new PluginError({ code: 'controller_services_unavailable' });
                const response = await http.request({ url: 'https://account-services.test/connectors', method: 'POST',
                    headers: { 'Content-Type': 'application/json' }, redirect: 'error',
                    body: new TextEncoder().encode(JSON.stringify({ name: key })),
                }, { signal: context.signal });
                const minted: unknown = JSON.parse(new TextDecoder().decode(response.body));
                if (response.status !== 200 || !minted || typeof minted !== 'object'
                    || !('id' in minted) || typeof minted.id !== 'string'
                    || !('token' in minted) || typeof minted.token !== 'string') {
                    throw new PluginError({ code: 'connector_mint_failed' });
                }
                const bytes = new TextEncoder().encode(minted.token);
                try {
                    return await machineConnectorSecrets.write({ token: bytes,
                        subject: { provider: { pluginId: 'acme.account-actions', localId: 'network' }, connectorId: minted.id } });
                } finally { bytes.fill(0); }
            },
        },
        'purpose-request': { title: 'Inspect the recorded platform target', surfaces: ['cli'], placementBindings: [],
            execution, inputSchema: purposeInput, dangerLevel: 'safe', hostAccess: ['purpose-api', 'deploy-manage'],
            connectedAccountPurposeBindings: [{ path: 'link.credentialRef', purpose: 'deploy-manage' }],
            run: async ({ key }, context) => {
                if (!context.services.http) throw new PluginError({ code: 'controller_services_unavailable', message: 'CLI Account HTTP is unavailable' });
                if (key === 'stream') {
                    const response = await context.services.http.requestStream({ url: 'https://purpose-provider.example/projects', method: 'GET', redirect: 'error',
                        credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy-manage',
                            origin: 'https://purpose-provider.example', method: 'GET', headerNames: ['authorization'] },
                    }, { signal: context.signal });
                    const decoder = new TextDecoder();
                    let body = '';
                    try { for await (const chunk of response.chunks) body += decoder.decode(chunk, { stream: true }); }
                    finally { await response.dispose(); }
                    return { status: response.status, body: body + decoder.decode(), echo: response.headers['x-echo'] ?? '' };
                }
                const response = await context.services.http.request({
                    url: key === 'wrong-origin' ? 'https://elsewhere.example/projects' : 'https://purpose-provider.example/projects',
                    method: key === 'wrong-method' ? 'POST' : 'GET', redirect: 'error',
                    credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy-manage',
                        origin: 'https://purpose-provider.example', method: 'GET', headerNames: ['authorization'] },
                    ...(key === 'caller-auth' ? { headers: { Authorization: 'caller-selected-credential' } } : {}),
                }, { signal: context.signal });
                return { status: response.status, body: new TextDecoder().decode(response.body), echo: response.headers['x-echo'] ?? '' };
            },
        },
        'controller-request': { title: 'Send controller request', surfaces: ['plugin', 'cli'], placementBindings: [],
            execution, inputSchema: input, dangerLevel: 'safe', hostAccess: ['controller-api'],
            run: async ({ key }, context) => {
                const { http, secrets } = context.services;
                if (!http || !secrets) throw new PluginError({ code: 'controller_services_unavailable', message: 'CLI Account services are unavailable' });
                const status = await secrets.status(key === 'undeclared-secret' ? 'undeclared-token' : 'controller-token');
                const response = await http.request({ url: key === 'wrong-origin' ? 'https://foreign-services.test/variables' : 'https://account-services.test/variables',
                    method: key === 'wrong-method' ? 'GET' : 'POST',
                    headers: { 'Content-Type': 'application/json' }, redirect: 'error',
                    body: new TextEncoder().encode(JSON.stringify({ value: null })),
                }, { signal: context.signal });
                return { status: response.status, secretState: status.state,
                    response: new TextDecoder().decode(response.body),
                    nativeServices: ['exec', 'fs'].filter(name => name in context.services) };
            },
        },
        'read-settings': { title: 'Read personal settings', surfaces: ['plugin', 'cli', 'agent', 'mcp', 'ui', 'voice'], placementBindings: [],
            execution, inputSchema: input, dangerLevel: 'safe',
            run: async ({ key }, context) => {
                const reader = context.services.settings.forScope({ kind: 'account' });
                const snapshot = await reader.snapshot({ signal: context.signal });
                return { value: snapshot.values[key] ?? null, readerMethods: Object.keys(reader).sort() };
            },
        },
        source: { title: 'Read a Machine source', surfaces: ['plugin', 'cli', 'agent', 'mcp', 'ui'], placementBindings: [],
            execution, inputSchema: input, dangerLevel: 'safe',
            run: async ({ key }, context) => context.services.actions.execute({ pluginId: 'acme.account-source-provider', localId: 'read' }, { key }),
        },
        'record-source': { title: 'Record through an Account source', surfaces: ['plugin', 'cli', 'agent', 'mcp', 'ui'], placementBindings: [],
            execution, inputSchema: input, dangerLevel: 'writesLocal',
            confirmation: { title: 'Record through an Account source?' },
            run: async ({ key }, context) => context.services.actions.execute({ pluginId: 'acme.account-source-provider', localId: 'record' }, { key }),
        },
        echo: { title: 'Echo personal input', surfaces: ['plugin', 'cli', 'agent', 'mcp', 'ui'], placementBindings: [],
            execution, inputSchema: input, dangerLevel: 'safe',
            run: async ({ key }, context) => ({ key, surface: context.surface }),
        },
        read: { title: 'Read personal value', surfaces: ['plugin', 'cli', 'agent', 'mcp', 'ui'], placementBindings: [],
            execution, inputSchema: input, dangerLevel: 'safe', hostAccess: ['account-storage'],
            run: async ({ key }, context) => {
                const entry = await context.services.storage.account.kv.get(key, { signal: context.signal });
                return { value: entry && !('deleted' in entry) ? entry.value : null };
            },
        },
        write: { title: 'Write personal value', surfaces: ['plugin', 'cli', 'agent', 'mcp', 'ui'], placementBindings: [],
            execution, inputSchema: writeInput, dangerLevel: 'writesLocal', hostAccess: ['account-storage'],
            confirmation: { title: 'Write personal value?' },
            run: async ({ key, value }, context) => context.services.storage.account.kv.transaction(async (tx) => {
                const entry = await tx.get(key, { signal: context.signal });
                const stored = await tx.set(key, value, { expectedVersion: entry?.version ?? 'absent', signal: context.signal });
                return { version: stored.version };
            }, { signal: context.signal }),
        },
    },
});

export const manifest = plugin.manifest;
export const activate = plugin.activate;
export const activateAccount = plugin.activateAccount;

const sourceProvider = definePlugin({
    id: 'acme.account-source-provider', version: '1.0.0',
    hostAccess: { required: [{
        id: 'account-storage', capability: 'storage.account',
        reason: 'Record a value in this Account.', scope: { enabled: true },
    }], optional: [] },
    actions: {
        record: { title: 'Record personal value', surfaces: ['plugin', 'cli', 'agent', 'mcp', 'ui'], placementBindings: [],
            execution: { target: 'account', account: {
                artifactId: 'account-source-provider-runtime', exportName: 'activateSourceProvider',
            } },
            inputSchema: input, dangerLevel: 'writesLocal', hostAccess: ['account-storage'],
            confirmation: { title: 'Record personal value?' },
            run: async ({ key }, context) => context.services.storage.account.kv.transaction(async (tx) => {
                const entry = await tx.get(key, { signal: context.signal });
                const stored = await tx.set(key, 'nested-effect', {
                    expectedVersion: entry?.version ?? 'absent', signal: context.signal,
                });
                return { value: 'nested-effect', version: stored.version };
            }, { signal: context.signal }),
        },
    },
});

export const sourceProviderManifest = sourceProvider.manifest;
export const activateSourceProvider = sourceProvider.activateAccount;
