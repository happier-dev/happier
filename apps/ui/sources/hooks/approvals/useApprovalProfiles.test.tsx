import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { installRealActionExecutorModuleLoader, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import type { ApprovalProfileV1 } from '@happier-dev/protocol/actions';
import { createArtifactStoreBoundary, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { APPROVAL_PROFILE_ARTIFACT_KIND_V1, ApprovalProfileArtifactChangeResultV1Schema } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { encodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';

// Native presentation SDKs and sockets are external boundaries; the authoring
// controls, Account projections, profile resolver and Action executor stay real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { useApprovalProfiles } = await import('./useApprovalProfiles');
const { storage } = await import('@/sync/domains/state/storage');
const originalState = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
afterEach(async () => { await account?.dispose(); account = undefined; storage.setState(originalState, true); });

function plainProfileArtifact(profile: ApprovalProfileV1, ownerAccountId: string) {
    const { id, ...content } = profile;
    const header = { kind: APPROVAL_PROFILE_ARTIFACT_KIND_V1, name: profile.name, title: profile.name };
    return createPlainArtifactHttpFixture({ id, isDecrypted: true, title: profile.name, header, rawHeader: header,
        body: JSON.stringify({ kind: APPROVAL_PROFILE_ARTIFACT_KIND_V1, profile: content }),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }, ownerAccountId);
}

describe('approval profile Account data', () => {
    it.each(['explicit', 'machine'] as const)('names a collapsed %s profile through its header without loading the profile catalog bodies', async selection => {
        const profile = { id: 'artifact-selected', name: 'Selected deployment' } as const;
        account = await createSecretSettingsTestHarness({ mode: 'plain', settings: settingsParse({ actionsSettingsV1: {
            v: 1, actions: {}, machineApprovalProfiles: { 'machine-selected': profile.id },
        } }) });
        account.artifacts.replaceStoredRow(plainProfileArtifact(profile, account.scope.accountId));
        let demand = false;
        const hook = await renderHook(() => useApprovalProfiles(selection === 'explicit' ? profile.id : undefined, undefined,
            { demand, machineId: 'machine-selected' }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().selectedDescriptor).toEqual(profile));
            expect(hook.getCurrent().profiles).toEqual([]);
            const reads = account.request.mock.calls.filter(([url]) => new URL(String(url)).pathname.startsWith('/v1/artifacts'));
            expect(reads.length).toBeGreaterThan(0);
            expect(reads.every(([url, init]) => new URL(String(url)).pathname.endsWith('/read')
                && typeof init?.body === 'string' && JSON.parse(init.body).projection === 'headers')).toBe(true);
            demand = true;
            await hook.rerender();
            await vi.waitFor(() => expect(hook.getCurrent().profiles).toContainEqual(profile));
        } finally { await hook.unmount(); }
    });
    it('opens the held Artifact catalog on demand and reuses it for warm reads and unrelated Artifact pushes', async () => {
        const profile = { id: 'artifact-demand', name: 'Demanded profile' } as const;
        account = await createSecretSettingsTestHarness({ mode: 'plain' });
        account.artifacts.replaceStoredRow(plainProfileArtifact(profile, account.scope.accountId));
        const disposeLoader = await installRealActionExecutorModuleLoader();
        const hook = await renderHook(() => useApprovalProfiles(undefined, undefined, { demand: false }));
        const artifactReads = () => account!.request.mock.calls.filter(([url, init]) =>
            (!init?.method || init.method === 'GET' || init.method === 'POST')
            && new URL(String(url)).pathname.startsWith('/v1/artifacts')).length;
        try {
            await vi.waitFor(() => expect(hook.getCurrent().execution.ready).toBe(true));
            expect(account!.request.mock.calls.filter(([url, init]) => {
                const target = new URL(String(url));
                return target.pathname === '/v1/artifacts' && target.searchParams.get('includeBody') === 'true'
                    || target.pathname === `/v1/artifacts/${profile.id}`
                    || target.pathname === '/v1/artifacts/read' && typeof init?.body === 'string'
                        && JSON.parse(init.body).projection !== 'headers';
            })).toEqual([]);
            const { createApprovalProfileComposerChip } = await import('@/components/approvals/createApprovalProfileComposerChip');
            const source = hook.getCurrent();
            const chip = createApprovalProfileComposerChip({ value: undefined, profiles: source.displayProfiles,
                machineDefault: null, ready: source.ready, requestCatalog: source.requestCatalog, onChange: () => {} });
            await act(async () => { chip.onIntent?.(); });
            await vi.waitFor(() => expect(hook.getCurrent().profiles).toContainEqual(profile));
            const coldReads = artifactReads();
            expect(coldReads).toBeGreaterThan(0);
            await act(async () => {
                await hook.getCurrent().requestCatalog();
                expect(await hook.getCurrent().execution.executeForCaller('actions.policy.get', { profiles: true },
                    { surface: 'ui', approvalProfileId: profile.id })).toMatchObject({ ok: true });
                publishHomeAccountChange(account!.scope.serverId, ['unrelated-document'], { source: 'socket', changeKinds: ['artifact'],
                    artifactKinds: [encodeArtifactKindV1({ kind: 'other', kindHint: 'prompt_doc.v2' })] });
                await hook.getCurrent().requestCatalog();
            });
            expect(artifactReads()).toBe(coldReads);
        } finally { await hook.unmount(); disposeLoader(); }
    });
    it('resolves a background Home profile against that exact Account without borrowing the focused Account', async () => {
        const selectedId = 'approval-home-profile';
        const catalogs = {
            background: createArtifactStoreBoundary({ ownerAccountId: () => 'background-account', encryptionMode: 'plain' }),
            focused: createArtifactStoreBoundary({ ownerAccountId: () => 'focused-account', encryptionMode: 'plain' }),
        };
        catalogs.background.replaceStoredRow(plainProfileArtifact({ id: selectedId, name: 'Background profile',
            actions: { 'session.stop': { approvalRequiredSurfaces: ['agent'] } } }, 'background-account'));
        catalogs.focused.replaceStoredRow(plainProfileArtifact({ id: selectedId, name: 'Focused profile' }, 'focused-account'));
        const homes = await serveAccountHomes({ homes: [
            { key: 'background', serverUrl: 'https://approval-background.test', accountId: 'background-account', settings: {
                actionsSettingsV1: { v: 1, actions: {} },
            } },
            { key: 'focused', serverUrl: 'https://approval-focused.test', accountId: 'focused-account', settings: {
                actionsSettingsV1: { v: 1, actions: {} },
            } },
        ], route: request => catalogs[request.home as keyof typeof catalogs]?.handle(`${request.url.pathname}${request.url.search}`, {
            method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        }) ?? undefined });
        const hook = await renderHook(() => useApprovalProfiles(selectedId, homes.homes.background!.id));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
            expect(hook.getCurrent().selection).toMatchObject({ profile: { name: 'Background profile' } });
        } finally { await hook.unmount(); await homes.dispose(); }
    });
    it('keeps both changed profiles when a second push arrives during a targeted refresh', async () => {
        account = await createSecretSettingsTestHarness({ mode: 'plain' });
        const first = { id: 'artifact-first', name: 'First' };
        const second = { id: 'artifact-second', name: 'Second' };
        for (const profile of [first, second]) account.artifacts.replaceStoredRow(plainProfileArtifact(profile, account.scope.accountId));
        const hook = await renderHook(() => useApprovalProfiles());
        let release: () => void = () => {};
        const pending = new Promise<void>(resolve => { release = resolve; });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
            const request = account.request.getMockImplementation()!;
            let held = false;
            account.request.mockImplementation(async (url, init) => {
                const response = await request(url, init);
                if (!held && new URL(String(url)).pathname === '/v1/artifacts/read') {
                    held = true;
                    await pending;
                }
                return response;
            });
            const change = (profile: typeof first) => {
                account!.artifacts.replaceStoredRow({ ...plainProfileArtifact(profile, account!.scope.accountId), headerVersion: 2, bodyVersion: 2 });
                publishHomeAccountChange(account!.scope.serverId, [profile.id], { source: 'socket', changeKinds: ['artifact'],
                    artifactKinds: [encodeArtifactKindV1({ kind: 'other', kindHint: APPROVAL_PROFILE_ARTIFACT_KIND_V1 })] });
            };
            await act(async () => { change({ ...first, name: 'First changed' }); });
            await vi.waitFor(() => expect(held).toBe(true));
            await act(async () => { change({ ...second, name: 'Second changed' }); release(); });
            await vi.waitFor(() => expect(Object.fromEntries(hook.getCurrent().profiles.map(profile => [profile.id, profile.name])))
                .toEqual({ [first.id]: 'First changed', [second.id]: 'Second changed' }));
        } finally { release(); await hook.unmount(); }
    });
    it.each(['fields', 'chips'] as const)('renders the missing-profile warning in %s and lets the author follow the Machine or select an Account profile', async presentation => {
        const { SessionAuthoringControls } = await import('@/components/sessions/authoring/controls/SessionAuthoringControls');
        const { ModalProvider } = await import('@/modal');
        const { renderWithAppProviders } = await import('@/dev/testkit/render/renderWithAppProviders');
        const restoreWeb = withPopoverWebGlobals();
        const profile = { id: 'artifact-deploy', name: 'Deploy' } as const;
        account = await createSecretSettingsTestHarness({ mode: 'plain', settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: {} },
        }) });
        account.artifacts.replaceStoredRow(plainProfileArtifact(profile, account.scope.accountId));
        const change = vi.fn();
        const element = (approvalProfileId: string | null | undefined) => <ModalProvider><SessionAuthoringControls
            testIDPrefix="profile-authoring" presentation={presentation} fields={['approvalProfileId']}
            values={{ approvalProfileId }} onChangeField={change}
        /></ModalProvider>;
        const screen = await renderWithAppProviders(element('artifact-removed'));
        try {
            const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
            await act(async () => screen.tree.root.findByType(DropdownMenu).props.onOpenChange(true));
            await vi.waitFor(() => expect(screen.tree.root.findAllByProps({ testID: 'profile-authoring-approvalProfileId-missing' }).length).toBeGreaterThan(0));
            const picker = screen.tree.root.findByType(DropdownMenu);
            expect(picker.props.items.map((item: { id: string }) => item.id)).toEqual(['machine_default', profile.id]);
            await act(async () => picker.props.onSelect(profile.id));
            expect(change).toHaveBeenLastCalledWith('approvalProfileId', profile.id);
            await act(async () => picker.props.onSelect('machine_default'));
            expect(change).toHaveBeenLastCalledWith('approvalProfileId', null);
            await screen.update(element(profile.id));
            expect(screen.tree.root.findAllByProps({ testID: 'profile-authoring-approvalProfileId-missing' })).toHaveLength(0);
        } finally { await screen.unmount(); restoreWeb(); }
    });
    it.each(['plain', 'e2ee'] as const)('saves a %s Account profile, makes it a Machine default, and deleting it clears that default', async mode => {
        account = await createSecretSettingsTestHarness({ mode, settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: { 'session.stop': { disabledSurfaces: ['agent'] } } },
        }) });
        const disposeLoader = await installRealActionExecutorModuleLoader();
        const siblingPolicy = account.persistedSettings.actionsSettingsV1.actions['session.stop'];
        const content = { name: 'Deploy', actions: { 'session.stop': { approvalRequiredSurfaces: ['agent' as const] } } };
        let profileId: string | undefined;
        const hook = await renderHook(() => useApprovalProfiles(profileId));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
            expect(hook.getCurrent().profiles).toEqual([]);
            await act(async () => {
                const created = await hook.getCurrent().execute({ profileChange: { kind: 'create', profile: content } });
                expect(created.ok).toBe(true);
                if (!created.ok) throw new Error(created.errorCode);
                profileId = ApprovalProfileArtifactChangeResultV1Schema.parse((created.result as { profileChange: unknown }).profileChange).id;
            });
            await hook.rerender();
            expect(account.persistedSettings.actionsSettingsV1).not.toHaveProperty('approvalProfiles');
            expect(account.artifacts.read(profileId!)).not.toBeNull();
            expect(hook.getCurrent().selection).toMatchObject({ resolution: { status: 'available' } });
            await act(async () => { expect(await hook.getCurrent().execute({ profileChange: {
                kind: 'machine_default', machineId: 'machine-a', id: profileId! } })).toMatchObject({ ok: true }); });
            expect(hook.getCurrent().machineApprovalProfiles).toEqual({ 'machine-a': profileId });
            const row = hook.getCurrent().profileRows.find(row => row.id === profileId)!;
            await act(async () => { expect(await hook.getCurrent().execute({ profileChange: {
                kind: 'delete', id: row.id, expectedRevision: row.revision } })).toMatchObject({ ok: true }); });
            expect(account.artifacts.read(profileId!)).toBeNull();
            expect(account.persistedSettings.actionsSettingsV1.machineApprovalProfiles ?? {}).toEqual({});
            expect(account.persistedSettings.actionsSettingsV1.actions['session.stop']).toEqual(siblingPolicy);
            expect(hook.getCurrent().selection).toMatchObject({ resolution: { status: 'missing' } });
        } finally { await hook.unmount(); disposeLoader(); }
    });

    it('keeps profile projections stable on unrelated preferences and resolves removed references visibly', async () => {
        const profile = { id: 'artifact-deploy', name: 'Deploy' } as const;
        account = await createSecretSettingsTestHarness({ mode: 'plain', settings: settingsParse({
            actionsSettingsV1: { v: 1, actions: {} },
        }) });
        account.artifacts.replaceStoredRow(plainProfileArtifact(profile, account.scope.accountId));
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useApprovalProfiles(profile.id); });
        await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
        const first = hook.getCurrent();
        expect(first.profiles).toContainEqual(profile);
        expect(first.selection).toMatchObject({ profile, resolution: { status: 'available' } });
        const before = renders;
        await act(async () => {
            for (let index = 0; index < 20; index += 1) storage.getState().applySettingsForScope(account!.scope,
                settingsParse({ ...storage.getState().settings, useProfiles: index % 2 === 0 }), index + 2);
        });
        expect(renders).toBe(before);
        expect(hook.getCurrent().profiles).toBe(first.profiles);
        await act(async () => {
            account!.artifacts.clear();
            publishHomeAccountChange(account!.scope.serverId, [profile.id], { source: 'socket',
                changeKinds: ['artifact'], artifactKinds: [encodeArtifactKindV1({
                    kind: 'other', kindHint: APPROVAL_PROFILE_ARTIFACT_KIND_V1 })] });
        });
        await vi.waitFor(() => expect(hook.getCurrent().selection?.resolution.status).toBe('missing'));
        expect(hook.getCurrent().selection).toMatchObject({ profile: null,
            resolution: { status: 'missing', requestedId: profile.id } });
        expect(hook.getCurrent().profiles).not.toContainEqual(profile);
        await hook.unmount();
    });
});
