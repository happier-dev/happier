import type { PluginAccountExecutionSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import type { MachineProvisionersListResultV1, MachineProvisionerContributionV1, MachineProvisionerCheckResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ManagedMachineActionOutputSchemasV1,
    type ManagedAcquireInputV1, type ManagedMachineActionInputV1, type ManagedMachineActionOutputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorDeps, HostReviewedChildrenPlanV1 } from '@happier-dev/protocol/actions/executor/types';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { readMachineProvisionerActionRolesV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

export type ManagedProvisionerDiscoveryAction = 'machines.provisioners.list' | 'machines.provisioners.check' | 'machines.provisioners.options';
export type ManagedProvisionerDiscoveryEntry = MachineProvisionersListResultV1['provisioners'][number];
export type ManagedProvisionerSelectionRead = (pluginId: string) => Promise<readonly ManagedProvisionerDiscoveryEntry[] | null>;

export function readMachineProvisionerHostAvailability(input: Readonly<{
    host: 'browser' | 'native'; provisioner: Pick<MachineProvisionerContributionV1, 'browserReachable'>;
}>): Pick<MachineProvisionerCheckResultV1, 'available' | 'code'> {
    return input.host === 'browser' && input.provisioner.browserReachable !== true
        ? { available: false, code: 'provider_unavailable' } : { available: true };
}

/** Account declaration custody already includes bundled and explicitly selected releases. */
export function projectAccountManagedProvisioners(
    selections: readonly Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>[],
): readonly ManagedProvisionerDiscoveryEntry[] {
    return selections.flatMap(selection => (selection.manifest.contributes.machineProvisioners ?? []).map(descriptor => ({
            contribution: { pluginId: selection.manifest.id, localId: descriptor.id },
            occurrenceId: selection.custodyId,
            // Manifest admission already proved every role is an Account or daemon Action.
            acquireExecutionTarget: selection.manifest.contributes.actions!.find(action => action.id === descriptor.actions.acquire)!
                .execution.target as ManagedProvisionerDiscoveryEntry['acquireExecutionTarget'],
            descriptor,
        })));
}

/** Account roles use selected Account declarations; native roles retain the controller's registry owner. */
export async function prepareManagedAcquireProvisionerAdmissionV1(
    request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
    readSelected: ManagedProvisionerSelectionRead,
): Promise<ActionExecuteFailure | null> {
    if (request.actionId !== 'machines.managed.acquire'
        || resolveActionExecutionPlacementForInput(getActionSpec(request.actionId), request.input) !== 'account') return null;
    const facts = (request.input as ManagedAcquireInputV1).reviewedFacts;
    if (!facts?.provisioner) return null;
    return await matchesSelectedProvisioner(facts.launch.provider, facts.provisioner, readSelected) ? null
        : { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
}

async function matchesSelectedProvisioner(provider: ManagedProvisionerDiscoveryEntry['contribution'],
    descriptor: MachineProvisionerContributionV1, readSelected: ManagedProvisionerSelectionRead): Promise<boolean> {
    const entries = await readSelected(provider.pluginId);
    const selected = entries?.find(entry => sameStrictJsonValue(entry.contribution, provider));
    return Boolean(selected && sameStrictJsonValue(selected.descriptor, descriptor));
}

/** Review facts name roles only; a denied read leaves control permission to Home admission. */
export async function prepareManagedPowerProvisionerAdmissionV1(machine: ManagedMachineV1 | ActionExecuteFailure,
    readSelected: ManagedProvisionerSelectionRead,
    actionId: 'machines.managed.power.set' | 'machines.managed.inspect' | 'machines.managed.bootstrap.retry'
        | 'machines.managed.delete' | 'machines.managed.cancel' = 'machines.managed.power.set',
): Promise<HostReviewedChildrenPlanV1 | ActionExecuteFailure | null> {
    if ('ok' in machine) return machine.errorCode === 'permission_denied' ? { children: [] } : machine;
    if (machine.controller) return null;
    const provisioner = machine.reviewedFacts?.provisioner;
    if (!provisioner || !await matchesSelectedProvisioner(machine.launch.provider, provisioner, readSelected))
        return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
    return { children: readMachineProvisionerActionRolesV1(provisioner)
        .filter(({ role }) => actionId === 'machines.managed.power.set' ? role === 'power' || role === 'inspect'
            : actionId === 'machines.managed.delete' || actionId === 'machines.managed.cancel' ? role === 'destroy' || role === 'inspect' || role === 'cleanup' || role === 'reconcile'
            : actionId === 'machines.managed.inspect' ? role === 'inspect' || role === 'reconcile'
            : role === 'acquire' || role === 'bootstrap' || role === 'inspect' || role === 'reconcile'
                || role === 'exec' || role === 'putFile')
        .map(({ action, role }) => ({ action: { pluginId: machine.launch.provider.pluginId, localId: action }, role })) };
}

/** Shared discovery semantics; each host supplies its existing catalog and invocation adapter. */
export async function executeManagedProvisionerDiscovery<T extends ManagedProvisionerDiscoveryAction>(input: Readonly<{
    actionId: T;
    value: ManagedMachineActionInputV1<T>;
    entries: readonly ManagedProvisionerDiscoveryEntry[];
    controller?: MachineProvisionersListResultV1['controller'];
    readCredentialPurposes?(entry: ManagedProvisionerDiscoveryEntry): Promise<ManagedProvisionerDiscoveryEntry['credentialPurposes']>;
    invoke?(entry: ManagedProvisionerDiscoveryEntry, role: 'check' | 'options', value: unknown): Promise<unknown>;
}>): Promise<ManagedMachineActionOutputV1<T>> {
    const parsed = input.value;
    if (input.actionId === 'machines.provisioners.list') {
        const requested = 'contribution' in parsed ? parsed.contribution : undefined;
        const selected = input.entries.filter(entry => !requested || entry.contribution.pluginId === requested.pluginId
            && entry.contribution.localId === requested.localId);
        const provisioners = await Promise.all(selected.map(async entry => {
            const credentialPurposes = await input.readCredentialPurposes?.(entry);
            return credentialPurposes === undefined ? entry : { ...entry, credentialPurposes };
        }));
        const result = {
            ...(input.controller ? { controller: input.controller } : {}), provisioners,
        } satisfies MachineProvisionersListResultV1;
        return result as ManagedMachineActionOutputV1<T>;
    }
    const requested = 'contribution' in parsed ? parsed.contribution : undefined;
    const entry = input.entries.find(candidate => candidate.contribution.pluginId === requested?.pluginId
        && candidate.contribution.localId === requested.localId);
    const role = input.actionId === 'machines.provisioners.check' ? 'check' : 'options';
    if (!entry || !entry.descriptor.actions[role] || !input.invoke) throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
    const result = await input.invoke(entry, role, role === 'options' && 'selectors' in parsed ? parsed.selectors ?? {} : {});
    return ManagedMachineActionOutputSchemasV1[input.actionId].parse(result) as ManagedMachineActionOutputV1<T>;
}
