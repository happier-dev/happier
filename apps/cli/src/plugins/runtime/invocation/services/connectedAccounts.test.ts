import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { readPluginActionError } from '@happier-dev/protocol/plugins/actions/invocation';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { CRABBOX_PLUGIN } from '../../../../../../../packages/plugins/machine-crabbox/src/manifest';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { resolveManifestHostAccessRequests } from '@/plugins/runtime/hostAccess/manifestRequests';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type {
    ConnectedAccountMaterializationRequest,
    ConnectedAccountBindingSummary as PluginConnectedAccountBindingSummary,
    ConnectedAccountListedAccount as PluginConnectedAccountListedAccount,
    ConnectedAccountMaterialization as PluginConnectedAccountMaterialization,
    ConnectedAccountMetadataList as PluginConnectedAccountMetadataList,
    PluginConnectedAccountMaterializationKind,
} from '@happier-dev/plugin-sdk/connected-accounts';

import {
    createStablePluginConnectedAccountsHost,
    type StablePluginConnectedAccountsOwner,
} from './connectedAccounts';
import type { HostCurrentSessionInteractionsService } from '@/agent/runtime/state/currentSessionUiTypes';
import {
    createConnectedAccountPurposeBindingOwner,
    type ConnectedAccountPurposeBindingStore,
} from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import type {
    PluginConnectedAccountBindingScope,
    PluginInvocationServicesSeed,
} from './types';
import { createStablePluginUiResourceWatchOwner } from './uiResourceWatch';
import { createPluginInvocationLogger, createPluginInvocationSecretRedactor, type PluginInvocationLogRecord } from './logger';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createConnectedAccountPurposeMaterializer } from '@happier-dev/cli-common/connectedAccounts';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountConfigurationSnapshotV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createConnectedAccountHostRuntimeInvoker } from '@/plugins/runtime/connectedAccounts/runtimeInvoker';
import { createPluginInvocationServiceBinding } from './factory';
import { redactPluginInvocationResultData } from '../resultRedaction';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createPurposeTargetResolver } from '@happier-dev/cli-common/connectedAccounts';
import { PluginConnectedAccountAuthenticationV2Schema, QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol';
import { prepareOpenCodeQualifiedConnectedAccounts } from '../../../../../../../packages/plugins/opencode/src/agent/auth/services/qualifiedPurposeLaunch';
import { OPEN_CODE_CONNECTED_ACCOUNT_PURPOSE_IDS } from '../../../../../../../packages/plugins/opencode/src/agent/auth/services/purposes';
import { buildOpenCodeManagedServerSpawnSpec } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/spawnSpec';
import { OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV } from '../../../../../../../packages/plugins/opencode/src/agent/auth/services/requestAuth/env';
import { OPEN_CODE_SYSTEM_TOOL_ID } from '../../../../../../../packages/plugins/opencode/src/agent/systemTool';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { openAiCodexConnectedAccountRuntime } from '../../../../../../../packages/plugins/codex/src/connectedAccounts/openAiCodexRuntime';
import { parseHttpHeadersRequestAuthMaterial } from '@/daemon/connectedServices/requestAuth/parseHttpHeadersRequestAuthMaterial';

const scope: PluginConnectedAccountBindingScope = Object.freeze({
    purpose: 'realtime_upstream',
    serviceRefs: Object.freeze([
        Object.freeze({ pluginId: 'acme.accounts', localId: 'openai' }),
    ]),
    operations: Object.freeze(['select' as const, 'use' as const]),
    materializationKinds: Object.freeze([
        'httpHeaders' as const,
        'environment' as const,
        'files' as const,
    ]),
});

function createSeed(options: Readonly<{
    currentSession?: PluginInvocationServicesSeed['currentSession'];
    session?: PluginInvocationServicesSeed['session'];
}> = {}) {
    const controller = new AbortController();
    const retirement = new AbortController();
    let current = true;
    const seed: PluginInvocationServicesSeed = Object.freeze({
        plugin: Object.freeze({ id: 'acme.consumer', version: '1.0.0' }),
        contribution: Object.freeze({
            id: 'run',
            qualifiedId: 'acme.consumer/actions/run',
        }),
        occurrenceId: 'occurrenceId-1',
        correlationId: 'correlation-1',
        surface: 'cli',
        ...(options.session ? { session: options.session } : {}),
        ...(options.currentSession ? { currentSession: options.currentSession } : {}),
        signal: controller.signal,
        retirementSignal: retirement.signal,
        isOccurrenceCurrent: () => current,
    });
    return {
        seed,
        retire() {
            current = false;
            retirement.abort();
        },
    };
}

function bindingSummary(): PluginConnectedAccountBindingSummary {
    return Object.freeze({
        purpose: scope.purpose,
        service: scope.serviceRefs[0]!,
        account: Object.freeze({
            service: scope.serviceRefs[0]!,
            accountId: 'account-1',
        }),
        target: Object.freeze({ kind: 'group', displayName: 'Primary upstreams' }),
    });
}

function materialization(): PluginConnectedAccountMaterialization {
    return Object.freeze({
        kind: 'httpHeaders',
        headers: Object.freeze({ authorization: 'Bearer secret' }),
    });
}

function listedAccount(
    overrides: Partial<PluginConnectedAccountListedAccount> = {},
): PluginConnectedAccountListedAccount {
    return Object.freeze({
        account: Object.freeze({
            service: scope.serviceRefs[0]!,
            accountId: 'account-1',
        }),
        displayName: 'Primary account',
        state: 'connected' as const,
        connectedAccountOrigins: Object.freeze(['https://eu.example.test']),
        connectedAccountBases: Object.freeze(['https://eu.example.test']),
        ...overrides,
    });
}

function metadataList(
    overrides: Partial<PluginConnectedAccountMetadataList> = {},
): PluginConnectedAccountMetadataList {
    return Object.freeze({
        status: 'complete' as const,
        accounts: Object.freeze([listedAccount()]),
        ...overrides,
    });
}

function createOwner(overrides: Partial<StablePluginConnectedAccountsOwner> = {}): StablePluginConnectedAccountsOwner {
    return {
        getBinding: vi.fn(async () => bindingSummary()),
        requestSelection: vi.fn(async () => bindingSummary()),
        materialize: vi.fn(async () => materialization()),
        listAccounts: vi.fn(async () => metadataList()),
        materializeListedAccount: vi.fn(async () => materialization()),
        watch: vi.fn(() => Object.freeze({ dispose() {} })),
        ...overrides,
    };
}

describe('Crabbox coordinator check through declared host capabilities', () => {
    it('admits a selected coordinator without a local executable or native network effects', async () => {
        const manifest = normalizePluginManifestV2(CRABBOX_PLUGIN.manifest);
        const check = manifest.contributes.actions.find(action => action.id === 'check')!;
        const requests = resolveManifestHostAccessRequests({ manifest, pluginId: manifest.id,
            contribution: { family: 'actions', localId: check.id }, requestIds: check.hostAccess });
        const scopes: PluginConnectedAccountBindingScope[] = requests.flatMap(({ request }) => request.capability === 'connectedAccounts'
            ? [{ purpose: request.id, serviceRefs: request.scope.serviceRefs.map(reference => qualifyPluginContributionReferenceV1(reference, manifest.id)), operations: request.scope.operations,
                materializationKinds: request.scope.materializationKinds }] : []);
        const { seed } = createSeed();
        const account = { service: { pluginId: manifest.id, localId: 'coordinator' }, accountId: 'selected' };
        const connectedAccounts = createStablePluginConnectedAccountsHost(createOwner({
            getBinding: async ({ purpose }) => ({ purpose: purpose.purpose, service: account.service, account, target: { kind: 'group', displayName: 'Coordinator' } }),
            materialize: async () => ({ kind: 'environment', env: { CRABBOX_COORDINATOR_URL: 'https://coordinator.example.test/native',
                CRABBOX_COORDINATOR_TOKEN: 'selected-private-token', CRABBOX_ORG: 'test-org' } }),
        })).bind({ ...seed, plugin: { id: manifest.id, version: manifest.version }, contribution: { id: 'check', qualifiedId: `${manifest.id}/actions/check` } }, scopes);
        const handlers = new Map<string, ActionHandler>();
        await CRABBOX_PLUGIN.activate({ actions: { register(id: string, handler: ActionHandler) {
            handlers.set(id, handler); return { dispose() {} };
        } }, connectedAccounts: { register() { return { dispose() {} }; } } } as unknown as PluginApi);
        const network = vi.fn(async () => { throw new Error('Check must not contact the coordinator'); });
        const context = { invokedAtMs: 123, signal: seed.signal, services: { connectedAccounts,
            http: { request: network }, managedServices: { dependencies: { status: async () => ({ state: 'missing' }) } },
        } } as unknown as PluginInvocationContext;
        expect(await handlers.get('check')!({}, context)).toMatchObject({ available: true });
        expect(network).not.toHaveBeenCalled();
        expect(await handlers.get('options')!({ backendId: 'aws', transport: 'coordinator', namespace: 'test-org', target: 'linux',
            nativeImageId: 'ami-reviewed', nativeSizeId: 'm7i.large', ttlSeconds: 5400, idleTimeoutSeconds: 1800 }, context))
            .toMatchObject({ base: { available: true, launch: { backendId: 'aws', transport: 'coordinator' } } });
    });
});

describe('stable plugin Connected Accounts host', () => {
    it('projects requested revision observations through the real purpose owner without credential access', async () => {
        const { seed } = createSeed();
        const purpose = { consumer: { pluginId: seed.plugin.id, localId: seed.contribution.id }, purpose: scope.purpose };
        const account = { service: scope.serviceRefs[0], accountId: 'observed' };
        const authentication = PluginConnectedAccountAuthenticationV2Schema.parse({ defaultModeId: 'token', modes: [{
            id: 'token', kind: 'manual', outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }],
        }] });
        const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
        const listAccounts = vi.fn(async () => [QualifiedConnectedAccountProfileV4Schema.parse({
            ref: account, authenticationModeId: 'token', status: 'connected', revisionSemantics: 'revisioned',
            credentialRevision, configurationReady: true, configurationRevision: 'config-one', scopes: [], displayName: 'Observed',
        })]);
        const unexpected = async () => { throw new Error('Observation must not select or access credentials'); };
        const owner = createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [{ purpose, target: { kind: 'account', account } }] }),
                update: unexpected, subscribe: () => ({ dispose() {} }) },
            resolveTarget: createPurposeTargetResolver({ available: true,
                resolveService: async () => ({ service: account.service, authentication }), listAccounts }),
            selectTarget: unexpected, materializeAccount: unexpected,
            projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
        });
        const connectedAccounts = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);
        await expect(connectedAccounts.getBinding(scope.purpose, { observation: true })).resolves.toMatchObject({
            account, credentialRevision, configurationRevision: 'config-one',
        });
        expect(listAccounts).toHaveBeenCalledOnce();
    });

    it('connects the detached OpenCode server through its exact Run profile instead of ambient defaults', async () => {
        const consumer = { pluginId: 'happier.agent.opencode', localId: 'opencode' };
        const actionConsumer = { ...consumer, localId: 'nested-action' };
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const purposes = OPEN_CODE_CONNECTED_ACCOUNT_PURPOSE_IDS.map(purpose => ({ consumer, purpose }));
        const selectedPurpose = purposes.find(entry => entry.purpose === 'openai-codex-model-request')!;
        const binding = (accountId: string) => ({ purpose: selectedPurpose,
            target: { kind: 'account' as const, account: { service, accountId } } });
        const authentication = PluginConnectedAccountAuthenticationV2Schema.parse({ defaultModeId: 'token', modes: [{
            id: 'token', kind: 'manual', outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }],
        }] });
        // Account metadata is the boundary. The purpose owner, SDK binding,
        // OpenCode auth projection and managed child launch remain real.
        const resolver = createPurposeTargetResolver({ available: true,
            resolveService: async () => ({ service, authentication }),
            listAccounts: async () => ['ambient-profile', 'judge-profile'].map(accountId => QualifiedConnectedAccountProfileV4Schema.parse({
                ref: { service, accountId }, authenticationModeId: 'token', status: 'connected', revisionSemantics: 'revisioned',
                credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true,
                configurationRevision: null, scopes: [], displayName: accountId,
            })),
        });
        const unused = async () => { throw new Error('Request-auth launch must not acquire native credentials'); };
        const owner = createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [binding('ambient-profile'), {
                ...binding('ambient-profile'), purpose: { ...selectedPurpose, consumer: actionConsumer },
            }] }), update: unused, subscribe: () => ({ dispose() {} }) },
            resolveTarget: resolver, selectTarget: unused, materializeAccount: unused,
            projectTargetAccounts: unused, assertTargetAccountMaterializable: unused,
        });
        const runId = 'detached-opencode-judge';
        const lease = owner.activatePurposeBindings({ subject: { kind: 'execution_run', runId,
            runnerPid: process.pid, agentId: 'opencode', isCurrent: () => true }, purposes, bindings: [binding('judge-profile')] });
        onTestFinished(() => lease.dispose());
        const { seed } = createSeed();
        const runtime = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: { pluginIds: [consumer.pluginId], connectedAccounts: owner },
        });
        onTestFinished(() => runtime.dispose());
        const entry = runtime.registry.agentRuntimesByAgentId.get('opencode');
        if (!entry) throw new Error('Expected admitted OpenCode Agent runtime');
        const { connectedAccounts } = await runtime.registry.createAgentInvocationServices({
            pluginId: entry.pluginId, pluginVersion: entry.pluginVersion,
            agentId: entry.agentId, occurrenceId: entry.occurrenceId,
            processOwner: { kind: 'run', runId }, correlationId: runId,
            cwd: runtime.happyHomeDir, signal: seed.signal, isOccurrenceCurrent: entry.isCurrent,
        });
        expect(await connectedAccounts.getBinding(selectedPurpose.purpose)).toMatchObject({ account: { service, accountId: 'judge-profile' } });
        // A nested Action shares process custody, but keeps its own purpose authority.
        const actionHost = createStablePluginConnectedAccountsHost(owner);
        onTestFinished(() => actionHost.retire());
        const actionAccounts = actionHost.bind({ ...seed, plugin: { id: consumer.pluginId, version: '1.0.0' },
            contribution: { id: actionConsumer.localId, qualifiedId: `${consumer.pluginId}/actions/${actionConsumer.localId}` },
            processOwner: { kind: 'run', runId },
        }, [{ purpose: selectedPurpose.purpose, serviceRefs: [service], operations: ['use'], materializationKinds: ['httpHeaders'] }]);
        expect(await actionAccounts.getBinding(selectedPurpose.purpose)).toMatchObject({ account: { accountId: 'ambient-profile' } });
        const capabilityPath = '/synthetic/run/request-auth/capability.json';
        const prepared = await prepareOpenCodeQualifiedConnectedAccounts({
            launchEnvironment: { values: { [OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]: capabilityPath }, unset: [] },
        }, { signal: seed.signal, services: { connectedAccounts } });
        onTestFinished(() => prepared.dispose());
        const spawn = buildOpenCodeManagedServerSpawnSpec({ id: runId, dialect: 'v1', systemToolId: OPEN_CODE_SYSTEM_TOOL_ID,
            env: prepared.request.launchEnvironment.values });
        if (spawn.mode.kind !== 'spawn') throw new Error('Expected managed OpenCode server child');
        expect(JSON.parse(spawn.mode.launch.env!.OPENCODE_AUTH_CONTENT!)).toHaveProperty('openai');
        expect(spawn.mode.launch.env).toMatchObject({ [OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV]: capabilityPath });
        expect(spawn.mode.launch.env?.OPENCODE_CONFIG_CONTENT).toContain('plugin');
        lease.dispose();
        expect(await connectedAccounts.getBinding(selectedPurpose.purpose)).toBeNull();
    });

    it.each([false, true, 'configuration'] as const)('preserves public resource scope without disclosing credentials (public value equals credential=%s)', async collidingValue => {
        const { seed } = createSeed();
        const account = { service: scope.serviceRefs[0]!, accountId: 'selected' };
        const publicValues = { teamId: 'team_selected_scope', projectId: 'project_selected_scope', organization: 'selected-organization' };
        const token = collidingValue === true ? publicValues.teamId : 'selected-private-bearer-token';
        const configuredSecret = collidingValue === 'configuration' ? publicValues.projectId : 'selected-private-configuration-secret';
        const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
            id: account.service.localId, title: 'Resource provider', authentication: { defaultModeId: 'token', modes: [{
                id: 'token', kind: 'manual', outcomeReconciliation: 'none',
                fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
                configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [
                    ...Object.keys(publicValues).map(id => ({ id, title: id, schema: { type: 'string' }, secret: false })),
                    { id: 'private', title: 'Private', schema: { type: 'string' }, secret: true },
                ] },
            }] },
        });
        const runtime = {
            authentication: { modes: {} },
            refresh: async () => ({ status: 'connected' as const }),
            revoke: async () => ({ status: 'remoteUnsupported' as const }),
            status: async () => ({ status: 'connected' as const }),
            async materialize(_request: ConnectedAccountMaterializationRequest, context: Parameters<import('@happier-dev/plugin-sdk/connected-accounts').ConnectedAccountRuntime['materialize']>[1]) {
                return { kind: 'environment' as const, env: {
                    TEAM: String(context.configuration.values.teamId), PROJECT: String(context.configuration.values.projectId),
                    ORGANIZATION: String(context.configuration.values.organization),
                    TOKEN: (await context.credentials.get('token'))!, PRIVATE: (await context.configuration.getSecret('private'))!,
                } };
            },
        };
        const lease = { ref: account.service, descriptor, runtime, occurrenceId: createPluginRuntimeOccurrenceId(account.service.pluginId),
            sourceCustody: { kind: 'managed' as const, immutableGenerationId: 'provider-artifact', installSource: 'npm' as const }, isCurrent: () => true };
        const invoker = createConnectedAccountHostRuntimeInvoker({
            resolveRuntime: async () => lease, resolvePlugin: () => ({ version: '1.0.0', hostAccessRequests: [] }),
            resolveHostPolicy: () => ({ hostAccess: [], serviceBinding: createPluginInvocationServiceBinding('provider-generation', 'provider') }),
            // The loaded provider invokes no platform service; its configuration and credential readers remain real.
            createServices: () => ({}) as PluginInvocationContext['services'],
            registerRawForRedaction() {},
        });
        const registry = { resolveConnectedAccountRuntime: async () => lease, connectedAccountRuntimeInvoker: invoker };
        const content = (kind: 'credential' | 'configuration', payload: unknown) => sealQualifiedConnectedAccountContentEnvelope({
            kind, accountMode: 'plain', payload, randomBytes: length => new Uint8Array(length),
        });
        const revisions = { authenticationModeId: 'token', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: 'selected-configuration' };
        const credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ...revisions, ref: account,
            content: content('credential', { v: 1, values: { token } }), metadata: { scopes: [] } });
        const configuration = QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({ ...revisions,
            target: { kind: 'account', ref: account }, configurationContent: content('configuration', {
                values: publicValues, secretRefs: {}, secretValues: { private: configuredSecret },
            }) });
        const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({
            // Runtime loading and persisted snapshots are the only substituted system boundaries.
            reloadController: { acquireRuntimeRegistry: async () => ({ registry, source: 'active', release: async () => {} }),
                isRuntimeRegistryCurrent: () => true } as unknown as Pick<PluginReloadController, 'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'>,
            credentials: { token: 'home-token', encryption: null }, getAccountEncryptionMode: async () => 'plain',
            readCredential: async () => credential, readConfiguration: async () => configuration,
            configuration: { read: async () => null, secrets: { admit: async () => {}, has: async () => false, read: async () => null } },
        });
        const fixture = createForegroundPurposeOwnerFixture({ consumer: { pluginId: seed.plugin.id, localId: seed.contribution.id },
            service: account.service, accountId: account.accountId, purpose: scope.purpose,
            materializeAccount: createConnectedAccountPurposeMaterializer(established) });
        const redactor = createPluginInvocationSecretRedactor();
        const redactionScope = { pluginId: seed.plugin.id, occurrenceId: seed.occurrenceId, correlationId: seed.correlationId };
        redactor.beginInvocation(redactionScope, seed.signal);
        const host = createStablePluginConnectedAccountsHost(fixture.owner, {
            registerRawForRedaction: (_seed, value) => redactor.registerRaw(redactionScope, value),
            registerExactForRedaction: (_seed, value) => redactor.registerExact(redactionScope, value),
        });
        try {
            const material = await host.bind(seed, [scope]).materialize(scope.purpose, { kind: 'environment',
                keys: ['TEAM', 'PROJECT', 'ORGANIZATION', 'TOKEN', 'PRIVATE'] });
            expect(material).toEqual({ kind: 'environment', env: {
                TEAM: publicValues.teamId, PROJECT: publicValues.projectId, ORGANIZATION: publicValues.organization,
                TOKEN: token, PRIVATE: configuredSecret,
            } });
            const result = { resource: { scope: { teamId: publicValues.teamId, projectId: publicValues.projectId } },
                options: { base: { launch: { app: { organizationSlug: publicValues.organization } } } },
                pending: { nativeOperationRef: { value: { launch: { app: { organizationSlug: publicValues.organization } } } } },
                leakedCredential: token, leakedConfigurationSecret: configuredSecret };
            expect(redactPluginInvocationResultData(result, value => redactor.redact(redactionScope, value))).toEqual({
                ...result,
                resource: { scope: { ...result.resource.scope, teamId: collidingValue === true ? '[REDACTED]' : publicValues.teamId,
                    projectId: collidingValue === 'configuration' ? '[REDACTED]' : publicValues.projectId } },
                leakedCredential: '[REDACTED]', leakedConfigurationSecret: '[REDACTED]',
            });
        } finally {
            host.retire();
            redactor.completeInvocation(redactionScope);
        }
    });

    it('keeps selected Account authority through the real purpose owner without plugin operation or kind fences', async () => {
        const { seed } = createSeed();
        const selected = { service: scope.serviceRefs[0]!, accountId: 'selected-owner-account' };
        const fixture = createForegroundPurposeOwnerFixture({
            consumer: { pluginId: seed.plugin.id, localId: seed.contribution.id },
            service: selected.service, purpose: scope.purpose, accountId: selected.accountId,
            // This boundary represents the authenticated Account's credential store.
            async materializeAccount({ account }) {
                expect(account).toEqual(selected);
                return { kind: 'environment', env: { TOKEN: 'owner-private-material' } };
            },
        });
        const host = createStablePluginConnectedAccountsHost(fixture.owner);
        const service = host.bind(seed, [{ ...scope, operations: ['select'], materializationKinds: [] }]);
        const request = { kind: 'environment' as const, keys: ['TOKEN'] };
        await expect(service.materialize(scope.purpose, request, {
            expectedAccount: { ...selected, accountId: 'another-accounts-selection' },
        })).rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
        await expect(service.materialize(scope.purpose, request, { expectedAccount: selected }))
            .resolves.toEqual({ kind: 'environment', env: { TOKEN: 'owner-private-material' } });
        await fixture.store.update(() => ({ v: 1, bindings: [], teamResourceSelections: [{
            purpose: fixture.purpose, teamId: 'another-team',
            selection: { source: 'team_resource', resourceId: 'team-private-material', deliveryMode: 'brokered' },
        }] }));
        await expect(service.materialize(scope.purpose, request)).rejects.toMatchObject({
            code: 'plugin_connected_account_team_resource_unavailable', details: { reason: 'session_required' },
        });
        host.retire();
    });

    it('carries real owner authority retirement without invalidating presentation', async () => {
        const { seed, retire } = createSeed();
        const purpose = { consumer: { pluginId: seed.plugin.id, localId: seed.contribution.id }, purpose: scope.purpose };
        const service = scope.serviceRefs[0]!;
        let displayName = 'Selected account';
        let current: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [{ purpose,
            target: { kind: 'account', account: { service, accountId: 'first' } } }] };
        const subscribers = new Set<() => void>();
        // Substitute only the durable-store boundary. Admission, exact-purpose
        // comparison and SDK observation delivery remain the real owners.
        const store: ConnectedAccountPurposeBindingStore = {
            async read() { return current; },
            async update(mutate) { current = mutate(current); for (const listener of subscribers) listener(); return current; },
            subscribe(listener) { subscribers.add(listener); return { dispose() { subscribers.delete(listener); } }; },
        };
        const owner = createConnectedAccountPurposeBindingOwner({ store,
            async selectTarget() { return { kind: 'account', account: { service, accountId: 'second' } }; },
            async resolveTarget(target) {
                if (target.kind !== 'account') throw new Error('Only exact account selections are used');
                return { account: target.account, displayName };
            },
            async resolveCredentialRevision() { return 'csr_abcdefghijklmnopqrstuv'; },
            async materializeAccount() { throw new Error('Authority observation must not materialize credentials'); },
            async projectTargetAccounts() { throw new Error('Authority observation must not enumerate accounts'); },
            async assertTargetAccountMaterializable() { throw new Error('Authority observation must not materialize credentials'); },
        });
        const host = createStablePluginConnectedAccountsHost(owner);
        let retirements = 0;
        const connectedAccounts = host.bind({ ...seed, retireReadObservation() { retirements++; } }, [scope]);
        const subscription = connectedAccounts.watch(scope.purpose, () => {});
        const delivered: unknown[] = [];
        const publicSubscription = host.bind(seed, [scope]).watch(scope.purpose, event => { delivered.push(event); });
        const watches = createStablePluginUiResourceWatchOwner({
            isPluginConsumerCurrent: () => !seed.signal.aborted,
            readPluginOccurrenceId: () => seed.occurrenceId,
            observeReadAuthority(input) {
                const service = host.bind({ ...seed, signal: input.signal,
                    retireReadObservation: input.retire }, [scope]);
                return service.watch(input.authority.purpose, () => {});
            },
        });
        const settled = () => new Promise<void>(resolve => setImmediate(resolve));
        try {
            await expect(watches.open({ callerPluginId: seed.plugin.id, subscriptionId: 'exact-authority',
                readAuthority: { consumer: purpose.consumer, purpose: scope.purpose, input: {} } })).resolves.toEqual({ subscriptionId: 'exact-authority' });
            await settled();
            expect(delivered).toEqual([{ kind: 'resync', authorityChanged: false }]);
            delivered.length = 0;
            for (let index = 0; index < 100; index++) {
                await store.update(value => ({ ...value, bindings: [...value.bindings.filter(binding => binding.purpose.purpose !== 'unrelated'), {
                    purpose: { ...purpose, purpose: 'unrelated' },
                    target: { kind: 'account', account: { service, accountId: `unrelated-${index}` } },
                }] }));
            }
            await settled();
            expect(retirements).toBe(0);
            await store.update(value => value);
            await settled();
            expect(retirements).toBe(0);
            expect(delivered).toEqual([]);
            displayName = 'Renamed account';
            await store.update(value => value);
            await settled();
            expect(retirements).toBe(0);
            expect(delivered).toEqual([{ kind: 'resync', authorityChanged: false }]);
            delivered.length = 0;
            await owner.requestSelection({ purpose, serviceRefs: [service], assertGenerationCurrent() {},
                reason: 'Replace the exact observed authority', signal: seed.signal });
            await settled();
            expect(retirements).toBe(1);
            expect(delivered).toEqual([{ kind: 'resync', authorityChanged: true }]);
            await expect(watches.next({ callerPluginId: seed.plugin.id, subscriptionId: 'exact-authority' }))
                .resolves.toMatchObject({ status: 'event', event: { kind: 'error', code: 'expired_resource',
                    subscriptionId: 'exact-authority' } });
        } finally {
            watches.retire();
            publicSubscription.dispose();
            await subscription.dispose(); host.retire(); retire();
        }
        expect(subscribers.size).toBe(0);
    });

    it('rejects undeclared native services before disclosing credential material', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);
        await expect(service.materialize(scope.purpose, {
            kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'],
        }, { nativeService: { pluginId: 'acme.accounts', localId: 'undeclared' } })).rejects.toMatchObject({ code: 'plugin_connected_account_binding_out_of_scope' });
        expect(owner.materialize).not.toHaveBeenCalled();
    });

    it('delegates purpose-scoped reads, selection, and point-in-time materialization', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await expect(service.getBinding(scope.purpose)).resolves.toEqual(bindingSummary());
        await expect(service.requestSelection({
            purpose: scope.purpose,
            reason: 'Choose an upstream',
        })).resolves.toEqual(bindingSummary());
        await expect(service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        })).resolves.toEqual(materialization());

        expect(owner.getBinding).toHaveBeenCalledWith(expect.objectContaining({
            purpose: {
                consumer: { pluginId: 'acme.consumer', localId: 'run' },
                purpose: scope.purpose,
            },
            serviceRefs: scope.serviceRefs,
        }));
        expect(owner.requestSelection).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'Choose an upstream',
        }));
        expect(owner.materialize).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({ kind: 'httpHeaders' }),
        }));
    });

    it('binds an immutable exact purpose subject and denies selection for managed Provider operations', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(
            seed,
            [scope],
            { exactPurposeBindingSubjectId: 'managed-provider-operation:operation-1' },
        );

        await service.getBinding(scope.purpose);
        await service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        });
        await expect(service.requestSelection({
            purpose: scope.purpose,
            reason: 'Must not mutate a captured operation binding',
        })).rejects.toMatchObject({
            code: 'plugin_host_access_operation_denied',
        });
        expect(owner.requestSelection).not.toHaveBeenCalled();
        expect(owner.getBinding).toHaveBeenCalledWith(expect.objectContaining({
            exactPurposeBindingSubjectId: 'managed-provider-operation:operation-1',
        }));
        expect(owner.materialize).toHaveBeenCalledWith(expect.objectContaining({
            exactPurposeBindingSubjectId: 'managed-provider-operation:operation-1',
        }));
    });

    it('forwards an expected account only as a current-binding comparison precondition', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);
        const expectedAccount = Object.freeze({
            service: scope.serviceRefs[0]!,
            accountId: 'bot:123',
        });

        await expect(service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        }, { expectedAccount })).resolves.toEqual({
            kind: 'httpHeaders',
            headers: { authorization: 'Bearer secret' },
        });

        expect(owner.materialize).toHaveBeenCalledWith(expect.objectContaining({
            expectedAccount,
        }));
    });

    it('rejects a legacy exact-account payload before it reaches the owner', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);
        const account = Object.freeze({
            service: scope.serviceRefs[0]!,
            accountId: 'bot:exact',
        });
        const request = {
            kind: 'httpHeaders' as const,
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        };
        const call = Reflect.apply(service.materialize, service, [
            scope.purpose,
            request,
            Object.freeze({ account }),
        ]);

        await expect(call).rejects.toMatchObject({
            code: 'plugin_connected_account_binding_out_of_scope',
        });
        expect(owner.materialize).not.toHaveBeenCalled();
    });

    it('rejects a legacy exact-account payload even when a current-binding comparison is present', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);
        const account = Object.freeze({
            service: scope.serviceRefs[0]!,
            accountId: 'bot:exact',
        });
        const request = {
            kind: 'httpHeaders' as const,
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        };

        const call = Reflect.apply(service.materialize, service, [
            scope.purpose,
            request,
            Object.freeze({ expectedAccount: account, account }),
        ]);

        await expect(call).rejects.toMatchObject({
            code: 'plugin_connected_account_binding_out_of_scope',
        });
        expect(owner.materialize).not.toHaveBeenCalled();
    });

    it('passes the existing current-session interaction owner only to explicit selection', async () => {
        const request = vi.fn() as HostCurrentSessionInteractionsService['request'];
        const currentSession = Object.freeze({
            interactions: Object.freeze({ request }),
        });
        const owner = createOwner();
        const { seed } = createSeed({ currentSession });
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await service.getBinding(scope.purpose);
        await service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        });
        service.watch(scope.purpose, () => undefined).dispose();
        await service.requestSelection({
            purpose: scope.purpose,
            reason: 'Choose an upstream',
        });

        expect(owner.getBinding).not.toHaveBeenCalledWith(expect.objectContaining({ currentSession }));
        expect(owner.materialize).not.toHaveBeenCalledWith(expect.objectContaining({ currentSession }));
        expect(owner.watch).not.toHaveBeenCalledWith(expect.objectContaining({ currentSession }));
        expect(owner.requestSelection).toHaveBeenCalledWith(expect.objectContaining({
            assertGenerationCurrent: expect.any(Function),
            currentSession,
        }));
        const selectionInput = vi.mocked(owner.requestSelection).mock.calls[0]![0];
        expect(selectionInput.assertGenerationCurrent).not.toThrow();
    });

    it('identifies the consuming Agent session for reads, materialization, and watches', async () => {
        const owner = createOwner();
        const { seed } = createSeed({ session: { id: 'session-1' } });
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await service.getBinding(scope.purpose);
        await service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        });
        service.watch(scope.purpose, () => undefined).dispose();

        expect(owner.getBinding).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
        }));
        expect(owner.materialize).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
        }));
        expect(owner.watch).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
        }));
    });

    it('routes known purposes without enforcing plugin select/use permissions', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const selectOnly = Object.freeze({ ...scope, operations: Object.freeze(['select' as const]) });
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [selectOnly]);

        await expect(service.requestSelection({
            purpose: scope.purpose,
            reason: 'Choose an upstream',
        })).resolves.toEqual(bindingSummary());
        await expect(service.getBinding(scope.purpose)).resolves.toEqual(bindingSummary());
        await expect(service.materialize(scope.purpose, {
            kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'],
        })).resolves.toEqual(materialization());
        const subscription = service.watch(scope.purpose, () => undefined);
        subscription.dispose();
        await expect(service.requestSelection({
            purpose: 'undeclared',
            reason: 'Choose an upstream',
        })).rejects.toMatchObject({
            code: 'plugin_connected_account_purpose_undeclared',
        });
    });

    it('lets the actual Account adapter decide supported materialization kinds', async () => {
        const cases: readonly Readonly<{
            kind: PluginConnectedAccountMaterializationKind;
            request: ConnectedAccountMaterializationRequest;
            result: PluginConnectedAccountMaterialization;
        }>[] = [
            {
                kind: 'httpHeaders',
                request: {
                    kind: 'httpHeaders',
                    origin: 'https://api.example.test',
                    headerNames: ['authorization'],
                },
                result: { kind: 'httpHeaders', headers: { authorization: 'Bearer secret' } },
            },
            {
                kind: 'environment',
                request: { kind: 'environment', keys: ['TOKEN'] },
                result: { kind: 'environment', env: { TOKEN: 'secret' } },
            },
            {
                kind: 'files',
                request: { kind: 'files', fileIds: ['credentials'] },
                result: {
                    kind: 'files',
                    files: { credentials: new TextEncoder().encode('secret') },
                },
            },
        ];

        for (const entry of cases) {
            const allowedOwner = createOwner({
                materialize: vi.fn(async () => entry.result),
            });
            const { seed } = createSeed();
            const allowed = createStablePluginConnectedAccountsHost(allowedOwner).bind(seed, [{
                ...scope,
                materializationKinds: Object.freeze([entry.kind]),
            }]);

            await expect(allowed.materialize(scope.purpose, entry.request))
                .resolves.toEqual(entry.result);
            expect(allowedOwner.materialize).toHaveBeenCalledOnce();

            const deniedOwner = createOwner({
                materialize: vi.fn(async () => entry.result),
            });
            const inspectionOnly = createStablePluginConnectedAccountsHost(deniedOwner).bind(seed, [{
                purpose: scope.purpose,
                serviceRefs: scope.serviceRefs,
                operations: scope.operations,
            }]);
            await expect(inspectionOnly.materialize(scope.purpose, entry.request))
                .resolves.toEqual(entry.result);
        }
    });

    it('rejects a mode-changing accessor before authorization or owner dispatch', async () => {
        let kindReads = 0;
        const request = Object.defineProperty({
            fileIds: ['credentials'],
            keys: ['TOKEN'],
        }, 'kind', {
            enumerable: true,
            get() {
                kindReads += 1;
                return kindReads === 1 ? 'files' : 'environment';
            },
        }) as unknown as ConnectedAccountMaterializationRequest;
        const owner = createOwner({
            materialize: vi.fn(async (input) => {
                if (input.request.kind === 'environment') {
                    return {
                        kind: 'environment' as const,
                        env: { TOKEN: 'unauthorized-secret' },
                    };
                }
                return {
                    kind: 'files' as const,
                    files: { credentials: new TextEncoder().encode('authorized-secret') },
                };
            }),
        });
        const { seed } = createSeed();
        const filesOnly = createStablePluginConnectedAccountsHost(owner).bind(seed, [{
            ...scope,
            materializationKinds: Object.freeze(['files' as const]),
        }]);

        await expect(filesOnly.materialize(scope.purpose, request)).rejects.toMatchObject({
            code: 'plugin_connected_account_binding_out_of_scope',
        });
        expect(owner.materialize).not.toHaveBeenCalled();
        expect(kindReads).toBe(0);
    });

    it('rechecks occurrenceId currentness after snapshotting a crafted request', async () => {
        const invocation = createSeed();
        const request = new Proxy({
            kind: 'environment' as const,
            keys: ['TOKEN'],
        }, {
            ownKeys(target) {
                invocation.retire();
                return Reflect.ownKeys(target);
            },
        });
        const owner = createOwner({
            materialize: vi.fn(async () => ({
                kind: 'environment' as const,
                env: { TOKEN: 'stale-occurrenceId-secret' },
            })),
        });
        const service = createStablePluginConnectedAccountsHost(owner)
            .bind(invocation.seed, [scope]);

        await expect(service.materialize(scope.purpose, request)).rejects.toMatchObject({
            code: 'plugin_final_generation_retired',
        });
        expect(owner.materialize).not.toHaveBeenCalled();
    });

    it('rechecks occurrenceId currentness after composing plugin operation signals before every async owner dispatch', async () => {
        const cases = [
            {
                ownerMethod: 'getBinding' as const,
                invoke: (
                    service: ReturnType<ReturnType<typeof createStablePluginConnectedAccountsHost>['bind']>,
                    signal: AbortSignal,
                ) => service.getBinding(scope.purpose, { signal }),
            },
            {
                ownerMethod: 'requestSelection' as const,
                invoke: (
                    service: ReturnType<ReturnType<typeof createStablePluginConnectedAccountsHost>['bind']>,
                    signal: AbortSignal,
                ) => service.requestSelection({
                    purpose: scope.purpose,
                    reason: 'Choose an upstream',
                }, { signal }),
            },
            {
                ownerMethod: 'materialize' as const,
                invoke: (
                    service: ReturnType<ReturnType<typeof createStablePluginConnectedAccountsHost>['bind']>,
                    signal: AbortSignal,
                ) => service.materialize(scope.purpose, {
                    kind: 'environment',
                    keys: ['TOKEN'],
                }, { signal }),
            },
        ];

        for (const entry of cases) {
            const invocation = createSeed();
            const owner = createOwner();
            const service = createStablePluginConnectedAccountsHost(owner)
                .bind(invocation.seed, [scope]);
            const craftedSignal = {
                addEventListener() {
                    invocation.retire();
                },
                removeEventListener() {},
                get aborted() {
                    return false;
                },
            } as unknown as AbortSignal;

            await expect(entry.invoke(service, craftedSignal)).rejects.toMatchObject({
                code: 'plugin_final_generation_retired',
            });
            expect(owner[entry.ownerMethod]).not.toHaveBeenCalled();
        }
    });

    it('rechecks occurrenceId currentness after reading each request-selection input field', async () => {
        for (const retiringField of ['purpose', 'reason'] as const) {
            const invocation = createSeed();
            const owner = createOwner();
            let purposeReads = 0;
            let reasonReads = 0;
            const input = Object.defineProperties({}, {
                purpose: {
                    enumerable: true,
                    get() {
                        purposeReads += 1;
                        if (retiringField === 'purpose') invocation.retire();
                        return scope.purpose;
                    },
                },
                reason: {
                    enumerable: true,
                    get() {
                        reasonReads += 1;
                        if (retiringField === 'reason') invocation.retire();
                        return 'Choose an upstream';
                    },
                },
            }) as Parameters<ReturnType<
                ReturnType<typeof createStablePluginConnectedAccountsHost>['bind']
            >['requestSelection']>[0];
            const service = createStablePluginConnectedAccountsHost(owner)
                .bind(invocation.seed, [scope]);

            await expect(service.requestSelection(input)).rejects.toMatchObject({
                code: 'plugin_final_generation_retired',
            });
            expect(owner.requestSelection).not.toHaveBeenCalled();
            expect(purposeReads).toBe(1);
            expect(reasonReads).toBe(retiringField === 'purpose' ? 0 : 1);
        }
    });

    it('redacts decoded large Basic credentials without suppressing ordinary diagnostics', async () => {
        const { seed } = createSeed();
        const redactionScope = { pluginId: seed.plugin.id, occurrenceId: seed.occurrenceId, correlationId: seed.correlationId };
        const redactor = createPluginInvocationSecretRedactor();
        redactor.beginInvocation(redactionScope, seed.signal);
        const password = `opaque-${'x'.repeat(13 * 1024)}`;
        const authorization = `Basic ${Buffer.from(`user:${password}`).toString('base64')}`;
        // The credential vault is the external boundary; materialization-to-log redaction stays real.
        const service = createStablePluginConnectedAccountsHost(createOwner({
            materialize: async () => ({ kind: 'httpHeaders', headers: { authorization } }),
        }), {
            registerRawForRedaction: (_seed, value) => redactor.registerRaw(redactionScope, value),
            registerExactForRedaction: (_seed, value) => redactor.registerExact(redactionScope, value),
        }).bind(seed, [scope]);
        try {
            await service.materialize(scope.purpose, { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] });
            const records: PluginInvocationLogRecord[] = [];
            const logger = createPluginInvocationLogger({ seed, secretRedactor: redactor, sink: { write: record => { records.push(record); } } });
            logger.info('credential materialized');
            logger.info(`native echoed ${password}`);
            expect(records.map(record => record.message)).toEqual(['credential materialized', 'native echoed [REDACTED]']);
        } finally { redactor.completeInvocation(redactionScope); }
    });

    it('registers reversible variants for every materialized credential form', async () => {
        const registerForRedaction = vi.fn();
        const owner = createOwner({
            materialize: vi.fn(async (input) => {
                if (input.request.kind === 'httpHeaders') {
                    return Object.freeze({
                        kind: 'httpHeaders' as const,
                        headers: Object.freeze({
                            authorization: 'Bearer header-secret',
                            'proxy-authorization': 'Basic dXNlcjpwYXNzd29yZA==',
                            'x-account': 'account-secret',
                        }),
                    });
                }
                if (input.request.kind === 'environment') {
                    return Object.freeze({
                        kind: 'environment' as const,
                        env: Object.freeze({ TOKEN: 'environment-secret' }),
                    });
                }
                return Object.freeze({
                    kind: 'files' as const,
                    files: Object.freeze({
                        credentials: new TextEncoder().encode('file-secret'),
                        opaque: new Uint8Array([0xfb, 0xff, 0xfe]),
                    }),
                });
            }),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner, {
            registerRawForRedaction: registerForRedaction,
            registerExactForRedaction: registerForRedaction,
        }).bind(seed, [scope]);

        await service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization', 'proxy-authorization', 'x-account'],
        });
        await service.materialize(scope.purpose, {
            kind: 'environment',
            keys: ['TOKEN'],
        });
        await service.materialize(scope.purpose, {
            kind: 'files',
            fileIds: ['credentials', 'opaque'],
        });

        expect(registerForRedaction.mock.calls.map(([, value]) => value)).toEqual(
            expect.arrayContaining([
                'Bearer header-secret',
                'header-secret',
                'Basic dXNlcjpwYXNzd29yZA==',
                'dXNlcjpwYXNzd29yZA==',
                'user:password',
                'password',
                'account-secret',
                'environment-secret',
                'file-secret',
                'ZmlsZS1zZWNyZXQ=',
                '66696c652d736563726574',
                '+//+',
                '-__-',
                'fbfffe',
            ]),
        );
        expect(registerForRedaction.mock.calls.map(([, value]) => value))
            .not.toContain('user');
        expect(registerForRedaction.mock.calls.every(([registeredSeed]) => registeredSeed === seed)).toBe(true);
    });

    it.each([
        {
            caseName: 'malformed decoded credential syntax',
            header: 'Basic dXNlci1vbmx5',
            token: 'dXNlci1vbmx5',
        },
        {
            caseName: 'noncanonical base64',
            header: 'Basic dXNlcjpwYXNzd29yZA',
            token: 'dXNlcjpwYXNzd29yZA',
        },
        {
            caseName: 'non-UTF-8 decoded bytes',
            header: 'Basic //4=',
            token: '//4=',
        },
    ])('registers only the raw Basic header and token for $caseName', async ({ header, token }) => {
        const registerRawForRedaction = vi.fn();
        const registerExactForRedaction = vi.fn();
        const owner = createOwner({
            materialize: vi.fn(async () => Object.freeze({
                kind: 'httpHeaders' as const,
                headers: Object.freeze({ authorization: header }),
            })),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner, {
            registerRawForRedaction,
            registerExactForRedaction,
        }).bind(seed, [scope]);

        await service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        });

        expect(registerRawForRedaction.mock.calls).toEqual([
            [seed, header],
            [seed, token],
        ]);
        expect(registerExactForRedaction).not.toHaveBeenCalled();
    });

    it('preserves real Codex expiry through purpose materialization and the native request-auth reader', async () => {
        const { seed } = createSeed();
        const serviceRef = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const account = { service: serviceRef, accountId: 'expiry-account' };
        const expiresAt = 4_102_444_800_000;
        const values = new Map([['accessToken', 'fixture-access'], ['expiresAtMs', String(expiresAt)], ['providerAccountId', 'fixture-account']]);
        const request = { kind: 'httpHeaders' as const, origin: 'https://chatgpt.com', headerNames: ['authorization', 'chatgpt-account-id'] };
        const fixture = createForegroundPurposeOwnerFixture({
            consumer: { pluginId: seed.plugin.id, localId: seed.contribution.id }, service: serviceRef,
            accountId: account.accountId, purpose: scope.purpose,
            materializeAccount: async input => openAiCodexConnectedAccountRuntime.materialize(input.request, {
                account: input.account, signal: input.signal, credentials: { get: async key => values.get(key) ?? null },
                configuration: { target: { kind: 'account', account, modeId: 'oauth' }, revision: 'fixture-config', values: {}, getSecret: async () => null },
                services: {},
            } as Parameters<typeof openAiCodexConnectedAccountRuntime.materialize>[1]),
        });
        const host = createStablePluginConnectedAccountsHost(fixture.owner);
        try {
            const material = await host.bind(seed, [{ ...scope, serviceRefs: [serviceRef] }]).materialize(scope.purpose, request);
            expect(parseHttpHeadersRequestAuthMaterial(request, material)).toEqual({
                headers: { authorization: 'Bearer fixture-access', 'chatgpt-account-id': 'fixture-account' }, facts: {}, expiresAt,
            });
        } finally { host.retire(); }
    });

    it('returns bounded point-in-time copies and registers redaction from those copies', async () => {
        const sourceHeaders = { authorization: 'Bearer original-header' };
        const sourceEnvironment = { TOKEN: 'original-environment' };
        const sourceFile = new TextEncoder().encode('original-file');
        const sourceFiles = { credentials: sourceFile };
        const registerForRedaction = vi.fn();
        const owner = createOwner({
            materialize: vi.fn(async (input) => {
                if (input.request.kind === 'httpHeaders') {
                    return { kind: 'httpHeaders' as const, headers: sourceHeaders };
                }
                if (input.request.kind === 'environment') {
                    return { kind: 'environment' as const, env: sourceEnvironment };
                }
                return { kind: 'files' as const, files: sourceFiles };
            }),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner, {
            registerRawForRedaction: registerForRedaction,
            registerExactForRedaction: registerForRedaction,
        }).bind(seed, [scope]);

        const headers = await service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        });
        const environment = await service.materialize(scope.purpose, {
            kind: 'environment',
            keys: ['TOKEN'],
        });
        const files = await service.materialize(scope.purpose, {
            kind: 'files',
            fileIds: ['credentials'],
        });

        sourceHeaders.authorization = 'Bearer mutated-header';
        sourceEnvironment.TOKEN = 'mutated-environment';
        sourceFile.fill(0);
        sourceFiles.credentials = new TextEncoder().encode('mutated-file');

        expect(headers).toEqual({
            kind: 'httpHeaders',
            headers: { authorization: 'Bearer original-header' },
        });
        expect(environment).toEqual({
            kind: 'environment',
            env: { TOKEN: 'original-environment' },
        });
        expect(files.kind === 'files' ? new TextDecoder().decode(files.files.credentials) : null)
            .toBe('original-file');
        expect(Object.isFrozen(headers)).toBe(true);
        expect(headers.kind === 'httpHeaders' && Object.isFrozen(headers.headers)).toBe(true);
        expect(Object.isFrozen(environment)).toBe(true);
        expect(environment.kind === 'environment' && Object.isFrozen(environment.env)).toBe(true);
        expect(Object.isFrozen(files)).toBe(true);
        expect(files.kind === 'files' && Object.isFrozen(files.files)).toBe(true);
        expect(registerForRedaction.mock.calls.map(([, value]) => value)).toEqual(
            expect.arrayContaining([
                'Bearer original-header',
                'original-environment',
                'original-file',
            ]),
        );
        expect(registerForRedaction.mock.calls.map(([, value]) => value)).not.toEqual(
            expect.arrayContaining([
                'Bearer mutated-header',
                'mutated-environment',
                'mutated-file',
            ]),
        );
    });

    it('rejects producer materialization outside the requested kind and key bounds', async () => {
        const { seed } = createSeed();
        const cases: readonly Readonly<{
            request:
                | { kind: 'httpHeaders'; origin: string; headerNames: readonly string[] }
                | { kind: 'environment'; keys: readonly string[] }
                | { kind: 'files'; fileIds: readonly string[] };
            result: PluginConnectedAccountMaterialization;
        }>[] = [
            {
                request: {
                    kind: 'httpHeaders',
                    origin: 'https://api.example.test',
                    headerNames: ['authorization'],
                },
                result: { kind: 'environment', env: { TOKEN: 'secret' } },
            },
            {
                request: {
                    kind: 'httpHeaders',
                    origin: 'https://api.example.test',
                    headerNames: ['authorization'],
                },
                result: {
                    kind: 'httpHeaders',
                    headers: {
                        Authorization: 'Bearer allowed-case-insensitively',
                        'x-unrequested-secret': 'secret',
                    },
                },
            },
            {
                request: { kind: 'environment', keys: ['TOKEN'] },
                result: {
                    kind: 'environment',
                    env: { TOKEN: 'allowed', EXTRA_SECRET: 'secret' },
                },
            },
            {
                request: { kind: 'files', fileIds: ['credentials'] },
                result: {
                    kind: 'files',
                    files: {
                        credentials: new Uint8Array([1]),
                        unrequested: new Uint8Array([2]),
                    },
                },
            },
        ];

        for (const entry of cases) {
            const owner = createOwner({
                materialize: vi.fn(async () => entry.result),
            });
            const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);
            await expect(service.materialize(scope.purpose, entry.request)).rejects.toMatchObject({
                code: 'plugin_connected_account_binding_out_of_scope',
            });
        }
    });

    it('rejects case-colliding producer header names before registering redaction', async () => {
        const registerRawForRedaction = vi.fn();
        const registerExactForRedaction = vi.fn();
        const owner = createOwner({
            materialize: vi.fn(async () => ({
                kind: 'httpHeaders' as const,
                headers: {
                    Authorization: 'Bearer first-secret',
                    authorization: 'Bearer second-secret',
                },
            })),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner, {
            registerRawForRedaction,
            registerExactForRedaction,
        }).bind(seed, [scope]);

        await expect(service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        })).rejects.toMatchObject({
            code: 'plugin_connected_account_binding_out_of_scope',
        });
        expect(registerRawForRedaction).not.toHaveBeenCalled();
        expect(registerExactForRedaction).not.toHaveBeenCalled();
    });

    it('preserves one allowed producer header casing variant', async () => {
        const owner = createOwner({
            materialize: vi.fn(async () => ({
                kind: 'httpHeaders' as const,
                headers: { Authorization: 'Bearer secret' },
            })),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await expect(service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        })).resolves.toEqual({
            kind: 'httpHeaders',
            headers: { Authorization: 'Bearer secret' },
        });
    });

    it('rechecks occurrenceId currentness after snapshotting a crafted producer result', async () => {
        const invocation = createSeed();
        const result = Object.defineProperty({
            kind: 'httpHeaders' as const,
        }, 'headers', {
            enumerable: true,
            get() {
                invocation.retire();
                return { authorization: 'Bearer stale-occurrenceId-secret' };
            },
        }) as PluginConnectedAccountMaterialization;
        const owner = createOwner({
            materialize: vi.fn(async () => result),
        });
        const service = createStablePluginConnectedAccountsHost(owner)
            .bind(invocation.seed, [scope]);

        await expect(service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        })).rejects.toMatchObject({
            code: 'plugin_final_generation_retired',
        });
    });

    it('rejects a materialization whose invocation retires while the owner is pending', async () => {
        let resolveMaterialization: (
            value: PluginConnectedAccountMaterialization,
        ) => void = () => undefined;
        const owner = createOwner({
            materialize: vi.fn(async () => await new Promise<
                PluginConnectedAccountMaterialization
            >((resolve) => {
                resolveMaterialization = resolve;
            })),
        });
        const invocation = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner)
            .bind(invocation.seed, [scope]);
        const pending = service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        });
        void pending.catch(() => undefined);
        await vi.waitFor(() => expect(owner.materialize).toHaveBeenCalledOnce());
        invocation.retire();
        resolveMaterialization(materialization());

        await expect(pending).rejects.toMatchObject({
            code: 'plugin_final_generation_retired',
        });
    });

    it('registers before one initial resync, coalesces invalidations, and reschedules changes during delivery', async () => {
        let invalidate: (() => void) | null = null;
        let registered = false;
        const dispose = vi.fn();
        const owner = createOwner({
            watch: vi.fn((input) => {
                invalidate = () => input.listener({ account: null, authorityChanged: true });
                input.listener({ account: null, authorityChanged: true });
                registered = true;
                return Object.freeze({ dispose });
            }),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);
        const events: string[] = [];
        let invalidatedDuringDelivery = false;

        const subscription = service.watch(scope.purpose, (event) => {
            expect(registered).toBe(true);
            events.push(event.kind);
            if (!invalidatedDuringDelivery) {
                invalidatedDuringDelivery = true;
                invalidate?.();
                invalidate?.();
            }
        });

        expect(events).toEqual([]);
        await Promise.resolve();
        expect(events).toEqual(['resync']);
        await Promise.resolve();
        expect(events).toEqual(['resync', 'resync']);

        subscription.dispose();
        (invalidate as (() => void) | null)?.();
        await Promise.resolve();
        expect(events).toEqual(['resync', 'resync']);
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('delivers an invalidation that arrives before the initial resync as a separate resync', async () => {
        let invalidate: (() => Promise<void>) | null = null;
        const owner = createOwner({
            watch: vi.fn((input) => {
                invalidate = () => input.listener({ account: null, authorityChanged: true });
                return Object.freeze({ dispose() {} });
            }),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);
        const delivered: string[] = [];

        const subscription = service.watch(scope.purpose, (event) => {
            delivered.push(event.kind);
        });
        const invalidationDelivered = (
            invalidate as (() => Promise<void>) | null
        )?.();

        expect(delivered).toEqual([]);
        await invalidationDelivered;
        expect(delivered).toEqual(['resync', 'resync']);

        subscription.dispose();
    });

    it('serializes async resync delivery and coalesces invalidations while the listener is pending', async () => {
        let invalidate: (() => void) | null = null;
        const owner = createOwner({
            watch: vi.fn((input) => {
                invalidate = () => {
                    void input.listener({ account: null, authorityChanged: true });
                };
                return Object.freeze({ dispose() {} });
            }),
        });
        const { seed } = createSeed({ session: { id: 'session-1' } });
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);
        const releases: Array<() => void> = [];
        const delivered: string[] = [];

        const subscription = service.watch(scope.purpose, async () => {
            delivered.push('resync');
            await new Promise<void>((resolve) => releases.push(resolve));
        });

        await vi.waitFor(() => expect(delivered).toEqual(['resync']));
        (invalidate as (() => void) | null)?.();
        (invalidate as (() => void) | null)?.();
        await Promise.resolve();
        await Promise.resolve();
        expect(delivered).toEqual(['resync']);

        releases.shift()?.();
        await vi.waitFor(() => expect(delivered).toEqual(['resync', 'resync']));
        releases.shift()?.();
        subscription.dispose();
    });

    it('retires the invocation capability and its subscriptions with the consumer occurrenceId', async () => {
        const dispose = vi.fn();
        const owner = createOwner({
            watch: vi.fn(() => Object.freeze({ dispose })),
        });
        const invocation = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(invocation.seed, [scope]);
        service.watch(scope.purpose, () => undefined);

        invocation.retire();

        expect(dispose).toHaveBeenCalledOnce();
        expect(() => service.watch(scope.purpose, () => undefined)).toThrow(expect.objectContaining({
            code: 'plugin_final_generation_retired',
        }));
        await expect(service.getBinding(scope.purpose)).rejects.toMatchObject({
            code: 'plugin_final_generation_retired',
        });
        await expect(service.materialize(scope.purpose, {
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization'],
        })).rejects.toMatchObject({
            code: 'plugin_final_generation_retired',
        });
        expect(owner.materialize).not.toHaveBeenCalled();
    });

    it('synchronously disposes active watches when the executable registry retires its consumers', () => {
        const dispose = vi.fn();
        const owner = createOwner({
            watch: vi.fn(() => Object.freeze({ dispose })),
        });
        const invocation = createSeed();
        const host = createStablePluginConnectedAccountsHost(owner);
        host.bind(invocation.seed, [scope]).watch(scope.purpose, () => undefined);

        host.retire();

        expect(dispose).toHaveBeenCalledOnce();
    });

    it('projects a purpose-scoped metadata listing and honors its requested limit', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await expect(service.listAccounts({ purpose: scope.purpose, limit: 10_000 }))
            .resolves.toEqual({
                status: 'complete',
                accounts: [{
                    account: { service: scope.serviceRefs[0]!, accountId: 'account-1' },
                    displayName: 'Primary account',
                    state: 'connected',
                    connectedAccountOrigins: ['https://eu.example.test'],
                    connectedAccountBases: ['https://eu.example.test'],
                }],
            });
        expect(owner.listAccounts).toHaveBeenCalledWith(expect.objectContaining({
            purpose: {
                consumer: { pluginId: 'acme.consumer', localId: 'run' },
                purpose: scope.purpose,
            },
            serviceRefs: scope.serviceRefs,
            limit: 10_000,
        }));
    });

    it('preserves an explicitly truncated listing rather than reporting a complete result', async () => {
        const owner = createOwner({
            listAccounts: vi.fn(async () => metadataList({ status: 'truncated' })),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await expect(service.listAccounts({ purpose: scope.purpose }))
            .resolves.toMatchObject({ status: 'truncated' });
    });

    it('rejects an owner result that exceeds an explicit caller limit', async () => {
        const owner = createOwner({
            listAccounts: vi.fn(async () => metadataList({ accounts: [
                listedAccount(),
                listedAccount({ account: { service: scope.serviceRefs[0]!, accountId: 'account-2' } }),
            ] })),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await expect(service.listAccounts({ purpose: scope.purpose, limit: 1 })).rejects.toMatchObject({
            code: 'plugin_connected_account_binding_out_of_scope',
        });
    });

    it('routes a known listing purpose without enforcing plugin select/use permissions', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [
            { ...scope, purpose: 'select_only', operations: Object.freeze(['select' as const]) },
        ]);

        await expect(service.listAccounts({ purpose: scope.purpose })).rejects.toMatchObject({
            code: 'plugin_connected_account_purpose_undeclared',
        });
        await expect(service.listAccounts({ purpose: 'select_only' })).resolves.toMatchObject({ accounts: expect.any(Array) });
        expect(owner.listAccounts).toHaveBeenCalledOnce();
    });

    it('rejects an owner listing that escapes the authorized service scope', async () => {
        const owner = createOwner({
            listAccounts: vi.fn(async () => metadataList({
                accounts: Object.freeze([listedAccount({
                    account: Object.freeze({
                        service: Object.freeze({ pluginId: 'acme.accounts', localId: 'anthropic' }),
                        accountId: 'account-2',
                    }),
                })]),
            })),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await expect(service.listAccounts({ purpose: scope.purpose })).rejects.toMatchObject({
            code: 'plugin_connected_account_binding_out_of_scope',
        });
    });

    it('rejects a listed origin that is not an exact credential-free HTTPS origin', async () => {
        const owner = createOwner({
            listAccounts: vi.fn(async () => metadataList({
                accounts: Object.freeze([listedAccount({
                    connectedAccountOrigins: Object.freeze(['https://user:secret@eu.example.test']),
                    connectedAccountBases: Object.freeze(['https://user:secret@eu.example.test']),
                })]),
            })),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await expect(service.listAccounts({ purpose: scope.purpose })).rejects.toMatchObject({
            code: 'plugin_connected_account_binding_out_of_scope',
        });
    });

    it('projects a path-prefixed configured base alongside the origin HostAccess governs', async () => {
        const owner = createOwner({
            listAccounts: vi.fn(async () => metadataList({
                accounts: Object.freeze([listedAccount({
                    connectedAccountOrigins: Object.freeze(['https://dev.azure.test']),
                    connectedAccountBases: Object.freeze(['https://dev.azure.test/acme']),
                })]),
            })),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await expect(service.listAccounts({ purpose: scope.purpose }))
            .resolves.toMatchObject({
                accounts: [{
                    connectedAccountOrigins: ['https://dev.azure.test'],
                    connectedAccountBases: ['https://dev.azure.test/acme'],
                }],
            });
    });

    it.each([undefined, 300])('preserves every declared origin and configured base in a metadata listing (limit %s)', async (limit) => {
        const origins = Array.from({ length: 40 }, (_, index) => `https://endpoint-${index}.example.test`);
        const bases = origins.flatMap(origin => [origin, `${origin}/deployment`]);
        const account = listedAccount({
            displayName: 'a'.repeat(513),
            connectedAccountOrigins: origins,
            connectedAccountBases: bases,
        });
        const accounts = Array.from({ length: 300 }, (_, index) => listedAccount({
            ...(index === 0 ? account : {}),
            account: { service: scope.serviceRefs[0]!, accountId: `account-${index}` },
        }));
        const owner = createOwner({
            listAccounts: vi.fn(async () => metadataList({ accounts })),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await expect(service.listAccounts({ purpose: scope.purpose, ...(limit === undefined ? {} : { limit }) })).resolves.toEqual({
            status: 'complete',
            accounts,
        });
        expect(owner.listAccounts).toHaveBeenCalledOnce();
    });

    it.each([
        [Object.freeze(['https://elsewhere.test/acme'])],
        [Object.freeze(['https://dev.azure.test/acme?project=secret'])],
        [Object.freeze(['https://dev.azure.test/acme/'])],
        [Object.freeze([] as readonly string[])],
    ])('rejects a listed base the admitted origins do not account for (%s)', async (bases) => {
        const owner = createOwner({
            listAccounts: vi.fn(async () => metadataList({
                accounts: Object.freeze([listedAccount({
                    connectedAccountOrigins: Object.freeze(['https://dev.azure.test']),
                    connectedAccountBases: bases,
                })]),
            })),
        });
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await expect(service.listAccounts({ purpose: scope.purpose })).rejects.toMatchObject({
            code: 'plugin_connected_account_binding_out_of_scope',
        });
    });

    it('materializes one exact listed account without turning it into a selector', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await expect(service.materializeListedAccount({
            purpose: scope.purpose,
            account: { service: scope.serviceRefs[0]!, accountId: 'account-1' },
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://eu.example.test',
                headerNames: ['authorization'],
            },
        })).resolves.toEqual(materialization());

        expect(owner.materializeListedAccount).toHaveBeenCalledWith(expect.objectContaining({
            account: { service: scope.serviceRefs[0]!, accountId: 'account-1' },
            request: expect.objectContaining({ kind: 'httpHeaders' }),
        }));
        expect(owner.materialize).not.toHaveBeenCalled();
        expect(owner.getBinding).not.toHaveBeenCalled();
    });

    it('rejects an exact-listed materialization outside the authorized service scope', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [scope]);

        await expect(service.materializeListedAccount({
            purpose: scope.purpose,
            account: {
                service: { pluginId: 'acme.accounts', localId: 'anthropic' },
                accountId: 'account-2',
            },
            materialization: { kind: 'environment', keys: ['TOKEN'] },
        })).rejects.toMatchObject({
            code: 'plugin_connected_account_binding_out_of_scope',
        });
        expect(owner.materializeListedAccount).not.toHaveBeenCalled();
    });

    it('delegates exact-listed materialization support to the Account adapter', async () => {
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner).bind(seed, [
            { ...scope, materializationKinds: Object.freeze(['environment' as const]) },
        ]);

        await expect(service.materializeListedAccount({
            purpose: scope.purpose,
            account: { service: scope.serviceRefs[0]!, accountId: 'account-1' },
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://eu.example.test',
                headerNames: ['authorization'],
            },
        })).resolves.toEqual(materialization());
    });

    it('registers redaction for an exact-listed materialization result', async () => {
        const registerRawForRedaction = vi.fn();
        const registerExactForRedaction = vi.fn();
        const owner = createOwner();
        const { seed } = createSeed();
        const service = createStablePluginConnectedAccountsHost(owner, {
            registerRawForRedaction,
            registerExactForRedaction,
        }).bind(seed, [scope]);

        await service.materializeListedAccount({
            purpose: scope.purpose,
            account: { service: scope.serviceRefs[0]!, accountId: 'account-1' },
            materialization: {
                kind: 'httpHeaders',
                origin: 'https://eu.example.test',
                headerNames: ['authorization'],
            },
        });

        expect(registerRawForRedaction).toHaveBeenCalledWith(seed, 'Bearer secret');
    });

    it.each(['binding', 'listing'] as const)('finishes an admitted %s metadata read after retirement and refuses its successor', async operation => {
        const invocation = createSeed();
        let entered!: () => void;
        const reading = new Promise<void>(resolve => { entered = resolve; });
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        const unexpected = async (): Promise<never> => { throw new Error('Metadata reads do not select or materialize credentials'); };
        const stored: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [{
            purpose: { consumer: { pluginId: invocation.seed.plugin.id, localId: invocation.seed.contribution.id }, purpose: scope.purpose },
            target: { kind: 'account', account: listedAccount().account },
        }] };
        const owner = createConnectedAccountPurposeBindingOwner({
            // Defer the genuine binding-store boundary, not the purpose owner.
            store: { read: async () => { entered(); await released; return stored; },
                update: unexpected, subscribe: () => ({ dispose() {} }) },
            selectTarget: unexpected,
            resolveTarget: async target => target.kind === 'account'
                ? { displayName: 'Primary account', account: target.account } : null,
            materializeAccount: unexpected,
            projectTargetAccounts: async () => metadataList(),
            assertTargetAccountMaterializable: unexpected,
        });
        const service = createStablePluginConnectedAccountsHost(owner).bind(invocation.seed, [scope]);
        const read = () => operation === 'binding'
            ? service.getBinding(scope.purpose) : service.listAccounts({ purpose: scope.purpose });
        const pending = read();
        try {
            await reading;
            invocation.retire();
            release();
            await expect(pending).resolves.toMatchObject(operation === 'binding'
                ? { account: listedAccount().account } : metadataList());
            await expect(read()).rejects.toMatchObject({ code: 'plugin_final_generation_retired' });
        } finally { release(); await pending.catch(() => undefined); }
    });
});

describe('Coder options with established token material', () => {
    it.each(['ok', 'missing', 'io'] as const)('settles Coder options with %s material through the real owner', async failure => {
        const { PLUGIN } = await import('../../../../../../../packages/plugins/machine-coder/src/manifest');
        const { CODER_CONNECTED_ACCOUNT_RUNTIME: runtime } = await import('../../../../../../../packages/plugins/machine-coder/src/machine/connection');
        const manifest = normalizePluginManifestV2(PLUGIN.manifest);
        const account = { service: { pluginId: manifest.id, localId: 'coder-account' }, accountId: 'selected' };
        const descriptor = manifest.contributes.connectedAccountDescriptors[0]!;
        const scope: PluginConnectedAccountBindingScope = { purpose: 'coder-account', serviceRefs: [account.service], operations: ['select', 'use'], materializationKinds: ['environment'] };
        const original = createSeed();
        const seed = { ...original.seed, plugin: { id: manifest.id, version: manifest.version }, contribution: { id: 'options', qualifiedId: `${manifest.id}/actions/options` } };
        const token = 'synthetic-coder-token';
        const warnings = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        onTestFinished(() => warnings.mockRestore());
        const lease = { ref: account.service, descriptor, runtime, occurrenceId: createPluginRuntimeOccurrenceId(account.service.pluginId),
            sourceCustody: { kind: 'managed' as const, immutableGenerationId: 'provider-artifact', installSource: 'npm' as const }, isCurrent: () => true };
        const invoker = createConnectedAccountHostRuntimeInvoker({
            resolveRuntime: async () => lease, resolvePlugin: () => ({ version: '1.0.0', hostAccessRequests: [] }),
            resolveHostPolicy: () => ({ hostAccess: [], serviceBinding: createPluginInvocationServiceBinding('provider-generation', 'provider') }),
            // The loaded provider invokes no platform service; its configuration and credential readers remain real.
            createServices: () => ({}) as PluginInvocationContext['services'],
            registerRawForRedaction() {},
        });
        const registry = { resolveConnectedAccountRuntime: async () => lease, connectedAccountRuntimeInvoker: invoker };
        const content = (kind: 'credential' | 'configuration', payload: unknown) => sealQualifiedConnectedAccountContentEnvelope({
            kind, accountMode: 'plain', payload, randomBytes: length => new Uint8Array(length),
        });
        const revisions = { authenticationModeId: 'token', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: 'selected-configuration' };
        const credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ...revisions, ref: account,
            content: content('credential', { v: 1, values: { token } }), metadata: { scopes: [] } });
        const configuration = QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({ ...revisions,
            target: { kind: 'account', ref: account }, configurationContent: content('configuration', {
                values: { endpoint: "https://coder.example.test" }, secretRefs: {}, secretValues: {},
            }) });
        const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({
            // Runtime loading and persisted snapshots are the only substituted system boundaries.
            reloadController: { acquireRuntimeRegistry: async () => ({ registry, source: 'active', release: async () => {} }),
                isRuntimeRegistryCurrent: () => true } as unknown as Pick<PluginReloadController, 'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'>,
            credentials: { token: 'home-token', encryption: null }, getAccountEncryptionMode: async () => 'plain',
            readCredential: async () => { if (failure === 'io') throw Object.assign(new TypeError('private-credential-error'), { code: 'EIO' }); return failure === 'missing' ? null : credential; }, readConfiguration: async () => configuration,
            configuration: { read: async () => null, secrets: { admit: async () => {}, has: async () => false, read: async () => null } },
        });
        const fixture = createForegroundPurposeOwnerFixture({ consumer: { pluginId: seed.plugin.id, localId: seed.contribution.id },
            service: account.service, accountId: account.accountId, purpose: scope.purpose,
            materializeAccount: createConnectedAccountPurposeMaterializer(established) });

        const host = createStablePluginConnectedAccountsHost(fixture.owner);
        const handlers = new Map<string, ActionHandler>();
        await PLUGIN.activate({ actions: { register(id: string, handler: ActionHandler) {
            handlers.set(id, handler); return { dispose() {} };
        } }, connectedAccounts: { register() { return { dispose() {} }; } } } as unknown as PluginApi);
        const http = vi.fn(async () => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify([
            { id: 'template', name: 'Development', organization_id: 'org', active_version_id: 'version' },
        ])), finalUrl: 'https://coder.example.test/api/v2/organizations/org/templates' }));
        const context = { signal: seed.signal, invokedAtMs: 1, services: { connectedAccounts: host.bind(seed, [scope]), http: { request: http } } } as unknown as PluginInvocationContext;
        try {
            if (failure !== 'ok') {
                const failureResult = await handlers.get('options')!({ organizationId: 'org' }, context).catch(error => readPluginActionError(error));
                expect(failureResult).toMatchObject({
                    code: 'plugin_action_execution_failed', data: { failureCause: { phase: 'connected_accounts.materialize',
                        errorCode: failure === 'io' ? 'EIO' : 'credential_snapshot_unavailable' } },
                });
                expect(http).not.toHaveBeenCalled();
                const records = warnings.mock.calls.filter(([message]) => message === '[connected-account-materialization-failed]');
                expect(records).toHaveLength(1);
                expect(records[0]?.[1]).toMatchObject({ phase: 'connected_accounts.materialize',
                    errorClass: failure === 'io' ? 'TypeError' : 'Error',
                    errorCode: failure === 'io' ? 'EIO' : 'credential_snapshot_unavailable' });
                expect(JSON.stringify(records)).not.toMatch(/synthetic-coder-token|private-credential-error/);
                return;
            }
            await expect(handlers.get('options')!({ organizationId: 'org' }, context)).resolves.toMatchObject({ dimensions: { image: [{ id: 'template' }] } });
            expect(http).toHaveBeenCalledOnce();
        } finally { host.retire(); }
    });
});
