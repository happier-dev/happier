import type { QualifiedConnectedAccountPurposeV1, QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import type { PluginContributionRef } from '../../plugins/registration/contracts.js';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { isMachineProvisionerCredentialPurposeRequiredV1,
    type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ManagedMachineControllerError } from './controllerErrors.js';

/** Both hosts join their selected role declaration to the already admitted launch selections. */
export function bindManagedMachineRoleCredentials<T extends Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1; serviceRefs: readonly PluginContributionRef[];
}>>(input: Readonly<{
    authorizations: readonly T[];
    provider: PluginContributionRef;
    credentials: ManagedMachineV1['launch']['credentials'];
    qualification?: Readonly<{ descriptor: MachineProvisionerContributionV1; launch: unknown }>;
}>): Array<T & { credential: NonNullable<ManagedMachineV1['launch']['credentials']>[number] }> {
    const { qualification } = input;
    return input.authorizations.filter(authorization => !qualification || isMachineProvisionerCredentialPurposeRequiredV1(
        qualification.descriptor, authorization.purpose.purpose, qualification.launch)).map(authorization => {
        const matches = input.credentials?.filter(credential => credential.purpose.consumer.pluginId === input.provider.pluginId
            && credential.purpose.consumer.localId === input.provider.localId
            && credential.purpose.purpose === authorization.purpose.purpose) ?? [];
        const credential = matches[0];
        if (matches.length !== 1 || !credential || 'account' in credential && !authorization.serviceRefs.some(service =>
            service.pluginId === credential.account.service.pluginId && service.localId === credential.account.service.localId)) {
            throw new ManagedMachineControllerError('credential_unavailable');
        }
        return { ...authorization, credential };
    });
}

/** Each role consumes the exact selected launch credential through its own declared purpose. */
export function projectManagedMachineRolePurposeBindingsV1(authorizations: readonly Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    credential: NonNullable<ManagedMachineV1['launch']['credentials']>[number];
}>[]): QualifiedConnectedAccountPurposeBindingsV1 {
    const bindings = authorizations.flatMap(({ purpose, credential }) => 'account' in credential
        ? [{ purpose, target: { kind: 'account' as const, account: credential.account } }] : []);
    const teamResourceSelections = authorizations.flatMap(({ purpose, credential }) => 'account' in credential
        ? [] : [{ purpose, teamId: credential.teamId, selection: credential.selection }]);
    return { v: 1, bindings, ...(teamResourceSelections.length ? { teamResourceSelections } : {}) };
}

export function readManagedMachineRoleCredentialConfigurationsV1(authorizations: readonly Readonly<{
    credential: NonNullable<ManagedMachineV1['launch']['credentials']>[number];
}>[]) {
    return authorizations.flatMap(({ credential }) => !('account' in credential) || credential.configurationRevision === undefined
        ? [] : [{ account: credential.account, revision: credential.configurationRevision }]);
}
