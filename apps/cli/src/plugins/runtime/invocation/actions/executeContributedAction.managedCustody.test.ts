import { describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withTempDir } from '@/testkit/fs/tempDir';

import { createManagedPluginSourceCustody } from '@/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit';
import { executeContributedAction as dispatchContributedAction } from './executeContributedAction';
import { fixture, pluginId, roles, roleActionId, roleInput, roleResult } from './managedCustody.testkit';
import { createConnectedAccountPurposeBindingOwner, type ConnectedAccountPurposeBindingStore } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { machineProvisionerAuthorFixture } from '../../../../../../../packages/plugin-sdk/fixtures/authoring-inference/machineProvisioners';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { activateContributionModule } from '@/plugins/runtime/lifecycle/activation/activateContributionModule';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createTargetActionInvocationRegistry } from '../targetActionRegistry';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createUnavailablePluginServicesFactory } from '../services/factory';

function executeContributedAction(request: Parameters<typeof dispatchContributedAction>[0]) {
    const localId = String(request.actionId).split('/').at(-1)!;
    return dispatchContributedAction({ ...request, input: request.input ?? roleInput(localId) });
}

describe('managed native-role custody at contributed dispatch', () => {
    it.each(['acquire', 'rebuild', 'reconcile'] as const)('retains a known managed %s identity after cancellation without changing ordinary Action cancellation', async role => {
        const allocationAbort = new AbortController();
        const f = fixture({ ...(role === 'reconcile' ? { reconciliation: true } : {}),
            onNativeRole: currentRole => { if (currentRole === role) allocationAbort.abort(); } });
        const result = await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/${role}`,
            admittedManagedProviderOperation: { ...f.custody, role, isCurrent: () => !allocationAbort.signal.aborted },
            context: { surface: 'plugin', signal: allocationAbort.signal },
        });
        expect(allocationAbort.signal.aborted).toBe(true);
        expect(result).toEqual({ matched: true, result: { ok: true, result: roleResult(role) } });
        const beforeIssueAbort = new AbortController();
        const unissued = fixture();
        const canceledBeforeIssue = await executeContributedAction({ runtimeRegistry: unissued.runtimeRegistry, actionId: `${pluginId}/acquire`,
            admittedManagedProviderOperation: { ...unissued.custody, isCurrent: () => !beforeIssueAbort.signal.aborted },
            context: { surface: 'plugin', signal: beforeIssueAbort.signal,
                beforeHandlerInvocation: async () => { beforeIssueAbort.abort(); },
            },
        });
        expect(canceledBeforeIssue).toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
        expect(unissued.effects()).toBe(0);
        const ordinaryAbort = new AbortController();
        const ordinary = fixture({ nativeTransport: false, onNativeRole: role => { if (role === 'exec') ordinaryAbort.abort(); } });
        const canceledOrdinary = await executeContributedAction({ runtimeRegistry: ordinary.runtimeRegistry, actionId: `${pluginId}/exec`,
            context: { surface: 'plugin', signal: ordinaryAbort.signal },
        });
        expect(ordinaryAbort.signal.aborted).toBe(true);
        expect(canceledOrdinary).toMatchObject({ result: { ok: false, errorCode: 'plugin_action_outcome_unknown' } });
    });
    it.each(['reconcile', 'cleanup'] as const)('requires retained operation custody for pending %s and after awaits', async role => {
        const config = { reconciliation: true, ...(role === 'cleanup' ? { cleanupObservation: { kind: 'confirmed' as const } } : {}) };
        const f = fixture(config);
        const request = { runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/${role}`, context: { surface: 'plugin' as const } };
        expect(await executeContributedAction({ ...request, admittedManagedProviderOperation: { ...f.custody, role } }))
            .toMatchObject({ result: { ok: true, result: role === 'cleanup' ? { kind: 'confirmed' } : roleResult('reconcile') } });
        const cold = fixture({ ...config, cold: true });
        expect(await executeContributedAction({ ...request, runtimeRegistry: cold.runtimeRegistry }))
            .toMatchObject({ result: { ok: false, errorCode: 'plugin_managed_provider_operation_custody_invalid', actionHandlerInvocation: 'notStarted' } });
        expect(cold.activations()).toBe(0);
        expect(cold.effects()).toBe(0);
        const staleNativeReference = { ...f.custody, role, isCurrent: () => false };
        expect(await executeContributedAction({ ...request, admittedManagedProviderOperation: staleNativeReference }))
            .toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
        let current = true;
        expect(await executeContributedAction({ ...request,
            admittedManagedProviderOperation: { ...f.custody, role, isCurrent: async () => current },
            context: { surface: 'plugin', beforeHandlerInvocation: async () => { current = false; } },
        })).toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
        expect(current).toBe(false);
        f.retire();
        expect(await executeContributedAction({ ...request, admittedManagedProviderOperation: { ...f.custody, role } }))
            .toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
        expect(f.effects()).toBe(1);
    });
    it('executes the public-only author fixture through real activation and managed dispatch', async ({ onTestFinished }) => {
        const manifest = normalizePluginManifestV2(machineProvisionerAuthorFixture.manifest);
        const authorPluginId = manifest.id;
        const occurrenceId = createPluginRuntimeOccurrenceId(authorPluginId);
        const activated = await activateContributionModule({ pluginId: authorPluginId, occurrenceId,
            isOccurrenceCurrent: () => true, manifest, moduleNamespace: machineProvisionerAuthorFixture,
        });
        onTestFinished(() => activated.dispose());
        expect(activated.status).toBe('active');
        const registrations = activated.registrations.flatMap((registration) => {
            if (registration.family !== 'actions') return [];
            const declaration = manifest.contributes.actions.find((action) => action.id === registration.localId)!;
            return [{ pluginId: authorPluginId, pluginVersion: manifest.version, occurrenceId,
                sourceCustody: createManagedPluginSourceCustody('public-author-fixture'), localId: registration.localId,
                definition: declaration, handler: registration.value,
            }];
        });
        const targetActionInvocations = createTargetActionInvocationRegistry({ actions: registrations,
            readCurrentPluginOccurrenceId: () => occurrenceId,
            resolveAuthorizationFacts: () => ({ generation: { targetGeneration: occurrenceId, desiredGeneration: occurrenceId, appliedGeneration: occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [],
            }), resolveHostBinding: createTargetActionHostBindingResolver(), createServices: createUnavailablePluginServicesFactory(),
        });
        onTestFinished(() => targetActionInvocations.dispose());
        const contributes = createResolvedContributionRegistry({
            occurrenceIdsByPluginId: { [authorPluginId]: occurrenceId },
            activationTargets: [{ pluginId: authorPluginId, manifest, provenance: 'external', source: { kind: 'path' },
                manifestPath: join(tmpdir(), 'public-author-fixture', 'plugin.json'), daemonEntryPath: null,
                sourceSpec: { kind: 'path', path: join(tmpdir(), 'public-author-fixture') },
            }],
            machineProvisioners: manifest.contributes.machineProvisioners.map((definition) => ({ pluginId: authorPluginId, identity: { pluginId: authorPluginId, localId: definition.id }, definition })),
            actions: manifest.contributes.actions.map((action): ResolvedActionContribution => ({ pluginId: authorPluginId, provenance: 'external', source: { kind: 'path' },
                definition: { id: action.id, title: action.id, description: null, kindVersion: 1, placements: [], slash: null, bindings: null, examples: null,
                    surfaces: { plugin: true, cli: false, ui: false, voice: false, agent: false, mcp: false, rpc: false, api: false },
                    inputHints: null, inputSchema: action.inputSchema, execution: { target: 'daemon' }, safety: 'safe', dangerLevel: action.dangerLevel,
                },
            })),
        });
        // Only module loading is represented by the already genuinely activated fixture.
        const runtimeRegistry = { contributes, targetActionInvocations, readPluginOccurrenceId: () => occurrenceId } as unknown as ResolvedExecutablePluginRuntimeRegistry;
        const custody = { managedId: 'public-managed', homeId: 'home', intentRevision: 1,
            controller: { machineId: 'controller', installationId: 'installation' },
            contribution: { pluginId: authorPluginId, localId: 'guest', occurrenceId }, isCurrent: () => true,
        };
        const call = (localId: string, input: Parameters<typeof dispatchContributedAction>[0]['input'], role: 'acquire' | 'inspect' | 'exec' | 'putFile') => dispatchContributedAction({
            runtimeRegistry, actionId: `${authorPluginId}/${localId}`, input,
            admittedManagedProviderOperation: { ...custody, role }, context: { surface: 'plugin' },
        });
        const resource = { name: 'public-guest' };
        expect(await dispatchContributedAction({ runtimeRegistry, actionId: `${authorPluginId}/acquire`, input: { launch: resource }, context: { surface: 'plugin' } }))
            .toMatchObject({ result: { ok: false, errorCode: 'plugin_managed_provider_operation_custody_invalid', actionHandlerInvocation: 'notStarted' } });
        expect(await call('acquire', { launch: resource }, 'acquire')).toMatchObject({ result: { ok: true, result: { kind: 'bound', resource: { value: resource } } } });
        expect(await call('inspect', { resource }, 'inspect')).toMatchObject({ result: { ok: true, result: { availability: 'present' } } });
        expect(await call('exec', { resource, argv: ['true'] }, 'exec')).toMatchObject({ result: { ok: true, result: { termination: { observed: { kind: 'exit', exitCode: 0 } } } } });
        expect(await call('put-file', { resource, guestPath: '/fixture', bytesBase64: '' }, 'putFile')).toMatchObject({ result: { ok: true, result: { kind: 'confirmed' } } });
    });
    it('streams the admitted native Exec process while the actual role Action remains pending', async ({ onTestFinished }) => {
        await withTempDir('happier-native-output-', async (root) => {
            const releasePath = join(root, 'release');
            const f = fixture({ nativeCommandTimeoutMs: 0, nativePreflightArgs: ['-e', "process.stdout.write('{\"unrelated\":\"list\"}\\n');"], nativeCommandArgs: ['-e',
                "process.stdout.write('pairing-request'); const timer = setInterval(() => { if(require('node:fs').existsSync(process.argv[1])) { clearInterval(timer); process.exit(0); } }, 10);", releasePath] });
            let settled = false;
            let observed = '';
            const controller = new AbortController();
            onTestFinished(() => { controller.abort(); });
            try {
                const result = await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/exec`,
                    admittedManagedProviderOperation: { ...f.custody, role: 'exec', execTimeoutMs: null, onProcessOutput: (output) => {
                        if (output.stream !== 'stdout') return;
                        expect(settled).toBe(false);
                        observed += Buffer.from(output.data).toString('utf8');
                        writeFileSync(releasePath, 'release');
                    } }, context: { surface: 'plugin', signal: controller.signal },
                }).finally(() => { settled = true; });
                expect(result, JSON.stringify(result)).toMatchObject({ result: { ok: true, result: { termination: { observed: { kind: 'exit', exitCode: 0 } }, stdoutBase64: Buffer.from('pairing-request').toString('base64') } } });
                expect(observed).toBe('pairing-request');
            } finally { controller.abort(); }
        });
    });
    it('applies the inherited task budget to the selected guest process without cutting off its captured inspection', async ({ onTestFinished }) => {
        await withTempDir('happier-native-budget-', async (root) => {
            const inspectedPath = join(root, 'inspected');
            const f = fixture({
                nativePreflightArgs: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'inspected');", inspectedPath],
                nativeCommandArgs: ['-e', "setInterval(() => {}, 1000);"],
            });
            const controller = new AbortController();
            onTestFinished(() => { controller.abort(); });
            try {
                const result = await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/exec`,
                    admittedManagedProviderOperation: { ...f.custody, role: 'exec', execTimeoutMs: 0 }, context: { surface: 'plugin', signal: controller.signal },
                });
                expect(existsSync(inspectedPath)).toBe(true);
                expect(result, JSON.stringify(result)).toMatchObject({ result: { ok: true, result: { termination: { requestedBy: { kind: 'timeout' } } } } });
            } finally { controller.abort(); }
        });
    });
    it('keeps hidden native Actions private while admitting the host plugin-surface call', async () => {
        const f = fixture({ privateNative: true });
        const request = { runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/acquire`, admittedManagedProviderOperation: f.custody };
        expect(await executeContributedAction({ ...request, context: { surface: 'cli' } })).toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
        expect(await executeContributedAction({ ...request, context: { surface: 'plugin', originSurface: 'cli', invocationSurface: 'plugin' } })).toMatchObject({ result: { ok: true, result: roleResult('acquire') } });
        expect(f.effects()).toBe(1);
    });
    it('pins the captured account or captured absence after defaults change and refuses a retired lease', async () => {
        const purpose = { consumer: { pluginId, localId: 'acquire' }, purpose: 'upstream' };
        const service = { pluginId: 'acme.accounts', localId: 'cloud' };
        const selected = { kind: 'account' as const, account: { service, accountId: 'new-default' } };
        let stored: Awaited<ReturnType<ConnectedAccountPurposeBindingStore['read']>> = { v: 1, bindings: [{ purpose, target: selected }] };
        const disclosedAccounts: string[] = [];
        const owner = createConnectedAccountPurposeBindingOwner({
            store: { read: async () => stored, update: async (mutate) => (stored = mutate(stored)) },
            selectTarget: async () => selected,
            resolveTarget: async (target) => target.kind === 'account' ? { account: target.account, displayName: target.account.accountId } : null,
            materializeAccount: async ({ account }) => {
                disclosedAccounts.push(account.accountId);
                return { kind: 'environment', env: { TOKEN: account.accountId } };
            },
            projectTargetAccounts: async () => { throw new Error('No listing in captured account invocation'); },
            assertTargetAccountMaterializable: async () => { throw new Error('No listed account use in captured invocation'); },
        });
        const lease = owner.activatePurposeBindings({
            subject: { kind: 'managed_provider_operation', operationId: 'managed-1', pluginId, providerLocalId: 'acquire', isCurrent: () => true },
            purposes: [purpose], bindings: [{ purpose, target: { kind: 'account', account: { service, accountId: 'captured-account' } } }],
        });
        const f = fixture({ credentialOwner: owner, reconciliation: true });
        expect(await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/inspect`,
            admittedManagedProviderOperation: { ...f.custody, role: 'inspect' }, context: { surface: 'plugin' },
        })).toMatchObject({ result: { ok: false, errorCode: 'plugin_managed_provider_operation_custody_invalid', actionHandlerInvocation: 'notStarted' } });
        expect(disclosedAccounts).toEqual([]);
        const request = { runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/acquire`, admittedManagedProviderOperation: { ...f.custody, exactPurposeBindingSubjectId: lease.subjectId, isCurrent: lease.isCurrent }, context: { surface: 'cli' as const } };
        expect(await executeContributedAction(request)).toEqual({ matched: true, result: { ok: true, result: roleResult('acquire') } });
        expect(f.materializedAccounts).toEqual(['captured-account']);
        lease.dispose();
        expect(await executeContributedAction(request)).toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
        expect(f.effects()).toBe(1);
        const authority = createManagedProviderOperationAuthority({
            materializationBaseDir: join(tmpdir(), 'unused-managed-custody-root'), purposeBindingOwner: owner,
            requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
            resolveRequestAuthHttpPort: () => 43123, createRedactionLease: () => ({ add() {}, close() {} }),
        });
        const empty = await authority.activate({ identity: purpose.consumer, operationId: 'empty-managed-operation',
            purposes: [], purposeBindings: { v: 1, bindings: [] }, requestAuthUses: [], isCurrent: () => true,
            managedOperation: { role: 'acquire', isCurrent: () => true },
        });
        try {
            expect(await executeContributedAction({ ...request, admittedManagedProviderOperation: {
                ...f.custody, isCurrent: empty.isCurrent,
                ...(empty.exactPurposeBindingSubjectId ? { exactPurposeBindingSubjectId: empty.exactPurposeBindingSubjectId } : {}),
            } })).toMatchObject({ result: { ok: false } });
            expect(disclosedAccounts).toEqual(['captured-account']);
        } finally { await empty.cleanup(); }
        const probePurpose = { consumer: { pluginId, localId: 'check' }, purpose: 'upstream' };
        const probe = await authority.activate({ identity: probePurpose.consumer, operationId: 'initial-check',
            purposes: [probePurpose], purposeBindings: { v: 1, bindings: [{ purpose: probePurpose, target: { kind: 'account', account: { service, accountId: 'captured-check-account' } } }] },
            requestAuthUses: [], isCurrent: () => true, managedOperation: { role: 'check', isCurrent: () => true },
        });
        try {
            const probeBinding = { exactPurposeBindingSubjectId: probe.exactPurposeBindingSubjectId!, isCurrent: probe.isCurrent };
            expect(await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/check`, admittedConnectedAccountPurposeBinding: probeBinding, context: { surface: 'plugin' } })).toMatchObject({ result: { ok: true, result: roleResult('check') } });
            expect(f.materializedAccounts).toContain('captured-check-account');
            expect(await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/acquire`, admittedConnectedAccountPurposeBinding: probeBinding, context: { surface: 'plugin' } })).toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
            await probe.cleanup();
            expect(await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/check`, admittedConnectedAccountPurposeBinding: probeBinding, context: { surface: 'plugin' } })).toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
        } finally { await probe.cleanup(); }
        const inspectPurpose = { consumer: { pluginId, localId: 'inspect' }, purpose: 'upstream' };
        stored = { v: 1, bindings: [...stored.bindings, { purpose: inspectPurpose, target: selected }] };
        const inspection = await authority.activate({ identity: inspectPurpose.consumer, operationId: 'retained-inspect',
            purposes: [inspectPurpose], purposeBindings: { v: 1, bindings: [{ purpose: inspectPurpose, target: { kind: 'account', account: { service, accountId: 'captured-inspect-account' } } }] },
            requestAuthUses: [], isCurrent: () => true, managedOperation: { role: 'inspect', isCurrent: () => true },
        });
        try {
            expect(await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/inspect`, admittedManagedProviderOperation: {
                ...f.custody, role: 'inspect', exactPurposeBindingSubjectId: inspection.exactPurposeBindingSubjectId!, isCurrent: inspection.isCurrent,
            }, context: { surface: 'plugin' } })).toMatchObject({ result: { ok: true, result: roleResult('inspect') } });
            expect(f.materializedAccounts).toContain('captured-inspect-account');
            expect(disclosedAccounts).not.toContain('new-default');
        } finally { await inspection.cleanup(); }
        const reconcilePurpose = { consumer: { pluginId, localId: 'reconcile' }, purpose: 'upstream' };
        stored = { v: 1, bindings: [...stored.bindings, { purpose: reconcilePurpose, target: selected }] };
        const reconciliation = await authority.activate({ identity: reconcilePurpose.consumer, operationId: 'retained-reconcile',
            purposes: [reconcilePurpose], purposeBindings: { v: 1, bindings: [{ purpose: reconcilePurpose, target: { kind: 'account', account: { service, accountId: 'captured-reconcile-account' } } }] },
            requestAuthUses: [], isCurrent: () => true, managedOperation: { role: 'reconcile', isCurrent: () => true },
        });
        const reconcileRequest = { runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/reconcile`, admittedManagedProviderOperation: {
            ...f.custody, role: 'reconcile' as const, exactPurposeBindingSubjectId: reconciliation.exactPurposeBindingSubjectId!, isCurrent: reconciliation.isCurrent,
        }, context: { surface: 'plugin' as const } };
        try {
            expect(await executeContributedAction(reconcileRequest)).toMatchObject({ result: { ok: true, result: roleResult('reconcile') } });
            expect(f.materializedAccounts).toContain('captured-reconcile-account');
            expect(disclosedAccounts).not.toContain('new-default');
            await reconciliation.cleanup();
            expect(await executeContributedAction(reconcileRequest)).toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
        } finally { await reconciliation.cleanup(); }
    });
    it.each(roles)('refuses direct %s without managed custody before demand or native IO', async (role) => {
        const f = fixture({ cold: true });
        for (const callerPluginId of [pluginId, 'acme.other']) {
            const result = await executeContributedAction({
                runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/${roleActionId(role)}`,
                context: { surface: 'plugin', caller: {
                    kind: 'plugin', pluginId: callerPluginId,
                    contribution: { id: 'caller', qualifiedId: `${callerPluginId}/caller` },
                    occurrenceId: f.custody.contribution.occurrenceId, sourceCustody: createManagedPluginSourceCustody('caller-generation'),
                } },
            });
            expect(result).toMatchObject({ matched: true, result: { ok: false, errorCode: 'plugin_managed_provider_operation_custody_invalid', actionHandlerInvocation: 'notStarted' } });
        }
        expect(f.effects()).toBe(0);
        expect(f.activations()).toBe(0);
    });

    it('executes an approved current host operation and preserves ordinary read-only Actions', async () => {
        const f = fixture({ cold: true, dangerous: true });
        const result = await executeContributedAction({
            runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/acquire`,
            admittedManagedProviderOperation: f.custody,
            requestCurrentIntent: async ({ fingerprint }) => ({ status: 'approved', fingerprint }),
            context: { surface: 'cli' },
        });
        expect(result).toEqual({ matched: true, result: { ok: true, result: roleResult('acquire') } });
        const readFixture = fixture();
        for (const localId of ['check', 'options', 'inspect', 'ordinary']) {
            expect(await executeContributedAction({ runtimeRegistry: readFixture.runtimeRegistry, actionId: `${pluginId}/${localId}`, context: { surface: 'cli' } })).toMatchObject({ result: { ok: true, result: roleResult(localId) } });
        }
        expect(f.effects()).toBe(1);
        expect(f.activations()).toBe(1);
        expect(readFixture.effects()).toBe(4);
    });

    it('refuses custody retired while the native module loads', async () => {
        let current = true;
        const f = fixture({ cold: true, afterActivation: () => { current = false; } });
        expect(await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/acquire`, admittedManagedProviderOperation: { ...f.custody, isCurrent: () => current }, context: { surface: 'cli' } })).toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
        expect(f.activations()).toBe(1);
        expect(f.effects()).toBe(0);
    });

    it('admits native bootstrap transport and lifecycle IO only for their bound roles', async () => {
        const f = fixture();
        for (const role of ['bootstrap', 'exec', 'putFile', 'power', 'destroy'] as const) {
            expect(await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/${roleActionId(role)}`, admittedManagedProviderOperation: { ...f.custody, role }, context: { surface: 'cli' } })).toMatchObject({ result: { ok: true, result: roleResult(roleActionId(role)) } });
        }
        expect(f.effects()).toBe(5);
        for (const role of ['check', 'options', 'inspect'] as const) {
            expect(await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/${role}`, admittedManagedProviderOperation: { ...f.custody, role }, context: { surface: 'cli' } })).toMatchObject({ result: { ok: true, result: roleResult(role) } });
        }
    });

    it('refuses stale row/controller/intent, mismatched role or contribution, and retired occurrence', async () => {
        const f = fixture();
        const invalid = [
            { ...f.custody, isCurrent: () => false },
            { ...f.custody, role: 'destroy' as const },
            { ...f.custody, contribution: { ...f.custody.contribution, localId: 'other' } },
            { ...f.custody, contribution: { ...f.custody.contribution, occurrenceId: 'retired' } },
        ];
        for (const custody of invalid) {
            expect(await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/acquire`, admittedManagedProviderOperation: custody, context: { surface: 'cli' } })).toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
        }
        expect(f.effects()).toBe(0);
    });

    it('rechecks custody after approval and after a host custody transition awaits', async () => {
        for (const phase of ['approval', 'transition'] as const) {
            const f = fixture({ dangerous: true });
            let current = true;
            const result = await executeContributedAction({
                runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/acquire`,
                admittedManagedProviderOperation: { ...f.custody, isCurrent: async () => current },
                requestCurrentIntent: async ({ fingerprint }) => { if (phase === 'approval') current = false; return { status: 'approved', fingerprint }; },
                context: { surface: 'cli', beforeHandlerInvocation: async () => { if (phase === 'transition') current = false; } },
            });
            expect(current).toBe(false);
            expect(result).toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
            expect(f.effects()).toBe(0);
        }
    });

    it('rejects a prepared operation when its managed row or occurrence retires before running', async () => {
        const f = fixture();
        let current = true;
        let prepared: Parameters<NonNullable<Parameters<typeof executeContributedAction>[0]['context']['capturePreparedInvocation']>>[0] | undefined;
        await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/acquire`, admittedManagedProviderOperation: { ...f.custody, isCurrent: () => current }, context: { surface: 'cli', capturePreparedInvocation: (value) => { prepared = value; } } });
        expect(prepared).toBeDefined();
        current = false;
        expect(await prepared!.run()).toMatchObject({ ok: false, actionHandlerInvocation: 'notStarted' });
        expect(f.effects()).toBe(0);
    });
});
