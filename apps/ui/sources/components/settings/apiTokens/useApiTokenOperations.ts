import * as React from 'react';
import type { ApiTokenSettingsController, ApiTokenSettingsToken } from './apiTokenSettingsController';
import { showApiTokenCreateModal, showApiTokenEditAccessModal } from './showApiTokenCreateModal';

/**
 * The collection's operations use the controller's captured Account lifetime and Action admission.
 */
export function useApiTokenOperations(controller: ApiTokenSettingsController) {
    const create = React.useCallback(() => {
        showApiTokenCreateModal(controller);
    }, [controller]);

    const editAccess = React.useCallback((token: ApiTokenSettingsToken) => {
        showApiTokenEditAccessModal(controller, token.tokenId);
    }, [controller]);

    const revoke = React.useCallback(async (token: Pick<ApiTokenSettingsToken, 'tokenId' | 'label'>): Promise<boolean> => {
        return await controller.revokeToken(token.tokenId);
    }, [controller]);

    const revokeAll = React.useCallback(async (): Promise<void> => {
        await controller.revokeAllTokens();
    }, [controller]);

    return { create, editAccess, revoke, revokeAll };
}
