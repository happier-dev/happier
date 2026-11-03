import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { PluginSettingsContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/settings';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { projectAccountDeclaredPluginSettingsGroups } from '@/sync/domains/plugins/settings/accountDeclaredPluginSettings';
import { createAccountScopedPluginSettingsTransport, createScopedPluginSettingsAdapter } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import { executeScopedPluginSettingsAdministrationAction } from './pluginSettingsAdministrationAction';
import { createScopedPluginSettingsActionAdapter } from '@/sync/domains/plugins/settings/scopedPluginSettingsActionAdapter';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { applyAccountSettingsSavedSecretMutation, resolveAccountSettingsPluginSecretBinding } from '@happier-dev/protocol';
import { createAccountPluginSecretSettingsAdapter } from '@/sync/domains/plugins/settings/scopedPluginAccountSecretSettingsAdapter';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { useScopedPluginSettingsProjection } from '@/sync/domains/plugins/settings/scopedPluginSettingsProjection';

type SettingsActionRequest = Parameters<NonNullable<ActionExecutorDeps['pluginSettingsAdministrationAction']>>[0];
function settingsStoragePort(scope: Omit<Parameters<typeof executeScopedPluginSettingsAdministrationAction>[0], keyof SettingsActionRequest>) {
    return Object.assign((request: SettingsActionRequest) => executeScopedPluginSettingsAdministrationAction({ ...request, ...scope }), {
        admitInput: (request: SettingsActionRequest) => executeScopedPluginSettingsAdministrationAction.admitInput({ ...request, ...scope }),
    });
}

describe('UI plugin Settings Action owner', () => {
    it('cancels the daemon read preceding a Settings write when its request retires', async () => {
        const { projectPluginSettingsContributionV2 } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { mapV2EditableSettingsGroup } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
        const definition = PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'daemon',
            target: { kind: 'plugin' }, fields: [{ id: 'endpoint', title: 'Endpoint', schema: { type: 'string' } }] });
        const groups = [mapV2EditableSettingsGroup(projectPluginSettingsContributionV2({ pluginId: 'acme.settings', definition }))];
        const controller = new AbortController();
        const started = createDeferred<void>();
        let cancelled = false;
        const unexpected = async (): Promise<never> => { throw new Error('Unexpected Settings write'); };
        const adapter = createScopedPluginSettingsAdapter({ accountRead: unexpected, accountWrite: unexpected, daemonSet: unexpected,
            daemonGet: async (_machineId, options) => {
                started.resolve();
                return new Promise<never>((_resolve, reject) => {
                    options.signal?.addEventListener('abort', () => { cancelled = true; reject(new Error('aborted')); }, { once: true });
                });
            },
        });
        const pending = executeScopedPluginSettingsAdministrationAction({ actionId: 'plugins.settings.set',
            input: { pluginId: 'acme.settings', scope: { kind: 'daemon' },
                target: { kind: 'daemon', serverIdentityId: 'srv_a', machineId: 'machine-a' },
                localId: 'endpoint', value: 'next', expectedRevision: '1' },
            context: { surface: 'ui', signal: controller.signal },
            target: { kind: 'daemon', serverIdentityId: 'srv_a', serverId: 'home-a', machineId: 'machine-a' },
            groups, adapter, secretAdapter: adapter, assertCurrent: () => controller.signal.throwIfAborted(),
        });
        await started.promise;
        controller.abort();
        expect(cancelled).toBe(true);
        expect(await pending).toMatchObject({ ok: false });
    });

    it.each(['account', 'daemon'] as const)('preserves quiet secret declines and sole executor confirmation for %s custody', async custody => {
        const { projectPluginSettingsContributionV2 } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { mapV2EditableSettingsGroup } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
        for (const scenario of ['reject', 'canceled', 'default', 'waived'] as const) {
            let accountSnapshot = { revision: 5, settings: {} };
            let daemonState: 'configured' | 'missing' = 'configured';
            let confirmations = 0;
            let approvalRequests = 0;
            const accountTarget = { kind: 'account' as const, serverIdentityId: 'srv_a' };
            const daemonTarget = { kind: 'daemon' as const, serverIdentityId: 'srv_a', serverId: 'home-a', machineId: 'machine-a' };
            const target = custody === 'account' ? accountTarget : daemonTarget;
            const secretAdapter = createAccountPluginSecretSettingsAdapter({ readSnapshot: () => accountSnapshot,
                // Persistent resources are external to this Action-admission fixture.
                async createResource() { return 'happier:shared-secret:v1:saved-token'; },
                async deleteResource() {},
                async writeOnce(input) {
                    accountSnapshot = { revision: accountSnapshot.revision + 1, settings: input.mutate(accountSnapshot.settings) };
                    return { status: 'applied', revision: accountSnapshot.revision, snapshot: accountSnapshot };
                } });
            const secretInput = { pluginId: 'acme.settings', scope: { kind: 'account' as const }, target: accountTarget,
                fields: [{ key: 'token', redacted: true }], fieldId: 'token', expectedRevision: { kind: 'account-secret' as const, value: 5 } };
            expect(await secretAdapter.write({ ...secretInput, mutation: { kind: 'set', value: 'synthetic-private-token' } })).toMatchObject({ status: 'ready' });
            const unexpected = async (): Promise<never> => { throw new Error('Wrong secret custody'); };
            const daemonAdapter = createScopedPluginSettingsAdapter({ accountRead: unexpected, accountWrite: unexpected,
                daemonGet: unexpected, daemonSet: unexpected,
                daemonSecretStatus: async (_machineId, input) => ({ supported: true, result: { protocolVersion: 1, pluginId: input.pluginId,
                    secretId: input.secretId, state: daemonState, revision: 'secret-r1' } }),
                daemonSecretSet: unexpected,
                daemonSecretDelete: async (_machineId, input) => { daemonState = 'missing'; return { supported: true,
                    result: { protocolVersion: 1, pluginId: input.pluginId, secretId: input.secretId, state: daemonState, revision: 'secret-r2' } }; },
            });
            const adapter = custody === 'account' ? secretAdapter : daemonAdapter;
            const definition = PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: custody,
                target: { kind: 'plugin' }, fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: { custody } }] });
            const groups = [mapV2EditableSettingsGroup(projectPluginSettingsContributionV2({ pluginId: 'acme.settings', definition }))];
            const settings = ActionsSettingsV1Schema.parse({ v: 1, ...(scenario === 'waived'
                ? { approvalWaivedSurfaces: { 'plugins.settings.secret.delete': ['ui'] } }
                : scenario === 'default' ? {} : { actions: { 'plugins.settings.secret.delete': { approvalRequiredSurfaces: ['ui'] } } }) });
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({
                isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
                hostActionApprovalLifetime: { actionId: 'plugins.settings.secret.delete', signal: new AbortController().signal, surface: 'ui' },
                presentUserActionConfirmation: async () => { confirmations += 1; return true; },
                isApprovalExecutionOriginCurrent: async () => true,
                approvalsCreate: async () => { approvalRequests += 1; return { artifactId: 'secret-approval' }; },
                approvalsUpdate: async () => ({ ok: true }),
                approvalsWaitForDecision: async ({ request }) => ({ decision: scenario === 'reject' ? 'reject' : 'canceled', request }),
                pluginSettingsAdministrationAction: settingsStoragePort({ target, groups, adapter, secretAdapter, assertCurrent() {} }),
            }));
            let executionSummary: unknown;
            const actionAdapter = createScopedPluginSettingsActionAdapter({ adapter,
                accountLifetime: { scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
                // Production's host stamps caller provenance before the pure Protocol executor.
                execute: async (id, input, context) => {
                    const result = await executor.execute(id, input, { ...context,
                        authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: `secret-${custody}-${scenario}` });
                    executionSummary = result.ok ? { ok: true, result: result.result } : { ok: false, errorCode: result.errorCode };
                    return result;
                } });
            const result = custody === 'account'
                ? await actionAdapter.write({ ...secretInput, expectedRevision: { kind: 'account-secret', value: accountSnapshot.revision }, mutation: { kind: 'delete' } })
                : await actionAdapter.daemonSecret!.write({ pluginId: 'acme.settings', target: daemonTarget, secretId: 'token',
                    expectedRevision: 'secret-r1', mutation: { kind: 'delete' } });
            const declined = scenario === 'reject' || scenario === 'canceled';
            expect(confirmations).toBe(scenario === 'default' ? 1 : 0);
            expect(approvalRequests).toBe(declined ? 1 : 0);
            expect(result, JSON.stringify({ scenario, executionSummary })).toMatchObject({ status: declined ? 'declined' : custody === 'account' ? 'applied' : 'ready' });
            const configured = custody === 'account'
                ? Boolean(resolveAccountSettingsPluginSecretBinding(accountSnapshot.settings, { pluginId: 'acme.settings', localId: 'token' }))
                : daemonState === 'configured';
            expect(configured).toBe(declined);
        }
    });
    it.each(['reject', 'canceled'] as const)('settles %s without field errors, recovery reads or persisted changes', async decision => {
        let revision = 7;
        let values: Readonly<Record<string, unknown>> = { enabled: false, endpoint: 'before' };
        let reads = 0;
        let failWrites = false;
        const target = { kind: 'account' as const, serverIdentityId: 'srv_a' };
        const groups = projectAccountDeclaredPluginSettingsGroups({ pluginId: 'acme.settings', declaration: { id: 'acme.settings',
            contributes: { settings: [PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'account',
                target: { kind: 'plugin' }, fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } },
                    { id: 'endpoint', title: 'Endpoint', schema: { type: 'string' } }] })] } } });
        const transport = createAccountScopedPluginSettingsTransport({ readRecord: async () => { reads += 1; return { status: 'present', revision, values }; },
            writeRecord: async input => {
                if (failWrites) return { status: 'unavailable', reason: 'transport' };
                values = input.values; revision += 1; return { status: 'updated', revision };
            } });
        const unexpected = async (): Promise<never> => { throw new Error('Wrong Settings scope'); };
        const adapter = createScopedPluginSettingsAdapter({ accountRead: transport.read, accountWrite: transport.write,
            daemonGet: unexpected, daemonSet: unexpected });
        let ask = true;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            isActionApprovalRequired: () => ask,
            isApprovalExecutionOriginCurrent: async () => true,
            approvalsCreate: async () => ({ artifactId: 'approval-1' }),
            approvalsUpdate: async () => ({ ok: true }),
            approvalsWaitForDecision: async ({ request }) => ({ decision, request }),
            pluginSettingsAdministrationAction: settingsStoragePort({ target, groups, adapter, secretAdapter: adapter, assertCurrent() {} }),
        }));
        const accountLifetime = { scope: { serverId: 'home-a', accountId: `quiet-${decision}` }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        let invocation = 0;
        const actionAdapter = createScopedPluginSettingsActionAdapter({ adapter, accountLifetime,
            execute: (id, input, context) => executor.execute(id, input, { ...context,
                authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: `field-${decision}-${++invocation}` }) });
        const fields = groups[0]!.fields.map(field => ({ key: field.key, redacted: false }));
        const scope = { kind: 'account' as const };
        const hook = await renderHook(() => useScopedPluginSettingsProjection({ pluginId: 'acme.settings', scope, target,
            perActiveServerIdentityId: null,
            accountLifetime, fields,
            declaredFields: groups[0]!.fields, enabled: true, adapter: actionAdapter }));
        try {
            expect(hook.getCurrent().state.ready).toBe(true);
            for (const [key, draft] of [['enabled', true], ['endpoint', 'after']] as const) {
                const beforeReads = reads;
                await act(async () => {
                    expect(await hook.getCurrent().fieldModels.find(model => model.field.key === key)!.commit({ draft }))
                        .toEqual({ status: 'declined' });
                });
                expect(hook.getCurrent().state).toMatchObject({ writePending: false, error: null, values: { enabled: false, endpoint: 'before' } });
                expect(reads).toBe(beforeReads);
                const model = hook.getCurrent().fieldModels.find(model => model.field.key === key)!;
                expect(model.error).toBeNull();
                expect(model.draft).toBe(key === 'enabled' ? false : 'after');
            }
            expect(values).toEqual({ enabled: false, endpoint: 'before' });
            expect(revision).toBe(7);
            ask = false;
            failWrites = true;
            await act(async () => {
                expect(await hook.getCurrent().fieldModels.find(model => model.field.key === 'endpoint')!.commit())
                    .toMatchObject({ status: 'unavailable' });
            });
            expect(hook.getCurrent().state.error).toBe('failed');
            expect(hook.getCurrent().fieldModels.find(model => model.field.key === 'endpoint')!.error).toBe('failed');
            ask = true;
            await act(async () => {
                expect(await hook.getCurrent().fieldModels.find(model => model.field.key === 'endpoint')!.commit())
                    .toEqual({ status: 'declined' });
            });
            expect(hook.getCurrent().state).toMatchObject({ error: null, writePending: false });
            expect(hook.getCurrent().fieldModels.find(model => model.field.key === 'endpoint')).toMatchObject({ error: null, draft: 'after' });
            expect(values).toEqual({ enabled: false, endpoint: 'before' });
        } finally { standardCleanup(); }
    });
    it('keeps an omitted secret target Account-owned and never borrows an ambient daemon for custody', async () => {
        for (const custody of ['account', 'daemon'] as const) {
            let snapshot = { revision: 5, settings: applyAccountSettingsSavedSecretMutation({}, { kind: 'add', secret: {
                id: 'saved-1', name: 'Existing token', kind: 'other',
                encryptedValue: { _isSecretValue: true, value: 'private-fixture-value' }, createdAt: 1, updatedAt: 1,
            } }).settings };
            const secretAdapter = createAccountPluginSecretSettingsAdapter({ readSnapshot: () => snapshot,
                async writeOnce(input) {
                    snapshot = { revision: snapshot.revision + 1, settings: input.mutate(snapshot.settings) };
                    return { status: 'applied', revision: snapshot.revision, snapshot };
                } });
            const target = { kind: 'account' as const, serverIdentityId: 'srv_a' };
            const groups = projectAccountDeclaredPluginSettingsGroups({ pluginId: 'acme.settings', declaration: { id: 'acme.settings',
                contributes: { settings: [PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'account',
                    target: { kind: 'plugin' }, fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: { custody } }] })] } } });
            const unexpected = async (): Promise<never> => { throw new Error('Omitted secret target reached a daemon or ordinary Settings boundary'); };
            const adapter = createScopedPluginSettingsAdapter({ accountRead: unexpected, accountWrite: unexpected,
                daemonGet: unexpected, daemonSet: unexpected, daemonSecretStatus: unexpected, daemonSecretDelete: unexpected });
            const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
                'plugins.settings.secret.bind': ['agent'], 'plugins.settings.secret.delete': ['agent'],
            } });
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({
                isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
                pluginSettingsAdministrationAction: settingsStoragePort({ target, groups, adapter, secretAdapter, assertCurrent() {} }),
            }));
            const input = { pluginId: 'acme.settings', localId: 'token' };
            const context = { surface: 'agent' as const, authority: 'account_automation' as const, defaultSessionMachineId: 'ambient-machine' };
            const result = custody === 'account'
                ? await executor.execute('plugins.settings.secret.bind', { ...input, savedSecretId: 'saved-1', expectedRevision: 'account-secret-r1:5' }, context)
                : await executor.execute('plugins.settings.secret.delete', input, context);
            if (custody === 'account') {
                expect(result).toMatchObject({ ok: true, result: { data: { target: { kind: 'account' }, revision: 'account-secret-r1:6' } } });
                expect(resolveAccountSettingsPluginSecretBinding(snapshot.settings, input)?.savedSecretId).toBe('saved-1');
                expect(JSON.stringify(result)).not.toContain('private-fixture-value');
            } else {
                expect(result).toMatchObject({ ok: false, errorCode: 'plugin_settings_unknown_key' });
                expect(snapshot.revision).toBe(5);
            }
        }
    });
    it('executes waived Agent and MCP writes through the existing declared Settings and CAS owners', async () => {
        for (const surface of ['agent', 'mcp'] as const) {
            let revision = 7;
            let values: Readonly<Record<string, unknown>> = { enabled: false, unrelated: 'retained' };
            const target = { kind: 'account' as const, serverIdentityId: 'srv_a' };
            const groups = projectAccountDeclaredPluginSettingsGroups({ pluginId: 'acme.settings', declaration: { id: 'acme.settings',
                contributes: { settings: [PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'account',
                    target: { kind: 'plugin' }, fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } }] })] } } });
            const transport = createAccountScopedPluginSettingsTransport({ readRecord: async () => ({ status: 'present', revision, values }),
                writeRecord: async input => {
                    if (input.expectedRevision !== revision) return { status: 'conflict', revision };
                    values = input.values;
                    revision += 1;
                    return { status: 'updated', revision };
                } });
            const unexpected = async (): Promise<never> => { throw new Error('Wrong Settings scope'); };
            const adapter = createScopedPluginSettingsAdapter({ accountRead: transport.read, accountWrite: transport.write,
                daemonGet: unexpected, daemonSet: unexpected });
            const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'plugins.settings.set': [surface] } });
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({
                isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
                pluginSettingsAdministrationAction: settingsStoragePort({ target, groups, adapter, secretAdapter: adapter, assertCurrent() {} }),
            }));
            const input = { pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' },
                localId: 'enabled', value: true, expectedRevision: '7' };
            const context = { surface, authority: 'account_automation' as const };
            expect(await executor.execute('plugins.settings.set', input, context))
                .toMatchObject({ ok: true, result: { data: { revision: '8' } } });
            expect(values).toEqual({ enabled: true, unrelated: 'retained' });
            expect(await executor.execute('plugins.settings.set', input, context))
                .toMatchObject({ ok: false, errorCode: 'plugin_settings_revision_conflict' });
            expect(revision).toBe(8);
        }
    });
    it('refuses declared secret record operands before the UI storage port or hooks can read custody', async () => {
        const target = { kind: 'account' as const, serverIdentityId: 'srv_a' };
        const groups = projectAccountDeclaredPluginSettingsGroups({ pluginId: 'acme.settings', declaration: { id: 'acme.settings',
            contributes: { settings: [PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'account',
                target: { kind: 'plugin' }, fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: { custody: 'account' } }] })] } } });
        const unexpected = async (): Promise<never> => { throw new Error('Secret record operands reached an external boundary'); };
        const adapter = createScopedPluginSettingsAdapter({ accountRead: unexpected, accountWrite: unexpected, daemonGet: unexpected, daemonSet: unexpected });
        const observations: unknown[] = [];
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            pluginSettingsAdministrationAction: settingsStoragePort({ target, groups, adapter, secretAdapter: adapter, assertCurrent() {} }),
            interceptActionExecution: unexpected,
            approvalsCreate: unexpected,
            observeActionExecution: result => { observations.push(result); },
        }));
        expect(await executor.execute('plugins.settings.set', { pluginId: 'acme.settings', scope: { kind: 'account' },
            target: { kind: 'account' }, localId: 'token', value: 'synthetic-private-ui-token' }, { surface: 'cli' }))
            .toMatchObject({ ok: false, errorCode: 'plugin_settings_unknown_key' });
        expect(JSON.stringify(observations)).not.toContain('synthetic-private-ui-token');
    });
    it('keeps configured UI Ask on the live field intent and refuses a changed declaration before effects', async () => {
        for (const changeIntent of [true, false]) {
            let current = true;
            let revision = 7;
            let values: Readonly<Record<string, unknown>> = { enabled: false };
            const target = { kind: 'account' as const, serverIdentityId: 'srv_a' };
            const groups = projectAccountDeclaredPluginSettingsGroups({ pluginId: 'acme.settings', declaration: { id: 'acme.settings',
                contributes: { settings: [PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'account',
                    target: { kind: 'plugin' }, fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } }] })] } } });
            const transport = createAccountScopedPluginSettingsTransport({ readRecord: async () => ({ status: 'present', revision, values }),
                writeRecord: async input => { if (input.expectedRevision !== revision) return { status: 'conflict', revision };
                    values = input.values; revision += 1; return { status: 'updated', revision }; } });
            const adapter = createScopedPluginSettingsAdapter({ accountRead: transport.read, accountWrite: transport.write,
                daemonGet: async () => { throw new Error('wrong scope'); }, daemonSet: async () => { throw new Error('wrong scope'); } });
            const entered = createDeferred<void>();
            const decided = createDeferred<void>();
            const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'plugins.settings.set': { approvalRequiredSurfaces: ['ui'] } } });
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({
                isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
                isApprovalExecutionOriginCurrent: async () => true,
                approvalsCreate: async ({ request }) => { expect(request.approval?.flow).toBe('blocking'); return { artifactId: 'approval-1' }; },
                approvalsUpdate: async () => ({ ok: true }),
                approvalsWaitForDecision: async ({ request }) => { entered.resolve(); await decided.promise;
                    return { decision: 'approve', request: { ...request, status: 'approved', decision: { kind: 'approve', decidedAtMs: 2 } } }; },
                pluginSettingsAdministrationAction: settingsStoragePort({ target, groups, adapter, secretAdapter: adapter, assertCurrent() {} }),
            }));
            const actionAdapter = createScopedPluginSettingsActionAdapter({ adapter,
                accountLifetime: { scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
                execute: (id, input, context) => executor.execute(id, input, { ...context, actionRequestId: 'captured-field-attempt' }) });
            const writeInput = { pluginId: 'acme.settings', scope: { kind: 'account' as const }, target,
                fields: [{ key: 'enabled', redacted: false }], fieldId: 'enabled', mutation: { kind: 'set' as const, value: true },
                expectedRevision: { kind: 'account' as const, value: 7 }, isCurrent: () => current };
            const pending = actionAdapter.write(writeInput);
            const observed = await Promise.race([entered.promise.then(() => 'waiting'), pending.then(() => 'returned')]);
            expect(observed).toBe('waiting');
            expect(values).toEqual({ enabled: false });
            if (changeIntent) current = false;
            decided.resolve();
            expect(await pending).toMatchObject({ status: changeIntent ? 'unavailable' : 'applied' });
            expect(values).toEqual({ enabled: !changeIntent });
            expect(revision).toBe(changeIntent ? 7 : 8);
        }
    });
    it('preserves the canonical safe readback currentness when a declared intent changes during a pending read', async () => {
        for (const holdAt of [1, 2]) {
        let current = true;
        let values: Readonly<Record<string, unknown>> = { enabled: false };
        let reads = 0;
        let enterRead!: () => void;
        let releaseRead!: () => void;
        const entered = new Promise<void>(resolve => { enterRead = resolve; });
        const released = new Promise<void>(resolve => { releaseRead = resolve; });
        const target = { kind: 'account' as const, serverIdentityId: 'srv_a' };
        const groups = projectAccountDeclaredPluginSettingsGroups({ pluginId: 'acme.settings', declaration: { id: 'acme.settings',
            contributes: { settings: [PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'account',
                target: { kind: 'plugin' }, fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } }] })] } } });
        const transport = createAccountScopedPluginSettingsTransport({
            readRecord: async () => { reads += 1; if (reads === holdAt) { enterRead(); await released; } return { status: 'present', revision: 7, values }; },
            writeRecord: async input => { values = input.values; return { status: 'updated', revision: 8 }; },
        });
        const adapter = createScopedPluginSettingsAdapter({ accountRead: transport.read, accountWrite: transport.write,
            daemonGet: async () => { throw new Error('wrong scope'); }, daemonSet: async () => { throw new Error('wrong scope'); } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ pluginSettingsAdministrationAction:
            settingsStoragePort({ target, groups, adapter, secretAdapter: adapter, assertCurrent() {} }) }));
        const input = { pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' }, localId: 'enabled', value: true, expectedRevision: '7' };
        const context = { surface: 'cli' as const, bypassApprovals: true, isPluginSettingsIntentCurrent: () => current };
        const pending = executor.execute('plugins.settings.set', input, context);
        await entered;
        current = false;
        releaseRead();
        expect(await pending).toMatchObject({ ok: false, errorCode: 'plugin_settings_target_not_current' });
        expect(values).toEqual({ enabled: false });
        current = true;
        expect(await executor.execute('plugins.settings.set', input, context)).toMatchObject({ ok: true });
        expect(values).toEqual({ enabled: true });
        }
    });
    it('refuses a redacted record draft before it can become a persisted Action operand', async () => {
        const operands: unknown[] = [];
        const adapter = createScopedPluginSettingsAdapter({ accountRead: async () => ({ status: 'unavailable', reason: 'transport' }),
            accountWrite: async () => ({ status: 'unavailable', reason: 'transport' }),
            daemonGet: async () => { throw new Error('wrong scope'); }, daemonSet: async () => { throw new Error('wrong scope'); } });
        const actionAdapter = createScopedPluginSettingsActionAdapter({ adapter,
            accountLifetime: { scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            execute: async (_id, input) => { operands.push(input); return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' }; } });
        expect(await actionAdapter.write({ pluginId: 'acme.settings', scope: { kind: 'account' },
            target: { kind: 'account', serverIdentityId: 'srv_a' }, fields: [{ key: 'token', redacted: true }],
            fieldId: 'token', mutation: { kind: 'set', value: 'private-draft' }, expectedRevision: { kind: 'account', value: 7 } }))
            .toMatchObject({ status: 'unavailable' });
        expect(operands).toEqual([]);
    });
    it('preserves the canonical safe readback without replay after acknowledgement loss', async () => {
        let values: Readonly<Record<string, unknown>> = { enabled: false, privateEntry: 'never-presented' };
        let revision = 7;
        const target = { kind: 'account' as const, serverIdentityId: 'srv_a' };
        const groups = projectAccountDeclaredPluginSettingsGroups({ pluginId: 'acme.settings', declaration: { id: 'acme.settings',
            contributes: { settings: [PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences',
                scope: 'account', target: { kind: 'plugin' }, fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } }] })] } } });
        const transport = createAccountScopedPluginSettingsTransport({
            readRecord: async () => ({ status: 'present', revision, values }),
            writeRecord: async input => { values = input.values; revision += 1; return { status: 'outcomeUnknown' }; },
        });
        const adapter = createScopedPluginSettingsAdapter({ accountRead: transport.read, accountWrite: transport.write,
            daemonGet: async () => { throw new Error('wrong scope'); }, daemonSet: async () => { throw new Error('wrong scope'); } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ pluginSettingsAdministrationAction:
            settingsStoragePort({ target, groups, adapter, secretAdapter: adapter, assertCurrent() {} }) }));
        const result = await executor.execute('plugins.settings.set', { pluginId: 'acme.settings', scope: { kind: 'account' },
            target: { kind: 'account' }, localId: 'enabled', value: true, expectedRevision: '7' }, { surface: 'cli', bypassApprovals: true });
        expect(result).toMatchObject({ ok: false, errorCode: 'plugin_settings_outcome_unknown',
            details: { kind: 'settings_snapshot', scope: { kind: 'account' }, target: { kind: 'account' }, revision: '8', values: { enabled: true } } });
        if (!result.ok) expect(result.details).not.toHaveProperty('values.privateEntry');
        expect(revision).toBe(8);
        const lifetime = { scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const writeInput = { pluginId: 'acme.settings', scope: { kind: 'account' as const }, target,
            fields: [{ key: 'enabled', redacted: false }], fieldId: 'enabled', mutation: { kind: 'set' as const, value: true },
            expectedRevision: { kind: 'account' as const, value: 7 } };
        const actionAdapter = createScopedPluginSettingsActionAdapter({ adapter, accountLifetime: lifetime,
            execute: (id, input, context) => executor.execute(id, input, { ...context, surface: 'cli', bypassApprovals: true }) });
        expect(await actionAdapter.write({ ...writeInput, expectedRevision: { kind: 'account', value: 8 } }))
            .toMatchObject({ status: 'outcomeUnknown', snapshot: { revision: { kind: 'account', value: 9 }, values: { enabled: true } } });
        for (const details of [
            { kind: 'settings_snapshot', scope: { kind: 'account' }, target: { kind: 'daemon', machineId: 'other', serverIdentityId: 'srv_b' }, revision: '9', values: { enabled: true } },
            { kind: 'settings_snapshot', scope: { kind: 'account' }, target: { kind: 'account' }, revision: '9', values: { enabled: true, privateEntry: 'must-not-disclose' } },
            { kind: 'settings_snapshot', scope: { kind: 'account' }, target: { kind: 'account' }, revision: 'not-a-revision', values: { enabled: true } },
        ]) {
            const unsafeAdapter = createScopedPluginSettingsActionAdapter({ adapter, accountLifetime: lifetime,
                execute: async () => ({ ok: false, errorCode: 'plugin_settings_outcome_unknown', error: 'plugin_settings_outcome_unknown', details }) });
            expect(await unsafeAdapter.write(writeInput)).toEqual({ status: 'outcomeUnknown' });
        }
    });
    it('preserves explicit fallback and byServer intents while retaining neighboring entries', async () => {
        let revision = 7;
        let values: Readonly<Record<string, unknown>> = { endpoint: 'fallback', endpoints: { srv_a: 'a', srv_b: 'b' } };
        const target = { kind: 'account' as const, serverIdentityId: 'srv_a' };
        const groups = projectAccountDeclaredPluginSettingsGroups({ pluginId: 'acme.settings', declaration: {
            id: 'acme.settings', contributes: { settings: [PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences',
                scope: 'account', target: { kind: 'plugin' }, fields: [
                    { id: 'endpoint', title: 'Endpoint', schema: { type: 'string' }, default: 'default',
                        presentation: { binding: { kind: 'perActiveServer', fallbackSettingId: 'endpoint', byServerIdSettingId: 'endpoints' } } },
                    { id: 'endpoints', title: 'Endpoints', schema: { type: 'object', additionalProperties: { type: 'string' } },
                        presentation: { hidden: true } },
                ],
            })] },
        } });
        const transport = createAccountScopedPluginSettingsTransport({ readRecord: async () => ({ status: 'present', revision, values }),
            writeRecord: async input => {
                if (input.expectedRevision !== revision) return { status: 'conflict', revision };
                values = input.values; revision += 1; return { status: 'updated', revision };
            } });
        const adapter = createScopedPluginSettingsAdapter({ accountRead: transport.read, accountWrite: transport.write,
            daemonGet: async () => { throw new Error('wrong scope'); }, daemonSet: async () => { throw new Error('wrong scope'); } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ pluginSettingsAdministrationAction:
            settingsStoragePort({ target, groups, adapter, secretAdapter: adapter, assertCurrent() {} }) }));
        const context = { surface: 'ui' as const, bypassApprovals: true };
        const input = { pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' }, localId: 'endpoint' };
        expect(await executor.execute('plugins.settings.set', { ...input, value: 'new-a', expectedRevision: '7', bindingServerIdentityId: 'srv_a' }, context))
            .toMatchObject({ ok: true, result: { data: { revision: '8' } } });
        expect(values).toEqual({ endpoint: 'fallback', endpoints: { srv_a: 'new-a', srv_b: 'b' } });
        expect(await executor.execute('plugins.settings.set', { ...input, value: 'new-fallback', expectedRevision: '8', bindingServerIdentityId: null }, context))
            .toMatchObject({ ok: true });
        expect(values).toEqual({ endpoint: 'new-fallback', endpoints: { srv_a: 'new-a', srv_b: 'b' } });
        expect(await executor.execute('plugins.settings.reset', { ...input, expectedRevision: '9', bindingServerIdentityId: 'srv_a' }, context))
            .toMatchObject({ ok: true });
        expect(values).toEqual({ endpoint: 'new-fallback', endpoints: { srv_b: 'b' } });
        const actionAdapter = createScopedPluginSettingsActionAdapter({ adapter,
            accountLifetime: { scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            execute: (id, input, actionContext) => executor.execute(id, input, { ...actionContext, bypassApprovals: true }) });
        expect(await actionAdapter.write({ pluginId: 'acme.settings', scope: { kind: 'account' }, target,
            fields: [{ key: 'endpoint', redacted: false, binding: { kind: 'perActiveServer', fallbackSettingId: 'endpoint', byServerIdSettingId: 'endpoints' } },
                { key: 'endpoints', redacted: false }], fieldId: 'endpoints', mutation: { kind: 'set', value: { srv_b: 'new-b' } },
            expectedRevision: { kind: 'account', value: 10 }, bindingServerIdentityId: 'srv_b' }))
            .toMatchObject({ status: 'applied', revision: { kind: 'account', value: 11 } });
        expect(values).toEqual({ endpoint: 'new-fallback', endpoints: { srv_b: 'new-b' } });
    });

    it('deletes only the submitted daemon origin even when another origin has the same revision', async () => {
        const target = { kind: 'daemon' as const, serverIdentityId: 'srv_a', serverId: 'home-a', machineId: 'machine-a' };
        const origins = new Map([['https://a.example', 'configured'], ['https://b.example', 'configured']]);
        const adapter = createScopedPluginSettingsAdapter({
            accountRead: async () => { throw new Error('wrong custody'); }, accountWrite: async () => { throw new Error('wrong custody'); },
            daemonGet: async () => { throw new Error('no Settings record'); }, daemonSet: async () => { throw new Error('no Settings record'); },
            daemonSecretStatus: async (_machine, input) => ({ supported: true, result: { protocolVersion: 1, pluginId: input.pluginId,
                secretId: input.secretId, state: origins.get(input.canonicalOrigin ?? '') === 'configured' ? 'configured' : 'missing', revision: 'same' } }),
            daemonSecretSet: async () => { throw new Error('Raw replacement is outside the Action port'); },
            daemonSecretDelete: async (_machine, input) => {
                origins.set(input.canonicalOrigin ?? '', 'missing');
                return { supported: true, result: { protocolVersion: 1, pluginId: input.pluginId, secretId: input.secretId,
                    state: 'missing', revision: 'deleted' } };
            },
        });
        const definition = PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'daemon', target: { kind: 'plugin' },
            fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: { custody: 'daemon' } }] });
        const { projectPluginSettingsContributionV2 } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { mapV2EditableSettingsGroup } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
        const groups = [mapV2EditableSettingsGroup(projectPluginSettingsContributionV2({ pluginId: 'acme.settings', definition }))];
        const input = { pluginId: 'acme.settings', localId: 'token', secretDaemonTarget: { kind: 'daemon', serverIdentityId: 'srv_a', machineId: 'machine-a' },
            canonicalOrigin: 'https://a.example', expectedRevision: 'same' };
        expect(await executeScopedPluginSettingsAdministrationAction({ actionId: 'plugins.settings.secret.delete', input,
            context: { surface: 'ui', authority: 'present_user', bypassApprovals: true },
            target, groups, adapter, secretAdapter: adapter, assertCurrent() {} }))
            .toMatchObject({ ok: true });
        expect(origins.get('https://a.example')).toBe('missing');
        expect(origins.get('https://b.example')).toBe('configured');
    });
    it('runs an approved Account CAS through the existing record owner and rejects invalid or stale intent', async () => {
        let revision = 7;
        let values: Readonly<Record<string, unknown>> = { enabled: false, unrelated: 'retained' };
        let writes = 0;
        const target = { kind: 'account' as const, serverIdentityId: 'srv_fixture' };
        const groups = projectAccountDeclaredPluginSettingsGroups({ pluginId: 'acme.settings', declaration: {
            id: 'acme.settings', contributes: { settings: [PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'account',
                target: { kind: 'plugin' }, fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: false }],
            })] },
        } });
        // The record boundary represents persistence. Domain normalization, CAS and admission stay real.
        const transport = createAccountScopedPluginSettingsTransport({
            readRecord: async () => ({ status: 'present', revision, values }),
            writeRecord: async input => {
                if (input.expectedRevision !== revision) return { status: 'conflict', revision };
                writes += 1;
                values = input.values;
                revision += 1;
                return { status: 'updated', revision };
            },
        });
        const adapter = createScopedPluginSettingsAdapter({ accountRead: transport.read, accountWrite: transport.write,
            daemonGet: async () => { throw new Error('Wrong custody'); }, daemonSet: async () => { throw new Error('Wrong custody'); } });
        let current = true;
        const settings = ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'plugins.settings.set': { approvalRequiredSurfaces: ['ui'] } } });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
            pluginSettingsAdministrationAction: settingsStoragePort({
                target, groups, adapter, secretAdapter: adapter, assertCurrent: () => { if (!current) throw new Error('retired'); } }),
        }));
        const input = { pluginId: 'acme.settings', scope: { kind: 'account' }, target: { kind: 'account' },
            localId: 'enabled', value: true, expectedRevision: '7' };
        const context = { surface: 'ui' as const, authority: 'present_user' as const };
        const actionAdapter = createScopedPluginSettingsActionAdapter({ adapter,
            accountLifetime: { scope: { serverId: 'home-a', accountId: 'alice' }, isCurrent: () => current,
                onRetire: () => ({ dispose() {} }) }, execute: executor.execute });
        const writeInput = { pluginId: input.pluginId, scope: { kind: 'account' as const }, target,
            fields: [{ key: 'enabled', redacted: false }], fieldId: 'enabled', mutation: { kind: 'set' as const, value: true },
            expectedRevision: { kind: 'account' as const, value: 7 } };
        expect(await actionAdapter.write(writeInput)).toMatchObject({ status: 'unavailable' });
        expect(writes).toBe(0);
        expect(await executor.execute('plugins.settings.set', input, context)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(writes).toBe(0);
        expect(await executor.execute('plugins.settings.set', input, { ...context, bypassApprovals: true }))
            .toMatchObject({ ok: true, result: { ok: true, data: { revision: '8' } } });
        expect(values).toEqual({ enabled: true, unrelated: 'retained' });
        expect(await executor.execute('plugins.settings.set', { ...input, expectedRevision: '8', value: 'invalid' },
            { ...context, bypassApprovals: true })).toMatchObject({ ok: false, errorCode: 'plugin_settings_invalid_value' });
        expect(await executor.execute('plugins.settings.set', input, { ...context, bypassApprovals: true }))
            .toMatchObject({ ok: false, errorCode: 'plugin_settings_revision_conflict' });
        current = false;
        expect(await executor.execute('plugins.settings.reset', { pluginId: input.pluginId, scope: input.scope,
            target: input.target, localId: input.localId, expectedRevision: '8' }, { ...context, bypassApprovals: true }))
            .toMatchObject({ ok: false, errorCode: 'plugin_settings_target_not_current' });
        expect(writes).toBe(1);
    });
});
