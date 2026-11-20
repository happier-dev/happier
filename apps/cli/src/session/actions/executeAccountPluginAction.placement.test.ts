import fastify from 'fastify';
import { DATABASE_PLUGIN_ID_V1, DATABASE_STATEMENT_RUN_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolLiteral, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { invokeHostReviewedChildV1, readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { createPluginStateStore } from '@/plugins/store/state.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from './widgetApproval.testkit';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { executeAccountPluginAction } from './executeAccountPluginAction';
import { createDaemonPluginActionExecutor } from './createDaemonPluginActionExecutor';
import { actionSpecToActionDefinitionV1, projectActionDefinitionForExternalDiscovery, readCompleteActionSpecV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { projectActionSpecSchemaSections } from '../../../../../packages/protocol/src/actions/actionSpecSections';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker, createRegistryInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectSessionAccessCapabilitiesV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { manifest as sessionSourceManifest, sourceManifest as sessionProviderManifest } from './accountSessionMachineSource.testkit';
import nacl from 'tweetnacl';
import type { StoredCredentials } from '@/persistence';
import { encodeBase64 } from '@/api/encryption';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { prepareAccountSettingsV2Content } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createRetainedAccountExecutionRuntime } from '@/plugins/runtime/accountExecutionRuntime';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { AutomationDefinitionCreateRequestSchema, AutomationDefinitionDetailSchema } from '@happier-dev/protocol';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { WORKFLOW_TRIGGER_ADD_ACTION_ID } from '@happier-dev/protocol/actions/workflowTriggerActionIds';

it('arms an after-Action trigger for an installed Account Action from the retained CLI executor', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'account-action-trigger-'));
    const app = fastify();
    const accountId = 'account-action-trigger-owner';
    const serverId = 'account-action-trigger-home';
    const serverHttpBaseUrl = 'http://account-action-trigger.test';
    const homeFeatures = registerAccountHomeHttp(app, { accountId, serverId });
    const authored = await registerAuthoredAccountActionRelease(app, accountId, {
        includeBundledPluginIds: [DATABASE_PLUGIN_ID_V1],
    });
    const saved = new Map<string, ReturnType<typeof AutomationDefinitionDetailSchema.parse>>();
    app.get('/v3/automations', async () => ({ automations: [], nextCursor: null }));
    app.post('/v3/automations', async request => {
        const input = AutomationDefinitionCreateRequestSchema.parse(request.body);
        const row = AutomationDefinitionDetailSchema.parse({
            id: input.automationId, name: input.name, description: input.description ?? null, enabled: input.enabled,
            executionRecipe: input.executionRecipe, targetType: null, existingSessionId: null, templateVersion: 1,
            lastRunAt: null, createdAt: 1, updatedAt: 1, workflowDefinitionId: null, scopeSessionId: null,
            assignments: input.assignments?.map(assignment => ({ ...assignment, enabled: assignment.enabled ?? true,
                priority: assignment.priority ?? 0, updatedAt: 1 })) ?? [],
            triggers: input.triggers.map(({ triggerId, trigger }) => {
                if (trigger.kind !== 'action' || !('triggerDefinitionEnvelope' in trigger)) throw new Error('Expected a sealed Action trigger');
                return { ...trigger, id: triggerId, revision: 0, createdAt: 1, updatedAt: 1,
                    reachesOthers: false, triggerDefinitionEnvelope: JSON.stringify(trigger.triggerDefinitionEnvelope) };
            }),
        });
        saved.set(row.id, row);
        return row;
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
    try {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const executor = createCliActionExecutor({ token, credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
            happyHomeDir, sessionId: 'cli-global', mode: 'plain', ctx: null, serverId, serverHttpBaseUrl,
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated',
                features: { ...homeFeatures, features: { ...homeFeatures.features, automations: { enabled: true }, workflows: { enabled: true } } } }),
        });
        const machineId = 'workflow-machine';
        const accountAction = (localId: string) => formatQualifiedPluginActionId({ pluginId: authored.pluginId, localId });
        const arm = (actionId: string, subject?: unknown) => executor.execute(WORKFLOW_TRIGGER_ADD_ACTION_ID, {
            project: { machineId, directory: '/workspace' },
            target: { kind: 'inline', definition: { version: 1, blocks: [
                { kind: 'action', id: 'read-policy', actionId: 'actions.policy.get', input: { profiles: { kind: 'literal', value: true } } },
            ] } },
            trigger: { kind: 'action', enabled: true, phase: 'after',
                actionIds: [actionId], ...(subject === undefined ? {} : { subject }) },
        }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
            externalActionTarget: { kind: 'machine', machineId },
            presentUserConfirmation: { actionId: WORKFLOW_TRIGGER_ADD_ACTION_ID } });
        expect(await arm(accountAction('echo'))).toMatchObject({ ok: true, result: { set: { triggers: [
            { kind: 'action', phase: 'after', actionIds: [formatQualifiedPluginActionId({ pluginId: authored.pluginId, localId: 'echo' })] },
        ] } } });
        expect(await arm(accountAction('unknown'))).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        authored.setEnabled(false);
        expect(await arm(accountAction('echo'))).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        const subject = { kind: 'database', serverId, target: { kind: 'managed_deployment',
            environmentId: 'env', targetLinkId: 'db-link', databaseName: 'neondb' } };
        expect(await arm(DATABASE_STATEMENT_RUN_ACTION_ID_V1, subject)).toMatchObject({
            ok: true, result: { set: { triggers: [{ kind: 'action', phase: 'after',
                actionIds: [DATABASE_STATEMENT_RUN_ACTION_ID_V1], subject }] } },
        });
        expect(saved.size).toBe(2);
    } finally {
        restore();
        await app.close();
        resetActiveAccountSettingsSnapshotForTests();
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

it.each(['plain', 'e2ee'] as const)('routes declared and host-attached Session sources to their own Machine (%s)', async encryptionMode => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'account-session-source-'));
    const app = fastify();
    const accountId = 'session-source-owner';
    const serverHttpBaseUrl = 'http://account-session-source.test';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const accountKeys = encryptionMode === 'e2ee' ? nacl.box.keyPair() : null;
    const credentials: StoredCredentials = { token, encryption: accountKeys ? { type: 'dataKey',
        machineKey: accountKeys.secretKey, publicKey: accountKeys.publicKey } : null, credentialProvenance: 'stored_session' };
    if (encryptionMode === 'plain') registerAccountHomeHttp(app, { accountId, serverId: 'session-source-home' });
    else {
        app.get('/v1/account/encryption', async () => ({ mode: encryptionMode, updatedAt: 1 }));
        app.get('/v1/account/encryption/currentness', async () => ({ mode: encryptionMode, version: 1,
            signingKeyFingerprint: 'fixture-signing', contentKeyFingerprint: 'fixture-content', updatedAt: 1 }));
        app.get('/v1/account/profile', async () => ({ id: accountId }));
        app.get('/v2/account/settings', async () => ({ content: prepareAccountSettingsV2Content({ credentials, raw: {},
            envelopeKind: 'encrypted', randomBytes: nacl.randomBytes }), version: 1 }));
    }
    const authored = await registerAuthoredAccountActionRelease(app, accountId, { encryptionMode, primary: {
        manifest: sessionSourceManifest, projectRoot: resolve(import.meta.dirname, '../../..'),
        entryPath: resolve(import.meta.dirname, 'accountSessionMachineSource.testkit.ts'),
    } });
    const sessionId = 'selected-session';
    const sessionKey = nacl.randomBytes(32);
    const metadata = accountKeys ? encryptSessionPayload({ ctx: { encryptionKey: sessionKey, encryptionVariant: 'dataKey' },
        payload: { machineId: 'session-machine' } }) : JSON.stringify({ machineId: 'session-machine' });
    const metadataWithoutMachine = accountKeys ? encryptSessionPayload({ ctx: { encryptionKey: sessionKey, encryptionVariant: 'dataKey' },
        payload: {} }) : '{}';
    let sessionHasMachine = true;
    const dataEncryptionKey = accountKeys ? encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionKey,
        recipientPublicKey: accountKeys.publicKey, randomBytes: nacl.randomBytes })) : null;
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: { id: sessionId, seq: 1, createdAt: 1, updatedAt: 1,
        active: false, activeAt: 1, encryptionMode, metadata: sessionHasMachine ? metadata : metadataWithoutMachine, metadataVersion: 1,
        dataEncryptionKey, agentState: null, agentStateVersion: 0, responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    } }));
    const machines: string[] = [];
    const targetManifest = ingestPluginManifestV2(sessionSourceManifest);
    const providerManifest = ingestPluginManifestV2(sessionProviderManifest);
    if (!targetManifest.ok || !providerManifest.ok) throw new Error('Invalid Session source fixture manifest');
    let expectedMachineId = 'session-machine';
    // Only Machine RPC and Home HTTP are replaced; the authored Account runtime
    // and Session transport/encryption/Machine identity owners remain real.
    const transport = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
        machines.push(request.machineId);
        expect(request.machineId).toBe(expectedMachineId);
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) return {
            status: 'sourceDeclarations', pluginId: authored.pluginId, sourceDeclarations: [{
                manifest: { id: authored.pluginId, contributes: { actions: targetManifest.manifest.contributes.actions,
                    pluginContributionPoints: targetManifest.manifest.contributes.pluginContributionPoints,
                    targetedPluginContributions: targetManifest.manifest.contributes.targetedPluginContributions, ui: { renderers: [] } } },
                occurrenceId: 'source-current', sourceCustody: { kind: 'development', registeredRootId: 'source-root' },
            }, {
                manifest: { id: sessionProviderManifest.id, contributes: { actions: providerManifest.manifest.contributes.actions,
                    pluginContributionPoints: [], targetedPluginContributions: providerManifest.manifest.contributes.targetedPluginContributions,
                    ui: { renderers: [] } } },
                occurrenceId: 'provider-current', sourceCustody: { kind: 'development', registeredRootId: 'provider-root' },
            }],
        };
        expect(request.method).toBe(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        const providerAction = buildQualifiedPluginContributionKey({ pluginId: sessionProviderManifest.id, localId: 'read' });
        const transported = request.request as Readonly<{ qualifiedActionId: string }>;
        const entryAction = buildQualifiedPluginContributionKey({ pluginId: authored.pluginId, localId: 'read-entry' });
        expect(request.request).toMatchObject({ input: transported.qualifiedActionId === entryAction ? { key: 'issue56' } : { sessionId },
            expectedContributorOccurrenceId: transported.qualifiedActionId === providerAction ? 'provider-current' : 'source-current' });
        return { ok: true, result: { value: `from-${request.machineId}` } };
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
    try {
        await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => authored.publishArtifacts(credentials));
        const executor = createCliActionExecutor({ token, credentials,
            happyHomeDir, sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'session-source-home', serverHttpBaseUrl });
        // Mounted Ask's source input names an entry, while its containing
        // Session is carried in host context rather than an authored operand.
        for (const defaultSessionMachineId of [undefined, 'session-machine']) {
            expect(await executor.execute('action.invoke', { action: { pluginId: authored.pluginId, localId: 'attached-entry' }, input: { key: 'issue56' } },
                { surface: 'cli', defaultSessionId: sessionId, ...(defaultSessionMachineId ? { defaultSessionMachineId } : {}) }))
                .toEqual({ ok: true, result: { value: 'from-session-machine' } });
        }
        expect(await executor.execute('action.invoke', { action: { pluginId: authored.pluginId, localId: 'attached-targeted' }, input: { sessionId } },
            { surface: 'cli', defaultSessionId: sessionId }))
            .toEqual({ ok: true, result: { value: 'from-session-machine' } });
        // An Account source may call another Account Action. Its bound runtime
        // must retain that placement in both modes.
        expect(await executor.execute('action.invoke', { action: { pluginId: authored.pluginId, localId: 'targeted-account' }, input: { sessionId } },
            { surface: 'cli', defaultSessionMachineId: 'session-machine' }))
            .toEqual({ ok: true, result: { value: 'account-source' } });
        for (const defaultSessionMachineId of [undefined, 'ambient-machine']) {
            expect(await executor.execute('action.invoke', { action: { pluginId: authored.pluginId, localId: 'source' }, input: { sessionId } },
                { surface: 'cli', ...(defaultSessionMachineId ? { defaultSessionMachineId } : {}) }))
                .toEqual({ ok: true, result: { value: 'from-session-machine' } });
            expect(await executor.execute('action.invoke', { action: { pluginId: authored.pluginId, localId: 'targeted' }, input: { sessionId } },
                { surface: 'cli', ...(defaultSessionMachineId ? { defaultSessionMachineId } : {}) }))
                .toEqual({ ok: true, result: { value: 'from-session-machine' } });
        }
        expect(machines.length).toBeGreaterThan(0);
        expect(new Set(machines)).toEqual(new Set(['session-machine']));
        const retained = createRetainedAccountExecutionRuntime(() => ({ happyHomeDir,
            accountExecution: { credentials, serverUrl: serverHttpBaseUrl, serverId: 'session-source-home', machineId: 'ambient-machine', isCurrent: () => true } }));
        try {
            const host = { token, credentials, happyHomeDir, sessionId: 'cli-global', mode: 'plain' as const, ctx: null,
                serverId: 'session-source-home', serverHttpBaseUrl };
            const { deps } = createCliActionExecutorHarness(host);
            for (const surface of ['agent', 'mcp'] as const) expect(await executeAccountPluginAction({ host, deps, accountRuntime: retained, actionId: 'action.invoke',
                input: { action: { pluginId: authored.pluginId, localId: 'targeted' }, input: { sessionId } },
                context: { surface, defaultSessionId: sessionId, defaultSessionMachineId: 'ambient-machine',
                    runtimeAccountId: accountId, serverId: 'session-source-home', sessionListAccess: 'current_session' } }))
                .toEqual({ matched: true, result: { ok: true, result: { value: 'from-session-machine' } } });
        } finally { await retained.dispose(); }
        expectedMachineId = 'explicit-machine';
        expect(await executor.execute('action.invoke', { action: { pluginId: authored.pluginId, localId: 'attached-entry' }, input: { key: 'issue56' } },
            { surface: 'cli', defaultSessionId: sessionId, externalActionTarget: { kind: 'machine', machineId: expectedMachineId } }))
            .toEqual({ ok: true, result: { value: 'from-explicit-machine' } });
        for (const localId of ['source', 'targeted']) expect(await executor.execute('action.invoke', { action: { pluginId: authored.pluginId, localId }, input: { sessionId } },
            { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: expectedMachineId } }))
            .toEqual({ ok: true, result: { value: 'from-explicit-machine' } });
        sessionHasMachine = false;
        machines.length = 0;
        expect(await executor.execute('action.invoke', { action: { pluginId: authored.pluginId, localId: 'attached-entry' }, input: { key: 'issue56' } },
            { surface: 'cli', defaultSessionId: sessionId }))
            .toMatchObject({ ok: false, errorCode: 'plugin_action_execution_origin_unavailable' });
        expect(await executor.execute('action.invoke', { action: { pluginId: authored.pluginId, localId: 'account-only' }, input: { sessionId } },
            { surface: 'cli', defaultSessionMachineId: 'ambient-machine' }))
            .toEqual({ ok: true, result: { value: 'account-only' } });
        expect(await executor.execute('action.invoke', { action: { pluginId: authored.pluginId, localId: 'targeted-account' }, input: { sessionId } },
            { surface: 'cli', defaultSessionMachineId: 'ambient-machine' }))
            .toEqual({ ok: true, result: { value: 'account-source' } });
        expect(await executor.execute('action.invoke', { action: { pluginId: authored.pluginId, localId: 'source' }, input: { sessionId } },
            { surface: 'cli', defaultSessionMachineId: 'ambient-machine' }))
            .toMatchObject({ ok: false, errorCode: 'plugin_action_execution_origin_unavailable' });
        expect(machines).toEqual([]);
    } finally {
        transport.mockRestore(); restore(); await app.close(); resetActiveAccountSettingsSnapshotForTests();
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

it('carries an explicit Machine target into an Account Action’s nested Machine source', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'account-machine-source-'));
    const app = fastify();
    const accountId = 'machine-source-owner';
    const serverHttpBaseUrl = 'http://account-machine-source.test';
    registerAccountHomeHttp(app, { accountId, serverId: 'machine-source-home' });
    const authored = await registerAuthoredAccountActionRelease(app, accountId);
    const source = createPluginManifestV2Fixture({ id: 'acme.account-source-provider', contributes: {
        actions: [{ id: 'read', title: 'Read Machine source', scopes: ['global'], surfaces: ['plugin', 'cli'],
            dangerLevel: 'safe', execution: { target: 'daemon' } }],
        targetedPluginContributions: [{ id: 'source', target: { pluginId: authored.pluginId, pointId: 'sources' },
            protocol: { id: 'source', version: 1 }, descriptor: {}, operations: { read: 'read' } }],
    } });
    const machines: string[] = [];
    // Machine RPC is the external boundary; Account activation, nested Action
    // admission and source-declaration parsing all use the production owners.
    const transport = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
        machines.push(request.machineId);
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
            return { status: 'sourceDeclarations', pluginId: authored.pluginId, sourceDeclarations: [{
                manifest: { id: source.id, contributes: { actions: source.contributes.actions,
                    pluginContributionPoints: [], targetedPluginContributions: source.contributes.targetedPluginContributions,
                    ui: { renderers: [] } } },
                occurrenceId: 'source-current', sourceCustody: { kind: 'development', registeredRootId: 'source-root' },
            }] };
        }
        expect(request.method).toBe(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        expect(request.request).toMatchObject({ machineId: 'selected-machine',
            qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: source.id, localId: 'read' }),
            input: { key: 'selected-source' } });
        return { ok: true, result: { value: 'from-selected-machine' } };
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
    try {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const executor = createCliActionExecutor({ token, credentials: { token, encryption: null,
            credentialProvenance: 'stored_session' }, happyHomeDir, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId: 'machine-source-home', serverHttpBaseUrl });
        const input = { action: { pluginId: authored.pluginId, localId: 'source' }, input: { key: 'selected-source' } };
        expect(await executor.execute('action.invoke', input, { surface: 'cli' }))
            .toMatchObject({ ok: false, errorCode: 'plugin_action_machine_required' });
        expect(machines).toEqual([]);
        expect(await executor.execute('action.invoke', input, { surface: 'cli',
            externalActionTarget: { kind: 'machine', machineId: 'selected-machine' } }))
            .toEqual({ ok: true, result: { value: 'from-selected-machine' } });
        expect(machines.length).toBeGreaterThan(0);
        expect(new Set(machines)).toEqual(new Set(['selected-machine']));
    } finally {
        transport.mockRestore();
        restore();
        await app.close();
        resetActiveAccountSettingsSnapshotForTests();
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

it.each(['host', 'context', 'retained'] as const)('publishes canonical Home identity in Account plugin scope (%s)', async source => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'account-home-scope-'));
    const app = fastify();
    const accountId = 'account-home-scope-owner';
    const serverId = 'local-home-profile';
    const serverIdentityId = 'srv_canonical_account_home';
    const serverHttpBaseUrl = 'http://account-home-scope.test';
    registerAccountHomeHttp(app, { accountId, serverId: serverIdentityId });
    const authored = await registerAuthoredAccountActionRelease(app, accountId, { primary: {
        manifest: sessionSourceManifest, projectRoot: resolve(import.meta.dirname, '../../..'),
        entryPath: resolve(import.meta.dirname, 'accountSessionMachineSource.testkit.ts'),
    } });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials: StoredCredentials = { token, encryption: null, credentialProvenance: 'stored_session' };
    const retained = source === 'retained' ? createRetainedAccountExecutionRuntime(() => ({ happyHomeDir,
        accountExecution: { credentials, serverUrl: serverHttpBaseUrl, serverId, serverIdentityId, isCurrent: () => true } })) : undefined;
    try {
        await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => authored.publishArtifacts(credentials));
        const host = { token, credentials, happyHomeDir, sessionId: 'cli-global', mode: 'plain' as const, ctx: null,
            serverId, serverHttpBaseUrl, ...(source === 'host' ? { serverIdentityId } : {}) };
        const input = { action: { pluginId: authored.pluginId, localId: 'account-scope' }, input: {} };
        const context = { surface: 'cli' as const, ...(source === 'context' ? { serverIdentityId } : {}) };
        const expected = { ok: true, result: { scope: { serverId: serverIdentityId, accountId } } };
        if (retained) {
            const { deps } = createCliActionExecutorHarness(host);
            expect(await executeAccountPluginAction({ host, deps, accountRuntime: retained,
                actionId: 'action.invoke', input, context })).toEqual({ matched: true, result: expected });
        } else {
            expect(await createCliActionExecutor(host).execute('action.invoke', input, context)).toEqual(expected);
        }
    } finally {
        await retained?.dispose();
        restore();
        await app.close();
        resetActiveAccountSettingsSnapshotForTests();
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

it('executes a qualified Account Action through the same owner as action.invoke without a Machine', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'account-qualified-action-'));
    const app = fastify();
    const accountId = 'qualified-account-owner';
    const serverHttpBaseUrl = 'http://qualified-account-action.test';
    registerAccountHomeHttp(app, { accountId, serverId: 'qualified-account-home' });
    const authored = await registerAuthoredAccountActionRelease(app, accountId);
    let intentReads = 0;
    app.addHook('onRequest', async (request) => {
        if (request.url === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) intentReads += 1;
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
    try {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const executor = createCliActionExecutor({ token, credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
            happyHomeDir, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId: 'qualified-account-home', serverHttpBaseUrl });
        const action = { pluginId: authored.pluginId, localId: 'echo' };
        const input = { key: 'search-triage' };
        const expected = { ok: true, result: { key: input.key, surface: 'cli' } };
        expect(await executor.execute('action.invoke', { action, input }, { surface: 'cli' })).toEqual(expected);
        expect(intentReads).toBe(2);
        const bridge = createActionToolExecutorBridge({ executor, surface: 'cli' });
        expect(await bridge.executeActionByToolName('action_execute', {
            actionId: `${action.pluginId}/actions/${action.localId}`, input,
        }, 'cli-global')).toEqual(expected);
        authored.setEnabled(false);
        expect(await executor.execute('action.invoke', { action, input }, { surface: 'cli' }))
            .toMatchObject({ ok: false, errorCode: 'plugin_disabled' });
    } finally {
        restore();
        await app.close();
        resetActiveAccountSettingsSnapshotForTests();
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

it('accepts the Account selection custody occurrence for a retained Account Action', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'account-custody-occurrence-'));
    const app = fastify();
    const accountId = 'account-custody-occurrence-owner';
    const serverId = 'account-custody-occurrence-home';
    const serverHttpBaseUrl = 'http://account-custody-occurrence.test';
    registerAccountHomeHttp(app, { accountId, serverId });
    const authored = await registerAuthoredAccountActionRelease(app, accountId);
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials: StoredCredentials = { token, encryption: null, credentialProvenance: 'stored_session' };
    const retained = createRetainedAccountExecutionRuntime(() => ({ happyHomeDir,
        accountExecution: { credentials, serverUrl: serverHttpBaseUrl, serverId, isCurrent: () => true } }));
    try {
        const runtime = await retained.read();
        const selection = runtime.registry.readAccountExecutionSelection?.(authored.pluginId);
        if (!selection || selection.kind !== 'available') throw new Error('Account fixture selection unavailable');
        const host = { token, credentials, happyHomeDir, sessionId: 'cli-global', mode: 'plain' as const,
            ctx: null, serverId, serverHttpBaseUrl };
        const { deps } = createCliActionExecutorHarness(host);
        const attempt = await executeAccountPluginAction({ host, deps, accountRuntime: retained,
            actionId: 'action.invoke',
            input: { action: { pluginId: authored.pluginId, localId: 'echo' }, input: { key: 'custody' } },
            context: { surface: 'ui', expectedContributedActionOccurrenceId: selection.custodyId } });
        expect(attempt).toEqual({ matched: true, result: { ok: true, result: { key: 'custody', surface: 'ui' } } });
        const stale = await executeAccountPluginAction({ host, deps, accountRuntime: retained,
            actionId: 'action.invoke',
            input: { action: { pluginId: authored.pluginId, localId: 'echo' }, input: { key: 'stale' } },
            context: { surface: 'ui', expectedContributedActionOccurrenceId: `${selection.custodyId}-stale` } });
        expect(stale).toMatchObject({ matched: true, result: { ok: false, errorCode: 'plugin_action_generation_retired' } });
    } finally {
        await retained.dispose();
        restore();
        await app.close();
        resetActiveAccountSettingsSnapshotForTests();
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

it('resolves installed Machine author placement for an active reviewed child', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-action-placement-'));
    const pluginRoot = join(happyHomeDir, 'author');
    const plugin = definePlugin({ id: 'example.installed-machine', version: '1.0.0', actions: {
        read: { title: 'Read Machine', surfaces: ['cli'], dangerLevel: 'safe',
            inputSchema: defineProtocolObject({}, { policy: 'closed' }),
            resultSchema: defineProtocolObject({ machine: defineProtocolLiteral(true) }, { policy: 'closed' }),
            run: async () => ({ machine: true as const }) },
    } });
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
    await writeFile(manifestPath, JSON.stringify({ ...plugin.manifest, entrypoints: { daemon: './daemon.mjs' } }));
    await writeFile(join(pluginRoot, 'daemon.mjs'), 'export async function activate() {}\n');
    await createPluginStateStore({ happyHomeDir }).write({ t: 'happier_plugin_state_v1', schemaVersion: 1,
        plugins: { [plugin.manifest.id]: {
            source: { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
                resolvedPath: pluginRoot, manifestPath },
            compatibility: { status: 'unknown', diagnostics: [] },
            install: { mode: 'link', manifestVersion: plugin.manifest.version, installedPath: null },
            state: { enabled: true },
        } } });
    const app = fastify();
    const endpoint = 'http://installed-machine-placement.test';
    registerAccountHomeHttp(app, { accountId: 'owner', serverId: 'placement-home' });
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () =>
        PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: true, maxArtifactBytes: 16 * 1024 * 1024, maxAccountBytes: 256 * 1024 * 1024 },
            intent: null, release: null, uiArtifacts: [], packageAssets: [] }));
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    try {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const action = { pluginId: plugin.manifest.id, localId: 'read' };
        const host = { token, credentials: { token, encryption: null,
            credentialProvenance: 'stored_session' }, sessionId: 'bound-session', mode: 'plain', ctx: null,
            serverId: 'placement-home', serverIdentityId: 'placement-home', serverHttpBaseUrl: endpoint, happyHomeDir,
        } satisfies Parameters<typeof createCliActionExecutorHarness>[0];
        const harness = createCliActionExecutorHarness(host);
        const result = await invokeHostReviewedChildV1({ parent: { actionId: 'machines.reachability.configure', input: {} },
            context: { surface: 'cli', authority: 'account_automation', runtimeAccountId: 'owner',
                serverId: 'placement-home', serverIdentityId: 'placement-home' },
            child: { action, role: 'inspect', input: {} },
            admittedReview: { action, role: 'inspect', surface: 'cli' },
            execute: async (input, context, actionId) => {
                expect(readHostReviewedChildOperationV1(context, actionId, input)).not.toBeNull();
                return await executeAccountPluginAction({ host, deps: harness.deps, actionId, input, context });
            },
        });
        expect(result).toEqual({ matched: false, accountSelectionUnavailable: true, executionPlacement: 'machine' });

        // Use the declaration from the failing LIVE53 binding read, then prove
        // the same transport works for an installed external author's Action.
        const manifest = ingestPluginManifestV2(await readFile(new URL('../../../assets/bundled-plugin-manifests/channels.json', import.meta.url), 'utf8'));
        if (!manifest.ok) throw new Error('Invalid generated Channels manifest');
        const binding = manifest.manifest.contributes.actions.find(candidate => candidate.id === 'session-pull-request-binding-v1');
        if (!binding?.inputSchema || !binding.resultSchema) throw new Error('Missing binding declaration');
        const base = actionSpecToActionDefinitionV1(getActionSpec('action.spec.get'), { includeOutputSchema: false });
        for (const id of ['happier.channels/actions/session-pull-request-binding-v1', `${plugin.manifest.id}/actions/read`]) {
            const definition = projectActionDefinitionForExternalDiscovery({ ...base, id, executionPlacement: 'machine',
                inputSchema: binding.inputSchema, outputSchema: binding.resultSchema });
            const executor = createDaemonPluginActionExecutor({ base: harness.executor,
                executeInCurrentProcess: async (actionId, input, context) =>
                    executeAccountPluginAction({ host, deps: harness.deps, actionId, input, context }),
                // Daemon IPC is the system boundary; keep the real schema
                // projection and restoration on either side of that boundary.
                requestPluginActionExecution: async request => {
                    const input = getActionSpec('action.spec.get').inputSchema.parse(request.input);
                    const schemaPath = input && typeof input === 'object' && 'schemaPath' in input
                        && typeof input.schemaPath === 'string' ? input.schemaPath : undefined;
                    return { matched: true, result: { ok: true,
                        result: StrictJsonValueSchema.parse(projectActionSpecSchemaSections(definition, schemaPath)) } };
                },
            });
            const discovered = await readCompleteActionSpecV1({ actionId: id, read: async input => {
                const result = await executor.execute('action.spec.get', input, { surface: 'cli' });
                if (!result.ok) throw new Error(result.errorCode);
                return result.result;
            } });
            expect(discovered).toEqual(definition);
        }
    } finally {
        restore();
        await app.close();
    }
});

it.each(['typed failure', 'malformed descriptor', 'mismatched Action', 'Account placement', 'no admitted runtime'] as const)(
    'distinguishes descriptor read failures from placement refusals through Account-selection fallback (%s)', async failureKind => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'descriptor-read-failure-'));
    const app = fastify();
    const endpoint = 'http://descriptor-read-failure.test';
    registerAccountHomeHttp(app, { accountId: 'owner', serverId: 'descriptor-home' });
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () =>
        PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: true, maxArtifactBytes: 16 * 1024 * 1024, maxAccountBytes: 256 * 1024 * 1024 },
            intent: null, release: null, uiArtifacts: [], packageAssets: [] }));
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    try {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const action = { pluginId: 'example.descriptor-failure', localId: 'read' };
        const id = `${action.pluginId}/actions/${action.localId}`;
        const failure = { ok: false as const, errorCode: 'database_unavailable', error: 'Transaction acquisition failed',
            details: { cause: 'P2028' } };
        const expected = failureKind === 'typed failure' ? failure : {
            ok: false, errorCode: failureKind === 'Account placement' || failureKind === 'no admitted runtime'
                ? 'plugin_action_execution_placement_unavailable' : 'invalid_action_transport_output',
        };
        let descriptorRequests = 0;
        const executor = createCliActionExecutor({ token, credentials: { token, encryption: null,
            credentialProvenance: 'stored_session' }, sessionId: 'session', mode: 'plain', ctx: null,
            serverId: 'descriptor-home', serverIdentityId: 'descriptor-home', serverHttpBaseUrl: endpoint, happyHomeDir,
            // Home HTTP and daemon IPC are the only replaced system boundaries.
            // Keep Account selection, descriptor dispatch and Action admission real.
            requestPluginActionExecution: async request => {
                expect(request.actionId).toBe('action.spec.get');
                expect(request.input).toMatchObject({ id });
                descriptorRequests++;
                if (failureKind === 'typed failure') return { matched: true, result: failure };
                if (failureKind === 'no admitted runtime') return { matched: false };
                return { matched: true, result: { ok: true, result: failureKind === 'malformed descriptor' ? {}
                    : StrictJsonValueSchema.parse(projectActionSpecSchemaSections(projectActionDefinitionForExternalDiscovery({
                        ...actionSpecToActionDefinitionV1(getActionSpec('action.spec.get'), { includeOutputSchema: false }),
                        id: failureKind === 'mismatched Action' ? 'example.other/actions/read' : id,
                        executionPlacement: failureKind === 'Account placement' ? 'account' : 'machine',
                    }))) } };
            },
        });
        const context = { surface: 'cli' as const };
        expect(await executor.execute('action.spec.get', { id }, context)).toMatchObject(expected);
        expect(await executor.execute('action.invoke', { action, input: {} }, context)).toMatchObject(expected);
        expect(await executor.execute('action.options.resolve', { actionId: id, fieldPath: 'choice', draftInput: {} }, context))
            .toMatchObject(expected);
        // One failed descriptor read per requested operation; no execution or retry.
        expect(descriptorRequests).toBe(3);
    } finally {
        restore();
        await app.close();
        resetActiveAccountSettingsSnapshotForTests();
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

it('preserves Machine placement when the Account selection read is unavailable', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'account-placement-unavailable-'));
    const app = fastify();
    const endpoint = 'http://account-placement-unavailable.test';
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'placement-owner' })).toString('base64url')}.signature`;
    const host = { token, credentials: { token, encryption: null, credentialProvenance: 'stored_session' as const },
        happyHomeDir, sessionId: 'cli-global', mode: 'plain' as const, ctx: null,
        serverId: 'placement-home', serverHttpBaseUrl: endpoint };
    try {
        const { deps } = createCliActionExecutorHarness(host);
        const result = await executeAccountPluginAction({ host, deps, actionId: 'action.invoke',
            input: { action: { pluginId: 'happier.triage', localId: 'sessions/start-entry-v1' }, input: {} },
            context: { surface: 'cli' } });
        expect(result).toEqual({ matched: false, accountSelectionUnavailable: true, executionPlacement: 'machine' });
    } finally {
        restore();
        await app.close();
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});

it('places the reload-18 flower options request on the same admitted Machine runtime as invocation', async () => {
    const pluginId = 'qa.qar90s-r8';
    const machineId = 'ffd72b3e-40ca-4644-9bd2-46753a01d8cb';
    const serverId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const accountId = '5e3a0581-6f3d-4e73-bf40-383db0be6c3e';
    const flowerValueSchema = defineProtocolUnion([defineProtocolLiteral('marigold'), defineProtocolLiteral('rose')]);
    const flowerSchema = defineProtocolObject({ flower: flowerValueSchema }, { policy: 'closed' });
    const plugin = definePlugin({ id: pluginId, version: '0.1.2', entrypoints: { daemon: './daemon.mjs' },
        actions: { change: { title: 'QAR90S change flower', scopes: ['global', 'machine'], surfaces: ['ui', 'agent', 'cli'],
            execution: { target: 'daemon' }, dangerLevel: 'safe',
            inputSchema: flowerSchema,
            inputHints: { fields: [{ path: 'flower', title: 'Flower', widget: 'select', required: true,
                inputType: { pluginId, localId: 'flower' } }] },
            resultSchema: flowerSchema,
            async run(input) { return { flower: input.flower }; },
        } },
        inputTypes: { flower: { title: 'Flower', semantic: 'qa-qar90s-flower', valueSchema: flowerValueSchema.jsonSchema, picker: 'flower-picker-renderer' } },
        ui: { surfaces: [{ id: 'flower-picker', placement: 'rendererOnly', renderer: { kind: 'reactNative' } }] },
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ manifest: plugin.manifest,
        files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: plugin.activate }) }] });
    const app = fastify();
    const endpoint = 'http://reload-18-machine-options.test';
    registerAccountHomeHttp(app, { accountId, serverId });
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () =>
        PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: true, maxArtifactBytes: 16 * 1024 * 1024, maxAccountBytes: 256 * 1024 * 1024 },
            intent: null, release: null, uiArtifacts: [], packageAssets: [] }));
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    try {
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const executor = createCliActionExecutor({ token, credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
            sessionId: 'session', mode: 'plain', ctx: null, serverId, serverIdentityId: serverId, serverHttpBaseUrl: endpoint,
            // Like the daemon external-Action receiver, consume its admitted
            // runtime rather than constructing another registry from a home path.
            pluginActionExecutionOwner: 'current_process',
            listContributedActionDefinitions: createCommittedContributedActionDefinitionLister({
                tryAcquireRuntimeRegistryLease: () => tryAcquireAuthoritativePluginRuntimeRegistryLease({ controller: fixture.controller }) }),
            inputTypeDeps: createRegistryInputTypeDeps(fixture.registry),
            invokeContributedAction: createCommittedContributedActionInvoker({
                acquireRuntimeRegistryLease: async () => {
                    const lease = fixture.controller.tryAcquireRuntimeRegistry();
                    if (!lease) throw new Error('Fixture runtime retired');
                    return lease;
                } }),
        });
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, serverIdentityId: serverId,
            runtimeAccountId: accountId, externalActionTarget: { kind: 'machine' as const, machineId } };
        expect(await executor.execute('action.invoke', { action: { pluginId, localId: 'change' }, input: { flower: 'marigold' } }, context))
            .toMatchObject({ ok: true, result: { flower: 'marigold' } });
        const options = await executor.execute('action.options.resolve', {
            actionId: 'qa.qar90s-r8/actions/change', fieldPath: 'flower', draftInput: { machineId },
        }, context);
        expect(options, options.ok ? undefined : options.errorCode).toMatchObject({ ok: true, result: { actionId: 'qa.qar90s-r8/actions/change', fieldPath: 'flower',
            optionsSourceId: null, options: [] } });
    } finally {
        restore();
        await app.close();
        await fixture.dispose();
    }
});

it('keeps current-process Machine options on their admitted owner while refusing unknown placement', async () => {
    const pluginId = 'example.machine-options';
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{
        manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { actions: [{
            id: 'read', title: 'Read', scopes: ['global'], surfaces: ['cli'], dangerLevel: 'safe', execution: { target: 'daemon' },
            inputSchema: { type: 'object', properties: { choice: { type: 'string' } }, additionalProperties: false },
            inputHints: { fields: [{ path: 'choice', title: 'Choice', widget: 'select', options: [{ value: 'ready', label: 'Ready' }] }] },
            resultSchema: { type: 'object', properties: {}, additionalProperties: false },
        }] } }),
        files: { 'daemon.mjs': "export function activate(api) { api.actions.register('read', async () => ({})); }" },
    }] });
    const app = fastify();
    const endpoint = 'http://current-machine-options.test';
    registerAccountHomeHttp(app, { accountId: 'owner', serverId: 'machine-options-home' });
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () =>
        PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: true, maxArtifactBytes: 16 * 1024 * 1024, maxAccountBytes: 256 * 1024 * 1024 },
            intent: null, release: null, uiArtifacts: [], packageAssets: [] }));
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    try {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const list = createCommittedContributedActionDefinitionLister({
            tryAcquireRuntimeRegistryLease: () => tryAcquireAuthoritativePluginRuntimeRegistryLease({ controller: fixture.controller }),
        });
        const executor = createCliActionExecutor({ token, credentials: { token, encryption: null,
            credentialProvenance: 'stored_session' }, sessionId: 'session', mode: 'plain', ctx: null,
            serverId: 'machine-options-home', serverIdentityId: 'machine-options-home', serverHttpBaseUrl: endpoint,
            happyHomeDir: fixture.happyHomeDir, pluginActionExecutionOwner: 'current_process',
            listContributedActionDefinitions: list,
        });
        const context = { surface: 'cli' as const };
        const options = await executor.execute('action.options.resolve', {
            actionId: `${pluginId}/actions/read`, fieldPath: 'choice', draftInput: {},
        }, context);
        expect(options, options.ok ? undefined : options.errorCode).toMatchObject({ ok: true,
            result: { options: [{ value: 'ready', label: 'Ready' }] } });
        expect(await executor.execute('action.options.resolve', {
            actionId: 'example.unknown-placement/actions/read', fieldPath: 'choice', draftInput: {},
        }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters',
            details: { issues: [{ code: 'unknown_action', path: ['id'] }] } });
    } finally {
        restore();
        await app.close();
        await fixture.dispose();
    }
});

it('keeps a plugin caller’s requested schema section through its bound Machine owner', async () => {
    const pluginId = 'example.section-read';
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{
        manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { actions: [{
            id: 'read', title: 'Read', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
            inputSchema: { type: 'object', additionalProperties: false },
            resultSchema: { type: 'object', properties: { value: { $ref: '#/definitions/value' } },
                definitions: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
        }] } }),
        files: { 'daemon.mjs': "export function activate(api) { api.actions.register('read', async () => ({ value: 'ready' })); }" },
    }] });
    try {
        const list = createCommittedContributedActionDefinitionLister({
            tryAcquireRuntimeRegistryLease: () => tryAcquireAuthoritativePluginRuntimeRegistryLease({ controller: fixture.controller }),
        });
        const executor = createCliActionExecutor({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null,
            listContributedActionDefinitions: list,
            invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry() }),
        });
        const id = `${pluginId}/actions/read`;
        const context = { surface: 'plugin' as const, actionCaller: { kind: 'plugin' as const, pluginId } };
        const result = await executor.execute('action.spec.get', { id, includeOutputSchema: true, schemaPath: '/outputSchema/definitions/value' }, context);
        expect(result).toMatchObject({ ok: true, result: { actionSpec: { id },
            schemaSection: { path: '/outputSchema/definitions/value', schema: { type: 'string' } } } });
    } finally { await fixture.dispose(); }
});
