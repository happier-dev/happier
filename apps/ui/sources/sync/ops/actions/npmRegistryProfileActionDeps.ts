import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { NpmRegistryProfileActionInputSchemasV1 as inputs,
    NpmRegistryProfileActionOutputSchemasV1 as outputs } from '@happier-dev/protocol/actions/npmRegistryProfileActionFamily';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { DaemonNpmRegistryProfileMutationRequestV1Schema } from '@happier-dev/protocol/rpc/npmRegistryProfiles';
import { Modal } from '@/modal';
import { t } from '@/text';
import { describeDirectDeliveryVisibility, readDirectDeliveryVisibility } from '@/components/sessions/teamCredentials/directDeliveryDisclosure';
import { resolveFreshMachineAdministrationExecutionTarget,
    type FreshMachineAdministrationExecutionTargetV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { sameMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/operationCurrentness';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { machineNpmRegistryProfilesGet, machineNpmRegistryProfilesMutate } from '@/sync/ops/machineNpmRegistryProfiles';
import type { LazyActionAccountContext } from './actionAccountContext';
import type { DaemonNpmRegistryProfileMutationRequestV1 } from '@happier-dev/protocol/rpc/npmRegistryProfiles';

type RegistryCredential = Readonly<{ kind: 'bearer_token'; secret: string }>;
/** Incumbent mounted target and private token delivery, never serialized into an Action or approval. */
export type UiNpmRegistryProfileDelivery = Readonly<{
    resolveExecutionTarget: (target: MachineAdministrationTargetV1) => FreshMachineAdministrationExecutionTargetV1 | null;
    isCurrent: (mutationId: string) => boolean;
    acquireCredential: (mutationId: string) => Promise<RegistryCredential | null>;
}>;

/** Profile storage/CAS and credential checking remain exclusively owned by the daemon service. */
export function createUiNpmRegistryProfileAction(
    account: Pick<LazyActionAccountContext, 'serverId' | 'serverIdentityId' | 'accountId' | 'accountLifetime' | 'assertCurrent'>,
    delivery?: UiNpmRegistryProfileDelivery,
): NonNullable<ActionExecutorDeps['npmRegistryProfileAction']> {
    return async ({ actionId, input, context }) => {
        const parsed = inputs[actionId].parse(input);
        const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
        const resolve = () => delivery
            ? delivery.resolveExecutionTarget(parsed.target)
            : resolveFreshMachineAdministrationExecutionTarget(parsed.target, { accountScope: account.accountLifetime.scope });
        const selected = resolve();
        const assertCurrent = () => {
            account.assertCurrent();
            context.signal?.throwIfAborted();
            const current = resolve();
            if (parsed.target.serverIdentityId !== account.serverIdentityId || !selected || !current
                || !machineAdministrationTargetsEqual(selected.target, parsed.target)
                || !areServerProfileIdentifiersEquivalent(selected.serverId, account.serverId)
                || !sameMachineAdministrationExecutionTarget(selected, current)
                || delivery && (!('mutationId' in parsed) || typeof parsed.mutationId !== 'string' || !delivery.isCurrent(parsed.mutationId)))
                throw new Error('npm_registry_target_not_current');
        };
        try { assertCurrent(); } catch { return fail('npm_registry_target_not_current'); }
        if (!selected) return fail('npm_registry_target_not_current');
        const options = { serverId: selected.serverId, accountId: account.accountId, signal: context.signal,
            assertCurrent, onIssued: context.onTransportIssued };
        if (actionId === 'plugins.npm_registry_profiles.list') {
            const result = await machineNpmRegistryProfilesGet(selected.machine.id, options);
            assertCurrent();
            return outputs[actionId].parse(result);
        }
        const mutation = inputs[actionId].parse(input);
        let credential: Extract<DaemonNpmRegistryProfileMutationRequestV1, { action: 'login' }>['credential'] | null = null;
        if (actionId === 'plugins.npm_registry_profiles.login') {
            if ('login' in mutation && mutation.login) credential = mutation.login;
            else if (delivery) credential = await delivery.acquireCredential(mutation.mutationId);
            else {
                const secret = await Modal.prompt(t('settingsPlugins.registriesLoginTitle'),
                    [t('settingsPlugins.registriesLoginBody'), describeDirectDeliveryVisibility(readDirectDeliveryVisibility())].join('\n\n'), {
                    inputType: 'secure-text', confirmText: t('settingsPlugins.registriesLogin'), cancelText: t('common.cancel'),
                });
                if (secret?.trim()) credential = { kind: 'bearer_token', secret: secret.trim() };
            }
            try { assertCurrent(); } catch { return fail('npm_registry_target_not_current'); }
            if (!credential) return fail('approval_canceled');
        }
        // The raw RPC schema is the daemon's single mutation grammar. Its secret
        // operand is materialized only here, after policy and native acquisition.
        const publicOperands = { ...mutation };
        if ('login' in publicOperands) delete publicOperands.login;
        const { target: _target, ...operands } = publicOperands;
        const action = actionId.slice('plugins.npm_registry_profiles.'.length);
        const request = DaemonNpmRegistryProfileMutationRequestV1Schema.parse({ ...operands,
            action, machineId: selected.machine.id, ...(credential ? { credential } : {}) });
        try {
            const result = await machineNpmRegistryProfilesMutate(selected.machine.id, request, options);
            return outputs[actionId].parse(result);
        } finally {
            // Retiring the client RPC does not stop the daemon's npm web wait.
            // Its admitted Action owns explicit cleanup on the captured Machine,
            // including when the sheet or its selected Machine has changed.
            if (context.signal?.aborted && request.action === 'login'
                && request.credential.kind === 'browser' && request.credential.step === 'complete') {
                await machineNpmRegistryProfilesMutate(selected.machine.id, {
                    ...request, credential: { ...request.credential, step: 'cancel' },
                }, { serverId: selected.serverId, accountId: account.accountId }).catch(() => undefined);
            }
        }
    };
}
