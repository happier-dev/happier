import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountPortableRuntime, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { DeploymentTargetRoleInputProtocolSchemasV1, DeploymentTargetRoleInputSchemasV1, DeploymentTargetRoleResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/v2';
import { defineProtocolObject, defineProtocolString, defineProtocolLiteral, ScmHostingRepositoryIdentityV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';

// The package-owned fixture consumes the canonical role parser rather than
// reconstructing its cross-owner fields. Handler and registration use the SDK.
const roleInput = DeploymentTargetRoleInputProtocolSchemasV1.deploy;
const execution = { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } } as const;
const custody = { hostAccess: ['provider-api', 'deploy-manage'],
    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy-manage' }] } as const;
const platformRuntime = {
    authentication: { modes: { token: { kind: 'manual', async complete(input, context) {
        await context.attemptCredentials.set('token', input.fields.token!);
        return { status: 'connected', displayName: 'Deployment fixture', scopes: [] };
    } } } },
    async status() { return { status: 'connected', displayName: 'Deployment fixture', scopes: [] }; },
    async refresh() { return { status: 'connected', displayName: 'Deployment fixture', scopes: [] }; },
    async revoke() { return { status: 'remoteUnsupported' }; },
    async materialize(request, context) {
        if (request.kind !== 'httpHeaders' || request.origin !== 'https://purpose-provider.example')
            throw new PluginError({ code: 'credential_unavailable' });
        const token = await context.credentials.get('token');
        if (!token) throw new PluginError({ code: 'credential_unavailable' });
        return { kind: 'httpHeaders', headers: { authorization: `Bearer ${token}` } };
    },
} satisfies ConnectedAccountPortableRuntime & Pick<ConnectedAccountRuntime, 'status' | 'refresh' | 'revoke'>;
const plugin = definePlugin({
    id: 'acme.deployment-role', version: '1.0.0', entrypoints: { daemon: './dist/index.js' },
    hostAccess: { required: [{ id: 'provider-api', capability: 'network', reason: 'Send the reviewed deployment.',
        scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://purpose-provider.example' }], methods: ['GET'] } },
    { id: 'deploy-manage', capability: 'connectedAccounts', reason: 'Use the stored purpose selection.',
        scope: { serviceRefs: ['platform'],
            operations: ['use'], materializationKinds: ['httpHeaders'] } }], optional: [] },
    deploymentTargets: { runtime: { title: 'Deployment fixture', icon: 'server-outline', targetKind: 'platform', role: 'runtime',
        targetSchema: { type: 'object', additionalProperties: false }, linkSchema: { type: 'object', additionalProperties: false },
        actions: { inspect: 'inspect', link: 'link', deploy: 'deploy', observe: 'observe' },
    } },
    scmHostingProviders: { forge: { declaration: { title: 'Fixture forge', kind: 'github', capabilities: ['detect'],
        authService: 'platform', resolveRefAction: 'resolve-ref' }, runtime: { adapter: {} } } },
    connectedAccountDescriptors: { platform: {
        declaration: { title: 'Deployment fixture', authentication: { defaultModeId: 'token', account: execution.account, modes: [{
            id: 'token', kind: 'manual', outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }],
        }] } },
        runtime: platformRuntime,
        accountRuntime: platformRuntime,
    } },
    actions: {
    'resolve-ref': { title: 'Read the linked branch', surfaces: ['ui', 'cli'], placementBindings: [], execution,
        dangerLevel: 'safe', readOnly: true, hostAccess: ['provider-api', 'deploy-manage'],
        inputSchema: defineProtocolObject({ repository: ScmHostingRepositoryIdentityV1ProtocolSchema,
            ref: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
        resultSchema: defineProtocolObject({ kind: defineProtocolLiteral('value'), value: defineProtocolObject({
            repository: ScmHostingRepositoryIdentityV1ProtocolSchema, branch: defineProtocolString({ minLength: 1 }),
            headSha: defineProtocolString({ minLength: 40, maxLength: 40 }),
        }, { policy: 'closed' }) }, { policy: 'closed' }),
        run: async (input, context) => {
            if (!context.services.http) throw new PluginError({ code: 'controller_services_unavailable' });
            const response = await context.services.http.request({
                url: `https://purpose-provider.example/commits/${encodeURIComponent(input.ref)}`, method: 'GET', redirect: 'error',
                credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy-manage',
                    origin: 'https://purpose-provider.example', method: 'GET', headerNames: ['authorization'] },
            }, { signal: context.signal });
            if (response.status !== 200) throw new PluginError({ code: 'scm_ref_unavailable' });
            return { kind: 'value', value: { repository: input.repository, branch: input.ref,
                headSha: new TextDecoder().decode(response.body) } };
        },
    },
    'purpose-control': { title: 'Read with the recorded Account purpose', surfaces: ['cli'], placementBindings: [], execution,
        inputSchema: DeploymentTargetRoleInputProtocolSchemasV1.inspect, resultSchema: DeploymentTargetRoleResultV1ProtocolSchema,
        dangerLevel: 'safe', readOnly: true, ...custody,
        run: async (_input, context) => {
            if (!context.services.http) throw new PluginError({ code: 'controller_services_unavailable' });
            const response = await context.services.http.request({ url: 'https://purpose-provider.example/projects', method: 'GET', redirect: 'error',
                credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy-manage',
                    origin: 'https://purpose-provider.example', method: 'GET', headerNames: ['authorization'] } },
                { signal: context.signal });
            if (response.status !== 200) throw new PluginError({ code: 'provider_request_failed' });
            return { v: 1 as const, state: 'queued' as const, observedAtMs: 1 };
        },
    },
    inspect: { title: 'Inspect the recorded target', surfaces: ['plugin', 'cli', 'agent'], placementBindings: [], execution,
        inputSchema: DeploymentTargetRoleInputProtocolSchemasV1.inspect, resultSchema: DeploymentTargetRoleResultV1ProtocolSchema,
        dangerLevel: 'safe', readOnly: true, ...custody,
        run: async () => ({ v: 1 as const, state: 'queued' as const, observedAtMs: 1 }),
    },
    link: { title: 'Link the recorded target', surfaces: ['plugin', 'cli'], placementBindings: [], execution,
        inputSchema: DeploymentTargetRoleInputProtocolSchemasV1.link, resultSchema: DeploymentTargetRoleResultV1ProtocolSchema,
        dangerLevel: 'writesRemote', confirmation: { title: 'Link the recorded target?' }, ...custody,
        run: async () => ({ v: 1 as const, state: 'queued' as const, observedAtMs: 1 }),
    },
    observe: { title: 'Observe the recorded deployment', surfaces: ['plugin', 'cli'], placementBindings: [], execution,
        inputSchema: DeploymentTargetRoleInputProtocolSchemasV1.observe, resultSchema: DeploymentTargetRoleResultV1ProtocolSchema,
        dangerLevel: 'safe', readOnly: true, ...custody,
        run: async input => ({ v: 1 as const, state: 'succeeded' as const,
            providerDeploymentId: `provider-${DeploymentTargetRoleInputSchemasV1.observe.parse(input).deploymentId}`, observedAtMs: 1 }),
    },
    deploy: {
        title: 'Deploy the recorded role', surfaces: ['plugin', 'cli'], placementBindings: [],
        execution, inputSchema: roleInput, resultSchema: DeploymentTargetRoleResultV1ProtocolSchema,
        dangerLevel: 'writesRemote', confirmation: { title: 'Deploy the recorded role?' },
        ...custody,
        run: async rawInput => {
            const input = DeploymentTargetRoleInputSchemasV1.deploy.parse(rawInput);
            // This finite fixture endpoint needs no credential. It proves the
            // trusted authored handler/receipt path, not Account HTTP injection.
            const response = await fetch('https://purpose-provider.example/deploy', {
                method: 'GET', redirect: 'error',
                ...(input.sourceIntent.kind === 'repository' ? { headers: { 'x-reviewed-sha': input.sourceIntent.sha } } : {}),
            });
            // Mirror the provider HTTP owner's typed authorization refusal.
            if (response.status === 401 || response.status === 403) throw new PluginError({ code: 'deployment_access_denied',
                details: { phase: 'send' }, failureCause: { phase: 'deployment.provider.send', errorClass: 'Error',
                    errorCode: null, httpStatus: response.status } });
            if (response.status !== 200) throw new PluginError({ code: 'provider_request_failed' });
            const observation: unknown = await response.json();
            const state = observation && typeof observation === 'object' && 'state' in observation
                && observation.state === 'BUILDING' ? 'running' : 'succeeded';
            return { v: 1 as const, state, providerDeploymentId: `provider-${input.deploymentId}`, observedAtMs: 1 };
        },
    } },
});
export const manifest = plugin.manifest;
export const activate = plugin.activate;
export const activateAccount = plugin.activateAccount;
