import { describe, expect, expectTypeOf, it } from 'vitest';
import { derivePluginAccountContributionRegistrationRights, derivePluginContributionRegistrationRights, derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { createPluginRegistrationScope } from '../registration/scope.js';
import { definePlugin } from '../definePlugin.js';
import type { PluginInvocationContext } from '../invocation.js';
import type { PluginAccountActionContext } from '../actions/contracts.js';
import { activate as activateAuthentication, portableAuthentication } from '../../examples/public-authoring/portableAuthentication.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '@happier-dev/protocol/plugins/contributions/catalog';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { createPluginHttpFixture } from './http.js';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountPortableReadContext } from '../connectedAccounts.js';
import { createConnectedAccountEstablishedRuntimeDispatcher } from '@happier-dev/cli-common/connectedAccounts';

describe('Account action registration through the shared activation ABI', () => {
    it('admits a public authentication artifact through exact Account rights while retaining the native runtime', async () => {
        const target = { artifactId: 'portable-auth', exportName: 'activate' };
        const nativeRuntime = {
            ...portableAuthentication,
            authentication: { modes: { ...portableAuthentication.authentication.modes,
                native: { kind: 'manual' as const, async complete() {
                    return { status: 'connected' as const, displayName: 'Native import', scopes: [] };
                } },
            } },
            async refresh() { return { status: 'connected' as const }; },
            async revoke() { return { status: 'remoteUnsupported' as const }; },
            async status() { return { status: 'connected' as const }; },
            async materialize() { return { kind: 'httpHeaders' as const, headers: { Authorization: 'native' } }; },
        };
        const plugin = definePlugin({ id: 'acme.portable-auth', version: '1.0.0', connectedAccountDescriptors: {
            example: {
                declaration: { title: 'Example', authentication: { account: target, defaultModeId: 'manual', modes: [{
                    id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [{
                        id: 'token', title: 'Token', secret: true, schema: { type: 'string' },
                    }],
                }, { id: 'native', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] } },
                runtime: nativeRuntime,
                accountRuntime: portableAuthentication,
            },
        } });
        const contributes = plugin.manifest.contributes;
        const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse(contributes.connectedAccountDescriptors![0]!);
        expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({ ...descriptor, authentication: {
            ...descriptor.authentication, account: { ...target, machineId: 'foreign' },
        } }).success).toBe(false);
        const rights = derivePluginAccountContributionRegistrationRights(contributes, target);
        expect(rights).toMatchObject([{ family: 'connectedAccountDescriptors', localId: 'example', target: { realm: 'account', ...target } }]);
        expect(derivePluginAccountContributionRegistrationRights(contributes, { ...target, exportName: 'other' })).toEqual([]);
        const scope = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'account', ...target }, rights });
        activateAuthentication(scope.api);
        const [registered] = scope.commit();
        expect(registered).toMatchObject({ family: 'connectedAccountDescriptors', localId: 'example' });
        if (registered?.family !== 'connectedAccountDescriptors') throw new Error('Expected admitted authentication');
        expect(Object.keys(registered.value.authentication.modes)).toEqual(['manual']);
        const mode = registered.value.authentication.modes.manual;
        if (mode?.kind !== 'manual') throw new Error('Expected the declared portable manual mode');
        const credentials = new Map<string, string>();
        const credentialReads: string[] = [];
        const service = { pluginId: plugin.manifest.id, localId: 'example' };
        const context = {
            plugin: { id: plugin.manifest.id, version: '1.0.0' },
            contribution: { id: 'example', qualifiedId: `${plugin.manifest.id}/example` },
            surface: 'ui', invokedAtMs: 1, signal: new AbortController().signal, service,
            attempt: { kind: 'connect', attemptId: 'attempt' },
            configuration: { target: { kind: 'attempt', attemptId: 'attempt', service, modeId: 'manual' },
                revision: '1', values: {}, async getSecret() { return null; } },
            attemptCredentials: {
                async get(key: string) { credentialReads.push(key); return credentials.get(key) ?? null; },
                async set(key: string, value: string) { credentials.set(key, value); },
                async delete(key: string) { credentials.delete(key); },
            },
            services: { http: createPluginHttpFixture({ async request() { throw new Error('Manual staging needs no HTTP'); } }) },
        } satisfies ConnectedAccountAuthenticationContext;
        expect(await mode.complete({ fields: { token: 'fixture-credential' } }, context)).toEqual({
            status: 'connected', accountId: 'example-account', displayName: 'Example account', scopes: [],
        });
        expect(credentials.get('token')).toBe('fixture-credential');
        const account = { service, accountId: 'example-account' };
        const readContext = {
            plugin: context.plugin, contribution: context.contribution, surface: 'ui',
            invokedAtMs: context.invokedAtMs, signal: context.signal, services: context.services,
            account, configuration: { ...context.configuration, target: { kind: 'account', account } },
            credentials: context.attemptCredentials,
        } satisfies ConnectedAccountPortableReadContext;
        const invocation = {
            target: { account, expectedCredentialRevision: '1', expectedRuntimeConfigurationRevision: '1' },
            context: readContext, isConfigurationCurrent: () => true, isCredentialRevisionCurrent: () => true,
        };
        const dispatcher = createConnectedAccountEstablishedRuntimeDispatcher();
        const materialized = await dispatcher.invokeEstablishedRuntime(registered.value, descriptor, readContext, {
            ...invocation, operation: { kind: 'materialize', request: {
                kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'],
            } },
        }, () => {}, async () => {});
        expect(materialized).toEqual({ kind: 'httpHeaders', headers: { Authorization: 'Bearer fixture-credential' } });
        for (const operation of [
            { kind: 'refresh', operationId: 'refresh', stagedCredentials: context.attemptCredentials },
            { kind: 'status' },
            { kind: 'revoke' },
        ] as const) {
            await expect(dispatcher.invokeEstablishedRuntime(registered.value, descriptor, readContext, {
                ...invocation, operation,
            }, () => {}, async () => {})).rejects.toMatchObject({ code: 'unsupported', retryable: false, details: { operation: operation.kind } });
        }
        const authOnly = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'account', ...target }, rights });
        authOnly.api.connectedAccounts.register('example', { authentication: portableAuthentication.authentication });
        const [authRegistration] = authOnly.commit();
        if (authRegistration?.family !== 'connectedAccountDescriptors') throw new Error('Expected admitted authentication');
        expect(Object.keys(authRegistration.value.authentication.modes)).toEqual(['manual']);
        await expect(dispatcher.invokeEstablishedRuntime(authRegistration.value, descriptor, readContext, {
            ...invocation, operation: { kind: 'materialize', request: {
                kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'],
            } },
        }, () => {}, async () => {})).rejects.toMatchObject({ code: 'unsupported', retryable: false, details: { operation: 'materialize' } });
        // Unsupported operations acquire no credentials or provider resources.
        expect(credentialReads).toEqual(['token']);
        const second = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'account', ...target }, rights });
        plugin.activateAccount(second.api);
        const [secondRegistration] = second.commit();
        expect(secondRegistration).toMatchObject({ family: 'connectedAccountDescriptors', localId: 'example' });
        if (secondRegistration?.family !== 'connectedAccountDescriptors') throw new Error('Expected admitted portable authentication');
        expect(Object.keys(secondRegistration.value.authentication.modes)).toEqual(['manual']);
        const undeclared = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'account', ...target }, rights: [] });
        expect(() => activateAuthentication(undeclared.api)).toThrow(/undeclared/);
        expect(() => createPluginRegistrationScope({ pluginId: plugin.manifest.id,
            target: { realm: 'account', ...target, exportName: 'other' }, rights })).toThrow(/registration realm/);
        const daemon = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'daemon' },
            rights: derivePluginDaemonContributionRegistrationRights(contributes) });
        await plugin.activate(daemon.api);
        const [nativeRegistration] = daemon.commit();
        if (nativeRegistration?.family !== 'connectedAccountDescriptors') throw new Error('Expected admitted native authentication');
        expect(Object.keys(nativeRegistration.value.authentication.modes)).toEqual(['manual', 'native']);
        expect(await nativeRuntime.authentication.modes.native.complete()).toMatchObject({ status: 'connected', displayName: 'Native import' });
        expect(await nativeRuntime.materialize()).toEqual({ kind: 'httpHeaders', headers: { Authorization: 'native' } });
        const catalog = PLUGIN_CONTRIBUTION_CATALOG_V2.find(entry => entry.manifestKey === 'connectedAccountDescriptors')!;
        expect(catalog.extractReferences(contributes.connectedAccountDescriptors![0]!)).toEqual([{
            targetFamily: 'generated.uiArtifacts', reference: target.artifactId, path: ['authentication', 'account', 'artifactId'],
        }]);
        await Promise.all([scope.dispose(), second.dispose(), undeclared.dispose(), daemon.dispose(), authOnly.dispose()]);
        expect(scope.registrations()).toEqual([]);
    });
    it('activates portable Resource-only artifacts through the same exact Account target and retires their producers', async () => {
        const target = { artifactId: 'portable-resources', exportName: 'activate' };
        const plugin = definePlugin({ id: 'acme.account-resources', version: '1.0.0', resources: {
            personal: { source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'session',
                execution: { target: 'account', account: target },
                runtime: { read: ({ context }) => JSON.stringify(context), observe: () => ({ dispose() {} }) } },
        } });
        const scope = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'account', ...target },
            rights: derivePluginAccountContributionRegistrationRights(plugin.manifest.contributes, target) });
        plugin.activateAccount(scope.api);
        expect(scope.commit()).toMatchObject([{ family: 'resources', localId: 'personal' }]);
        const daemon = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'daemon' },
            rights: derivePluginDaemonContributionRegistrationRights(plugin.manifest.contributes) });
        await plugin.activate(daemon.api);
        expect(daemon.commit()).toEqual([]);
        await scope.dispose();
        expect(scope.registrations()).toEqual([]);
        expect(() => scope.api.resources.registerDynamicResource('personal', {
            read: () => 'retired', observe: () => ({ dispose() {} }),
        })).toThrow();
        await daemon.dispose();
    });
    it('infers each handler context from its declared target including the daemon default', () => {
        const plugin = definePlugin({ id: 'acme.inference', version: '1.0.0', actions: {
            daemon: { title: 'Daemon', surfaces: ['plugin'], run: (_input, context) => {
                expectTypeOf(context).toEqualTypeOf<PluginInvocationContext>();
                return null;
            }, observeRead: (_input, invalidate, context) => {
                expectTypeOf(context).toEqualTypeOf<PluginInvocationContext>();
                invalidate();
                invalidate.retire();
                return { dispose() {} };
            } },
            account: { title: 'Account', surfaces: ['plugin'], execution: { target: 'account',
                account: { artifactId: 'portable', exportName: 'activate' } }, run: (_input, context) => {
                expectTypeOf(context).toEqualTypeOf<PluginAccountActionContext>();
                return null;
            }, observeRead: (_input, invalidate, context) => {
                expectTypeOf(context).toEqualTypeOf<PluginAccountActionContext>();
                invalidate();
                invalidate.retire();
                return { dispose() {} };
            } },
        } });
        expect(plugin.manifest.contributes.actions).toMatchObject([
            { id: 'daemon', execution: { target: 'daemon' } },
            { id: 'account', execution: { target: 'account' } },
        ]);
    });
    it('accepts declaration-only Account Actions registered by a separate portable artifact', () => {
        const plugin = definePlugin({ id: 'acme.separate', version: '1.0.0', actions: {
            read: { title: 'Read', surfaces: ['plugin'], execution: { target: 'account',
                account: { artifactId: 'portable', exportName: 'activate' } } },
        } });
        const target = { artifactId: 'portable', exportName: 'activate' };
        const scope = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'account', ...target },
            rights: derivePluginAccountContributionRegistrationRights(plugin.manifest.contributes, target) });
        expect(() => plugin.activateAccount(scope.api)).toThrow(TypeError);
        const activate = (api: typeof scope.api) => api.actions.register('read', () => ({ value: 'portable' }));
        activate(scope.api);
        expect(scope.commit()).toMatchObject([{ family: 'actions', localId: 'read' }]);
    });
    it('activates authored Account Actions without registering them in the daemon realm', async () => {
        const plugin = definePlugin({ id: 'acme.account', version: '1.0.0', actions: {
            read: { title: 'Read', surfaces: ['plugin'], execution: {
                target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' },
            }, run: () => ({ retained: true }) },
        } });
        const scope = createPluginRegistrationScope({ pluginId: plugin.manifest.id,
            target: { realm: 'account', artifactId: 'account-runtime', exportName: 'activateAccount' },
            rights: derivePluginContributionRegistrationRights(plugin.manifest.contributes),
        });
        await plugin.activateAccount(scope.api);
        expect(scope.commit()).toMatchObject([{ family: 'actions', localId: 'read' }]);
        const daemon = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'daemon' },
            rights: derivePluginDaemonContributionRegistrationRights(plugin.manifest.contributes) });
        await plugin.activate(daemon.api);
        expect(daemon.commit()).toEqual([]);
        await Promise.all([scope.dispose(), daemon.dispose()]);
    });
    it('requires an exact target when an author has several portable activation exports', () => {
        const plugin = definePlugin({ id: 'acme.account', version: '1.0.0', actions: {
            first: { title: 'First', surfaces: ['plugin'], execution: { target: 'account',
                account: { artifactId: 'one', exportName: 'activate' } }, run: () => null },
            second: { title: 'Second', surfaces: ['plugin'], execution: { target: 'account',
                account: { artifactId: 'two', exportName: 'activate' } }, run: () => null },
        } });
        const target = { artifactId: 'two', exportName: 'activate' };
        const scope = createPluginRegistrationScope({ pluginId: plugin.manifest.id, target: { realm: 'account', ...target },
            rights: derivePluginAccountContributionRegistrationRights(plugin.manifest.contributes, target) });
        expect(() => plugin.activateAccount(scope.api)).toThrow(TypeError);
        plugin.activateAccount(scope.api, target);
        expect(scope.commit().map((registration) => registration.localId)).toEqual(['second']);
    });
    it('commits the exact portable handler and retires it through the existing scope', async () => {
        const target = { realm: 'account', artifactId: 'account-runtime', exportName: 'activateAccount' } as const;
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.account', target,
            rights: derivePluginContributionRegistrationRights({ actions: [{ id: 'read', execution: {
                target: 'account', account: { artifactId: target.artifactId, exportName: target.exportName },
            } }] }),
        });
        const activate = (api: typeof scope.api) => api.actions.register('read', () => ({ retained: true }));
        activate(scope.api);
        const [registration] = scope.commit();
        expect(registration).toMatchObject({ family: 'actions', localId: 'read' });
        expect(Object.keys(scope.api)).toEqual(['actions', 'resources', 'connectedAccounts']);
        await scope.dispose();
        expect(scope.registrations()).toEqual([]);
    });
});
