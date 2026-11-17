import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { BUILT_IN_PET_IDS_V1 } from '@happier-dev/protocol/pets/constants';
import type { AccountPetLibraryEntryV1 } from '@happier-dev/protocol/pets/accountLibrary';

import { listAccountPets } from '@/sync/api/pets/apiAccountPets';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { storage } from '@/sync/domains/state/storage';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Selection has one owner beneath both UI intent and answering-client automation. */
export function createUiPetChooseAction(account: LazyActionAccountContext | null,
    openRoute?: (route: string) => void | Promise<void>): NonNullable<ActionExecutorDeps['uiPetChooseAction']> {
    return async ({ input, context }) => {
        throwIfAborted(context.signal);
        account?.assertCurrent();
        if (!('petRef' in input) && !('deviceOverride' in input)) {
            if (openRoute) await openRoute('/settings/pets');
            else (await import('expo-router')).router.push('/settings/pets');
            return { ok: true, result: { status: 'opened' } };
        }
        if (!account || !account.readLiveSettings()) {
            return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        }
        const settings = await account.readSettings();
        const snapshot = await getServerFeaturesSnapshot({ serverId: account.serverId });
        account.assertCurrent();
        throwIfAborted(context.signal);
        if (resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'pets.companion', settings, snapshot })?.state !== 'enabled') {
            return { ok: false, errorCode: 'feature_disabled', error: 'feature_disabled' };
        }
        if ('deviceOverride' in input) {
            const override = input.deviceOverride;
            if (override.kind !== 'inherit') {
                const source = storage.getState().localPetSourcesBySourceKey[override.sourceKey];
                if (!source || source.kind !== override.kind) {
                    return { ok: false, errorCode: 'pet_not_found', error: 'pet_not_found' };
                }
            }
            storage.getState().applyLocalSettings({ petsSelectedPetOverride: override }, { source: 'ui' });
            return { ok: true, result: { status: 'selected' } };
        }
        const petRef = input.petRef;
        let accountPet: AccountPetLibraryEntryV1 | undefined;
        if (petRef.kind === 'builtIn') {
            if (!(BUILT_IN_PET_IDS_V1 as readonly string[]).includes(petRef.petId)) {
                return { ok: false, errorCode: 'pet_not_found', error: 'pet_not_found' };
            }
        } else {
            if (resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'pets.sync', settings, snapshot })?.state !== 'enabled') {
                return { ok: false, errorCode: 'feature_disabled', error: 'feature_disabled' };
            }
            const library = await listAccountPets(account.credentials, { request: account.request });
            account.assertCurrent();
            throwIfAborted(context.signal);
            if (!library.ok) return { ok: false, errorCode: library.errorCode, error: library.errorCode };
            accountPet = library.pets.find(pet => pet.accountPetId === petRef.accountPetId);
            if (!accountPet) return { ok: false, errorCode: 'pet_not_found', error: 'pet_not_found' };
        }
        await account.mutateRawSettings(raw => ({ ...raw, petsSelectedPetRef: petRef }), { signal: context.signal });
        // Account persistence owns success. A refused/failed write never changes the device choice.
        account.assertCurrent();
        throwIfAborted(context.signal);
        if (accountPet) storage.getState().upsertAccountPet(accountPet);
        storage.getState().applyLocalSettings({ petsSelectedPetOverride: { kind: 'inherit' } }, { source: 'ui' });
        return { ok: true, result: { status: 'selected' } };
    };
}
