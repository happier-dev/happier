import { sameQualifiedConnectedAccountRef, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import type { PluginContributionRef } from '../../plugins/registration/contracts.js';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedMachinePresetPreparationBindingV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetPreparationV1';
import { isMachineProvisionerCredentialPurposeRequiredV1,
    type MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { ManagedMachineControllerError } from './controllerErrors.js';

/** Both hosts join their selected role declaration to the already admitted launch selections. */
export function bindManagedMachineRoleCredentials<T extends Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1; serviceRefs: readonly PluginContributionRef[];
}>>(input: Readonly<{
    authorizations: readonly T[];
    provider: PluginContributionRef;
    credentials: ManagedMachineFullV1['launch']['credentials'];
    qualification?: Readonly<{ descriptor: MachineProvisionerContributionV1; launch: unknown }>;
}>): Array<T & { credential: NonNullable<ManagedMachineFullV1['launch']['credentials']>[number] }> {
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
    credential: NonNullable<ManagedMachineFullV1['launch']['credentials']>[number];
}>[]): QualifiedConnectedAccountPurposeBindingsV1 {
    const bindings = authorizations.flatMap(({ purpose, credential }) => 'account' in credential
        ? [{ purpose, target: { kind: 'account' as const, account: credential.account } }] : []);
    const teamResourceSelections = authorizations.flatMap(({ purpose, credential }) => 'account' in credential
        ? [] : [{ purpose, teamId: credential.teamId, selection: credential.selection }]);
    return { v: 1, bindings, ...(teamResourceSelections.length ? { teamResourceSelections } : {}) };
}

export function readManagedMachineRoleCredentialConfigurationsV1(authorizations: readonly Readonly<{
    credential: NonNullable<ManagedMachineFullV1['launch']['credentials']>[number];
}>[]) {
    return authorizations.flatMap(({ credential }) => !('account' in credential) || credential.configurationRevision === undefined
        ? [] : [{ account: credential.account, revision: credential.configurationRevision }]);
}

/** Captures the current non-secret configuration basis once for each selected Account. */
export async function captureManagedMachineRoleCredentialConfigurationsV1(input: Readonly<{
    authorizations: readonly Readonly<{
        credential: NonNullable<ManagedMachineFullV1['launch']['credentials']>[number];
    }>[];
    readCredentialConfigurationRevision(account: QualifiedConnectedAccountRef, signal: AbortSignal): Promise<string | null>;
    signal: AbortSignal;
}>): Promise<ManagedMachinePresetPreparationBindingV1['credentialConfigurations']> {
    const accounts: QualifiedConnectedAccountRef[] = [];
    for (const { credential } of input.authorizations) {
        if (!('account' in credential)) continue;
        const selected = credential.account;
        if (!accounts.some(account => sameQualifiedConnectedAccountRef(account, selected))) accounts.push(selected);
    }
    return await Promise.all(accounts.map(async account => ({
        account,
        revision: await input.readCredentialConfigurationRevision(account, input.signal),
    })));
}
