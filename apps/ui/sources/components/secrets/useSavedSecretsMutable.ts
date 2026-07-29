import React from 'react';

import { Modal } from '@/modal';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { useSetting } from '@/sync/store/hooks';
import { t } from '@/text';

import {
    applySavedSecretReplacementIntent,
} from '@/sync/domains/settings/savedSecretMutations';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';

/**
 * Reference-aware replacement bridge for legacy SavedSecret editors. The
 * proposed array is converted into identity-local mutations and replayed
 * against each canonical Account Settings CAS winner.
 */
export function useSavedSecretsMutable(): readonly [
    SavedSecret[],
    (next: SavedSecret[]) => Promise<void>,
] {
    const secrets = useSetting('secrets');
    const replace = React.useCallback(async (next: SavedSecret[]) => {
        try {
            await getSyncSingleton().mutateAccountSettings((current) => (
                applySavedSecretReplacementIntent({
                    current,
                    base: secrets,
                    proposed: next,
                }).settings as Record<string, unknown>
            ));
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error
                    ? error.message
                    : 'SavedSecret mutation failed',
            );
        }
    }, [secrets]);
    return [secrets, replace] as const;
}
