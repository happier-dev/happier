import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { PET_DELETE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsPetsV1';
import { DaemonPetImportResponseV1Schema, PET_DAEMON_RPC_METHODS } from '@happier-dev/protocol/pets/daemonRpc';
import { buildAccountPetCreateRequestV1, prepareMachinePetImportV1 } from '@happier-dev/protocol/pets/importActionV1';
import { findMatchingAccountPetV1 } from '@happier-dev/protocol/pets/portablePetV1';
import { isAccountPetEncryptedLibraryEntryV1 } from '@happier-dev/protocol/pets/accountLibrary';
import type { RegistryPetAcquisitionV1 } from '@happier-dev/protocol/registries/registryPetV1';
import { createAccountPet, deleteAccountPet, listAccountPets } from '@/sync/api/pets/apiAccountPets';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { LazyActionAccountContext } from './actionAccountContext';

type PetActionAccount = Pick<LazyActionAccountContext, 'credentials' | 'serverId' | 'assertCurrent' | 'request'>;
type PetRegistry = Readonly<{ readRegistryPet: (input: Readonly<{ sourceId: string; itemId: string }>) => Promise<RegistryPetAcquisitionV1> }>;

/** The existing approval owner requests daemon validation before presenting Keep. */
export function createUiPetImportPrepare(account: PetActionAccount | null): NonNullable<ActionExecutorDeps['preparePetImport']> {
    return async ({ input, context }) => {
        if (!account) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        account.assertCurrent(); context.signal?.throwIfAborted();
        return prepareMachinePetImportV1(input, async (machineId, payload) => {
            const response = await machineRpcWithServerScope({
                serverId: account.serverId, machineId, method: PET_DAEMON_RPC_METHODS.VALIDATE_PACKAGE,
                payload, signal: context.signal,
            });
            account.assertCurrent(); context.signal?.throwIfAborted();
            return response;
        });
    };
}

/** The Account endpoint validates imports; Machine packages retain the existing daemon importer. */
export function createUiPetActionExecute(account: PetActionAccount | null,
    registry: (context: ActionExecutorContext) => Promise<PetRegistry>): NonNullable<ActionExecutorDeps['petAction']> {
    return async args => {
        if (!account) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        account.assertCurrent(); args.context.signal?.throwIfAborted();
        if (args.actionId === PET_DELETE_ACTION_ID_V1) {
            const result = await deleteAccountPet(account.credentials, args.input.accountPetId,
                { request: account.request, signal: args.context.signal });
            account.assertCurrent(); args.context.signal?.throwIfAborted();
            return result.ok ? { ok: true, result } : result;
        }
        const source = args.input.source;
        if (source.kind === 'machine') {
            const result = DaemonPetImportResponseV1Schema.parse(await machineRpcWithServerScope({
                serverId: account.serverId, machineId: source.machineId, method: PET_DAEMON_RPC_METHODS.IMPORT_ACCOUNT_PACKAGE,
                payload: { ...(source.packagePath ? { packagePath: source.packagePath } : {}),
                    ...(source.sourceKey ? { sourceKey: source.sourceKey } : {}) }, signal: args.context.signal,
            }));
            account.assertCurrent(); args.context.signal?.throwIfAborted();
            if (!result.ok) return { ...result, ...('validation' in result && result.validation ? { details: { validation: result.validation } } : {}) };
            if (result.target !== 'account') return { ok: false, errorCode: 'invalid_response', error: 'Unexpected pet import target.' };
            // The daemon opens sealed E2EE responses; an unopened entry is never presented as a pet.
            if (result.account.ok && isAccountPetEncryptedLibraryEntryV1(result.account.pet)) {
                return { ok: false, errorCode: 'invalid_response', error: 'Unexpected sealed pet entry.' };
            }
            return result.account.ok ? { ok: true, result: { pet: result.account.pet,
                ...(result.account.reused ? { reused: true } : {}) } } : result.account;
        }
        if (source.kind === 'registry') {
            const library = await listAccountPets(account.credentials, { request: account.request });
            account.assertCurrent(); args.context.signal?.throwIfAborted();
            if (!library.ok) return library;
            const existing = findMatchingAccountPetV1(library.pets, source);
            if (existing) return { ok: true, result: { pet: existing, reused: true } };
        }
        const request = source.kind === 'package' ? source.package
            : buildAccountPetCreateRequestV1(await (await registry(args.context)).readRegistryPet(source));
        const result = await createAccountPet(account.credentials, request,
            { request: account.request, signal: args.context.signal });
        account.assertCurrent(); args.context.signal?.throwIfAborted();
        return result.ok ? { ok: true, result: { pet: result.pet, ...(result.reused ? { reused: true } : {}) } } : result;
    };
}
