import * as React from 'react';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks();

// Only the Home transport boundary is simulated: the real Saved Secret
// operations owner reads the envelope census and the real editor projects it.
const requestHomeDomain = vi.hoisted(() => vi.fn());
const runTeamAction = vi.hoisted(() => vi.fn());
vi.mock('@/sync/api/home/homeServerActionTransport', () => ({ requestHomeDomain }));
vi.mock('@/sync/api/account/apiSavedSecretCatalog', () => ({
    readSavedSecretCatalog: vi.fn(async () => ({ ok: false })),
}));
vi.mock('@/sync/ops/teams/teamActionClient', () => ({
    runTeamAction,
    isTeamActionApprovalPendingError: () => false,
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({ getSyncSingleton: () => ({ encryption: null }) }));
vi.mock('@/components/sessions/access/useSessionAccessDirectory', () => ({
    useSessionAccessDirectory: () => ({
        sections: [], teamContexts: [], activeTeamContexts: [], teamDirectoryStatus: 'ready', teamDirectoryComplete: true,
        loadMore: vi.fn(), retry: vi.fn(),
    }),
}));

const scope = { serverId: 'home-a', accountId: 'account-owner' };

const e2eeEntry = {
    ref: 'happier:shared-secret:v1:resource-1',
    source: 'shared_resource',
    relationship: 'owner',
    name: 'Shared key',
    kind: 'apiKey',
    encryptionMode: 'e2ee',
    owner: null,
    accessSources: [],
    audience: {
        accounts: [
            { kind: 'account', accountId: 'account-ready', firstName: 'Ready', lastName: null, username: null, avatarUrl: null },
            { kind: 'account', accountId: 'account-missing', firstName: 'Missing', lastName: null, username: null, avatarUrl: null },
            { kind: 'account', accountId: 'account-plain', firstName: 'Plain', lastName: null, username: null, avatarUrl: null },
            { kind: 'account', accountId: 'account-setup', firstName: 'Setup', lastName: null, username: null, avatarUrl: null },
        ],
        teams: [],
        groups: [],
    },
    ownerAccountId: 'account-owner',
    revision: 3,
    materialStatus: 'ready',
    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
} as unknown as SavedSecretCatalogEntryV1;

function recipient(accountId: string, firstName: string, readiness: unknown, envelopeStatus: string) {
    return {
        account: { kind: 'account', accountId, firstName, lastName: null, username: null, avatarUrl: null },
        readiness,
        envelopeStatus,
    };
}

const AVAILABLE = { status: 'available', contentPublicKey: 'AAAA', contentPublicKeyFingerprint: 'fp' };

afterEach(() => {
    standardCleanup();
    requestHomeDomain.mockReset();
    runTeamAction.mockReset();
});

describe('SavedSecretAccessEditor recipient readiness', () => {
    it('tells the owner, per recipient, who can open an E2EE secret and what each one needs', async () => {
        requestHomeDomain.mockResolvedValue({
            ok: true,
            value: {
                resourceId: 'resource-1',
                revision: 3,
                recipients: [
                    recipient('account-owner', 'Owner', AVAILABLE, 'prepared'),
                    recipient('account-ready', 'Ready', AVAILABLE, 'prepared'),
                    recipient('account-missing', 'Missing', AVAILABLE, 'missing'),
                    recipient('account-plain', 'Plain', { status: 'unavailable', reason: 'plain_account' }, 'missing'),
                    recipient('account-setup', 'Setup', { status: 'unavailable', reason: 'encryption_setup_required' }, 'missing'),
                ],
                nextCursor: null,
            },
        });
        const onMakeHomeManaged = vi.fn();
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');

        const screen = await renderScreen(
            <SavedSecretAccessEditor
                target={{ kind: 'shared', entry: e2eeEntry }}
                scope={scope}
                onClose={vi.fn()}
                onSaved={vi.fn(async () => {})}
                onMakeHomeManaged={onMakeHomeManaged}
            />,
        );

        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-recipient:account-plain')).toBeTruthy());
        const subtitle = (accountId: string) => screen.findAllByTestId(`saved-secret-recipient:${accountId}`)[0]?.props.subtitle;
        expect(subtitle('account-ready')).toBe('secrets.catalog.status.ready');
        expect(subtitle('account-missing')).toBe('secrets.catalog.status.preparing_encrypted_access');
        expect(subtitle('account-plain')).toBe('secrets.catalog.recipientHomeManagedRequired');
        expect(subtitle('account-setup')).toBe('secrets.catalog.recipientEncryptionSetupRequired');
        // The owner is not listed as their own recipient.
        expect(screen.findByTestId('saved-secret-recipient:account-owner')).toBeFalsy();
        const request = requestHomeDomain.mock.calls[0]?.[0];
        expect(request).toMatchObject({ method: 'GET', effect: 'read', scope });
        const requestedUrl = new URL(request.path, 'https://home.test');
        expect(requestedUrl.pathname).toBe('/v1/account/saved-secrets/resources/envelope-census');
        expect(requestedUrl.searchParams.get('resourceId')).toBe('resource-1');

        // Selecting a Plain recipient never converts: conversion is the
        // owner's explicit, separately confirmed choice.
        expect(runTeamAction).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('saved-secret-recipient-make-home-managed');
        expect(onMakeHomeManaged).toHaveBeenCalledTimes(1);
        expect(runTeamAction).not.toHaveBeenCalled();
    });

    it('does not read a census for a Home-managed secret, which has no envelopes to prepare', async () => {
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        await renderScreen(
            <SavedSecretAccessEditor
                target={{ kind: 'shared', entry: { ...e2eeEntry, encryptionMode: 'plain' } as SavedSecretCatalogEntryV1 }}
                scope={scope}
                onClose={vi.fn()}
                onSaved={vi.fn(async () => {})}
            />,
        );
        expect(requestHomeDomain).not.toHaveBeenCalled();
    });
});
