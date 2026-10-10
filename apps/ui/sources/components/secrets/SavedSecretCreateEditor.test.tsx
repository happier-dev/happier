import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const confirmDisclosure = vi.hoisted(() => vi.fn(async () => true));
const createResource = vi.hoisted(() => vi.fn());

installSettingsViewCommonModuleMocks({
    storage: importOriginal => importOriginal(),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { confirm: confirmDisclosure } }).module;
    },
});

vi.mock('@/sync/ops/settings/savedSecretResourceOperations', () => ({
    createSavedSecretResource: createResource,
}));
const { serveActionHomes } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const { teamSummaryFixture, teamGroupFixture } = await import('@/dev/testkit/fixtures/teamFixtures');
let home: Awaited<ReturnType<typeof serveActionHomes>> | null = null;
let scopeA = { serverId: '', accountId: 'owner-a' };
let scopeB = { serverId: '', accountId: 'owner-b' };
beforeEach(async () => {
    home = await serveActionHomes({
        homes: [
            { key: 'home-b', serverUrl: 'https://saved-secret-create-b.test', accountId: 'owner-b' },
            { key: 'home-a', serverUrl: 'https://saved-secret-create-a.test', accountId: 'owner-a' },
        ],
        route: request => {
            if (request.path === '/v1/user/search') return Response.json({ users: request.home === 'home-a' ? [
                { id: 'account-b', firstName: 'B', lastName: null, username: 'b', avatar: null, bio: null, status: 'none', publicKey: null },
            ] : [], nextCursor: null });
            if (request.path === '/v1/teams/list') return Response.json({
                items: request.home === 'home-a' ? [teamSummaryFixture({ id: 'team-a', name: 'Team A' })] : [], nextCursor: null,
            });
            if (request.path === '/v1/teams/groups/list') return Response.json({
                items: request.home === 'home-a' ? [teamGroupFixture({ id: 'group-a', teamId: 'team-a', name: 'Group A' })] : [], nextCursor: null,
            });
            return undefined;
        },
    });
    scopeA = { serverId: home.homes['home-a']!.id, accountId: 'owner-a' };
    scopeB = { serverId: home.homes['home-b']!.id, accountId: 'owner-b' };
});

afterEach(() => {
    standardCleanup();
    home?.dispose();
    home = null;
    confirmDisclosure.mockReset();
    confirmDisclosure.mockResolvedValue(true);
    createResource.mockReset();
});

describe('SavedSecretCreateEditor', () => {
    it('creates an owner-only resource from one name, kind, and value entry', async () => {
        createResource.mockResolvedValueOnce({
            ok: true, resourceRef: 'happier:shared-secret:v1:resource-a', revision: 1,
        });
        const onCreated = vi.fn(async () => {});
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const screen = await renderScreen(
            <SavedSecretCreateEditor
                scope={scopeA}
                approvalPending={false}
                requestApproval={vi.fn()}
                onCancel={vi.fn()}
                onCreated={onCreated}
            />,
        );

        screen.changeTextByTestId('saved-secret-create-name', 'Deploy token');
        screen.changeTextByTestId('saved-secret-create-value', '  token-value\n');
        await screen.pressByTestIdAsync('saved-secret-create-kind:token');
        await screen.pressByTestIdAsync('saved-secret-create-submit');

        expect(confirmDisclosure).not.toHaveBeenCalled();
        expect(createResource).toHaveBeenCalledWith(expect.objectContaining({
            scope: scopeA,
            name: 'Deploy token', kind: 'token', value: '  token-value\n',
            accountGrants: [], teamGrants: [], groupGrants: [],
        }));
        expect(onCreated).toHaveBeenCalledWith('happier:shared-secret:v1:resource-a', 'shared');
    });

    it('confirms disclosure and submits initial Account, Team, and Group grants', async () => {
        createResource.mockResolvedValueOnce({
            ok: true, resourceRef: 'happier:shared-secret:v1:resource-a', revision: 1,
        });
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const screen = await renderScreen(
            <SavedSecretCreateEditor
                scope={scopeA}
                approvalPending={false}
                requestApproval={vi.fn()}
                onCancel={vi.fn()}
                onCreated={vi.fn(async () => {})}
            />,
        );

        screen.changeTextByTestId('saved-secret-create-name', 'Mixed secret');
        screen.changeTextByTestId('saved-secret-create-value', 'secret-value');
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-b')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-b');
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-team:team-a')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-team:team-a');
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-group:team-a:group-a')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-group:team-a:group-a');
        expect(home?.requests.some(request => request.path === '/v1/teams/list')).toBe(true);
        expect(home?.requests.some(request => request.path === '/v1/teams/groups/list')).toBe(true);
        await screen.pressByTestIdAsync('saved-secret-create-submit');

        expect(confirmDisclosure).toHaveBeenCalledOnce();
        expect(createResource).toHaveBeenCalledWith(expect.objectContaining({
            accountGrants: ['account-b'], teamGrants: ['team-a'], groupGrants: ['group-a'],
        }));
    });

    it('keeps the draft mounted while approval is pending and presents the exact artifact', async () => {
        const requestApproval = vi.fn();
        const { TeamActionApprovalPendingError } = await import('@/sync/ops/teams/teamActionClient');
        createResource.mockRejectedValueOnce(new TeamActionApprovalPendingError('approval-a'));
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const screen = await renderScreen(
            <SavedSecretCreateEditor
                scope={scopeA}
                approvalPending={false}
                requestApproval={requestApproval}
                onCancel={vi.fn()}
                onCreated={vi.fn(async () => {})}
            />,
        );
        screen.changeTextByTestId('saved-secret-create-name', 'Kept name');
        screen.changeTextByTestId('saved-secret-create-value', 'kept-value');
        // Both entries must be committed before the press: the rendered submit
        // handler is the one the last commit produced.
        await flushHookEffects();
        await screen.pressByTestIdAsync('saved-secret-create-submit');
        expect(requestApproval).toHaveBeenCalledWith('approval-a');

        await screen.update(
            <SavedSecretCreateEditor
                scope={scopeA}
                approvalPending
                approvalId="approval-a"
                requestApproval={requestApproval}
                onOpenApproval={vi.fn()}
                onCancel={vi.fn()}
                onCreated={vi.fn(async () => {})}
            />,
        );
        expect(screen.findByTestId('saved-secret-create-name')?.props.value).toBe('Kept name');
        expect(screen.findByTestId('saved-secret-create-submit')?.props.disabled).toBe(true);
        expect(screen.findByTestId('saved-secret-create-approval')).toBeTruthy();
    });

    it('clears the draft across a Home switch and ignores the old Home result', async () => {
        const deferred = createDeferred<{
            ok: true; resourceRef: string; revision: number;
        }>();
        createResource.mockReturnValueOnce(deferred.promise);
        const onCreated = vi.fn(async () => {});
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const common = {
            approvalPending: false,
            requestApproval: vi.fn(),
            onCancel: vi.fn(),
            onCreated,
        };
        const screen = await renderScreen(
            <SavedSecretCreateEditor scope={scopeA} {...common} />,
        );
        screen.changeTextByTestId('saved-secret-create-name', 'Home A secret');
        screen.changeTextByTestId('saved-secret-create-value', 'home-a-value');
        // Commit the typed draft before pressing, so the press reads it.
        await flushHookEffects();
        screen.pressByTestId('saved-secret-create-submit');

        await screen.update(
            <SavedSecretCreateEditor scope={scopeB} {...common} />,
        );
        // A different Home is a different draft: the value typed for Home A is
        // gone, so nothing typed there can be submitted here.
        expect(screen.findByTestId('saved-secret-create-name')?.props.value).toBe('');
        expect(screen.findByTestId('saved-secret-create-value')?.props.value).toBe('');
        await screen.pressByTestIdAsync('saved-secret-create-submit');
        expect(createResource).toHaveBeenCalledTimes(1);

        deferred.resolve({ ok: true, resourceRef: 'happier:shared-secret:v1:old-home', revision: 1 });
        await flushHookEffects();
        expect(onCreated).not.toHaveBeenCalled();
    });

    it('does not carry one Home\u2019s recipients into a Create on another Home', async () => {
        createResource.mockResolvedValueOnce({
            ok: true, resourceRef: 'happier:shared-secret:v1:resource-b', revision: 1,
        });
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const common = {
            approvalPending: false,
            requestApproval: vi.fn(),
            onCancel: vi.fn(),
            onCreated: vi.fn(async () => {}),
        };
        const screen = await renderScreen(
            <SavedSecretCreateEditor scope={scopeA} {...common} />,
        );
        screen.changeTextByTestId('saved-secret-create-name', 'Cross-Home secret');
        screen.changeTextByTestId('saved-secret-create-value', 'cross-home-value');
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-account:account-b')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-account:account-b');
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-candidate-team:team-a')).toBeTruthy());
        await screen.pressByTestIdAsync('saved-secret-access-candidate-team:team-a');

        await screen.update(
            <SavedSecretCreateEditor scope={scopeB} {...common} />,
        );
        screen.changeTextByTestId('saved-secret-create-name', 'Home B secret');
        screen.changeTextByTestId('saved-secret-create-value', 'home-b-value');
        await flushHookEffects();
        await screen.pressByTestIdAsync('saved-secret-create-submit');

        // `account-b`, `team-a` and `group-a` are Home A identities; submitting
        // them to Home B would ask it to share with principals it never named.
        expect(createResource).toHaveBeenCalledWith(expect.objectContaining({
            scope: scopeB,
            name: 'Home B secret',
            value: 'home-b-value',
            accountGrants: [], teamGrants: [], groupGrants: [],
        }));
        // An owner-only create needs no disclosure confirmation, which also
        // proves the recipient sets really were empty at submit time.
        expect(confirmDisclosure).not.toHaveBeenCalled();
    });

    it('adds a personal secret through the personal writer unless Shared is chosen', async () => {
        const onCreatePersonal = vi.fn(async () => 'personal-new');
        const onCreated = vi.fn(async () => {});
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const screen = await renderScreen(
            <SavedSecretCreateEditor
                scope={scopeA}
                onCreatePersonal={onCreatePersonal}
                approvalPending={false}
                requestApproval={vi.fn()}
                onCancel={vi.fn()}
                onCreated={onCreated}
            />,
        );

        // Personal is the default: no type or recipients to choose, and nothing reaches the Home.
        expect(screen.findByTestId('saved-secret-create-kind:token')).toBeFalsy();
        screen.changeTextByTestId('saved-secret-create-name', 'Local key');
        screen.changeTextByTestId('saved-secret-create-value', 'local-value');
        await flushHookEffects();
        await screen.pressByTestIdAsync('saved-secret-create-submit');

        expect(onCreatePersonal).toHaveBeenCalledWith({ name: 'Local key', value: 'local-value' });
        expect(createResource).not.toHaveBeenCalled();
        expect(onCreated).toHaveBeenCalledWith('personal-new', 'personal');
    });

    it('creates a shared resource instead when Shared is chosen in the same editor', async () => {
        createResource.mockResolvedValueOnce({ ok: true, resourceRef: 'happier:shared-secret:v1:resource-s', revision: 1 });
        const onCreatePersonal = vi.fn(async () => 'personal-new');
        const onCreated = vi.fn(async () => {});
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const screen = await renderScreen(
            <SavedSecretCreateEditor
                scope={scopeA}
                onCreatePersonal={onCreatePersonal}
                approvalPending={false}
                requestApproval={vi.fn()}
                onCancel={vi.fn()}
                onCreated={onCreated}
            />,
        );

        await screen.pressByTestIdAsync('saved-secret-create-storage:shared');
        screen.changeTextByTestId('saved-secret-create-name', 'Team key');
        screen.changeTextByTestId('saved-secret-create-value', 'team-value');
        await screen.pressByTestIdAsync('saved-secret-create-kind:password');
        await screen.pressByTestIdAsync('saved-secret-create-submit');

        expect(onCreatePersonal).not.toHaveBeenCalled();
        expect(createResource).toHaveBeenCalledWith(expect.objectContaining({ name: 'Team key', kind: 'password', value: 'team-value' }));
        expect(onCreated).toHaveBeenCalledWith('happier:shared-secret:v1:resource-s', 'shared');
    });

    it('offers only personal storage where this Home does not allow shared secrets', async () => {
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const screen = await renderScreen(
            <SavedSecretCreateEditor
                scope={scopeA}
                onCreatePersonal={vi.fn(async () => 'personal-new')}
                sharedAvailable={false}
                approvalPending={false}
                requestApproval={vi.fn()}
                onCancel={vi.fn()}
                onCreated={vi.fn(async () => {})}
            />,
        );

        expect(screen.findByTestId('saved-secret-create-storage:shared')).toBeFalsy();
        expect(screen.findByTestId('saved-secret-create-kind:token')).toBeFalsy();
    });

    it('keeps entered material available for retry after a typed failure', async () => {
        createResource.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const screen = await renderScreen(
            <SavedSecretCreateEditor
                scope={scopeA}
                approvalPending={false}
                requestApproval={vi.fn()}
                onCancel={vi.fn()}
                onCreated={vi.fn(async () => {})}
            />,
        );
        screen.changeTextByTestId('saved-secret-create-name', 'Retry me');
        screen.changeTextByTestId('saved-secret-create-value', 'still-here');
        await screen.pressByTestIdAsync('saved-secret-create-submit');

        expect(screen.findByTestId('saved-secret-create-name')?.props.value).toBe('Retry me');
        expect(screen.findByTestId('saved-secret-create-value')?.props.value).toBe('still-here');
        expect(screen.findByTestId('saved-secret-create-submit')?.props.disabled).toBe(false);
    });
});
