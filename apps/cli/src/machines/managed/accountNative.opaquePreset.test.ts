import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { readHostReviewedChildOperationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createPluginAccountBundledSelectionV1, resolvePluginAccountExecutionSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import { fixture as managedFixture, roleInput } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createCliManagedAccountNativeInvocation, resolveCliManagedAccountProvisioner } from './accountNative';

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
