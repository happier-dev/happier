import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { SharedSavedSecretCreateInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';

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

// The host runner supplies the native UUID adapter at its real OS boundary.
vi.mock('expo-crypto', async importOriginal => ({ ...await importOriginal<typeof import('expo-crypto')>(),
    randomUUID: (await import('node:crypto')).randomUUID }));
const { serveSavedSecretEditorHomes, savedSecretCreatePath } = await import('@/dev/testkit/harness/savedSecretEditorHttpHarness');
const { teamSummaryFixture, teamGroupFixture } = await import('@/dev/testkit/fixtures/teamFixtures');
let home: Awaited<ReturnType<typeof serveSavedSecretEditorHomes>> | null = null;
let scopeA = { serverId: '', accountId: 'owner-a' };
let scopeB = { serverId: '', accountId: 'owner-b' };
beforeEach(async () => {
    home = await serveSavedSecretEditorHomes({
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

afterEach(async () => {
    await standardCleanup();
    await home?.dispose();
    home = null;
    confirmDisclosure.mockReset();
    confirmDisclosure.mockResolvedValue(true);
});

const createWrites = () => home!.mutations.filter(request => request.path === savedSecretCreatePath);
const createdInput = () => SharedSavedSecretCreateInputV1Schema.parse(createWrites()[0]!.body);
const createdRef = () => `happier:shared-secret:v1:${createdInput().resourceId}`;
async function startAdding(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await act(async () => { invokeTestInstanceHandler(screen.findByTestId('saved-secret-access-search'), 'onFocus'); });
}

describe('SavedSecretCreateEditor', () => {
    it('links a personal secret to a field in an installed secret source instead of storing a value', async () => {
        const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
        const contribution = { pluginId: 'happier.secret-source.onepassword', localId: 'onepassword' };
        // Account availability is the declaration owner; a Machine materialization carries the admitted manifest.
        replacePluginAccountAvailabilityProjection({ scope: scopeA, snapshot: {
            availabilityCursor: 1, intentReads: [], snapshots: [], materializations: [{
                serverIdentityId: 'srv_fixture', machineId: 'machine-a', materializationId: 'bundled-onepassword',
                pluginId: contribution.pluginId, version: '0.0.0', sourceClass: 'localPath', portableRelease: false,
                uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1,
                declaredManifest: PluginManifestV2Schema.parse({ schemaVersion: 2, id: contribution.pluginId, version: '0.0.0', displayName: '1Password',
                    engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
                    contributes: { secretSources: [{ id: contribution.localId, title: '1Password' }] } }),
            }],
        } });
        const onCreatePersonal = vi.fn(async () => 'personal-linked');
        const onCreated = vi.fn(async () => {});
        const requestApproval = vi.fn();
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const screen = await renderScreen(
            <SavedSecretCreateEditor
                scope={scopeA}
                onCreatePersonal={onCreatePersonal}
                approvalPending={false}
                requestApproval={requestApproval}
                onCancel={vi.fn()}
                onCreated={onCreated}
            />,
        );

        const sourceTab = 'saved-secret-create-origin:happier.secret-source.onepassword/onepassword';
        await vi.waitFor(() => expect(screen.findByTestId(sourceTab)).toBeTruthy());
        await screen.pressByTestIdAsync(sourceTab);
        // A linked secret has no value to type and stays personal.
        expect(screen.findByTestId('saved-secret-create-value')).toBeFalsy();
        expect(screen.findByTestId('saved-secret-create-storage:shared')).toBeFalsy();
        screen.changeTextByTestId('saved-secret-create-name', 'Deploy token');
        screen.changeTextByTestId('saved-secret-create-link-account', ' my-team.1password.com ');
        screen.changeTextByTestId('saved-secret-create-link-reference', 'op://Deploy/Token/credential');
        await flushHookEffects();
        await screen.pressByTestIdAsync('saved-secret-create-submit');

        expect(onCreatePersonal).toHaveBeenCalledWith(
            { name: 'Deploy token', source: { kind: 'external', contribution,
                account: 'my-team.1password.com', reference: 'op://Deploy/Token/credential' } },
            { onApprovalPending: requestApproval },
        );
        expect(createWrites()).toHaveLength(0);
        expect(onCreated).toHaveBeenCalledWith('personal-linked', 'personal');
    });

    it('offers no link choice when no secret source is installed', async () => {
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const screen = await renderScreen(
            <SavedSecretCreateEditor
                scope={scopeA}
                onCreatePersonal={vi.fn(async () => 'personal-new')}
                approvalPending={false}
                requestApproval={vi.fn()}
                onCancel={vi.fn()}
                onCreated={vi.fn(async () => {})}
            />,
        );
        await flushHookEffects();
        expect(screen.findByTestId('saved-secret-create-origin:happier.secret-source.onepassword/onepassword')).toBeFalsy();
        expect(screen.findByTestId('saved-secret-create-value')).toBeTruthy();
    });

    it('creates an owner-only resource from one name, kind, and value entry', async () => {
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
        await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
        expect(createWrites()).toHaveLength(1);
        expect(createWrites()[0]).toMatchObject({ home: 'home-a', accountId: 'owner-a' });
        expect(createdInput()).toMatchObject({
            displayName: 'Deploy token', kind: 'token', storedContent: { t: 'plain', v: { value: '  token-value\n' } },
            accountGrants: [], teamGrants: [], groupGrants: [],
        });
        expect(onCreated).toHaveBeenCalledWith(createdRef(), 'shared');
    });

    it('confirms disclosure and submits initial Account, Team, and Group grants', async () => {
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
        await startAdding(screen);
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
        await vi.waitFor(() => expect(createWrites()).toHaveLength(1));
        expect(createdInput()).toMatchObject({
            accountGrants: ['account-b'], teamGrants: ['team-a'], groupGrants: ['group-a'],
        });
    });

    it('keeps the draft mounted while approval is pending and presents the exact artifact', async () => {
        const requestApproval = vi.fn();
        home!.replaceSettings('home-a', { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'secrets.shared.create': { approvalRequiredSurfaces: ['ui'] },
        } }) }, 2);
        // Cold restore intentionally ignores an already initialized Sync runtime.
        // Reconnect this fixture's Account before expecting the new server policy.
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        await home!.restoreActiveConnection();
        const { storage } = await import('@/sync/domains/state/storage');
        await vi.waitFor(() => expect(storage.getState().settings.actionsSettingsV1)
            .toEqual(home!.settings('home-a')!.actionsSettingsV1));
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
        await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce());
        const artifact = home!.artifacts.get('home-a')!.list()[0]!;
        expect(artifact).toBeTruthy();
        expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ artifactId: artifact.id }));
        const requestBody = home!.artifacts.get('home-a')!.readPlainBody(artifact.id);
        expect(requestBody).not.toBeNull();
        expect(StoredApprovalRequestSchema.parse(JSON.parse(requestBody!))).toMatchObject({ actionId: 'secrets.shared.create',
            actionArgs: { displayName: 'Kept name', storedContent: { t: 'plain', v: { value: 'kept-value' } } } });
        expect(createWrites()).toHaveLength(0);

        await screen.update(
            <SavedSecretCreateEditor
                scope={scopeA}
                approvalPending
                approvalId={artifact.id}
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
        const deferred = createDeferred<Response>();
        home!.respondToMutations(() => deferred.promise);
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
        await vi.waitFor(() => expect(createWrites()).toHaveLength(1));

        await screen.update(
            <SavedSecretCreateEditor scope={scopeB} {...common} />,
        );
        // A different Home is a different draft: the value typed for Home A is
        // gone, so nothing typed there can be submitted here.
        expect(screen.findByTestId('saved-secret-create-name')?.props.value).toBe('');
        expect(screen.findByTestId('saved-secret-create-value')?.props.value).toBe('');
        await screen.pressByTestIdAsync('saved-secret-create-submit');
        expect(createWrites()).toHaveLength(1);

        const response = Response.json({ resourceId: createdInput().resourceId, revision: 1 });
        deferred.resolve(response);
        await vi.waitFor(() => expect(response.bodyUsed).toBe(true));
        await flushHookEffects();
        expect(onCreated).not.toHaveBeenCalled();
    });

    it('does not carry one Home\u2019s recipients into a Create on another Home', async () => {
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
        await startAdding(screen);
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
        await vi.waitFor(() => expect(createWrites()).toHaveLength(1));
        expect(createWrites()[0]).toMatchObject({ home: 'home-b', accountId: 'owner-b' });
        expect(createdInput()).toMatchObject({
            displayName: 'Home B secret',
            storedContent: { t: 'plain', v: { value: 'home-b-value' } },
            accountGrants: [], teamGrants: [], groupGrants: [],
        });
        // An owner-only create needs no disclosure confirmation, which also
        // proves the recipient sets really were empty at submit time.
        expect(confirmDisclosure).not.toHaveBeenCalled();
    });

    it('asks for the value before the name, and saves under the suggested name when none is typed', async () => {
        const onCreatePersonal = vi.fn(async () => 'personal-new');
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const screen = await renderScreen(
            <SavedSecretCreateEditor scope={scopeA} onCreatePersonal={onCreatePersonal} approvalPending={false}
                requestApproval={vi.fn()} onCancel={vi.fn()} onCreated={vi.fn(async () => {})} initialName="ElevenLabs key" />,
        );
        const inputs = screen.tree.findAll((node) => node.type === ('TextInput' as never)).map((node) => node.props.testID);
        expect(inputs.indexOf('saved-secret-create-value')).toBeLessThan(inputs.indexOf('saved-secret-create-name'));
        screen.changeTextByTestId('saved-secret-create-value', 'sk-123');
        await flushHookEffects();
        await screen.pressByTestIdAsync('saved-secret-create-submit');
        expect(onCreatePersonal).toHaveBeenCalledWith({ name: 'ElevenLabs key', value: 'sk-123' }, expect.anything());
    });

    it('adds a personal secret through the personal writer unless Shared is chosen', async () => {
        const onCreatePersonal = vi.fn(async () => 'personal-new');
        const onCreated = vi.fn(async () => {});
        const requestApproval = vi.fn();
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const screen = await renderScreen(
            <SavedSecretCreateEditor
                scope={scopeA}
                onCreatePersonal={onCreatePersonal}
                approvalPending={false}
                requestApproval={requestApproval}
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

        expect(onCreatePersonal).toHaveBeenCalledWith(
            { name: 'Local key', value: 'local-value' },
            { onApprovalPending: requestApproval },
        );
        expect(createWrites()).toHaveLength(0);
        expect(onCreated).toHaveBeenCalledWith('personal-new', 'personal');
    });

    it('creates a shared resource instead when Shared is chosen in the same editor', async () => {
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
        await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
        expect(createdInput()).toMatchObject({ displayName: 'Team key', kind: 'password', storedContent: { t: 'plain', v: { value: 'team-value' } } });
        expect(onCreated).toHaveBeenCalledWith(createdRef(), 'shared');
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

    it('asks for the value before the name, and saves under the suggested name when none is typed', async () => {
        const onCreatePersonal = vi.fn(async () => 'personal-new');
        const { SavedSecretCreateEditor } = await import('./SavedSecretCreateEditor');
        const screen = await renderScreen(
            <SavedSecretCreateEditor scope={scopeA} onCreatePersonal={onCreatePersonal} approvalPending={false}
                requestApproval={vi.fn()} onCancel={vi.fn()} onCreated={vi.fn(async () => {})} initialName="ElevenLabs key" />,
        );
        const inputs = screen.tree.findAll((node) => node.type === ('TextInput' as never)).map((node) => node.props.testID);
        expect(inputs.indexOf('saved-secret-create-value')).toBeLessThan(inputs.indexOf('saved-secret-create-name'));
        screen.changeTextByTestId('saved-secret-create-value', 'sk-123');
        await flushHookEffects();
        await screen.pressByTestIdAsync('saved-secret-create-submit');
        expect(onCreatePersonal).toHaveBeenCalledWith({ name: 'ElevenLabs key', value: 'sk-123' }, expect.anything());
    });

    it('keeps entered material available for retry after a typed failure', async () => {
        home!.respondToMutations(() => Response.json({ error: 'temporarily_unavailable' }, { status: 503 }));
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
        await flushHookEffects();
        await screen.pressByTestIdAsync('saved-secret-create-submit');

        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-create-failure')).toBeTruthy());
        expect(createWrites()).toHaveLength(1);
        expect(screen.findByTestId('saved-secret-create-name')?.props.value).toBe('Retry me');
        expect(screen.findByTestId('saved-secret-create-value')?.props.value).toBe('still-here');
        expect(screen.findByTestId('saved-secret-create-submit')?.props.disabled).toBe(false);
    });
});
// Native filesystem classes are an OS boundary, not part of this source-driven UI journey.
vi.mock('expo-file-system', async () =>
    (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);
