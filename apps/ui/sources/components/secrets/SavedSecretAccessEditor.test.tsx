import * as React from 'react';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedSecretResourceOperationResult } from '@/sync/ops/settings/savedSecretResourceOperations';

import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const confirmDisclosure = vi.hoisted(() => vi.fn(async () => true));

installSettingsViewCommonModuleMocks({
    storage: importOriginal => importOriginal(),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { confirm: confirmDisclosure } }).module;
    },
});

const setGrants = vi.hoisted(() => vi.fn<() => Promise<SavedSecretResourceOperationResult>>(async () => ({ ok: true })));
const promotePersonal = vi.hoisted(() => vi.fn(async () => ({
    ok: true as const, resourceRef: 'happier:shared-secret:v1:resource-promoted',
})));

vi.mock('@/sync/ops/settings/savedSecretResourceOperations', () => ({
    setSavedSecretResourceGrants: setGrants,
    promotePersonalSavedSecretResource: promotePersonal,
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({ getSyncSingleton: () => ({ encryption: null }) }));
// The host Action boundary answers Team directories; their clients, schemas,
// pagers, and shared access-directory projection remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async () => {
    const { teamSummaryFixture, teamGroupFixture } = await import('@/dev/testkit/fixtures/teamFixtures');
    return { createFrontDoorActionExecute: () => async (actionId: string) => ({ ok: true,
        result: { items: actionId === 'teams.list'
            ? [teamSummaryFixture({ id: 'team-new', name: 'New Team' })]
            : actionId === 'teams.groups.list'
                ? [teamGroupFixture({ id: 'group-new', teamId: 'team-new', name: 'New Group' })] : [], nextCursor: null } }) };
});

const { serveAccountHomes } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
let home: Awaited<ReturnType<typeof serveAccountHomes>> | null = null;
let testScope = { serverId: '', accountId: 'account-owner' };
beforeEach(async () => {
    home = await serveAccountHomes({
        homes: [{ key: 'home-a', serverUrl: 'https://saved-secret-access.test', accountId: 'account-owner' }],
        route: request => request.path === '/v1/user/search' ? Response.json({ users: [
            { id: 'account-new', firstName: 'New', lastName: 'Person', username: 'new-person', avatar: null, bio: null, status: 'none', publicKey: null },
            { id: 'account-old', firstName: 'Old', lastName: 'Person', username: 'old-person', avatar: null, bio: null, status: 'none', publicKey: null },
        ], nextCursor: null }) : undefined,
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

afterEach(() => {
    standardCleanup();
    home?.dispose();
    home = null;
    setGrants.mockReset();
    setGrants.mockResolvedValue({ ok: true });
    promotePersonal.mockReset();
    promotePersonal.mockResolvedValue({ ok: true as const, resourceRef: 'happier:shared-secret:v1:resource-promoted' });
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

describe('SavedSecretAccessEditor', () => {
    it('requires a changed audience and disables Save again when the selection is reverted', async () => {
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const screen = await renderScreen(<SavedSecretAccessEditor
            target={{ kind: 'shared', entry }} scope={testScope}
            onClose={() => {}} onSaved={async () => {}} />);
        const save = () => screen.findAllByType(RoundButton).find((button) => button.props.testID === 'saved-secret-access-save')!;
        expect(save().props.disabled).toBe(true);
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        expect(home?.requests.some((request) => request.path === '/v1/user/search'
            && request.url.searchParams.get('purpose') === 'collaboration')).toBe(true);
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        expect(save().props.disabled).toBe(false);
        await screen.pressByTestIdAsync('saved-secret-access-grant-account:account-new');
        await screen.pressByTestIdAsync('saved-secret-access-remove:account:account-new');
        expect(save().props.disabled).toBe(true);
        expect(setGrants).not.toHaveBeenCalled();
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
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        expect(promotePersonal).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-team:team-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-team:team-new');
        expect(promotePersonal).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('saved-secret-access-save');

        expect(confirmDisclosure).toHaveBeenCalledOnce();
        expect(promotePersonal).toHaveBeenCalledOnce();
        expect(promotePersonal).toHaveBeenCalledWith(expect.objectContaining({
            scope: testScope,
            expectedSettingsVersion: 9,
            secret: personalSecret,
            accountGrants: ['account-new'],
            teamGrants: ['team-new'],
            groupGrants: [],
        }));
        expect(setGrants).not.toHaveBeenCalled();
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

        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        await screen.pressByTestIdAsync('saved-secret-access-save');

        expect(promotePersonal).not.toHaveBeenCalled();
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

        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-team:team-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-team:team-new');
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-group:team-new:group-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-group:team-new:group-new');
        await screen.pressByTestIdAsync('saved-secret-access-save');

        expect(setGrants).toHaveBeenCalledWith(expect.objectContaining({
            scope: testScope,
            resourceId: 'resource-1',
            expectedRevision: 3,
            encryptionMode: 'plain',
            accountGrants: ['account-new'],
            teamGrants: ['team-new'],
            groupGrants: ['group-new'],
        }));
        expect(onSaved).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('does not let a late save response close a different resource revision', async () => {
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        const request = createDeferred<{ ok: true }>();
        setGrants.mockImplementationOnce(() => request.promise);
        const onClose = vi.fn();
        const onSaved = vi.fn(async () => {});
        const scope = testScope;
        const screen = await renderScreen(
            <SavedSecretAccessEditor target={{ kind: 'shared', entry }} scope={scope} onClose={onClose} onSaved={onSaved} />,
        );

        screen.pressByTestId('saved-secret-access-save');
        await screen.update(
            <SavedSecretAccessEditor
                target={{ kind: 'shared', entry: { ...entry, revision: 4 } }}
                scope={scope}
                onClose={onClose}
                onSaved={onSaved}
            />,
        );
        request.resolve({ ok: true });
        await flushHookEffects();

        expect(onSaved).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.findByTestId('saved-secret-access-save')).toBeTruthy();
    });

    it('keeps an unsaved recipient choice when the catalog revision moves underneath', async () => {
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        const onClose = vi.fn();
        const onSaved = vi.fn(async () => {});
        const scope = testScope;
        const screen = await renderScreen(
            <SavedSecretAccessEditor target={{ kind: 'shared', entry }} scope={scope} onClose={onClose} onSaved={onSaved} />,
        );

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
        expect(setGrants).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('saved-secret-access-reload');
        expect(screen.findByTestId('saved-secret-access-save')?.props.disabled).toBe(true);
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        await screen.pressByTestIdAsync('saved-secret-access-save');
        expect(setGrants).toHaveBeenCalledWith(expect.objectContaining({
            expectedRevision: 4,
            accountGrants: ['account-new'],
        }));
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

        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        await screen.pressByTestIdAsync('saved-secret-access-save');

        expect(confirmDisclosure).toHaveBeenCalledOnce();
        expect(setGrants).not.toHaveBeenCalled();
        expect(screen.findByTestId('saved-secret-access-save')).toBeTruthy();
    });

    it('lists who has access at the one locked level and removes a grant only when the person saves', async () => {
        const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
        const shared = { ...entry, audience: {
            accounts: [{ kind: 'account', accountId: 'account-old', firstName: 'Old', lastName: 'Person', username: null, avatarUrl: null }],
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

        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        expect(screen.findByTestId('saved-secret-access-grant-account:account-old')).toBeTruthy();
        expect(screen.findByTestId('saved-secret-access-grant-team:team-old')).toBeTruthy();
        // Someone who already has access is listed once, never offered again as a candidate.
        expect(screen.findByTestId('saved-secret-access-candidate-account:account-old')).toBeNull();

        // One level, locked: a secret is only ever used by runs, so there is nothing to choose.
        expect(screen.findByTestId('saved-secret-access-level:team:team-old')).toBeTruthy();
        expect(screen.getTextContent()).toContain('shareSheet.secrets.levels.canUse');
        await screen.pressByTestIdAsync('saved-secret-access-level:team:team-old');
        expect(screen.getTextContent()).toContain('shareSheet.secrets.oneLevel');

        await screen.pressByTestIdAsync('saved-secret-access-grant-team:team-old');
        expect(screen.findByTestId('saved-secret-access-level:team:team-old:edit')).toBeNull();
        await screen.pressByTestIdAsync('saved-secret-access-remove:team:team-old');
        // Removing changes the draft only; nothing is written until Save.
        expect(setGrants).not.toHaveBeenCalled();
        expect(screen.findByTestId('saved-secret-access-grant-team:team-old')).toBeNull();

        await screen.pressByTestIdAsync('saved-secret-access-save');
        expect(setGrants).toHaveBeenCalledWith(expect.objectContaining({
            resourceId: 'resource-1',
            expectedRevision: 3,
            accountGrants: ['account-old'],
            teamGrants: [],
            groupGrants: [],
        }));
    });

    it('refreshes authoritative state and stays open when grant outcome is unknown', async () => {
        setGrants.mockResolvedValueOnce({ ok: false, reason: 'outcome_unknown' });
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

        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-new')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-new');
        await screen.pressByTestIdAsync('saved-secret-access-save');

        expect(onSaved).toHaveBeenCalledOnce();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.findByTestId('saved-secret-access-save')).toBeTruthy();
    });
});
