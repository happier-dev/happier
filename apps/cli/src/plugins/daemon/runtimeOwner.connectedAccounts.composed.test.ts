import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';
import { defineProtocolObject, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { deriveRegistryConnectedAccountPurposeReconciliationScopes } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import { createDaemonPluginRuntimeOwner } from './runtimeOwner';

it('admits native and explicit Account bindings through the cold daemon runtime, retaining fail-closed selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-cold-action-binding-'));
    const happyHomeDir = join(root, 'home');
    const pluginRoot = join(root, 'plugin');
    const pluginId = 'acme.cold-binding';
    const service = { pluginId, localId: 'account' };
    const inputSchema = defineProtocolUnion([
        defineProtocolObject({ nativeService: PluginContributionIdentityV1Schema }, { policy: 'closed' }),
        defineProtocolObject({ credentialRef: QualifiedConnectedAccountRefSchema }, { policy: 'closed' }),
    ]).jsonSchema;
    let stored: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };
    let accountAvailable = true;
    // Only persistence, current Account projection and credential materializers
    // are replaced. Admission, publication, binding and SDK dispatch remain real.
    const connectedAccounts = createConnectedAccountPurposeBindingOwner({
        store: {
            read: async () => stored,
            update: async (mutate) => (stored = mutate(stored)),
            subscribe: () => ({ dispose() {} }),
        },
        selectTarget: async () => { throw new Error('Invocation must not open selection UI'); },
        resolveTarget: async (target) => accountAvailable && target.kind === 'account'
            ? { displayName: 'Selected Account', account: target.account } : null,
        materializeAccount: async () => ({ kind: 'httpHeaders', headers: { 'x-fixture': 'fixture-account-token' } }),
        materializeNative: async () => ({ kind: 'httpHeaders', headers: { 'x-fixture': 'fixture-native-token' } }),
        projectTargetAccounts: async () => { throw new Error('Invocation must not enumerate Accounts'); },
        assertTargetAccountMaterializable: async () => { throw new Error('Invocation must not enumerate Accounts'); },
    });
    const controller = createPluginReloadController({ happyHomeDir });
    const owner = createDaemonPluginRuntimeOwner({
        happyHomeDir, staleCandidateCleanup: 'disabled', reloadController: controller,
        connectedAccounts, actionFormConnectedAccounts: connectedAccounts,
        reconcileConnectedAccountPurposePublication: async (input) => {
            await connectedAccounts.reconcileAuthorizedPurposes({
                consumerScopes: deriveRegistryConnectedAccountPurposeReconciliationScopes(
                    input.previous, input.candidate, input.resolveOptionalAccess,
                    { candidateActivePluginIds: input.candidateActivePluginIds },
                ),
                signal: new AbortController().signal, publish: input.publish,
            });
        },
    });
    try {
        await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
        await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(createPluginManifestV2Fixture({
            id: pluginId,
            activation: { events: [{ kind: 'startup' }] },
            hostAccess: { required: [{
                id: 'action-account', capability: 'connectedAccounts', reason: 'Read selected credentials',
                scope: { serviceRefs: ['account'], operations: ['select', 'use'], materializationKinds: ['httpHeaders'] },
            }], optional: [] },
            contributes: {
                connectedAccountDescriptors: [{
                    id: 'account', title: 'Fixture Account', authentication: {
                        defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }],
                    },
                }],
                actions: [{
                    id: 'read', title: 'Read', scopes: ['global'], surfaces: ['cli'],
                    dangerLevel: 'safe', execution: { target: 'daemon' }, hostAccess: ['action-account'],
                    inputSchema,
                    connectedAccountPurposeBindings: [{ path: 'credentialRef', nativeServicePath: 'nativeService', purpose: 'action-account' }],
                }],
            },
        })), 'utf8');
        await writeFile(join(pluginRoot, 'daemon.mjs'), `export function activate(api) {
            api.actions.register('read', async (input, context) => {
                const material = await context.services.connectedAccounts.materialize('action-account',
                    { kind: 'httpHeaders', origin: 'https://example.test', headerNames: ['x-fixture'] },
                    input.nativeService ? { nativeService: input.nativeService } : { expectedAccount: input.credentialRef });
                // Prove which credential was consumed without returning the
                // credential itself through the Action's redacted result.
                const token = material.headers['x-fixture'];
                if (token === 'fixture-native-token') return { source: 'native' };
                if (token === 'fixture-account-token') return { source: 'account' };
                throw new Error('Unexpected materialized fixture credential');
            });
            api.connectedAccounts.register('account', {
                authentication: { modes: { manual: { kind: 'manual', async complete() {
                    return { status: 'connected', displayName: 'Fixture', scopes: [] };
                } } } },
                async refresh() { return { status: 'connected', displayName: 'Fixture', scopes: [] }; },
                async revoke() { return { status: 'remoteUnsupported' }; },
                async status() { return { status: 'connected', displayName: 'Fixture', scopes: [] }; },
                async materialize() { throw new Error('Use the injected credential boundary'); },
            });
        }`, 'utf8');
        await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0', devWatch: false });
        await owner.initialize();
        const lease = await controller.acquireRuntimeRegistry();
        try {
            expect(lease.registry.pluginDiagnosticsByPluginId[pluginId] ?? []).toEqual([]);
            expect(lease.registry.activatedPluginIds.has(pluginId)).toBe(true);
            const invoke = (input: unknown) => lease.registry.targetActionInvocations.invoke({
                pluginId, localId: 'read', input, surface: 'cli',
            });
            await expect(invoke({ nativeService: service })).resolves.toEqual({ status: 'executed', value: { source: 'native' } });
            expect(stored).toEqual({ v: 1, bindings: [] });
            const credentialRef = { service, accountId: 'selected' };
            await expect(invoke({ credentialRef })).resolves.toEqual({ status: 'executed', value: { source: 'account' } });
            accountAvailable = false;
            await expect(invoke({ credentialRef })).resolves.toMatchObject({
                status: 'failed', code: 'plugin_action_form_connected_account_options_unavailable',
                actionHandlerInvocation: 'notStarted',
            });
            await expect(invoke({ nativeService: service, credentialRef })).resolves.toMatchObject({ status: 'invalid' });
        } finally {
            await lease.release();
        }
    } finally {
        await owner.changeService.shutdown();
        await controller.shutdown();
        await rm(root, { recursive: true, force: true });
    }
}, 120_000);
