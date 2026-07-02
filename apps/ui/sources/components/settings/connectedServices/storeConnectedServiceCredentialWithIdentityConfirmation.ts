import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { Modal } from '@/modal';
import { storeConnectedServiceCredentialForAccount } from '@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { ConnectedServiceCredentialRecordV1, ConnectedServiceId } from '@happier-dev/protocol';

const PROVIDER_IDENTITY_MISMATCH_ERROR = 'connect_reconnect_provider_identity_mismatch';

type StoredConnectedServiceCredentialParams = Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    record: ConnectedServiceCredentialRecordV1;
}>;

type StoreConnectedServiceCredentialWithIdentityConfirmationOptions = Readonly<{
    onStored?: (params: StoredConnectedServiceCredentialParams) => void | Promise<void>;
}>;

function isProviderIdentityMismatchError(error: unknown): boolean {
    return error instanceof Error && error.message === PROVIDER_IDENTITY_MISMATCH_ERROR;
}

function runStoredEffects(
    onStored: StoreConnectedServiceCredentialWithIdentityConfirmationOptions['onStored'],
    params: StoredConnectedServiceCredentialParams,
): void {
    if (!onStored) return;

    try {
        fireAndForget(Promise.resolve(onStored(params)), {
            tag: 'storeConnectedServiceCredentialWithIdentityConfirmation.onStored',
        });
    } catch (error) {
        fireAndForget(Promise.reject(error), {
            tag: 'storeConnectedServiceCredentialWithIdentityConfirmation.onStored',
        });
    }
}

export async function storeConnectedServiceCredentialWithIdentityConfirmation(
    credentials: AuthCredentials,
    params: StoredConnectedServiceCredentialParams,
    options: StoreConnectedServiceCredentialWithIdentityConfirmationOptions = {},
): Promise<boolean> {
    try {
        await storeConnectedServiceCredentialForAccount(credentials, params);
        runStoredEffects(options.onStored, params);
        return true;
    } catch (error) {
        if (!isProviderIdentityMismatchError(error)) throw error;
    }

    const confirmed = await Modal.confirm(
        t('connectedServices.reconnect.identityMismatchTitle'),
        t('connectedServices.reconnect.identityMismatchBody'),
        {
            confirmText: t('connectedServices.reconnect.identityMismatchConfirm'),
            cancelText: t('common.cancel'),
        },
    );
    if (!confirmed) return false;

    await storeConnectedServiceCredentialForAccount(credentials, params, {
        allowProviderIdentityChange: true,
    });
    runStoredEffects(options.onStored, params);
    return true;
}
