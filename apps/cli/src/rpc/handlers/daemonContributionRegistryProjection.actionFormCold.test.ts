import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import type { RpcHandler } from '@/api/rpc/types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { readCanonicalPluginManifest } from '@/plugins/manifest/normalize';
import { buildPluginContributionRegistry } from '@/plugins/projection/registry/normalize/package';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import { resolveRegistryConnectedAccountActionFormPurposeAuthorization } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';

describe('cold installed plugin Action form admission', () => {
    it.each([['channel-email', 'channel/setup-v1'], ['channel-telegram', 'telegram/prepare-bot']] as const)('admits the authored %s setup credential field through the canonical form-purpose owner', async (packageId, setupId) => {
        const { PLUGIN_MANIFEST }: Readonly<{ PLUGIN_MANIFEST: unknown }> = await import(
            new URL(`../../../../../packages/plugins/${packageId}/src/plugin.ts`, import.meta.url).href
        );
        const manifest = readCanonicalPluginManifest(PLUGIN_MANIFEST);
        if (!manifest) throw new Error('Expected authored provider manifest');
        const setup = manifest.contributes.actions.find(action => action.id === setupId);
        if (!setup) throw new Error('Expected declared provider setup Action');
        const normalized = buildPluginContributionRegistry({ loadedPlugins: [{
            pluginId: manifest.id, manifest, pluginRootPath: `/plugins/${manifest.id}`,
            manifestPath: `/plugins/${manifest.id}/plugin.json`, daemonEntryPath: `/plugins/${manifest.id}/daemon.js`,
            devDaemonEntryPath: null,
            sourceSpec: { kind: 'path', locator: `/plugins/${manifest.id}`, trustPolicy: 'local_trusted', installPolicy: 'link' },
        }] });
        const registry = createResolvedContributionRegistry({ actions: normalized.actions.map((action): ResolvedActionContribution => ({
            ...action, provenance: 'external', source: { kind: 'path' },
        })) });
        expect(resolveRegistryConnectedAccountActionFormPurposeAuthorization({ registry,
            qualifiedActionId: `${manifest.id}/${setup.id}`, fieldPath: 'credentialRef' })).toMatchObject({
            action: { pluginId: manifest.id, localId: setup.id },
            serviceRefs: [expect.objectContaining({ pluginId: manifest.id })],
        });
    });

    it.each([false, true])('offers declared credentials before Action activation and refuses retirement (native %s)', async native => {
        const pluginId = 'acme.cold-setup';
        const service = { pluginId, localId: 'account' };
        const nativeServiceSchema = { type: 'object' as const, properties: {
            pluginId: { type: 'string' as const }, localId: { type: 'string' as const },
        }, required: ['pluginId', 'localId'], additionalProperties: false as const };
        const accountInputSchema = { type: 'object' as const, properties: { credentialRef: QualifiedConnectedAccountRefJsonSchema },
            required: ['credentialRef'], additionalProperties: false as const };
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            coldStart: true,
            plugins: [{ manifest: createPluginManifestV2Fixture({ id: pluginId,
                hostAccess: { required: [{ id: 'select-account', capability: 'connectedAccounts', reason: 'Select setup account',
                    scope: { serviceRefs: ['account'], operations: ['select', 'use'] } }], optional: [] },
                contributes: { connectedAccountDescriptors: [{ id: 'account', title: 'Account', authentication: {
                    ...(native ? { native: { systemTool: 'gh' as const } } : {}),
                    defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                        fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }],
                } }], actions: [{ id: 'setup', title: 'Setup', scopes: ['settings'], surfaces: ['plugin'],
                    dangerLevel: 'safe', execution: { target: 'daemon' }, hostAccess: ['select-account'],
                    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'select-account',
                        ...(native ? { nativeServicePath: 'nativeService' } : {}) }],
                    inputSchema: native ? { oneOf: [accountInputSchema,
                        { type: 'object', properties: { nativeService: nativeServiceSchema }, required: ['nativeService'], additionalProperties: false }],
                    } : accountInputSchema,
                    inputHints: { fields: [{ path: 'credentialRef', title: 'Account', widget: 'select', connectedAccountOptions: true }] },
                }] },
            }), files: { 'daemon.mjs': "export function activate(api) { api.actions.register('setup', () => ({})); }" } }],
            runtimeOptions: { resolveCurrentMachineId: () => 'machine-1' },
        });
        try {
            const occurrenceId = fixture.registry.readPluginOccurrenceId?.(pluginId);
            expect(occurrenceId).toBeTruthy();
            expect(fixture.registry.targetActionInvocations?.has(pluginId, 'setup')).toBe(false);
            const handlers = new Map<string, RpcHandler>();
            const profile: QualifiedConnectedAccountProfileV4 = { ref: { service, accountId: 'account-1' },
                status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
                credentialRevision: 'csr_abcdefghijklmnopqrstuv', configurationRevision: null, configurationReady: true,
                expiresAt: null, kind: 'token', displayName: 'Setup account', scopes: [] };
            const credentials = createDaemonConnectedAccountPurposeBindingRuntime({
                reloadController: fixture.controller, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
                establishedRuntimeOwner: { invokeWithReceipt: async () => { throw new Error('No credential disclosure for form options'); },
                    invokeDirectMaterial: async () => { throw new Error('No direct material for form options'); } },
                // Only the remote Account API is replaced; manifest admission,
                // registry leases, purpose scope and option projection stay real.
                qualifiedApi: { listAccountsForServices: async services => ({ services, accounts: native ? [] : [profile] }),
                    listAccounts: async () => ({ service, accounts: native ? [] : [profile] }),
                    listGroups: async () => ({ groups: [] }), readGroup: async () => null },
                store: { read: async () => ({ v: 1, bindings: [] }), update: async mutate => mutate({ v: 1, bindings: [] }),
                    subscribe: () => ({ dispose() {} }) },
            });
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => fixture.registry,
                resolveConnectedAccountPurposeBindingRuntime: () => credentials,
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_ACTION_FORM_CONNECTED_ACCOUNT_OPTIONS_RESOLVE);
            if (!handler) throw new Error('Expected real Action-form RPC');
            const request = { machineId: 'machine-1', expectedOccurrenceId: occurrenceId,
                qualifiedActionId: `${pluginId}/setup`, fieldPath: 'credentialRef' };
            expect(await handler(request)).toEqual({ ok: true, options: native
                ? [{ label: 'gh', value: service, nativeServicePath: 'nativeService' }]
                : [{ label: 'Setup account', value: profile.ref }] });
            expect(fixture.registry.targetActionInvocations?.has(pluginId, 'setup')).toBe(false);
            fixture.registry.fencePluginConsumers?.([pluginId]);
            expect(await handler(request)).toMatchObject({ ok: false });
        } finally { await fixture.dispose(); }
    });
});
