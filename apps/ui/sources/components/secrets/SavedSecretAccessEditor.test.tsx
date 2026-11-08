import * as React from 'react';
import { act } from 'react-test-renderer';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SharedSavedSecretGrantsSetInputV1Schema, SharedSavedSecretPromoteInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const confirmDisclosure = vi.hoisted(() => vi.fn(async () => true));

installSettingsViewCommonModuleMocks({
    storage: 'real',
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { confirm: confirmDisclosure } }).module;
    },
});

// Native UUID generation is an OS boundary; all Action and Saved Secret owners remain real.
vi.mock('expo-crypto', async importOriginal => ({ ...await importOriginal<typeof import('expo-crypto')>(),
    randomUUID: (await import('node:crypto')).randomUUID }));
const { serveSavedSecretEditorHomes, savedSecretGrantsPath, savedSecretPromotePath } = await import('@/dev/testkit/harness/savedSecretEditorHttpHarness');
// Collect the real executor before the per-test Home fixture's setup budget starts.
await import('@/sync/ops/actions/defaultActionExecutor');
const { teamSummaryFixture, teamGroupFixture } = await import('@/dev/testkit/fixtures/teamFixtures');
let home: Awaited<ReturnType<typeof serveSavedSecretEditorHomes>> | null = null;
let testScope = { serverId: '', accountId: 'account-owner' };
beforeEach(async () => {
    home = await serveSavedSecretEditorHomes({
        homes: [{ key: 'home-a', serverUrl: 'https://saved-secret-access.test', accountId: 'account-owner' }],
        route: request => {
            if (request.path === '/v1/user/search') return Response.json({ users: [
                { id: 'account-new', firstName: 'New', lastName: 'Person', username: 'new-person', avatar: null, bio: null, status: 'none', publicKey: null },
                { id: 'account-old', firstName: 'Old', lastName: 'Person', username: 'old-person', avatar: null, bio: null, status: 'none', publicKey: null },
            ], nextCursor: null });
            if (request.path === '/v1/teams/list') return Response.json({ items: [teamSummaryFixture({ id: 'team-new', name: 'New Team' })], nextCursor: null });
            if (request.path === '/v1/teams/groups/list') return Response.json({ items: [teamGroupFixture({ id: 'group-new', teamId: 'team-new', name: 'New Group' })], nextCursor: null });
            return undefined;
        },
    });
    testScope = { serverId: home.homes['home-a']!.id, accountId: 'account-owner' };
});

const entry = {
    ref: 'happier:shared-secret:v1:resource-1',
    source: 'shared_resource',
    relationship: 'owner',
    name: 'Shared key',
    kind: 'apiKey',
    encryptionMode: 'plain',
    owner: null,
    accessSources: [],
    audience: { accounts: [], teams: [], groups: [] },
    ownerAccountId: 'account-owner',
    revision: 3,
    materialStatus: 'ready',
    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
} as const satisfies SavedSecretCatalogEntryV1;

afterEach(async () => {
    await standardCleanup();
    await home?.dispose();
    home = null;
    confirmDisclosure.mockReset();
    confirmDisclosure.mockResolvedValue(true);
});

const personalSecret = {
    id: 'personal-1',
    name: 'Personal key',
    kind: 'apiKey',
    encryptedValue: { _isSecretValue: true, value: 'sealed' },
    createdAt: 1,
    updatedAt: 2,
} as const;

async function startAdding(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await act(async () => { invokeTestInstanceHandler(screen.findByTestId('saved-secret-access-search'), 'onFocus'); });
}

const grantWrites = () => home!.mutations.filter(request => request.path === savedSecretGrantsPath);
const promotionWrites = () => home!.mutations.filter(request => request.path === savedSecretPromotePath);

describe('SavedSecretAccessEditor', () => {
    it('requires a changed audience and disables Save again when the selection is reverted', async () => {
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const screen = await renderScreen(<SavedSecretAccessEditor
            target={{ kind: 'shared', entry }} scope={testScope}
            onClose={() => {}} onSaved={async () => {}} />);
        const save = () => screen.findAllByType(RoundButton).find((button) => button.props.testID === 'saved-secret-access-save')!;
        expect(save().props.disabled).toBe(true);
        await startAdding(screen);
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        expect(home?.requests.some((request) => request.path === '/v1/user/search'
            && request.url.searchParams.get('purpose') === 'collaboration')).toBe(true);
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        expect(save().props.disabled).toBe(false);
        await screen.pressByTestIdAsync('saved-secret-access-grant-account:account-new');
        await screen.pressByTestIdAsync('saved-secret-access-remove:account:account-new');
        expect(save().props.disabled).toBe(true);
        expect(grantWrites()).toHaveLength(0);
    });

    it('promotes a personal secret once, with the chosen grants, only when the person saves', async () => {
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        const onClose = vi.fn();
        const onSaved = vi.fn(async () => {});
        const screen = await renderScreen(
            <SavedSecretAccessEditor
                target={{ kind: 'personal', secret: personalSecret, expectedSettingsVersion: 9 }}
                scope={testScope}
                onClose={onClose}
                onSaved={onSaved}
            />,
        );

        // Opening the picker converts nothing: the secret is still personal
        // until the person has chosen who receives it and confirmed.
        home!.replaceSettings('home-a', { secrets: [personalSecret] }, 9);
        await startAdding(screen);
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        expect(promotionWrites()).toHaveLength(0);
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-team:team-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-team:team-new');
        expect(promotionWrites()).toHaveLength(0);

        await screen.pressByTestIdAsync('saved-secret-access-save');

        await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        expect(confirmDisclosure).toHaveBeenCalledOnce();
        expect(promotionWrites()).toHaveLength(1);
        expect(SharedSavedSecretPromoteInputV1Schema.parse(promotionWrites()[0]!.body)).toMatchObject({
            expectedSettingsVersion: 9,
            accountGrants: ['account-new'],
            teamGrants: ['team-new'],
            groupGrants: [],
            personalSecretPromotions: [{ personalSecretId: personalSecret.id }],
            storedContent: { t: 'plain', v: { name: personalSecret.name, value: 'sealed' } },
        });
        expect(home!.settings('home-a')?.secrets).toEqual([]);
        expect(grantWrites()).toHaveLength(0);
        expect(onSaved).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('keeps a personal secret personal when the first-grant disclosure is declined', async () => {
        confirmDisclosure.mockResolvedValueOnce(false);
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        const screen = await renderScreen(
            <SavedSecretAccessEditor
                target={{ kind: 'personal', secret: personalSecret, expectedSettingsVersion: 9 }}
                scope={testScope}
                onClose={vi.fn()}
                onSaved={vi.fn(async () => {})}
            />,
        );

        await startAdding(screen);
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        await screen.pressByTestIdAsync('saved-secret-access-save');

        expect(promotionWrites()).toHaveLength(0);
        expect(screen.findByTestId('saved-secret-access-save')).toBeTruthy();
    });

    it('saves Account, Team and Group choices through the canonical revision-fenced grant operation', async () => {
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        const onClose = vi.fn();
        const onSaved = vi.fn(async () => {});
        const screen = await renderScreen(
            <SavedSecretAccessEditor
                target={{ kind: 'shared', entry }}
                scope={testScope}
                onClose={onClose}
                onSaved={onSaved}
            />,
        );

        await startAdding(screen);
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-team:team-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-team:team-new');
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-group:team-new:group-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-group:team-new:group-new');
        await screen.pressByTestIdAsync('saved-secret-access-save');

        await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        expect(grantWrites()).toHaveLength(1);
        expect(SharedSavedSecretGrantsSetInputV1Schema.parse(grantWrites()[0]!.body)).toMatchObject({
            resourceId: 'resource-1',
            expectedRevision: 3,
            accountGrants: ['account-new'],
            teamGrants: ['team-new'],
            groupGrants: ['group-new'],
        });
        expect(onSaved).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it.each([false, true])('settles an acknowledged grant after its own catalog revision arrives unless the resource changed (%s)', async differentResource => {
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        const request = createDeferred<Response>();
        const refresh = createDeferred<void>();
        home!.respondToMutations(() => request.promise);
        const onClose = vi.fn();
        const onSaved = vi.fn(async () => { await refresh.promise; });
        const scope = testScope;
        const screen = await renderScreen(
            <SavedSecretAccessEditor target={{ kind: 'shared', entry }} scope={scope} onClose={onClose} onSaved={onSaved} />,
        );

        await startAdding(screen);
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        screen.pressByTestId('saved-secret-access-save');
        await vi.waitFor(() => expect(grantWrites()).toHaveLength(1));
        expect(SharedSavedSecretGrantsSetInputV1Schema.parse(grantWrites()[0]!.body)).toMatchObject({ expectedRevision: 3, accountGrants: ['account-new'] });
        await screen.update(
            <SavedSecretAccessEditor
                target={{ kind: 'shared', entry: { ...entry, revision: 4,
                    ...(differentResource ? { ref: 'happier:shared-secret:v1:resource-2' } : {}) } }}
                scope={scope}
                onClose={onClose}
                onSaved={onSaved}
            />,
        );
        const response = Response.json({ resourceId: 'resource-1', revision: 4 });
        request.resolve(response);
        await vi.waitFor(() => expect(response.bodyUsed).toBe(true));
        await flushHookEffects();

        try {
            expect(onSaved).toHaveBeenCalledTimes(differentResource ? 0 : 1);
            expect(onClose).not.toHaveBeenCalled();
            expect(screen.getTextContent()).not.toContain('secrets.catalog.operationFailed');
        } finally {
            await act(async () => { refresh.resolve(); });
        }
        expect(onClose).toHaveBeenCalledTimes(differentResource ? 0 : 1);
    });

    it('keeps an unsaved recipient choice when the catalog revision moves underneath', async () => {
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        const onClose = vi.fn();
        const onSaved = vi.fn(async () => {});
        const scope = testScope;
        const screen = await renderScreen(
            <SavedSecretAccessEditor target={{ kind: 'shared', entry }} scope={scope} onClose={onClose} onSaved={onSaved} />,
        );

        await startAdding(screen);
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');

        // An ordinary background catalog refresh, not a different secret.
        await screen.update(
            <SavedSecretAccessEditor
                target={{ kind: 'shared', entry: { ...entry, revision: 4 } }}
                scope={scope}
                onClose={onClose}
                onSaved={onSaved}
            />,
        );

        // The choice survives, the stale save is fenced, and adopting the
        // Home's current recipients is offered as an explicit action.
        // The kept choice is still listed under "Who has access".
        expect(screen.findByTestId('saved-secret-access-grant-account:account-new')).toBeTruthy();
        expect(screen.findByTestId('saved-secret-access-save')?.props.disabled).toBe(true);
        expect(screen.findByTestId('saved-secret-access-reload')).toBeTruthy();

        await screen.pressByTestIdAsync('saved-secret-access-save');
        expect(grantWrites()).toHaveLength(0);

        await screen.pressByTestIdAsync('saved-secret-access-reload');
        expect(screen.findByTestId('saved-secret-access-save')?.props.disabled).toBe(true);
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        await screen.pressByTestIdAsync('saved-secret-access-save');
        await vi.waitFor(() => expect(grantWrites()).toHaveLength(1));
        expect(SharedSavedSecretGrantsSetInputV1Schema.parse(grantWrites()[0]!.body)).toMatchObject({
            expectedRevision: 4,
            accountGrants: ['account-new'],
        });
    });

    it('does not create the first external grant when direct-disclosure confirmation is cancelled', async () => {
        confirmDisclosure.mockResolvedValueOnce(false);
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        const screen = await renderScreen(
            <SavedSecretAccessEditor
                target={{ kind: 'shared', entry }}
                scope={testScope}
                onClose={vi.fn()}
                onSaved={vi.fn(async () => {})}
            />,
        );

        await startAdding(screen);
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        await screen.pressByTestIdAsync('saved-secret-access-save');

        expect(confirmDisclosure).toHaveBeenCalledOnce();
        expect(confirmDisclosure).toHaveBeenCalledWith(expect.any(String), 'secretsSettings.sharingDescription', expect.any(Object));
        expect(grantWrites()).toHaveLength(0);
        expect(screen.findByTestId('saved-secret-access-save')).toBeTruthy();
    });

    it('lists who has access at the one locked level and removes a grant only when the person saves', async () => {
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        const shared = { ...entry, audience: {
            accounts: [{ kind: 'account', accountId: 'account-old', name: 'Old Person', firstName: 'Old', lastName: 'Person', username: null, avatarUrl: null }],
            teams: [{ kind: 'team', teamId: 'team-old', name: 'Old Team' }],
            groups: [],
        } } as const satisfies SavedSecretCatalogEntryV1;
        const screen = await renderScreen(
            <SavedSecretAccessEditor
                target={{ kind: 'shared', entry: shared }}
                scope={testScope}
                onClose={vi.fn()}
                onSaved={vi.fn(async () => {})}
            />,
        );

        await startAdding(screen);
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        expect(screen.findByTestId('saved-secret-access-grant-account:account-old')).toBeTruthy();
        expect(screen.findByTestId('saved-secret-access-grant-team:team-old')).toBeTruthy();
        // Someone who already has access is listed once, never offered again as a candidate.
        expect(screen.findByTestId('saved-secret-access-candidate-account:account-old')).toBeNull();

        // One level for everyone: there is nothing to choose, so the row's one control is Remove, visible at
        // rest, and the sheet adds no second paragraph about what a grant gives.
        expect(screen.findByTestId('saved-secret-access-level:team:team-old')).toBeNull();
        expect(screen.getTextContent()).not.toContain('shareSheet.secrets.help.use');
        await screen.pressByTestIdAsync('saved-secret-access-remove:team:team-old');
        // Removing changes the draft only; nothing is written until Save.
        expect(grantWrites()).toHaveLength(0);
        expect(screen.findByTestId('saved-secret-access-grant-team:team-old')).toBeNull();

        await screen.pressByTestIdAsync('saved-secret-access-save');
        await vi.waitFor(() => expect(grantWrites()).toHaveLength(1));
        expect(SharedSavedSecretGrantsSetInputV1Schema.parse(grantWrites()[0]!.body)).toMatchObject({
            resourceId: 'resource-1',
            expectedRevision: 3,
            accountGrants: ['account-old'],
            teamGrants: [],
            groupGrants: [],
        });
    });

    it('refreshes authoritative state and stays open when grant outcome is unknown', async () => {
        home!.respondToMutations(async () => { throw new TypeError('Home connection ended after dispatch'); });
        const onClose = vi.fn();
        const onSaved = vi.fn(async () => {});
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        const screen = await renderScreen(
            <SavedSecretAccessEditor
                target={{ kind: 'shared', entry }}
                scope={testScope}
                onClose={onClose}
                onSaved={onSaved}
            />,
        );

        await startAdding(screen);
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        await screen.pressByTestIdAsync('saved-secret-access-save');

        await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
        expect(grantWrites()).toHaveLength(1);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.findByTestId('saved-secret-access-save')).toBeTruthy();
    });
});
// Native filesystem classes are an OS boundary, not part of this source-driven UI journey.
vi.mock('expo-file-system', async () =>
    (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);
