import * as React from 'react';
import { API_TOKEN_FULL_GRANT_V1, type ApiTokenGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';

import type { ApiTokenSettingsController, ApiTokenSettingsState, ApiTokenSettingsToken } from '@/components/settings/apiTokens/apiTokenSettingsController';
import { showApiTokenEditAccessModal } from '@/components/settings/apiTokens/showApiTokenCreateModal';
import { Modal } from '@/modal';

/**
 * Dev-only specimen: Settings → API tokens → Edit access, drawn by the real modal and grant editor over
 * an in-memory token whose grant is the narrow deployment grant with Automatic deploys (one
 * Environment; deploy and operation status). Save only closes. It proves composition; the loaded
 * page is judged on a real token.
 */
const DEPLOY_GRANT: ApiTokenGrantV1 = {
    ...API_TOKEN_FULL_GRANT_V1,
    actions: { families: [], ids: ['deployments.deploy', 'action.operations.get'] },
    targets: { sessions: [], machines: [], environments: ['env-production-api'] },
    deployApproval: 'automatic',
};

const TOKEN: ApiTokenSettingsToken = {
    tokenId: '5f0c2b9e-7a41-4c3d-9b8e-2d6f1a0c4e7b',
    label: 'Release pipeline',
    displayPrefix: 'hap_v1_5f0c2b9e',
    createdAt: '2026-10-02T09:14:00.000Z',
    lastUsedAt: '2026-10-29T17:42:00.000Z',
    expiresAt: null,
    hasEncryptionAccess: false,
    hasUnattendedTeamAccess: false,
    grant: DEPLOY_GRANT,
    parentTokenId: null,
    activeChildCount: 0,
    embedConfig: null,
};

function createSpecimenController(): ApiTokenSettingsController {
    let state: ApiTokenSettingsState = {
        phase: 'ready', tokens: [TOKEN], encryptionAvailability: 'plain', recoveryTokenId: null, isRefreshing: false,
        listError: null, createDraft: { label: '', expiryPreset: '90d' }, createPending: false, createError: null,
        reveal: null, operation: null, operationTokenId: null, operationError: null, operationNotice: null, accessEdit: null,
    };
    const listeners = new Set<() => void>();
    const publish = (next: ApiTokenSettingsState) => { state = next; for (const listener of listeners) listener(); };
    const idle = async () => {};
    return {
        getState: () => state,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        refresh: idle,
        refreshEncryptionAvailability: idle,
        setCreateDraft: () => {},
        resetCreateDraft: () => {},
        createToken: idle,
        adoptCreatedToken: async () => false,
        acknowledgeReveal: () => {},
        clearReveal: () => {},
        requestRevealDismiss: async () => true,
        captureDestructiveTarget: () => null,
        revokeToken: async () => false,
        revokeAllTokens: async () => null,
        signOutEverywhere: async () => false,
        beginAccessEdit: (tokenId) => {
            publish({ ...state, accessEdit: { tokenId, grant: TOKEN.grant, pending: false, error: null, signsOutEmbeddedCredentials: false } });
            return true;
        },
        setAccessEditGrant: (grant) => {
            if (state.accessEdit) publish({ ...state, accessEdit: { ...state.accessEdit, grant } });
        },
        saveAccessEdit: async () => true,
        updateToken: async () => null,
        cancelAccessEdit: () => publish({ ...state, accessEdit: null }),
        clearOperationFeedback: () => {},
        retire: () => {},
    };
}

export function ApiTokenEditAccessSpecimen() {
    React.useEffect(() => {
        const modalId = showApiTokenEditAccessModal(createSpecimenController(), TOKEN.tokenId);
        return () => { if (modalId) Modal.hide(modalId); };
    }, []);
    return null;
}
