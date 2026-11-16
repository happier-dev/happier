import { createActionPurposeBindingAdmission } from '@/daemon/connectedServices/purposeBindings/teamDirectMaterialAdmission';
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
import { machineProvisionerAuthorFixture, createMachineProvisionerPreparationAuthorFixture } from '../../../../../../../packages/plugin-sdk/fixtures/authoring-inference/machineProvisioners';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { activateContributionModule } from '@/plugins/runtime/lifecycle/activation/activateContributionModule';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createTargetActionInvocationRegistry, type TargetActionInvocationRegistration } from '../targetActionRegistry';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createUnavailablePluginServicesFactory } from '../services/factory';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedOpaquePresetMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createCommittedContributedActionInvoker } from './createCommittedContributedActionDeps';

function executeContributedAction(request: Parameters<typeof dispatchContributedAction>[0]) {
    const localId = String(request.actionId).split('/').at(-1)!;
    return dispatchContributedAction({ ...request, input: request.input ?? roleInput(localId) });
}

describe('managed native-role custody at contributed dispatch', () => {
    it.each(['prepare-build', 'prepare-destroy'] as const)('refuses an ordinary native %s without the admitted Prepare parent', async localId => {
        const manifest = normalizePluginManifestV2(createMachineProvisionerPreparationAuthorFixture().manifest);
        let effects = 0;
        const f = fixture({ fixtureManifest: manifest, credentialPurposes: [],
            actionHandlers: new Map(manifest.contributes.actions.map(action => [action.id, async () => {
                effects++;
                throw new Error('An unadmitted preparation must not execute');
            }])) });
        const provider = { pluginId: manifest.id, localId: manifest.contributes.machineProvisioners[0]!.id };
        const input = localId === 'prepare-build' ? { operationId: 'unadmitted', input: { name: 'base' } }
            : { artifact: { contributionRef: provider, schemaVersion: 1, value: { launch: { name: 'base' } } } };
        const result = await executeContributedAction({ runtimeRegistry: f.runtimeRegistry,
            actionId: `${manifest.id}/${localId}`, input, context: { surface: 'plugin' } });
        expect(result).toMatchObject({ result: { ok: false, errorCode: 'plugin_managed_provider_operation_custody_invalid',
            actionHandlerInvocation: 'notStarted' } });
        expect(effects).toBe(0);
    });
    it.each(['selected', 'foreign', 'absent', 'opaque', 'team', 'team-brokered', 'team-brokered-foreign'] as const)('uses the reviewed Account power credential without a controller (%s binding)', async scenario => {
        const service = { pluginId: 'acme.accounts', localId: 'cloud' };
        const team = scenario.startsWith('team');
        const brokered = scenario.startsWith('team-brokered');
        const disclosed: string[] = [];
        const owner = createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: async mutate => mutate({ v: 1, bindings: [] }), subscribe: () => ({ dispose() {} }) },
            selectTarget: async () => ({ kind: 'account', account: { service, accountId: 'mutable-default' } }),
            resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: target.account.accountId } : null,
            materializeAccount: async ({ account }) => { disclosed.push(account.accountId); return { kind: 'environment', env: { TOKEN: account.accountId } }; },
            projectTargetAccounts: async () => { throw new Error('No account listing'); },
            assertTargetAccountMaterializable: async () => { throw new Error('No listed account use'); },
        });
        const base = fixture({ credentialOwner: owner });
        const manifest = normalizePluginManifestV2({ ...base.manifest, contributes: { ...base.manifest.contributes,
            actions: base.manifest.contributes.actions.map(action => ({ ...action,
                execution: { target: 'account', account: { artifactId: 'native', exportName: 'activate' } } })),
        } });
        const reference = normalizePluginManifestV2({ schemaVersion: 2, id: service.pluginId, version: '1.0.0', displayName: 'Cloud', runtime: { apiVersion: 1 },
            contributes: { connectedAccountDescriptors: [{ id: service.localId, title: 'Cloud', authentication: { defaultModeId: 'token', modes: [{
                id: 'token', kind: 'manual', outcomeReconciliation: 'none', fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
            }] } }] } });
        let teamEffects = 0;
        const f = fixture({ fixtureManifest: manifest, executionRealm: 'account', credentialOwner: owner, referenceManifests: [reference],
            ...(team ? { actionHandlers: new Map(manifest.contributes.actions.map(action => [action.id, async () => {
                if (action.id === 'power') teamEffects++;
                return roleResult(action.id);
            }])) } : {}),
            nativeRoleResults: { inspect: { observedAt: 2, availability: 'present', power: 'running', storage: 'retained' } } });
        const provider = { pluginId, localId: 'vm' };
        const teamSelection = brokered ? { source: 'team_resource' as const, resourceId: 'shared-cloud', deliveryMode: 'brokered' as const }
            : { source: 'team_resource' as const, resourceId: 'shared-cloud', deliveryMode: 'direct' as const,
                disclosedMember: { service, accountId: 'sharer-private' } };
        const launch: ManagedMachineV1['launch'] = { provider, schemaVersion: 1, name: 'Retained', choices: {}, credentials: [{
            purpose: { consumer: provider, purpose: 'upstream' },
            ...(team ? { teamId: 'team-a', selection: teamSelection } : { account: { service, accountId: 'selected-account' } }),
        }] };
        const fullMachine: ManagedMachineV1 = { id: 'managed-1', homeId: 'home-1', custodianAccountId: 'owner', launch,
            allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 3,
            resource: { contributionRef: provider, schemaVersion: 1, value: {} }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true };
        const machine = scenario === 'opaque' ? ManagedOpaquePresetMachineV1Schema.parse({ ...fullMachine,
            launch: undefined, resource: undefined, preset: { id: 'preset', revision: 1, contentEncryptionMode: 'e2ee' },
        }) : fullMachine;
        const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation', actionRequestId: 'original',
            operationAcceptance: { operationId: 'original-operation', accept() {} } };
        let directOpens = 0;
        let brokerEffects = 0;
        const admitActionPurposeBindings = createActionPurposeBindingAdmission({ activatePurposeBindings: owner.activatePurposeBindings,
            // The remote Action transport is the boundary; local custody and routing remain real.
            executeTeamCredentialBrokerAction: async () => { brokerEffects++; return { ok: true, result: roleResult('power') }; },
            openTeamDirect: async () => { directOpens++; return { ok: true, payload: { v: 1,
                domain: 'happier.team-credential-direct-material', homeServerIdentityId: 'home-1', teamId: 'team-a',
                resourceId: 'shared-cloud', resourceRevision: 1, recipientAccountId: 'recipient',
                sourceMember: { kind: 'connected_account', service, connectedAccountId: 'sharer-private' }, sourceVersion: 'source-v1',
                material: { kind: 'qualified_connected_account', credential: { v: 1, values: { token: 'shared-token' } },
                    configuration: null, authenticationModeId: 'token' },
            } }; },
        });
        const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => ({ registry: f.runtimeRegistry,
            source: 'ephemeral', durableRevision: -1, release: async () => {} }), managedProviderOperationAuthority: createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
        purposeBindingOwner: { ...owner, admitActionPurposeBindings }, requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
        resolveRequestAuthHttpPort: () => 43123, createRedactionLease: () => ({ add() {}, close() {} }),
      }) });
        const port = createHostReviewedChildPortV1({ actionId: 'machines.managed.power.set', input: { homeId: machine.homeId, managedId: machine.id,
            expectedRevision: 2, intent: 'start', when: 'now' }, context, reviewAdmitted: true,
            plan: { children: ['power', 'inspect'].map(role => ({ action: { pluginId, localId: role }, role })) },
            policies: ['power', 'inspect'].map(role => ({ action: { pluginId, localId: role }, role, surface: 'cli' })),
            execute: async (body, childContext) => {
                if (!body || typeof body !== 'object' || !('action' in body) || !('input' in body)) throw new Error('Expected provider envelope');
                return invoke({ action: { pluginId, localId: 'power' }, input: body.input, context: childContext });
            } });
        const identity = { pluginId, localId: 'power' };
        const purpose = { consumer: identity, purpose: 'upstream' };
        const binding = { identity, operationId: 'original-operation', purposes: [purpose],
            purposeBindings: { v: 1 as const, bindings: team ? [] : [{ purpose, target: { kind: 'account' as const,
                account: { service, accountId: scenario === 'foreign' ? 'foreign-account' : 'selected-account' } } }],
                ...(team ? { teamResourceSelections: [{ purpose, teamId: 'team-a', selection: scenario === 'team-brokered-foreign'
                    ? { ...teamSelection, resourceId: 'foreign-cloud' } : teamSelection }] } : {}) },
            isCurrent: () => true, managedOperation: { role: 'power' as const, isCurrent: () => true } };
        const result = await port.invoke({ action: identity, role: 'power', input: { resource: {}, intent: 'start' },
            invocationServices: { managedMachine: machine, ...(scenario === 'absent' ? {} : { connectedAccountPurposeBinding: binding }) } });
        expect(result, JSON.stringify(result)).toMatchObject(scenario === 'selected' || scenario === 'team' || scenario === 'team-brokered' ? { ok: true, result: { kind: 'confirmed' } }
            : { ok: false, errorCode: 'plugin_managed_provider_operation_custody_invalid' });
        expect(disclosed).toEqual(scenario === 'selected' ? ['selected-account'] : []);
        expect(f.effects()).toBe(scenario === 'selected' ? 1 : 0);
        expect(teamEffects).toBe(scenario === 'team' ? 1 : 0);
        expect(directOpens).toBe(scenario === 'team' ? 1 : 0);
        expect(brokerEffects).toBe(scenario === 'team-brokered' ? 1 : 0);
    });
    it('delivers only the admitted acquire guest-host key through real dispatch and redacts its log echoes', async () => {
        const guestKey = 'invocation-private-generated-guest-host-key';
        const guestBytes = new TextEncoder().encode(guestKey);
        const bootstrapBytes = new TextEncoder().encode('separate-bootstrap-user-key');
        const logs: string[] = [];
        let opened: Uint8Array | undefined;
        let bootstrapReads = 0;
        const f = fixture({ bootstrapCredential: 'ssh', nativeCredentialService: true,
            invocationLogSink: { write(entry) { logs.push(JSON.stringify(entry)); } },
            async onNativeRole(role, _input, context) {
                if (role !== 'acquire') return;
                const lease = await context.services.machineProvisioners.materializeGuestHostCredential();
                opened = lease.bytes.slice();
                context.services.logger.info(new TextDecoder().decode(lease.bytes));
                // Invocation settlement, rather than the handler, owns forgotten disposal.
            },
        });
        const result = await executeContributedAction({ runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/acquire`,
            context: { surface: 'plugin' }, admittedManagedProviderOperation: { ...f.custody, role: 'acquire',
                readBootstrapCredential: async () => { bootstrapReads++; return bootstrapBytes; },
                readGuestHostCredential: async () => guestBytes },
        });
        expect(result).toMatchObject({ result: { ok: true, result: roleResult('acquire') } });
        expect(opened).toEqual(new TextEncoder().encode(guestKey));
        expect(bootstrapReads).toBe(0);
        expect(bootstrapBytes).toEqual(new TextEncoder().encode('separate-bootstrap-user-key'));
        expect(guestBytes).toEqual(new Uint8Array(guestBytes.length));
        expect(logs.join('\n')).toContain('[REDACTED]');
        expect(logs.join('\n')).not.toContain(guestKey);
        expect(JSON.stringify(result)).not.toContain(guestKey);
    });

    it('delivers the selected bootstrap credential to a trusted power role through real dispatch', async () => {
        let opened: Uint8Array | undefined;
        const material = new Uint8Array([7, 8, 9]);
        const f = fixture({ bootstrapCredential: 'native-token', nativeCredentialService: true,
            async onNativeRole(role, _input, context) {
                if (role !== 'power') return;
                const lease = await context.services.machineProvisioners.materializeBootstrapCredential({ kind: 'bytes' });
                if (lease.kind !== 'bytes') throw new Error('Expected private credential bytes');
                opened = lease.bytes.slice();
                await lease.dispose();
            },
        });
        const result = await executeContributedAction({ runtimeRegistry: f.runtimeRegistry,
            actionId: `${pluginId}/power`, context: { surface: 'plugin' },
            admittedManagedProviderOperation: { ...f.custody, role: 'power',
                readBootstrapCredential: async () => material },
        });
        const failure = result.matched && !result.result.ok ? {
            errorCode: result.result.errorCode, actionHandlerInvocation: result.result.actionHandlerInvocation,
        } : undefined;
        expect(result, JSON.stringify(failure)).toMatchObject({ result: { ok: true, result: { kind: 'confirmed' } } });
        expect(opened).toEqual(new Uint8Array([7, 8, 9]));
        expect(material).toEqual(new Uint8Array(3));
    });

    it('opens inference headers only for the admitted exact native apply binding and refuses ordinary empty replacements', async () => {
        let opened: unknown;
        const f = fixture({ nativeCredentialDelivery: true, nativeCredentialService: true,
            onNativeCredentialApply: async context => {
                opened = await context.services.machineProvisioners.materializeNativeCredentialHeaders({ bindingKey: 'binding' });
            } });
        const input = { resource: { contributionRef: { pluginId, localId: 'vm' }, schemaVersion: 1, value: {} },
            baseline: { kind: 'allow-all' }, bindings: [] };
        const request = { runtimeRegistry: f.runtimeRegistry, actionId: `${pluginId}/native-credential-apply`,
            input, context: { surface: 'plugin' as const } };
        expect(await dispatchContributedAction(request)).toMatchObject({ result: { ok: false,
            errorCode: 'plugin_managed_provider_operation_custody_invalid', actionHandlerInvocation: 'notStarted' } });
        expect(await dispatchContributedAction({ ...request, input: { ...input, bindings: [{ bindingKey: 'binding',
            destination: { host: 'example.test', port: 443 }, requests: [{ path: '/v1/responses', methods: ['POST'] }],
            placeholder: { header: 'Authorization', value: 'placeholder-test' } }] } }))
            .toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
        expect(f.effects()).toBe(0);
        const managedNativeCredentials = { role: 'nativeCredentialApply' as const, isCurrent: async () => true,
            bindings: new Map([['binding', { isCurrent: async () => true,
                readRenderedHeaders: async () => ({ ok: true as const, headers: { Authorization: 'native-test-material' } }) }]]) };
        expect(await dispatchContributedAction({ ...request,
            admittedManagedProviderOperation: { ...f.custody, role: 'nativeCredentialApply', managedNativeCredentials },
        })).toMatchObject({ result: { ok: true, result: { kind: 'confirmed' } } });
        expect(opened).toEqual({ ok: true, headers: { Authorization: 'native-test-material' } });
        expect(f.effects()).toBe(1);
        expect(await dispatchContributedAction({ ...request,
            admittedManagedProviderOperation: { ...f.custody, role: 'nativeCredentialApply', managedNativeCredentials,
                isCurrent: () => false },
        })).toMatchObject({ result: { ok: false, actionHandlerInvocation: 'notStarted' } });
        expect(f.effects()).toBe(1);
    });
    it('keeps a host read-only ceiling independent from input-sensitive confirmation defaults', async () => {
        const f = fixture({ dangerous: true });
        const registry = createResolvedContributionRegistry({ actions: f.runtimeRegistry.contributes.actions.map(action => ({
            ...action, definition: { ...action.definition,
                confirmationWhen: { op: 'not' as const, predicate: { op: 'eq' as const, path: 'kind', value: 'list' } },
            },
        })) });
        const result = await dispatchContributedAction({ registry, actionId: `${pluginId}/ordinary`,
            input: { kind: 'list' }, requiredDangerLevel: 'safe', context: { surface: 'agent' },
        });
        expect(result).toMatchObject({ matched: true, result: {
            ok: false, errorCode: 'plugin_action_read_only_required', actionHandlerInvocation: 'notStarted',
        } });
        expect(f.effects()).toBe(0);
        expect(f.activations()).toBe(0);
    });

    it.each(['acquire', 'rebuild', 'reconcile'] as const)('retains known managed %s and ordinary mutation results after cancellation while refusing unissued work', async role => {
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
        expect(canceledOrdinary).toMatchObject({ result: { ok: true, result: roleResult('exec') } });
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
            isOccurrenceCurrent: () => true, manifest, moduleNamespace: { activate: machineProvisionerAuthorFixture.activate },
        });
        onTestFinished(() => activated.dispose());
        expect(activated.status).toBe('active');
        const registrations = activated.registrations.flatMap((registration): TargetActionInvocationRegistration[] => {
            if (registration.family !== 'actions') return [];
            const declaration = manifest.contributes.actions.find((action) => action.id === registration.localId)!;
            return [{ pluginId: authorPluginId, pluginVersion: manifest.version, occurrenceId,
                sourceCustody: createManagedPluginSourceCustody('public-author-fixture'), localId: registration.localId,
                definition: declaration,
                // Invoke the genuinely activated author callback at the module ABI boundary.
                handler: (input, context) => Reflect.apply(registration.value, undefined, [input, context]),
            }];
        });
        const targetActionInvocations = createTargetActionInvocationRegistry({ actions: registrations,
            readCurrentPluginOccurrenceId: () => occurrenceId,
            resolveAuthorizationFacts: () => ({ generation: { targetGeneration: occurrenceId, desiredGeneration: occurrenceId, appliedGeneration: occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [],
            }), resolveHostBinding: createTargetActionHostBindingResolver(), createServices: createUnavailablePluginServicesFactory(),
        });
        onTestFinished(() => targetActionInvocations.dispose());
        const pluginRootPath = join(tmpdir(), 'public-author-fixture');
        const sourceSpec = { kind: 'path', locator: pluginRootPath, trustPolicy: 'local_trusted', installPolicy: 'link' } as const;
        const manifestPath = join(pluginRootPath, 'plugin.json');
        const contributes = createResolvedContributionRegistry({
            ...projectLoadedPluginContributes({ loadResult: { loadedPlugins: [{
                pluginId: authorPluginId, pluginRootPath, manifestPath, sourceSpec, manifest,
                daemonEntryPath: null, devDaemonEntryPath: null,
            }], diagnosticsByPluginId: {} }, provenance: 'external' }),
            occurrenceIdsByPluginId: { [authorPluginId]: occurrenceId },
            activationTargets: [{ pluginId: authorPluginId, manifest, provenance: 'external', source: { kind: 'path' },
                manifestPath, daemonEntryPath: null, sourceSpec,
            }],
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
            store: { read: async () => stored, update: async (mutate) => (stored = mutate(stored)),
                subscribe: () => ({ dispose() {} }) },
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
        const referenceManifest = normalizePluginManifestV2({
            schemaVersion: 2, id: service.pluginId, version: '1.0.0', displayName: 'Captured accounts',
            runtime: { apiVersion: 1 }, contributes: { connectedAccountDescriptors: [{
                id: service.localId, title: 'Cloud', authentication: { defaultModeId: 'token', modes: [{
                    id: 'token', kind: 'manual', outcomeReconciliation: 'none',
                    fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
                }] },
            }] },
        });
        const f = fixture({ credentialOwner: owner, reconciliation: true, referenceManifests: [referenceManifest] });
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

    it('admits managed custody once, then reads only its local currentness before the handler', async () => {
        const f = fixture({ cold: true });
        let currentnessReads = 0;
        let roleAdmissions = 0;
        const contributes = new Proxy(f.runtimeRegistry.contributes, { get(target, key, receiver) {
            if (key === 'machineProvisioners') roleAdmissions += 1;
            return Reflect.get(target, key, receiver);
        } });
        const runtimeRegistry = new Proxy(f.runtimeRegistry, { get(target, key, receiver) {
            return key === 'contributes' ? contributes : Reflect.get(target, key, receiver);
        } });
        const result = await executeContributedAction({
            runtimeRegistry, actionId: `${pluginId}/acquire`,
            admittedManagedProviderOperation: { ...f.custody, isCurrent: () => { currentnessReads += 1; return true; } },
            context: { surface: 'cli', beforeHandlerInvocation: async () => {} },
        });
        expect(result).toEqual({ matched: true, result: { ok: true, result: roleResult('acquire') } });
        expect({ roleAdmissions, currentnessReads }).toEqual({ roleAdmissions: 1, currentnessReads: 2 });
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

    it('rechecks prepared custody after approval and after a host custody transition awaits', async () => {
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


});
