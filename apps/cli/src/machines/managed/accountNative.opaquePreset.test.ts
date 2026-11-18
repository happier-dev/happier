import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createPluginAccountBundledSelectionV1, resolvePluginAccountExecutionSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { LIMA_PLUGIN } from '@happier-dev/plugins-machine-lima/manifest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { fixture as managedFixture, roleInput } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createCliManagedAccountNativeInvocation, createCliManagedAccountNativeInvocationForLaunch, resolveCliManagedAccountProvisioner } from './accountNative';

const input = { homeId: 'home', managedId: 'managed', expectedRevision: 1,
    when: 'now' as const, intent: 'start' as const };
const requestId = 'opaque-account-control';

function opaqueAccountNativeFixture() {
    const fixture = managedFixture({ nativeTransport: true });
    const bundled = createPluginAccountBundledSelectionV1({ packageName: '@fixture/acme-compute', manifest: fixture.manifest });
    const selected = resolvePluginAccountExecutionSelectionV1({ pluginId: fixture.manifest.id, intentRead: null, bundled });
    if (selected.kind !== 'available') throw new Error('Fixture Account declaration must be available');
    const declared = fixture.manifest.contributes.machineProvisioners[0];
    if (!declared) throw new Error('Fixture must declare a provisioner');
    const provider = { pluginId: fixture.manifest.id, localId: declared.id };
    const launch = { provider, schemaVersion: declared.schemaVersion, name: 'private-launch-name',
        choices: { image: 'private-image', location: 'private-place', size: 'private-size' } };
    const machine = ManagedMachineFullV1Schema.parse({
        id: input.managedId, homeId: input.homeId, custodianAccountId: 'owner',
        preset: { id: 'preset', revision: 1, contentEncryptionMode: 'e2ee' }, launch,
        allocation: 'bound', creationState: 'active', desired: input.intent, desiredWhen: input.when, intentRevision: input.expectedRevision,
        resource: { contributionRef: provider, schemaVersion: declared.schemaVersion, value: { native: 'private-native' } },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        reviewedFacts: { launch, provisioner: declared, optionStatus: 'current', prerequisites: [], billing: declared.billing,
            retentionCapabilities: declared.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
    });
    return { machine, selected, provisioner: resolveCliManagedAccountProvisioner(machine, selected) };
}

describe('CLI Account opaque preset native roles', () => {
    it.each([
        { originalMachineId: undefined, member: false },
        { originalMachineId: 'original-host', member: false },
        { originalMachineId: 'original-host', member: true },
    ])('runs original-host Archive cleanup only with retained custodian placement ($originalMachineId/member=$member)', async ({ originalMachineId, member }) => {
        const manifest = PluginManifestV2Schema.parse(LIMA_PLUGIN.manifest);
        const selected = resolvePluginAccountExecutionSelectionV1({ pluginId: manifest.id, intentRead: null,
            bundled: createPluginAccountBundledSelectionV1({ packageName: '@happier-dev/plugins-machine-lima', manifest }) });
        if (selected.kind !== 'available') throw new Error('Expected the bundled Account selection');
        const provisioner = manifest.contributes.machineProvisioners[0];
        if (!provisioner?.preparation) throw new Error('Expected Lima preparation roles');
        const launch = { provider: { pluginId: manifest.id, localId: provisioner.id }, schemaVersion: provisioner.schemaVersion,
            choices: {} };
        const credentialConfigurations = [{ account: { service: { pluginId: 'acme.accounts', localId: 'cloud' }, accountId: 'original-account' },
            revision: 'original-configuration' }];
        const archiveInput = { homeId: 'home', id: 'preset', expectedRevision: 7 };
        const observed: unknown[] = [];
        const executor = createActionExecutor({
            prepareHostReviewedChildren: async request => request.actionId !== 'machines.presets.archive' ? null : {
                children: [{ action: { pluginId: launch.provider.pluginId, localId: provisioner.preparation!.actions.inspect }, role: 'preparationInspect' },
                    { action: { pluginId: launch.provider.pluginId, localId: provisioner.preparation!.actions.destroy }, role: 'preparationDestroy' }],
                executeAdmittedAction: async ({ context }) => {
                    const invoke = createCliManagedAccountNativeInvocationForLaunch({ launch,
                        provisioner, selected, context, requestId, credentialConfigurations, ...{ originalMachineId } });
                    await invoke('preparationInspect', { nativeOperation: { native: 'original-image' } });
                    await invoke('preparationDestroy', { nativeOperation: { native: 'original-image' } });
                    return { ok: true, result: { kind: 'refused', code: 'managed_not_found' } };
                },
            },
            routeHostChildAction: async ({ actionId, input: childInput, context }) => {
                expect(readHostReviewedChildOperationV1(context, actionId, childInput)?.parent)
                    .toEqual({ actionId: 'machines.presets.archive', input: archiveInput });
                expect(context.invocationServices).not.toHaveProperty('managedMachine');
                expect(context.invocationServices).not.toHaveProperty('managedBootstrapCredential');
                expect(context.invocationServices?.connectedAccountPurposeBinding).toMatchObject({
                    managedOperation: { credentialConfigurations },
                });
                observed.push(childInput);
                return { ok: true, result: { kind: 'confirmed' } };
            },
        });
        const result = await executor.execute('machines.presets.archive', archiveInput, {
            surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: member ? 'member' : 'owner',
            runtimeActionMachineId: 'original-host',
            ...(member ? { externalActionTarget: { kind: 'machine' as const, machineId: 'original-host' } } : {}),
            ...(member ? { externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({
                v: 1, token: 'member-archive-admission', binding: { accountId: 'member', custodianAccountId: 'owner',
                    authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
                    serverIdentityId: 'home', machineId: 'original-host', installationId: 'owner-installation',
                    actionId: 'machines.presets.archive', requestId, requestEnvelopeDigest: 'a'.repeat(43),
                    target: { kind: 'machine', machineId: 'original-host' }, admittedMachineRole: 'use',
                    presetPreparationAdmission: archiveInput,
                },
            }) } : {}),
            actionRequestId: requestId,
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                ...(member ? { approvalWaivedSurfaces: { 'machines.presets.archive': ['cli'] } } : {}) }),
            presentUserConfirmation: { actionId: 'machines.presets.archive',
                inputDigest: computeActionInputApprovalDigestV1('machines.presets.archive', archiveInput), requestId,
                accountId: member ? 'member' : 'owner', serverId: 'home' },
        });
        expect(result, JSON.stringify(result)).toMatchObject(member ? { ok: false, errorCode: 'credential_scope_denied' } : originalMachineId
            ? { ok: true, result: { kind: 'refused', code: 'managed_not_found' } }
            : { ok: false, errorCode: 'controller_unavailable' });
        if (member) {
            expect(result).toMatchObject({ failureCause: { nativeErrorReason: 'prepared_image_custodian_required' } });
            if (result.ok) throw new Error('Expected Archive refusal');
            expect(result.error).toContain('original-host');
            expect(result.error).toContain('owner');
        }
        expect(observed).toHaveLength(originalMachineId && !member ? 2 : 0);
    });

    it('routes opened power, resize, and diagnostics roles through the reviewed host child without exposing the opened machine', async () => {
        const { machine, selected, provisioner } = opaqueAccountNativeFixture();
        const routed: string[] = [];
        const executor = createActionExecutor({
            managedMachineAction: async ({ context }) => {
                const invoke = createCliManagedAccountNativeInvocation({ machine, provisioner, selected, context, requestId });
                await invoke('power', roleInput('power'));
                await invoke('resize', roleInput('resize'));
                await invoke('exec', roleInput('exec'));
                return { kind: 'accepted', managedId: machine.id, intentRevision: machine.intentRevision + 1 };
            },
            // The selected Account plugin runtime is the external process boundary.
            // Child admission, role selection, and host routing remain production code.
            routeHostChildAction: async ({ actionId, input: childInput, context }) => {
                routed.push(actionId);
                expect(actionId).toBe('action.invoke');
                expect(readHostReviewedChildOperationV1(context, actionId, childInput)?.parent)
                    .toEqual({ actionId: 'machines.managed.power.set', input });
                expect(JSON.stringify(childInput)).not.toContain('private-launch-name');
                expect(JSON.stringify(childInput)).not.toContain('private-image');
                expect(JSON.stringify(childInput)).not.toContain('private-place');
                expect(JSON.stringify(childInput)).not.toContain('private-size');
                expect(JSON.stringify(childInput)).not.toContain('private-native');
                return { ok: true, result: { kind: 'confirmed' } };
            },
        });

        const result = await executor.execute('machines.managed.power.set', input, {
            surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'owner',
            actionRequestId: requestId, externalActionTarget: { kind: 'machine', machineId: 'account-host' },
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
            presentUserConfirmation: { actionId: 'machines.managed.power.set',
                inputDigest: computeActionInputApprovalDigestV1('machines.managed.power.set', input), requestId,
                accountId: 'owner', serverId: 'home', target: { kind: 'machine', machineId: 'account-host' } },
        });

        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'accepted', managedId: machine.id, intentRevision: 2 } });
        expect(JSON.stringify(result)).not.toContain('private-launch-name');
        expect(JSON.stringify(result)).not.toContain('private-image');
        expect(JSON.stringify(result)).not.toContain('private-place');
        expect(JSON.stringify(result)).not.toContain('private-size');
        expect(JSON.stringify(result)).not.toContain('private-native');
        expect(routed).toEqual(['action.invoke', 'action.invoke', 'action.invoke']);
    });

    it('fails closed rather than invoking an opaque preset role without the admitted parent port', async () => {
        const { machine, selected, provisioner } = opaqueAccountNativeFixture();
        const invoke = createCliManagedAccountNativeInvocation({ machine, provisioner, selected, requestId,
            context: { surface: 'cli', actionRequestId: requestId } });

        await expect(invoke('power', roleInput('power'))).rejects.toMatchObject({ code: 'admission_unavailable' });
    });
});
